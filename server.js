const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { analyze, score } = require('./matcher');
const db = require('./db');
const { createAuthRouter, socketAuth, displayName, profileExtras } = require('./auth');
const { iceServersFor } = require('./turn');
const safety = require('./safety');
const friends = require('./friends');

const PORT = process.env.PORT || 3000;
const MAX_MATCHES = 12;
const MIN_SCORE = 0.15;
// How long after a call you can still report or block the person you were talking to.
const LAST_PEER_TTL_MS = 30 * 60 * 1000;
const MAX_TRANSCRIPT = 100;
// Each shared interest nudges a match up a little (only for matches that already qualify).
const INTEREST_BOOST = 0.05;
const MAX_INTEREST_BOOST = 0.15;

const app = express();
// Set TRUST_PROXY=1 when running behind a load balancer so rate limits see real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  });
  // Tell browsers to only ever use HTTPS for this site.
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/auth', createAuthRouter({
  onLogout: (sessionId) => io.in(`session:${sessionId}`).disconnectSockets(true),
  // Password reset revokes every session, so drop every open tab for that account.
  onSessionsRevoked: (accountId) => io.in(`account:${accountId}`).disconnectSockets(true),
}));
app.use('/api/blocks', safety.createBlocksRouter());
app.use('/api/admin', safety.createAdminRouter());
app.get('/health', (_req, res) => res.json({ ok: true, online: users.size }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
io.use(socketAuth);

// Suspended accounts are told why, then disconnected (their sessions are already deleted).
safety.setSuspendHandler((accountId) => {
  io.to(`account:${accountId}`).emit('suspended');
  io.in(`account:${accountId}`).disconnectSockets();
});

// socket.id -> user (one entry per open tab)
// user: { id, accountId, name, avatar, activity, profile, status: 'idle'|'searching'|'in-room',
//         roomId, outgoing: Set<id>, incoming: Set<id>, joinedAt,
//         lastPeer: { accountId, name, activity, chat, at } }   <- for reporting after a call
const users = new Map();
// roomId -> { id, members: [id, id], chat: [{ name, text, at }], createdAt }
const rooms = new Map();

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function publicUser(u) {
  return {
    id: u.id, name: u.name, avatar: u.avatar, activity: u.activity,
    bio: u.bio, interests: u.interests, city: u.city, timezone: u.timezone,
  };
}

// Copies display fields from an account row onto a live user entry.
function applyProfile(u, row) {
  u.name = displayName(row);
  u.avatar = row.avatar;
  Object.assign(u, profileExtras(row));
}

function sharedInterests(a, b) {
  const mine = new Set((a.interests || []).map((i) => i.toLowerCase()));
  return (b.interests || []).filter((i) => mine.has(i.toLowerCase()));
}

// ---------- Matching ----------

function matchesFor(user) {
  const results = [];
  for (const other of users.values()) {
    // Skip yourself, including your own other tabs.
    if (other.accountId === user.accountId || other.status !== 'searching') continue;
    if (safety.isBlocked(user.accountId, other.accountId)) continue;
    let s = score(user.profile, other.profile);
    if (s >= MIN_SCORE) {
      const shared = sharedInterests(user, other);
      s = Math.min(1, s + Math.min(MAX_INTEREST_BOOST, shared.length * INTEREST_BOOST));
      results.push({
        ...publicUser(other),
        score: Math.round(s * 100),
        shared,
        friend: friends.areFriends(user.accountId, other.accountId),
        requested: user.outgoing.has(other.id),
        requestedYou: user.incoming.has(other.id),
      });
    }
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results.slice(0, MAX_MATCHES);
}

// Recompute and push match lists to every searching user. Debounced so bursts of
// joins/leaves only trigger one pass.
let recomputeTimer = null;
function scheduleRecompute() {
  if (recomputeTimer) return;
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    let searching = 0;
    for (const u of users.values()) if (u.status === 'searching') searching++;
    for (const u of users.values()) {
      if (u.status !== 'searching') continue;
      io.to(u.id).emit('matches', { matches: matchesFor(u), online: searching });
    }
    pushFriendLists();
  }, 120);
}

// ---------- Friends presence ----------

// Best status across an account's open tabs: in a call > searching > online.
function presenceByAccount() {
  const rank = { 'in-room': 3, searching: 2, idle: 1 };
  const out = new Map();
  for (const u of users.values()) {
    const cur = out.get(u.accountId);
    if (!cur || rank[u.status] > rank[cur.status]) out.set(u.accountId, { status: u.status, activity: u.activity });
  }
  return out;
}

const STATUS_LABEL = { 'in-room': 'in-call', searching: 'searching', idle: 'online' };

function friendListFor(accountId, presence, rowCache) {
  const row = (id) => {
    if (!rowCache.has(id)) rowCache.set(id, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return rowCache.get(id);
  };
  const list = friends.friendIds(accountId).map((id) => {
    const r = row(id);
    if (!r || r.banned_at) return null;
    const p = presence.get(id);
    return {
      id, name: displayName(r), avatar: r.avatar, ...profileExtras(r),
      status: p ? STATUS_LABEL[p.status] : 'offline',
      activity: p && p.status !== 'idle' ? p.activity : '',
    };
  }).filter(Boolean);
  const order = { searching: 0, online: 1, 'in-call': 2, offline: 3 };
  list.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const requests = friends.incomingRequestIds(accountId).map((id) => row(id)).filter((r) => r && !r.banned_at)
    .map((r) => ({ id: r.id, name: displayName(r), avatar: r.avatar }));
  return { friends: list, requests };
}

// Sends each tab its friend list, but only when it changed since the last push.
function pushFriendLists() {
  const presence = presenceByAccount();
  const rowCache = new Map();
  const perAccount = new Map();
  for (const u of users.values()) {
    if (!perAccount.has(u.accountId)) perAccount.set(u.accountId, friendListFor(u.accountId, presence, rowCache));
    const payload = perAccount.get(u.accountId);
    const sig = JSON.stringify(payload);
    if (sig !== u.friendsSig) {
      u.friendsSig = sig;
      io.to(u.id).emit('friends', payload);
    }
  }
}

// A tab that can take a friend's call invite right now (connected, not in a call).
function reachableSocket(accountId) {
  let best = null;
  for (const u of users.values()) {
    if (u.accountId !== accountId || u.status === 'in-room') continue;
    if (!best || (u.status === 'searching' && best.status !== 'searching')) best = u;
  }
  return best;
}

// ---------- Requests ----------

function clearRequests(user, notify = true) {
  for (const targetId of user.outgoing) {
    const t = users.get(targetId);
    if (t) {
      t.incoming.delete(user.id);
      if (notify) io.to(t.id).emit('request-cancelled', { from: user.id });
    }
  }
  for (const fromId of user.incoming) {
    const f = users.get(fromId);
    if (f) {
      f.outgoing.delete(user.id);
      if (notify) io.to(f.id).emit('request-declined', { by: user.id, name: user.name, reason: 'unavailable' });
    }
  }
  user.outgoing.clear();
  user.incoming.clear();
}

// ---------- Rooms ----------

function openRoom(a, b) {
  clearRequests(a);
  clearRequests(b);
  const roomId = crypto.randomUUID();
  // The server relays every chat message, so it keeps them while the room lasts; they're only
  // ever stored if someone files a report from this call.
  const chat = [];
  rooms.set(roomId, { id: roomId, members: [a.id, b.id], chat, createdAt: Date.now() });
  for (const [u, peer] of [[a, b], [b, a]]) {
    u.status = 'in-room';
    u.roomId = roomId;
    u.lastPeer = { accountId: peer.accountId, name: peer.name, activity: peer.activity, chat, at: Date.now() };
    io.sockets.sockets.get(u.id)?.join(roomId);
  }
  // The requester (b accepted a's request) creates the WebRTC offer.
  const areFriends = friends.areFriends(a.accountId, b.accountId);
  io.to(a.id).emit('room-start', { roomId, peer: { ...publicUser(b), friend: areFriends }, initiator: true, iceServers: iceServersFor(a.accountId) });
  io.to(b.id).emit('room-start', { roomId, peer: { ...publicUser(a), friend: areFriends }, initiator: false, iceServers: iceServersFor(b.accountId) });
  scheduleRecompute();
}

function leaveRoom(user, reason = 'left') {
  const room = rooms.get(user.roomId);
  if (!room) return;
  rooms.delete(room.id);
  for (const memberId of room.members) {
    const m = users.get(memberId);
    if (!m) continue;
    io.sockets.sockets.get(m.id)?.leave(room.id);
    m.roomId = null;
    m.status = m.activity ? 'searching' : 'idle';
    if (m.id !== user.id) io.to(m.id).emit('peer-left', { reason });
  }
  scheduleRecompute();
}

// ---------- Blocking ----------

// Who a report/block is about: the person from your current or most recent call
// ({ lastPeer: true }), or someone on your match list ({ target: socketId }).
function resolveTarget(u, { target, lastPeer } = {}) {
  if (lastPeer) {
    const p = u.lastPeer;
    if (!p || (!u.roomId && Date.now() - p.at > LAST_PEER_TTL_MS)) return null;
    return { accountId: p.accountId, context: 'call', activity: p.activity, transcript: p.chat };
  }
  const t = users.get(target);
  if (!t || t.accountId === u.accountId) return null;
  return { accountId: t.accountId, context: 'match', activity: t.activity, transcript: null };
}

// Records the block, ends any call between the two accounts and cancels pending requests.
// The blocked person is only told the other person "left" or is "no longer available".
function applyBlock(blockerAccountId, blockedAccountId) {
  safety.block(blockerAccountId, blockedAccountId);
  friends.remove(blockerAccountId, blockedAccountId);
  const mine = [...users.values()].filter((x) => x.accountId === blockerAccountId);
  const theirs = [...users.values()].filter((x) => x.accountId === blockedAccountId);
  for (const x of mine) {
    for (const y of theirs) {
      if (x.roomId && x.roomId === y.roomId) {
        leaveRoom(x, 'left');
        io.to(x.id).emit('room-ended');
      }
      if (x.outgoing.delete(y.id)) {
        y.incoming.delete(x.id);
        io.to(y.id).emit('request-cancelled', { from: x.id });
      }
      if (x.incoming.delete(y.id)) {
        y.outgoing.delete(x.id);
        io.to(x.id).emit('request-cancelled', { from: y.id });
        io.to(y.id).emit('request-declined', { by: x.id, name: x.name, reason: 'unavailable' });
      }
    }
  }
  scheduleRecompute();
}

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  const me = () => users.get(socket.id);
  const account = socket.data.account;
  // Lets logout disconnect every tab signed in with that session.
  socket.join(`session:${socket.data.sessionId}`);
  socket.join(`account:${account.id}`);
  const entry = {
    id: socket.id,
    accountId: account.id,
    activity: '',
    profile: analyze(''),
    status: 'idle',
    roomId: null,
    outgoing: new Set(),
    incoming: new Set(),
    joinedAt: Date.now(),
  };
  applyProfile(entry, account);
  users.set(socket.id, entry);
  // Friends see us come online.
  scheduleRecompute();

  // Called by the client after it changes its profile photo.
  socket.on('refresh-profile', () => {
    const u = me();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.data.account.id);
    if (!u || !row) return;
    // Every tab of this account picks up the new profile.
    for (const x of users.values()) if (x.accountId === u.accountId) applyProfile(x, row);
    scheduleRecompute();
  });

  socket.on('set-activity', (payload = {}, ack) => {
    const u = me();
    if (!u) return ack?.({ error: 'Not joined.' });
    if (u.status === 'in-room') return ack?.({ error: 'Leave the room first.' });
    const activity = clean(payload.activity, 140);
    if (!activity) return ack?.({ error: 'Tell us what you are doing.' });
    u.activity = activity;
    u.profile = analyze(activity);
    u.status = 'searching';
    // Requests were made against the old activity; drop them.
    clearRequests(u);
    ack?.({ ok: true });
    scheduleRecompute();
  });

  socket.on('stop-searching', () => {
    const u = me();
    if (!u || u.status !== 'searching') return;
    u.status = 'idle';
    clearRequests(u);
    scheduleRecompute();
  });

  socket.on('send-request', ({ to } = {}, ack) => {
    const u = me();
    const t = users.get(to);
    if (!u || u.status !== 'searching') return ack?.({ error: 'You are not searching.' });
    if (!t || t.status !== 'searching' || t.accountId === u.accountId || safety.isBlocked(u.accountId, t.accountId)) {
      return ack?.({ error: 'That person is no longer available.' });
    }
    // If they already asked us, treat this as an accept.
    if (u.incoming.has(t.id)) {
      openRoom(t, u);
      return ack?.({ ok: true, matched: true });
    }
    if (u.outgoing.size >= 5) return ack?.({ error: 'You have too many pending requests. Wait for replies or cancel one.' });
    u.outgoing.add(t.id);
    t.incoming.add(u.id);
    io.to(t.id).emit('incoming-request', { from: publicUser(u), score: Math.round(score(u.profile, t.profile) * 100) });
    ack?.({ ok: true });
    scheduleRecompute();
  });

  socket.on('cancel-request', ({ to } = {}) => {
    const u = me();
    const t = users.get(to);
    if (!u || !u.outgoing.has(to)) return;
    u.outgoing.delete(to);
    if (t) {
      t.incoming.delete(u.id);
      io.to(t.id).emit('request-cancelled', { from: u.id });
    }
    scheduleRecompute();
  });

  socket.on('respond-request', ({ from, accept } = {}, ack) => {
    const u = me();
    const f = users.get(from);
    if (!u || !u.incoming.has(from)) return ack?.({ error: 'That request has expired.' });
    u.incoming.delete(from);
    f?.outgoing.delete(u.id);
    // Friends can invite each other from the activity screen too, so "idle" counts as available.
    const isFriend = f && friends.areFriends(u.accountId, f.accountId);
    const available = (x) => x.status === 'searching' || (isFriend && x.status === 'idle');
    if (!f || !available(f) || safety.isBlocked(u.accountId, f.accountId)) {
      scheduleRecompute();
      return ack?.({ error: 'That person is no longer available.' });
    }
    if (accept) {
      if (!available(u)) return ack?.({ error: 'You are not available.' });
      openRoom(f, u);
    } else {
      io.to(f.id).emit('request-declined', { by: u.id, name: u.name, reason: 'declined' });
      scheduleRecompute();
    }
    ack?.({ ok: true });
  });

  // WebRTC signaling + chat, relayed only to the other member of the caller's room.
  const relay = (event) => (data) => {
    const u = me();
    if (!u || !u.roomId) return;
    socket.to(u.roomId).emit(event, data);
  };
  socket.on('signal', relay('signal'));
  socket.on('media-state', relay('media-state'));

  socket.on('chat', ({ text } = {}) => {
    const u = me();
    const msg = clean(text, 1000);
    if (!u || !u.roomId || !msg) return;
    const at = Date.now();
    const room = rooms.get(u.roomId);
    room?.chat.push({ name: u.name, text: msg, at });
    if (room && room.chat.length > MAX_TRANSCRIPT) room.chat.shift();
    io.to(u.roomId).emit('chat', { from: u.id, name: u.name, text: msg, at });
  });

  // ---- Friends ----

  // "Add as friend?" after a call. Only works for the person you were just with.
  socket.on('friend-request', (_payload, ack) => {
    const u = me();
    const p = u?.lastPeer;
    if (!p || (!u.roomId && Date.now() - p.at > LAST_PEER_TTL_MS)) return ack?.({ error: 'That call ended too long ago.' });
    if (safety.isBlocked(u.accountId, p.accountId)) return ack?.({ error: 'That person is no longer available.' });
    const status = friends.request(u.accountId, p.accountId);
    if (status === 'friends') {
      io.to(`account:${p.accountId}`).emit('friend-added', { name: u.name });
    } else {
      io.to(`account:${p.accountId}`).emit('friend-request', { id: u.accountId, name: u.name, avatar: u.avatar });
    }
    scheduleRecompute();
    ack?.({ ok: true, status });
  });

  socket.on('friend-respond', ({ id, accept } = {}, ack) => {
    const u = me();
    const fromId = Number(id);
    if (!u || !friends.incomingRequestIds(u.accountId).includes(fromId)) return ack?.({ error: 'That request is no longer open.' });
    if (accept) {
      friends.request(u.accountId, fromId);
      io.to(`account:${fromId}`).emit('friend-added', { name: u.name });
    } else {
      friends.decline(fromId, u.accountId);
    }
    scheduleRecompute();
    ack?.({ ok: true });
  });

  socket.on('friend-remove', ({ id } = {}, ack) => {
    const u = me();
    if (!u) return;
    friends.remove(u.accountId, Number(id));
    scheduleRecompute();
    ack?.({ ok: true });
  });

  // Call a friend directly, whatever they're doing (unless they're already in a call).
  socket.on('friend-invite', ({ id } = {}, ack) => {
    const u = me();
    const friendId = Number(id);
    if (!u || !friends.areFriends(u.accountId, friendId)) return ack?.({ error: 'You can only invite friends.' });
    if (u.status === 'in-room') return ack?.({ error: 'Leave your current call first.' });
    const t = reachableSocket(friendId);
    if (!t) return ack?.({ error: 'Your friend isn’t available right now.' });
    if (u.incoming.has(t.id)) {
      openRoom(t, u);
      return ack?.({ ok: true, matched: true });
    }
    u.outgoing.add(t.id);
    t.incoming.add(u.id);
    io.to(t.id).emit('incoming-request', { from: publicUser(u), friend: true });
    ack?.({ ok: true });
    scheduleRecompute();
  });

  socket.on('block', (payload = {}, ack) => {
    const u = me();
    const t = u && resolveTarget(u, payload);
    if (!t) return ack?.({ error: 'That person is no longer available to block.' });
    applyBlock(u.accountId, t.accountId);
    ack?.({ ok: true });
  });

  socket.on('report', (payload = {}, ack) => {
    const u = me();
    const t = u && resolveTarget(u, payload);
    if (!t) return ack?.({ error: 'That person is no longer available to report.' });
    const result = safety.createReport({
      reporterId: u.accountId,
      reportedId: t.accountId,
      reason: payload.reason,
      details: payload.details,
      context: t.context,
      activity: t.activity,
      transcript: t.transcript,
    });
    if (result.error) return ack?.({ error: result.error });
    if (payload.block) applyBlock(u.accountId, t.accountId);
    ack?.({ ok: true });
  });

  socket.on('leave-room', () => {
    const u = me();
    if (u?.roomId) leaveRoom(u, 'left');
  });

  socket.on('disconnect', () => {
    const u = me();
    if (!u) return;
    if (u.roomId) leaveRoom(u, 'disconnected');
    clearRequests(u);
    users.delete(socket.id);
    scheduleRecompute();
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Connecto running at http://localhost:${PORT}`));

  // Deploys send SIGTERM: stop accepting work, then close the database cleanly.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    io.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { server, io };
