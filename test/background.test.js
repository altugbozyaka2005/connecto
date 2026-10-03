const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, lastEmail, once, call, matchUp, Client } = require('./helpers');
const { outbox } = require('../mail');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

function waitFor(sock, ev, pred = () => true) {
  return new Promise((resolve) => {
    const h = (p) => { if (pred(p)) { sock.off(ev, h); resolve(p); } };
    sock.on(ev, h);
  });
}
const reconnect = async (cookie) => {
  const s = Client(base, { forceNew: true, extraHeaders: { cookie } });
  await once(s, 'connect');
  return s;
};

test('background search: away card, request while offline, email, inbox, accept, call', async (t) => {
  const away = await signedInSocket(base, { firstName: 'Aylin' });
  const live = await signedInSocket(base, { firstName: 'Baris' });
  const other = await signedInSocket(base, { firstName: 'Can' });
  const opened = [away.sock, live.sock, other.sock];
  t.after(() => opened.forEach((s) => s.close()));

  assert.ok((await call(away.sock, 'bg-start', { hours: 24 })).error, 'needs an activity');
  await call(away.sock, 'set-activity', { activity: 'bg test learning the violin' });
  assert.ok((await call(away.sock, 'bg-start', { hours: 5 })).error, 'only offered durations');
  const started = await call(away.sock, 'bg-start', { hours: 24, notify: true });
  assert.ok(started.ok && started.expiresAt > Date.now() + 23 * 3600e3);

  // While Aylin searches live, she's a normal match, not "away".
  const liveView = waitFor(live.sock, 'matches');
  await call(live.sock, 'set-activity', { activity: 'bg test practicing violin' });
  const lv = await liveView;
  assert.ok(lv.matches.some((m) => m.id === away.sock.id));
  assert.ok(!lv.away.some((m) => m.accountId === away.user.id));

  // She closes the tab: now she's an "away" match, ranked with a penalty.
  const awayView = waitFor(live.sock, 'matches', (m) => m.away.some((x) => x.accountId === away.user.id));
  away.sock.close();
  const card = (await awayView).away.find((x) => x.accountId === away.user.id);
  assert.strictEqual(card.away, true);
  assert.strictEqual(card.activity, 'bg test learning the violin');
  assert.ok(card.score < 100);

  // Baris sends a request; Aylin is offline so she gets one email (throttled after that).
  assert.deepStrictEqual(await call(live.sock, 'connect-request', { accountId: away.user.id }), { ok: true, status: 'pending' });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(lastEmail(away.user.email).subject, /wants to connect/);
  const sentTo = () => outbox.filter((m) => m.to === away.user.email).length;
  const before = sentTo();
  await call(other.sock, 'set-activity', { activity: 'bg test violin lessons' });
  await call(other.sock, 'connect-request', { accountId: away.user.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(sentTo(), before, 'no second email within the throttle window');

  // Requests only go to people with a background search.
  assert.ok((await call(live.sock, 'connect-request', { accountId: other.user.id })).error);

  // Aylin comes back: her inbox lists both requests.
  const back = await reconnect(away.cookie);
  opened.push(back);
  const inbox = await waitFor(back, 'inbox', (p) => p.incoming.length === 2);
  assert.strictEqual(inbox.background.activity, 'bg test learning the violin');
  const fromBaris = inbox.incoming.find((r) => r.person.id === live.user.id);
  assert.strictEqual(fromBaris.activity, 'bg test practicing violin');

  // She accepts; Baris is online, so he's told right away and can call her even though she's idle.
  const accepted = once(live.sock, 'connect-accepted');
  await call(back, 'connect-respond', { id: fromBaris.id, accept: true });
  assert.strictEqual((await accepted).accountId, away.user.id);
  const ready = await waitFor(live.sock, 'inbox', (p) => p.ready.some((r) => r.person.id === away.user.id && r.available));
  assert.ok(ready);

  const ring = once(back, 'incoming-request');
  assert.deepStrictEqual(await call(live.sock, 'connect-call', { accountId: away.user.id }), { ok: true });
  assert.strictEqual((await ring).connect, true);
  const rooms = Promise.all([once(back, 'room-start'), once(live.sock, 'room-start')]);
  assert.deepStrictEqual(await call(back, 'respond-request', { from: live.sock.id, accept: true }), { ok: true });
  await rooms;

  // After the call starts, that request is done and leaves both inboxes.
  await waitFor(live.sock, 'inbox', (p) => !p.ready.length);
  assert.ok((await call(live.sock, 'connect-call', { accountId: away.user.id })).error, 'no longer "connected" once they talked');
});

test('two background searches find each other', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Defne' });
  const b = await signedInSocket(base, { firstName: 'Emre' });
  t.after(() => { a.sock.close(); b.sock.close(); });
  await call(a.sock, 'set-activity', { activity: 'bg pair test sourdough baking' });
  await call(a.sock, 'bg-start', { hours: 3 });
  await call(b.sock, 'set-activity', { activity: 'bg pair test baking sourdough bread' });
  const seen = waitFor(b.sock, 'inbox', (p) => p.matches.some((m) => m.person.id === a.user.id));
  await call(b.sock, 'bg-start', { hours: 3 });
  const m = (await seen).matches.find((x) => x.person.id === a.user.id);
  assert.strictEqual(m.activity, 'bg pair test sourdough baking');
  // Asking each other = both want it.
  assert.strictEqual((await call(b.sock, 'connect-request', { accountId: a.user.id })).status, 'pending');
  assert.strictEqual((await call(a.sock, 'connect-request', { accountId: b.user.id })).status, 'accepted');
  await call(a.sock, 'bg-stop');
  await waitFor(a.sock, 'inbox', (p) => p.background === null);
});

// Two people become friends through a call.
async function befriend(x, y) {
  await matchUp(x.sock, y.sock, `friend setup ${Math.random()}`);
  await call(x.sock, 'friend-request');
  await call(y.sock, 'friend-request');
  const ended = once(y.sock, 'room-ended');
  x.sock.emit('leave-room');
  await ended;
}

test('inviting a friend into a call: host invites join directly (and make space), members need the host', async (t) => {
  const host = await signedInSocket(base, { firstName: 'Gul' });
  const guest = await signedInSocket(base, { firstName: 'Hakan' });
  const pal = await signedInSocket(base, { firstName: 'Ilke' });
  const pal2 = await signedInSocket(base, { firstName: 'Jale' });
  t.after(() => [host, guest, pal, pal2].forEach((x) => x.sock.close()));
  await befriend(host, pal);
  await befriend(guest, pal2);

  const [room] = await matchUp(host.sock, guest.sock, 'invite test studying law');
  // Nobody is host yet; host's invite lets the friend in directly and grows the 2-seat call.
  const invite = once(pal.sock, 'room-invite');
  assert.deepStrictEqual(await call(host.sock, 'friend-invite', { id: pal.user.id }), { ok: true, needsApproval: false });
  const inv = await invite;
  assert.strictEqual(inv.roomId, room.roomId);
  assert.strictEqual(inv.needsApproval, false);
  const joined = once(pal.sock, 'room-start');
  assert.deepStrictEqual(await call(pal.sock, 'room-invite-respond', { roomId: room.roomId, accept: true }), { ok: true, joined: true });
  const rs = await joined;
  assert.strictEqual(rs.members.length, 3);
  assert.strictEqual(rs.capacity, 3);
  assert.strictEqual(rs.hostId, host.sock.id, 'inviting into a hostless call makes you host');

  // A non-host member's friend needs the host's approval.
  const inv2 = once(pal2.sock, 'room-invite');
  assert.strictEqual((await call(guest.sock, 'friend-invite', { id: pal2.user.id })).needsApproval, true);
  await inv2;
  const hostAsked = once(host.sock, 'join-request');
  assert.deepStrictEqual(await call(pal2.sock, 'room-invite-respond', { roomId: room.roomId, accept: true }), { ok: true, pending: true });
  const req = await hostAsked;
  assert.strictEqual(req.invitedBy, guest.user.displayName);
  await call(host.sock, 'room-settings', { capacity: 4 });
  const in2 = once(pal2.sock, 'room-start');
  await call(host.sock, 'join-respond', { from: pal2.sock.id, accept: true });
  assert.strictEqual((await in2).members.length, 4);
});

test('a background search can be worded differently from the live search', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Kerem' });
  t.after(() => a.sock.close());
  assert.ok((await call(a.sock, 'bg-start', { hours: 3, activity: '   ' })).error, 'needs some wording');
  await call(a.sock, 'set-activity', { activity: 'bg wording test cooking' });
  const res = await call(a.sock, 'bg-start', { hours: 3, activity: 'Chess partner this weekend' });
  assert.strictEqual(res.activity, 'Chess partner this weekend');
  const inbox = await waitFor(a.sock, 'inbox', (p) => p.background);
  assert.strictEqual(inbox.background.activity, 'Chess partner this weekend');
});
