const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { analyze, score } = require('./matcher');
const db = require('./db');
const { createAuthRouter, socketAuth, displayName } = require('./auth');
const { iceServersFor } = require('./turn');

const PORT = process.env.PORT || 3000;
const MAX_MATCHES = 12;
const MIN_SCORE = 0.15;

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
app.get('/health', (_req, res) => res.json({ ok: true, online: users.size }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
io.use(socketAuth);

// socket.id -> user (one entry per open tab)
// user: { id, accountId, name, avatar, activity, profile, status: 'idle'|'searching'|'in-room',
//         roomId, outgoing: Set<id>, incoming: Set<id>, joinedAt }
const users = new Map();
// roomId -> { id, members: [id, id], activity, createdAt }
const rooms = new Map();

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function publicUser(u) {
  return { id: u.id, name: u.name, avatar: u.avatar, activity: u.activity };
}

// ---------- Matching ----------

function matchesFor(user) {
  const results = [];
  for (const other of users.values()) {
    // Skip yourself, including your own other tabs.
    if (other.accountId === user.accountId || other.status !== 'searching') continue;
    const s = score(user.profile, other.profile);
    if (s >= MIN_SCORE) {
      results.push({
        ...publicUser(other),
        score: Math.round(s * 100),
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
  }, 120);
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
  rooms.set(roomId, { id: roomId, members: [a.id, b.id], createdAt: Date.now() });
  for (const u of [a, b]) {
    u.status = 'in-room';
    u.roomId = roomId;
    io.sockets.sockets.get(u.id)?.join(roomId);
  }
  // The requester (b accepted a's request) creates the WebRTC offer.
  io.to(a.id).emit('room-start', { roomId, peer: publicUser(b), initiator: true, iceServers: iceServersFor(a.accountId) });
  io.to(b.id).emit('room-start', { roomId, peer: publicUser(a), initiator: false, iceServers: iceServersFor(b.accountId) });
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

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  const me = () => users.get(socket.id);
  const account = socket.data.account;
  // Lets logout disconnect every tab signed in with that session.
  socket.join(`session:${socket.data.sessionId}`);
  socket.join(`account:${account.id}`);
  users.set(socket.id, {
    id: socket.id,
    accountId: account.id,
    name: displayName(account),
    avatar: account.avatar,
    activity: '',
    profile: analyze(''),
    status: 'idle',
    roomId: null,
    outgoing: new Set(),
    incoming: new Set(),
    joinedAt: Date.now(),
  });

  // Called by the client after it changes its profile photo.
  socket.on('refresh-profile', () => {
    const u = me();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.data.account.id);
    if (!u || !row) return;
    u.name = displayName(row);
    u.avatar = row.avatar;
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
    if (!t || t.status !== 'searching' || t.accountId === u.accountId) return ack?.({ error: 'That person is no longer available.' });
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
    if (!f || f.status !== 'searching') {
      scheduleRecompute();
      return ack?.({ error: 'That person is no longer available.' });
    }
    if (accept) {
      if (u.status !== 'searching') return ack?.({ error: 'You are not available.' });
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
    io.to(u.roomId).emit('chat', { from: u.id, name: u.name, text: msg, at: Date.now() });
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
