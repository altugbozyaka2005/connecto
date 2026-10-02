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
// Group rooms: everyone sends video to everyone (browser-to-browser), which tops out around 5.
const MAX_ROOM_SIZE = 5;
const MAX_GROUP_MATCHES = 8;
const JOIN_REQUEST_TTL_MS = 60 * 1000;
const MAX_PENDING_JOINS = 3;

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
//         roomId, outgoing: Set<id>, incoming: Set<id>, joinRequests: Set<roomId>, joinedAt,
//         lastPeer: { accountId, name, activity, chat, at } }   <- for reporting after a 1:1 call
const users = new Map();
// roomId -> {
//   id, members: [socketId] (join order), hostId (socketId or null until opened),
//   capacity (2..5), open (visible in matching), activity, profile (for matching),
//   chat: [{ name, text, at }], removed: Set<accountId>, joinRequests: Map<socketId, timer>,
//   ready: Set<socketId> (media ready), links: Set<'a|b'> (peer connections set up), createdAt }
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

// Open group rooms with a free seat, ranked by how close their activity is to yours.
function groupsFor(user) {
  const results = [];
  for (const room of rooms.values()) {
    if (!room.open || room.members.length >= room.capacity || room.removed.has(user.accountId)) continue;
    const members = room.members.map((id) => users.get(id)).filter(Boolean);
    if (members.some((m) => m.accountId === user.accountId || safety.isBlocked(user.accountId, m.accountId))) continue;
    let s = score(user.profile, room.profile);
    for (const m of members) s = Math.max(s, score(user.profile, m.profile));
    if (s < MIN_SCORE) continue;
    const host = users.get(room.hostId);
    results.push({
      id: room.id,
      activity: room.activity,
      hostName: host?.name || '',
      members: members.map((m) => ({ name: m.name, avatar: m.avatar, friend: friends.areFriends(user.accountId, m.accountId) })),
      count: members.length,
      capacity: room.capacity,
      score: Math.round(s * 100),
      requested: room.joinRequests.has(user.id),
    });
  }
  results.sort((a, b) => b.score - a.score || b.count - a.count);
  return results.slice(0, MAX_GROUP_MATCHES);
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
      io.to(u.id).emit('matches', { matches: matchesFor(u), groups: groupsFor(u), online: searching });
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

// What one member sees about their room. Join requests are only shown to the host.
function roomView(room, viewer) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    isHost: room.hostId === viewer.id,
    capacity: room.capacity,
    open: room.open,
    activity: room.activity,
    members: room.members.map((id) => users.get(id)).filter(Boolean).map((m) => ({
      ...publicUser(m),
      friend: m.accountId !== viewer.accountId && friends.areFriends(viewer.accountId, m.accountId),
    })),
    requests: room.hostId === viewer.id
      ? [...room.joinRequests.keys()].map((id) => users.get(id)).filter(Boolean).map(publicUser)
      : [],
  };
}

function broadcastRoom(room) {
  for (const id of room.members) {
    const m = users.get(id);
    if (m) io.to(id).emit('room-state', roomView(room, m));
  }
  scheduleRecompute();
}

function newRoom({ capacity = 2, open = false, hostId = null, activity = '' } = {}) {
  const room = {
    id: crypto.randomUUID(),
    members: [],
    hostId,
    capacity,
    open,
    activity,
    profile: analyze(activity),
    // The server relays every chat message, so it keeps them while the room lasts; they're only
    // ever stored if someone files a report from this call.
    chat: [],
    removed: new Set(),
    joinRequests: new Map(),
    ready: new Set(),
    links: new Set(),
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function attach(room, u) {
  clearRequests(u);
  cancelJoinRequests(u);
  room.members.push(u.id);
  u.status = 'in-room';
  u.roomId = room.id;
  io.sockets.sockets.get(u.id)?.join(room.id);
}

function sendRoomStart(room, u) {
  io.to(u.id).emit('room-start', { ...roomView(room, u), iceServers: iceServersFor(u.accountId) });
}

function addMember(room, u) {
  attach(room, u);
  sendRoomStart(room, u);
}

// 1:1 call from a request. The requester joins second so they make the WebRTC offer.
function openRoom(requester, accepter) {
  const room = newRoom();
  for (const [u, peer] of [[accepter, requester], [requester, accepter]]) {
    u.lastPeer = { accountId: peer.accountId, name: peer.name, activity: peer.activity, chat: room.chat, at: Date.now() };
  }
  // Both are in the room before either is told, so each sees the other straight away.
  attach(room, accepter);
  attach(room, requester);
  sendRoomStart(room, accepter);
  sendRoomStart(room, requester);
  scheduleRecompute();
}

// Someone leaves, is removed or disconnects. A closed room with one person left ends;
// an open room keeps going (the last person waits for others to join).
function removeMember(room, u, reason) {
  room.members = room.members.filter((id) => id !== u.id);
  room.ready.delete(u.id);
  for (const link of [...room.links]) if (link.split('|').includes(u.id)) room.links.delete(link);
  io.sockets.sockets.get(u.id)?.leave(room.id);
  u.roomId = null;
  u.status = u.activity ? 'searching' : 'idle';
  // Host passes to whoever has been in the room longest.
  if (room.hostId === u.id) room.hostId = room.members[0] || null;

  if (!room.members.length) return closeRoom(room);
  if (room.members.length === 1 && !room.open) {
    const last = users.get(room.members[0]);
    closeRoom(room);
    if (last) {
      last.roomId = null;
      last.status = last.activity ? 'searching' : 'idle';
      io.sockets.sockets.get(last.id)?.leave(room.id);
      io.to(last.id).emit('room-ended', { reason, name: u.name });
    }
    return scheduleRecompute();
  }
  for (const id of room.members) io.to(id).emit('member-left', { id: u.id, name: u.name, reason });
  broadcastRoom(room);
}

function closeRoom(room) {
  for (const id of [...room.joinRequests.keys()]) declineJoin(room, id, 'closed');
  rooms.delete(room.id);
  scheduleRecompute();
}

// Media is ready on this member's side: connect them to every other ready member.
// The later joiner of each pair makes the offer, so every pair connects exactly once.
function markReady(room, u) {
  room.ready.add(u.id);
  for (const otherId of room.ready) {
    if (otherId === u.id) continue;
    const link = [u.id, otherId].sort().join('|');
    if (room.links.has(link)) continue;
    room.links.add(link);
    const offerer = room.members.indexOf(u.id) > room.members.indexOf(otherId) ? u.id : otherId;
    const answerer = offerer === u.id ? otherId : u.id;
    io.to(offerer).emit('connect-peer', { peerId: answerer });
  }
}

// ---------- Join requests (group rooms) ----------

function declineJoin(room, requesterId, reason) {
  const timer = room.joinRequests.get(requesterId);
  if (timer === undefined) return;
  clearTimeout(timer);
  room.joinRequests.delete(requesterId);
  const r = users.get(requesterId);
  r?.joinRequests.delete(room.id);
  io.to(requesterId).emit('join-declined', { roomId: room.id, activity: room.activity, reason });
}

// Withdraw all of this user's pending join requests (they joined something else or left).
function cancelJoinRequests(u) {
  for (const roomId of u.joinRequests) {
    const room = rooms.get(roomId);
    if (!room) continue;
    clearTimeout(room.joinRequests.get(u.id));
    room.joinRequests.delete(u.id);
    if (room.hostId) io.to(room.hostId).emit('join-request-cancelled', { from: u.id });
    broadcastRoom(room);
  }
  u.joinRequests.clear();
}

// Seats filled or the room was closed: nobody else can get in.
function settleRequests(room) {
  const reason = !room.open ? 'closed' : room.members.length >= room.capacity ? 'full' : null;
  if (reason) for (const id of [...room.joinRequests.keys()]) declineJoin(room, id, reason);
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
  if (t.roomId && t.roomId === u.roomId) {
    return { accountId: t.accountId, context: 'call', activity: t.activity, transcript: rooms.get(u.roomId)?.chat };
  }
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
      const room = x.roomId && x.roomId === y.roomId ? rooms.get(x.roomId) : null;
      if (room && room.members.length > 2) {
        // In a group, the blocked person is removed (without being told who did it).
        room.removed.add(y.accountId);
        removeMember(room, y, 'removed');
        io.to(y.id).emit('removed-from-room');
      } else if (room) {
        removeMember(room, x, 'left');
        io.to(x.id).emit('room-ended', { reason: 'self' });
      }
      // Pending join requests between them go too.
      for (const r of rooms.values()) {
        if (r.members.includes(x.id) && r.joinRequests.has(y.id)) declineJoin(r, y.id, 'declined');
        if (r.members.includes(y.id) && r.joinRequests.has(x.id)) declineJoin(r, x.id, 'declined');
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
    joinRequests: new Set(),
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
    cancelJoinRequests(u);
    ack?.({ ok: true });
    scheduleRecompute();
  });

  socket.on('stop-searching', () => {
    const u = me();
    if (!u || u.status !== 'searching') return;
    u.status = 'idle';
    clearRequests(u);
    cancelJoinRequests(u);
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

  // ---- Calls: WebRTC signaling between members of the same room ----

  socket.on('media-ready', () => {
    const u = me();
    const room = u && rooms.get(u.roomId);
    if (room) markReady(room, u);
  });

  // Offers/answers/candidates go to one specific member of your room.
  socket.on('signal', ({ to, ...data } = {}) => {
    const u = me();
    const t = users.get(to);
    if (!u || !u.roomId || !t || t.roomId !== u.roomId) return;
    io.to(to).emit('signal', { ...data, from: u.id });
  });

  socket.on('media-state', (data = {}) => {
    const u = me();
    if (!u || !u.roomId) return;
    socket.to(u.roomId).emit('media-state', { video: !!data.video, audio: !!data.audio, from: u.id });
  });

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
  // "Add as friend?" for someone in your current call ({ target }) or your last 1:1 call.
  socket.on('friend-request', (payload, ack) => {
    const u = me();
    if (!u) return;
    let p = null;
    if (payload?.target) {
      const t = users.get(payload.target);
      if (t && t.roomId && t.roomId === u.roomId) p = { accountId: t.accountId };
    } else if (u.lastPeer && (u.roomId || Date.now() - u.lastPeer.at <= LAST_PEER_TTL_MS)) {
      p = u.lastPeer;
    }
    if (!p) return ack?.({ error: 'That call ended too long ago.' });
    if (p.accountId === u.accountId || safety.isBlocked(u.accountId, p.accountId)) return ack?.({ error: 'That person is no longer available.' });
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

  // ---- Group rooms ----

  // Start a group room from search; you're the host and it's open right away.
  socket.on('create-room', ({ capacity } = {}, ack) => {
    const u = me();
    if (!u || u.status !== 'searching') return ack?.({ error: 'Tell us what you’re doing first.' });
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 2 || cap > MAX_ROOM_SIZE) return ack?.({ error: `Choose a size from 2 to ${MAX_ROOM_SIZE}.` });
    const room = newRoom({ capacity: cap, open: true, hostId: u.id, activity: u.activity });
    addMember(room, u);
    broadcastRoom(room);
    ack?.({ ok: true });
  });

  // Host (or, in a 1:1 call nobody has opened yet, either person) changes who can join.
  socket.on('room-settings', ({ open, capacity } = {}, ack) => {
    const u = me();
    const room = u && rooms.get(u.roomId);
    if (!room) return ack?.({ error: 'You’re not in a call.' });
    if (room.hostId && room.hostId !== u.id) return ack?.({ error: 'Only the host can change this.' });
    const cap = capacity === undefined ? room.capacity : Number(capacity);
    if (!Number.isInteger(cap) || cap < 2 || cap > MAX_ROOM_SIZE) return ack?.({ error: `Choose a size from 2 to ${MAX_ROOM_SIZE}.` });
    if (cap < room.members.length) return ack?.({ error: `There are already ${room.members.length} people here.` });
    const wasOpen = room.open;
    if (!room.hostId) room.hostId = u.id; // first to open the call becomes host
    room.capacity = cap;
    if (typeof open === 'boolean') room.open = open;
    if (room.open && !wasOpen) {
      // The room is matched on the host's activity (or anyone's, if the host has none).
      room.activity = u.activity || room.members.map((id) => users.get(id)?.activity).find(Boolean) || 'Hanging out';
      room.profile = analyze(room.activity);
      for (const id of room.members) io.to(id).emit('room-notice', { text: `${u.name} opened the call to others (up to ${cap} people).` });
    } else if (!room.open && wasOpen) {
      for (const id of room.members) io.to(id).emit('room-notice', { text: `${u.name} closed the call to new people.` });
    }
    settleRequests(room);
    broadcastRoom(room);
    ack?.({ ok: true });
  });

  socket.on('join-request', ({ roomId } = {}, ack) => {
    const u = me();
    const room = rooms.get(roomId);
    if (!u || u.status !== 'searching') return ack?.({ error: 'Tell us what you’re doing first.' });
    if (!room || !room.open || room.removed.has(u.accountId)) return ack?.({ error: 'That group isn’t taking new people.' });
    if (room.members.length >= room.capacity) return ack?.({ error: 'That group is full.' });
    const members = room.members.map((id) => users.get(id)).filter(Boolean);
    if (members.some((m) => m.accountId === u.accountId || safety.isBlocked(u.accountId, m.accountId))) {
      return ack?.({ error: 'That group isn’t taking new people.' });
    }
    if (room.joinRequests.has(u.id)) return ack?.({ ok: true });
    if (u.joinRequests.size >= MAX_PENDING_JOINS) return ack?.({ error: 'Wait for your other requests to be answered first.' });
    room.joinRequests.set(u.id, setTimeout(() => { declineJoin(room, u.id, 'timeout'); broadcastRoom(room); }, JOIN_REQUEST_TTL_MS));
    u.joinRequests.add(room.id);
    const host = users.get(room.hostId);
    if (host) io.to(host.id).emit('join-request', { from: publicUser(u), score: Math.round(score(host.profile, u.profile) * 100) });
    broadcastRoom(room);
    ack?.({ ok: true });
  });

  socket.on('cancel-join', ({ roomId } = {}) => {
    const u = me();
    const room = rooms.get(roomId);
    if (!u || !room || !room.joinRequests.has(u.id)) return;
    clearTimeout(room.joinRequests.get(u.id));
    room.joinRequests.delete(u.id);
    u.joinRequests.delete(room.id);
    if (room.hostId) io.to(room.hostId).emit('join-request-cancelled', { from: u.id });
    broadcastRoom(room);
  });

  socket.on('join-respond', ({ from, accept } = {}, ack) => {
    const u = me();
    const room = u && rooms.get(u.roomId);
    if (!room || room.hostId !== u.id) return ack?.({ error: 'Only the host can let people in.' });
    if (!room.joinRequests.has(from)) return ack?.({ error: 'That request has expired.' });
    const r = users.get(from);
    if (!accept) {
      declineJoin(room, from, 'declined');
      broadcastRoom(room);
      return ack?.({ ok: true });
    }
    if (room.members.length >= room.capacity) return ack?.({ error: 'The call is full. Make room for more people first.' });
    if (!r || r.status !== 'searching') {
      declineJoin(room, from, 'closed');
      broadcastRoom(room);
      return ack?.({ error: 'They’re no longer available.' });
    }
    clearTimeout(room.joinRequests.get(from));
    room.joinRequests.delete(from);
    r.joinRequests.delete(room.id);
    addMember(room, r);
    for (const id of room.members) io.to(id).emit('room-notice', { text: `${r.name} joined.` });
    settleRequests(room);
    broadcastRoom(room);
    ack?.({ ok: true });
  });

  socket.on('remove-member', ({ id } = {}, ack) => {
    const u = me();
    const room = u && rooms.get(u.roomId);
    const t = users.get(id);
    if (!room || room.hostId !== u.id) return ack?.({ error: 'Only the host can remove people.' });
    if (!t || t.roomId !== room.id || t.id === u.id) return ack?.({ error: 'They’re not in this call.' });
    room.removed.add(t.accountId); // and they won't see this room in matching again
    removeMember(room, t, 'removed');
    io.to(t.id).emit('removed-from-room');
    ack?.({ ok: true });
  });

  socket.on('leave-room', () => {
    const u = me();
    const room = u && rooms.get(u.roomId);
    if (room) removeMember(room, u, 'left');
  });

  socket.on('disconnect', () => {
    const u = me();
    if (!u) return;
    const room = rooms.get(u.roomId);
    if (room) removeMember(room, u, 'disconnected');
    cancelJoinRequests(u);
    for (const r of rooms.values()) if (r.joinRequests.has(u.id)) declineJoin(r, u.id, 'closed');
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
