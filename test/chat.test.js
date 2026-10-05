const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, once, call } = require('./helpers');
const db = require('../db');
const friends = require('../friends');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

function waitFor(sock, ev, pred = () => true) {
  return new Promise((resolve) => {
    const h = (p) => { if (pred(p)) { sock.off(ev, h); resolve(p); } };
    sock.on(ev, h);
  });
}
const person = (p, id) => p.connects.people.find((x) => x.person.id === id);

// b asks a (who has a background search) to connect; a accepts.
async function connectPair(a, b) {
  await call(a.sock, 'bg-start', { hours: 3, activity: `chat test ${Math.random()}` });
  await call(b.sock, 'connect-request', { accountId: a.user.id });
  const asked = await waitFor(a.sock, 'inbox', (p) => p.connects.answer.some((r) => r.person.id === b.user.id));
  await call(a.sock, 'connect-respond', { id: asked.connects.answer.find((r) => r.person.id === b.user.id).id, accept: true });
}

test('only connected people can message; messages arrive live, are saved, and get read receipts', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Tara' });
  const b = await signedInSocket(base, { firstName: 'Umut' });
  t.after(() => [a, b].forEach((x) => x.sock.close()));

  assert.ok((await call(b.sock, 'dm-send', { to: a.user.id, body: 'hi' })).error, 'not connected yet');
  assert.ok((await call(b.sock, 'dm-history', { with: a.user.id })).error);

  await connectPair(a, b);
  await waitFor(b.sock, 'inbox', (p) => person(p, a.user.id));
  assert.ok((await call(b.sock, 'dm-send', { to: a.user.id, body: '   ' })).error, 'empty');
  assert.ok((await call(b.sock, 'dm-send', { to: a.user.id, body: 'x'.repeat(2001) })).error, 'too long');

  const arrived = once(a.sock, 'dm');
  const echoed = once(b.sock, 'dm');
  const sent = await call(b.sock, 'dm-send', { to: a.user.id, body: '  Saturday chess? \n\n\n\n\n:)  ' });
  assert.strictEqual(sent.message.body, 'Saturday chess? \n\n\n:)');
  const [msg] = await Promise.all([arrived, echoed]);
  assert.strictEqual(msg.from, b.user.id);
  assert.strictEqual(msg.fromName, b.user.displayName);

  const unread = await waitFor(a.sock, 'inbox', (p) => person(p, b.user.id)?.unread === 1);
  assert.strictEqual(person(unread, b.user.id).last.body, 'Saturday chess? \n\n\n:)');

  const hist = await call(a.sock, 'dm-history', { with: b.user.id });
  assert.deepStrictEqual(hist.messages.map((m) => m.body), ['Saturday chess? \n\n\n:)']);
  assert.strictEqual(hist.more, false);

  const seen = once(b.sock, 'dm-read');
  a.sock.emit('dm-read', { with: b.user.id });
  assert.strictEqual((await seen).by, a.user.id);
  await waitFor(a.sock, 'inbox', (p) => person(p, b.user.id)?.unread === 0);

  // Typing indicator goes to the other side.
  const typing = once(a.sock, 'dm-typing');
  b.sock.emit('dm-typing', { to: a.user.id });
  assert.strictEqual((await typing).from, b.user.id);

  // Connected people can call each other directly and plan a meeting any time.
  const ring = once(a.sock, 'incoming-request');
  assert.deepStrictEqual(await call(b.sock, 'connect-call', { accountId: a.user.id }), { ok: true });
  assert.strictEqual((await ring).connect, true);
  b.sock.emit('cancel-request', { to: a.sock.id });
  assert.deepStrictEqual(await call(b.sock, 'connect-propose', { accountId: a.user.id, slots: [Date.now() + 3 * 3600e3] }), { ok: true });
});

test('history pages, rate limit', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Vera' });
  const b = await signedInSocket(base, { firstName: 'Yusuf' });
  t.after(() => [a, b].forEach((x) => x.sock.close()));
  await connectPair(a, b);
  const now = Date.now();
  const ins = db.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 60; i++) ins.run(a.user.id, b.user.id, `m${i}`, now + i);
  const first = await call(b.sock, 'dm-history', { with: a.user.id });
  assert.strictEqual(first.messages.length, 50);
  assert.strictEqual(first.messages.at(-1).body, 'm59');
  assert.strictEqual(first.more, true);
  const older = await call(b.sock, 'dm-history', { with: a.user.id, before: first.messages[0].id });
  assert.strictEqual(older.messages.length, 10);
  assert.strictEqual(older.more, false);

  let error = null;
  for (let i = 0; i < 16 && !error; i++) error = (await call(a.sock, 'dm-send', { to: b.user.id, body: `burst ${i}` })).error;
  assert.match(error, /too fast/);
});

test('friends can message too; report includes the messages; block cuts it off', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Zara' });
  const b = await signedInSocket(base, { firstName: 'Aras' });
  t.after(() => [a, b].forEach((x) => x.sock.close()));
  friends.request(a.user.id, b.user.id);
  friends.request(b.user.id, a.user.id);
  assert.ok((await call(a.sock, 'dm-send', { to: b.user.id, body: 'hey friend' })).ok);
  await call(b.sock, 'dm-send', { to: a.user.id, body: 'something rude' });

  assert.deepStrictEqual(await call(a.sock, 'report', { accountId: b.user.id, reason: 'harassment', details: 'in DMs' }), { ok: true });
  const r = db.prepare('SELECT * FROM reports WHERE reporter_id = ? AND reported_id = ?').get(a.user.id, b.user.id);
  assert.strictEqual(r.context, 'chat');
  assert.deepStrictEqual(JSON.parse(r.transcript).map((m) => m.text), ['hey friend', 'something rude']);

  assert.deepStrictEqual(await call(a.sock, 'block', { accountId: b.user.id }), { ok: true });
  assert.ok((await call(b.sock, 'dm-send', { to: a.user.id, body: 'hello?' })).error);
  await waitFor(a.sock, 'inbox', (p) => !person(p, b.user.id));
});
