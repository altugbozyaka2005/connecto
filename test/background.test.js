const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, lastEmail, once, call, matchUp, Client } = require('./helpers');
const db = require('../db');
const { sendMeetingReminders } = require('../server');
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
  const inbox = await waitFor(back, 'inbox', (p) => p.connects.answer.length === 2);
  assert.strictEqual(inbox.searches[0].activity, 'bg test learning the violin');
  assert.ok(inbox.lastSeen, 'last visit recorded when her tab closed');
  assert.ok(inbox.connects.answer.every((r) => r.new && r.kind === 'request'), 'requests made while she was away are flagged new');
  const fromBaris = inbox.connects.answer.find((r) => r.person.id === live.user.id);
  assert.strictEqual(fromBaris.activity, 'bg test practicing violin');

  // She accepts; Baris is online, so he's told right away and can call her even though she's idle.
  const accepted = once(live.sock, 'connect-accepted');
  await call(back, 'connect-respond', { id: fromBaris.id, accept: true });
  assert.strictEqual((await accepted).accountId, away.user.id);
  const ready = await waitFor(live.sock, 'inbox', (p) => p.connects.ready.some((r) => r.person.id === away.user.id && r.available));
  assert.ok(ready);

  const ring = once(back, 'incoming-request');
  assert.deepStrictEqual(await call(live.sock, 'connect-call', { accountId: away.user.id }), { ok: true });
  assert.strictEqual((await ring).connect, true);
  const rooms = Promise.all([once(back, 'room-start'), once(live.sock, 'room-start')]);
  assert.deepStrictEqual(await call(back, 'respond-request', { from: live.sock.id, accept: true }), { ok: true });
  await rooms;

  // After the call starts, that request is done: it leaves "ready" and shows as history.
  const after = await waitFor(live.sock, 'inbox', (p) => !p.connects.ready.length);
  assert.strictEqual(after.connects.recent[0].person.id, away.user.id);
  assert.ok((await call(live.sock, 'connect-call', { accountId: away.user.id })).error, 'no longer "connected" once they talked');
  // From "Talked recently": add as friend, or ask to talk again.
  assert.strictEqual((await call(live.sock, 'friend-request', { accountId: away.user.id })).status, 'pending');
  assert.ok((await call(live.sock, 'friend-request', { accountId: other.user.id })).error, 'only people you talked to');
  assert.strictEqual((await call(live.sock, 'connect-request', { accountId: away.user.id })).status, 'pending');
  const again = await waitFor(live.sock, 'inbox', (p) => p.connects.waiting.some((r) => r.person.id === away.user.id));
  assert.ok(!again.connects.recent.some((r) => r.person.id === away.user.id), 'each person sits in one group');
});

test('two background searches find each other', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Defne' });
  const b = await signedInSocket(base, { firstName: 'Emre' });
  t.after(() => { a.sock.close(); b.sock.close(); });
  await call(a.sock, 'set-activity', { activity: 'bg pair test sourdough baking' });
  await call(a.sock, 'bg-start', { hours: 3 });
  await call(b.sock, 'set-activity', { activity: 'bg pair test baking sourdough bread' });
  const found = (p) => p.searches[0]?.matches.find((m) => m.person.id === a.user.id);
  const seen = waitFor(b.sock, 'inbox', found);
  await call(b.sock, 'bg-start', { hours: 3 });
  const m = found(await seen);
  assert.strictEqual(m.activity, 'bg pair test sourdough baking');
  assert.strictEqual(m.request, null);
  // Asking each other = both want it; the match stays listed with its request state.
  assert.strictEqual((await call(b.sock, 'connect-request', { accountId: a.user.id })).status, 'pending');
  await waitFor(b.sock, 'inbox', (p) => found(p)?.request === 'sent');
  assert.strictEqual((await call(a.sock, 'connect-request', { accountId: b.user.id })).status, 'accepted');
  await waitFor(b.sock, 'inbox', (p) => found(p)?.request === 'ready');
  await call(a.sock, 'bg-stop');
  await waitFor(a.sock, 'inbox', (p) => !p.searches.length);
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
  const inbox = await waitFor(a.sock, 'inbox', (p) => p.searches.length);
  assert.strictEqual(inbox.searches[0].activity, 'Chess partner this weekend');
});

test('a background search keeps working while you search live for something else', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Lale' });
  const b = await signedInSocket(base, { firstName: 'Mete' });
  t.after(() => { a.sock.close(); b.sock.close(); });
  await call(a.sock, 'set-activity', { activity: 'concurrent test chess openings' });
  await call(a.sock, 'bg-start', { hours: 3 });
  // Now Lale searches live for something different; her chess search stays visible to Mete.
  await call(a.sock, 'set-activity', { activity: 'concurrent test reading novels' });
  const view = waitFor(b.sock, 'matches', (m) => m.away.some((x) => x.accountId === a.user.id));
  await call(b.sock, 'set-activity', { activity: 'concurrent test chess openings' });
  const card = (await view).away.find((x) => x.accountId === a.user.id);
  assert.strictEqual(card.activity, 'concurrent test chess openings');
  // She's online, so a request reaches her immediately.
  const pinged = once(a.sock, 'connect-request');
  await call(b.sock, 'connect-request', { accountId: a.user.id });
  assert.strictEqual((await pinged).from.id, b.sock.id);
  // If her live search becomes the same thing, only the live card is shown.
  const merged = waitFor(b.sock, 'matches', (m) => m.matches.some((x) => x.id === a.sock.id) && !m.away.some((x) => x.accountId === a.user.id));
  await call(a.sock, 'set-activity', { activity: 'concurrent test chess openings' });
  await merged;
});

test('several background searches at once, each with its own matches; edit and stop one', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Nil' });
  const b = await signedInSocket(base, { firstName: 'Oya' });
  const c = await signedInSocket(base, { firstName: 'Pelin' });
  t.after(() => [a, b, c].forEach((x) => x.sock.close()));
  const chess = await call(a.sock, 'bg-start', { hours: 24, activity: 'playing chess openings' });
  const guitar = await call(a.sock, 'bg-start', { hours: 3, activity: 'practicing guitar chords' });
  assert.notStrictEqual(chess.id, guitar.id);
  // Starting the same wording again extends it instead of adding a duplicate.
  assert.strictEqual((await call(a.sock, 'bg-start', { hours: 72, activity: 'playing chess openings' })).id, chess.id);
  await call(a.sock, 'bg-start', { hours: 3, activity: 'multi test third thing' });
  assert.ok((await call(a.sock, 'bg-start', { hours: 3, activity: 'multi test fourth thing' })).error, 'at most 3');

  await call(b.sock, 'bg-start', { hours: 3, activity: 'chess openings blitz games' });
  await call(c.sock, 'bg-start', { hours: 3, activity: 'strumming guitar chords' });
  const of = (p, id) => p.searches.find((s) => s.id === id);
  const inbox = await waitFor(a.sock, 'inbox', (p) => of(p, chess.id)?.matches.length && of(p, guitar.id)?.matches.length);
  assert.strictEqual(inbox.searches.length, 3);
  const ids = (id) => of(inbox, id).matches.map((m) => m.person.id);
  assert.ok(ids(chess.id).includes(b.user.id) && !ids(chess.id).includes(c.user.id));
  assert.ok(ids(guitar.id).includes(c.user.id) && !ids(guitar.id).includes(b.user.id));

  // A request sent from the guitar search carries its wording.
  const asked = once(c.sock, 'connect-request');
  await call(a.sock, 'connect-request', { accountId: c.user.id, searchId: guitar.id });
  assert.strictEqual((await asked).activity, 'practicing guitar chords');

  // Someone live sees Nil once, with the closest of her searches.
  const view = waitFor(b.sock, 'matches', (m) => m.away.some((x) => x.accountId === a.user.id));
  await call(b.sock, 'set-activity', { activity: 'chess openings' });
  const cards = (await view).away.filter((x) => x.accountId === a.user.id);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].activity, 'playing chess openings');

  // Edit one, then stop one: the others keep running.
  await call(a.sock, 'bg-start', { id: guitar.id, hours: 12, activity: 'bass guitar lessons' });
  await waitFor(a.sock, 'inbox', (p) => of(p, guitar.id)?.activity === 'bass guitar lessons');
  await call(a.sock, 'bg-stop', { id: chess.id });
  const left = await waitFor(a.sock, 'inbox', (p) => !of(p, chess.id));
  assert.strictEqual(left.searches.length, 2);
});

test('scheduling a meeting: propose times, pick one, reminder, cancel', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Rana' });
  const b = await signedInSocket(base, { firstName: 'Sena' });
  t.after(() => [a, b].forEach((x) => x.sock.close()));
  await call(a.sock, 'bg-start', { hours: 24, activity: 'schedule test pottery wheel' });
  await call(b.sock, 'connect-request', { accountId: a.user.id });
  const asked = await waitFor(a.sock, 'inbox', (p) => p.connects.answer.length);
  await call(a.sock, 'connect-respond', { id: asked.connects.answer[0].id, accept: true });
  const ready = await waitFor(a.sock, 'inbox', (p) => p.connects.ready.length);
  const id = ready.connects.ready[0].id;

  const hour = 60 * 60 * 1000;
  const slots = [Date.now() + 3 * hour, Date.now() + 26 * hour];
  assert.ok((await call(a.sock, 'connect-propose', { id, slots: [Date.now() - hour] })).error, 'no times in the past');
  assert.ok((await call(a.sock, 'connect-propose', { id, slots: [1, 2, 3, 4].map((i) => Date.now() + i * hour) })).error, 'at most 3');
  const told = once(b.sock, 'connect-update');
  assert.deepStrictEqual(await call(a.sock, 'connect-propose', { id, slots }), { ok: true });
  assert.strictEqual((await told).kind, 'proposed');
  const mine = await waitFor(a.sock, 'inbox', (p) => p.connects.waiting.some((x) => x.kind === 'times'));
  assert.deepStrictEqual(mine.connects.waiting[0].proposal, { mine: true, slots });
  const theirs = await waitFor(b.sock, 'inbox', (p) => p.connects.answer.some((x) => x.kind === 'times'));
  assert.ok(!theirs.connects.ready.length, 'one group per person');

  assert.ok((await call(a.sock, 'connect-pick', { id, slot: slots[0] })).error, 'you can’t pick your own proposal');
  assert.ok((await call(b.sock, 'connect-pick', { id, slot: slots[0] + 1 })).error, 'only a proposed time');
  const set = once(a.sock, 'connect-update');
  assert.strictEqual((await call(b.sock, 'connect-pick', { id, slot: slots[1] })).meetingAt, slots[1]);
  assert.strictEqual((await set).kind, 'scheduled');
  const both = await Promise.all([a, b].map((x) => waitFor(x.sock, 'inbox', (p) => p.connects.scheduled.length)));
  for (const p of both) assert.strictEqual(p.connects.scheduled[0].meetingAt, slots[1]);

  // Starting soon: both get a reminder once.
  db.prepare('UPDATE connect_requests SET meeting_at = ? WHERE id = ?').run(Date.now() + 60 * 1000, id);
  const reminded = Promise.all([once(a.sock, 'meeting-soon'), once(b.sock, 'meeting-soon')]);
  sendMeetingReminders();
  const [ra] = await reminded;
  assert.strictEqual(ra.accountId, b.user.id);
  assert.strictEqual(db.prepare('SELECT reminded_at FROM connect_requests WHERE id = ?').get(id).reminded_at > 0, true);

  // Cancel: back to "ready to talk".
  await call(a.sock, 'connect-unschedule', { id });
  await waitFor(b.sock, 'inbox', (p) => p.connects.ready.length && !p.connects.scheduled.length);
});
