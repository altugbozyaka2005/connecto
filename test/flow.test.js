const test = require('node:test');
const assert = require('node:assert');
const { start, stop, signedInSocket, once, call, Client } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

test('match → request → accept → room → chat → leave', async (t) => {
  const { sock: alice } = await signedInSocket(base, { firstName: 'Alice', lastName: 'Smith' });
  const { sock: bob } = await signedInSocket(base, { firstName: 'Bob', lastName: 'Jones' });
  const { sock: carol } = await signedInSocket(base, { firstName: 'Carol', lastName: 'White' });
  t.after(() => [alice, bob, carol].forEach((c) => c.close()));

  await call(alice, 'set-activity', { activity: 'studying for a math exam' });
  await call(carol, 'set-activity', { activity: 'playing the guitar' });
  const bobMatches = once(bob, 'matches');
  await call(bob, 'set-activity', { activity: 'doing calculus homework' });
  const { matches } = await bobMatches;
  assert.strictEqual(matches[0].name, 'Alice S.', 'strangers see first name + last initial');
  assert.ok(!matches.some((m) => m.name.startsWith('Carol')), 'unrelated user should not match');

  const incoming = once(alice, 'incoming-request');
  assert.ok((await call(bob, 'send-request', { to: alice.id })).ok);
  assert.strictEqual((await incoming).from.name, 'Bob J.');

  const aRoom = once(alice, 'room-start');
  const bRoom = once(bob, 'room-start');
  assert.ok((await call(alice, 'respond-request', { from: bob.id, accept: true })).ok);
  const [ra, rb] = await Promise.all([aRoom, bRoom]);
  assert.strictEqual(ra.roomId, rb.roomId);
  assert.strictEqual(rb.initiator, true);

  // Users in a room are hidden from others.
  const carolMatches = once(carol, 'matches');
  await call(carol, 'set-activity', { activity: 'studying math' });
  assert.strictEqual((await carolMatches).matches.length, 0);
  assert.ok((await call(carol, 'send-request', { to: alice.id })).error);

  const sig = once(alice, 'signal');
  bob.emit('signal', { ready: true });
  assert.deepStrictEqual(await sig, { ready: true });

  const chat = once(alice, 'chat');
  bob.emit('chat', { text: 'hey <b>there</b>' });
  assert.strictEqual((await chat).text, 'hey <b>there</b>');

  const left = once(alice, 'peer-left');
  bob.emit('leave-room');
  assert.strictEqual((await left).reason, 'left');
});

test('two tabs of the same account never match each other', async (t) => {
  const { sock: tab1, cookie } = await signedInSocket(base, { firstName: 'Dana', lastName: 'Solo' });
  const tab2 = Client(base, { forceNew: true, extraHeaders: { cookie } });
  t.after(() => { tab1.close(); tab2.close(); });
  await once(tab2, 'connect');

  await call(tab1, 'set-activity', { activity: 'knitting a scarf' });
  const m = once(tab2, 'matches');
  await call(tab2, 'set-activity', { activity: 'knitting a scarf' });
  assert.ok(!(await m).matches.some((x) => x.name === 'Dana S.'));
  assert.ok((await call(tab2, 'send-request', { to: tab1.id })).error);
});
