// The matches screen's two sides: requests you sent, and requests sent to you.
const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, once, call } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

function waitFor(sock, ev, pred = () => true) {
  return new Promise((resolve) => {
    const h = (p) => { if (pred(p)) { sock.off(ev, h); resolve(p); } };
    sock.on(ev, h);
  });
}

test('a sent request shows on your left and on their right; cancel and accept update both', async (t) => {
  const a = await signedInSocket(base, { firstName: 'Bora' });
  const b = await signedInSocket(base, { firstName: 'Cem' });
  t.after(() => [a, b].forEach((x) => x.sock.close()));
  const activity = 'split test studying organic chemistry';
  await call(a.sock, 'set-activity', { activity });
  await call(b.sock, 'set-activity', { activity });

  const theirs = waitFor(b.sock, 'matches', (m) => m.incoming.some((x) => x.id === a.sock.id));
  const mine = waitFor(a.sock, 'matches', (m) => m.sent.some((x) => x.id === b.sock.id));
  assert.deepStrictEqual(await call(a.sock, 'send-request', { to: b.sock.id }), { ok: true });
  const [inc, sent] = await Promise.all([theirs, mine]);
  const card = inc.incoming.find((x) => x.id === a.sock.id);
  assert.strictEqual(card.activity, activity);
  assert.ok(card.score >= 90 && card.at <= Date.now());
  assert.strictEqual(sent.sent[0].name, b.user.displayName);
  assert.deepStrictEqual(inc.sent, []);

  // Cancel: gone from both sides.
  const cleared = waitFor(b.sock, 'matches', (m) => !m.incoming.length);
  a.sock.emit('cancel-request', { to: b.sock.id });
  await cleared;

  // Ask again; accepting from the right side starts the call.
  await call(a.sock, 'send-request', { to: b.sock.id });
  await waitFor(b.sock, 'matches', (m) => m.incoming.length === 1);
  const rooms = Promise.all([once(a.sock, 'room-start'), once(b.sock, 'room-start')]);
  assert.deepStrictEqual(await call(b.sock, 'respond-request', { from: a.sock.id, accept: true }), { ok: true });
  await rooms;
});
