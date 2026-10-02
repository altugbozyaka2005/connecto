const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, once, call, matchUp } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

// Next event `ev` on `sock` whose payload satisfies `pred`.
function waitFor(sock, ev, pred = () => true) {
  return new Promise((resolve) => {
    const h = (p) => { if (pred(p)) { sock.off(ev, h); resolve(p); } };
    sock.on(ev, h);
  });
}
const groupIn = (matches, roomId) => matches.groups.find((g) => g.id === roomId);

const NAMES = ['Ada', 'Bora', 'Cem', 'Deniz', 'Ece', 'Firat'];
function people(n) {
  return Promise.all(NAMES.slice(0, n).map((firstName) => signedInSocket(base, { firstName })));
}

test('opening a 1:1 call makes you host and lists it as a group in matching', async (t) => {
  const [a, b, seeker] = await people(3);
  t.after(() => [a, b, seeker].forEach((x) => x.sock.close()));
  const [ra] = await matchUp(a.sock, b.sock, 'group test studying organic chemistry');

  // Not visible while closed.
  await call(seeker.sock, 'set-activity', { activity: 'group test studying organic chemistry' });

  assert.ok((await call(b.sock, 'room-settings', { open: true, capacity: 6 })).error, 'capacity capped at 5');
  const listed = waitFor(seeker.sock, 'matches', (m) => groupIn(m, ra.roomId));
  const state = waitFor(a.sock, 'room-state', (r) => r.open);
  assert.deepStrictEqual(await call(b.sock, 'room-settings', { open: true, capacity: 4 }), { ok: true });
  const rs = await state;
  assert.strictEqual(rs.hostId, b.sock.id, 'whoever opens it becomes host');
  assert.strictEqual(rs.isHost, false);
  assert.ok((await call(a.sock, 'room-settings', { capacity: 5 })).error, 'only the host changes settings');

  const g = groupIn(await listed, ra.roomId);
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.capacity, 4);
  assert.strictEqual(g.hostName, b.user.displayName);
  assert.strictEqual(g.activity, 'group test studying organic chemistry');
});

test('ask to join → host lets in → newcomer connects to everyone; full rooms decline the rest', async (t) => {
  const [a, b, c, d] = await people(4);
  t.after(() => [a, b, c, d].forEach((x) => x.sock.close()));
  const [ra] = await matchUp(a.sock, b.sock, 'group test lifting weights at the gym');
  await call(a.sock, 'room-settings', { open: true, capacity: 3 }); // a = host
  for (const x of [c, d]) await call(x.sock, 'set-activity', { activity: 'group test gym workout' });

  // Media ready for the first two.
  a.sock.emit('media-ready');
  b.sock.emit('media-ready');

  const hostSees = waitFor(a.sock, 'join-request');
  assert.deepStrictEqual(await call(c.sock, 'join-request', { roomId: ra.roomId }), { ok: true });
  assert.strictEqual((await hostSees).from.id, c.sock.id);
  await call(d.sock, 'join-request', { roomId: ra.roomId });
  assert.ok((await call(b.sock, 'join-respond', { from: c.sock.id, accept: true })).error, 'only the host lets people in');

  const cStart = once(c.sock, 'room-start');
  const dDeclined = waitFor(d.sock, 'join-declined');
  const bState = waitFor(b.sock, 'room-state', (r) => r.members.length === 3);
  assert.deepStrictEqual(await call(a.sock, 'join-respond', { from: c.sock.id, accept: true }), { ok: true });
  const cs = await cStart;
  assert.strictEqual(cs.members.length, 3);
  assert.ok(cs.iceServers);
  await bState;
  assert.strictEqual((await dDeclined).reason, 'full', 'room filled up → other requests declined');

  // The newcomer offers to both existing members.
  const offers = [];
  const got = new Promise((resolve) => c.sock.on('connect-peer', (p) => { offers.push(p.peerId); if (offers.length === 2) resolve(); }));
  c.sock.emit('media-ready');
  await got;
  assert.deepStrictEqual(offers.sort(), [a.sock.id, b.sock.id].sort());
});

test('decline, host hand-over, removal, and a removed person never sees the room again', async (t) => {
  const [a, b, c, d] = await people(4);
  t.after(() => [a, b, c, d].forEach((x) => x.sock.close()));
  const [ra] = await matchUp(a.sock, b.sock, 'group test painting watercolors');
  await call(a.sock, 'room-settings', { open: true, capacity: 5 });
  await call(c.sock, 'set-activity', { activity: 'group test painting' });
  await call(d.sock, 'set-activity', { activity: 'group test painting' });

  // Decline.
  await call(d.sock, 'join-request', { roomId: ra.roomId });
  const declined = waitFor(d.sock, 'join-declined');
  await call(a.sock, 'join-respond', { from: d.sock.id, accept: false });
  assert.strictEqual((await declined).reason, 'declined');

  // Let c in, then the host leaves: b (longest present) becomes host and the call continues.
  await call(c.sock, 'join-request', { roomId: ra.roomId });
  await call(a.sock, 'join-respond', { from: c.sock.id, accept: true });
  const handover = waitFor(b.sock, 'room-state', (r) => r.members.length === 2);
  a.sock.emit('leave-room');
  const rs = await handover;
  assert.strictEqual(rs.hostId, b.sock.id);
  assert.strictEqual(rs.isHost, true);

  // New host removes c.
  const removed = once(c.sock, 'removed-from-room');
  assert.deepStrictEqual(await call(b.sock, 'remove-member', { id: c.sock.id }), { ok: true });
  await removed;
  const m = waitFor(c.sock, 'matches');
  await call(c.sock, 'set-activity', { activity: 'group test painting' });
  assert.ok(!groupIn(await m, ra.roomId), 'removed person no longer sees that room');
  assert.ok((await call(c.sock, 'join-request', { roomId: ra.roomId })).error);

  // b is alone in an open room: it stays open, waiting.
  assert.ok((await call(d.sock, 'join-request', { roomId: ra.roomId })).ok);
});

test('start a group room from search; it disappears when you leave', async (t) => {
  const [host, seeker] = await people(2);
  t.after(() => [host, seeker].forEach((x) => x.sock.close()));
  assert.ok((await call(host.sock, 'create-room', { capacity: 4 })).error, 'needs an activity first');
  await call(host.sock, 'set-activity', { activity: 'group test learning spanish' });
  const started = once(host.sock, 'room-start');
  assert.deepStrictEqual(await call(host.sock, 'create-room', { capacity: 4 }), { ok: true });
  const rs = await started;
  assert.strictEqual(rs.isHost, true);
  assert.strictEqual(rs.open, true);
  assert.strictEqual(rs.members.length, 1);

  const seen = waitFor(seeker.sock, 'matches', (m) => groupIn(m, rs.roomId));
  await call(seeker.sock, 'set-activity', { activity: 'group test spanish practice' });
  assert.strictEqual(groupIn(await seen, rs.roomId).count, 1);

  const gone = waitFor(seeker.sock, 'matches', (m) => !groupIn(m, rs.roomId));
  host.sock.emit('leave-room');
  await gone;
});

test('blocking someone in a group removes them; a closed 2-person group ends when one leaves', async (t) => {
  const [a, b, c] = await people(3);
  t.after(() => [a, b, c].forEach((x) => x.sock.close()));
  const [ra] = await matchUp(a.sock, b.sock, 'group test board games');
  await call(a.sock, 'room-settings', { open: true, capacity: 3 });
  await call(c.sock, 'set-activity', { activity: 'group test board games' });
  await call(c.sock, 'join-request', { roomId: ra.roomId });
  await call(a.sock, 'join-respond', { from: c.sock.id, accept: true });

  const cOut = once(c.sock, 'removed-from-room');
  await call(b.sock, 'block', { target: c.sock.id });
  await cOut;

  // Close it again; with 2 people left, one leaving ends the call for the other.
  await call(a.sock, 'room-settings', { open: false });
  const ended = once(b.sock, 'room-ended');
  a.sock.emit('leave-room');
  assert.strictEqual((await ended).reason, 'left');
});
