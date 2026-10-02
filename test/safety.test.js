const test = require('node:test');
const assert = require('node:assert');
const { start, stop, request, signedInSocket, lastEmail, once, call, matchUp } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

const nextMatches = (sock) => once(sock, 'matches');
const settle = () => new Promise((r) => setTimeout(r, 200));

test('blocking from the match list hides both people and refuses requests; unblock restores', async (t) => {
  const { sock: a, cookie: aCookie } = await signedInSocket(base, { firstName: 'Bia' });
  const { sock: b } = await signedInSocket(base, { firstName: 'Cem' });
  t.after(() => { a.close(); b.close(); });
  await call(a, 'set-activity', { activity: 'block test juggling clubs' });
  const seen = nextMatches(b);
  await call(b, 'set-activity', { activity: 'block test juggling clubs' });
  assert.ok((await seen).matches.some((m) => m.id === a.id));

  const bAfter = nextMatches(b);
  assert.deepStrictEqual(await call(a, 'block', { target: b.id }), { ok: true });
  assert.ok(!(await bAfter).matches.some((m) => m.id === a.id), 'blocked person no longer sees blocker');
  assert.ok((await call(b, 'send-request', { to: a.id })).error, 'blocked person cannot send requests');
  assert.ok((await call(a, 'send-request', { to: b.id })).error, 'blocker cannot either');

  const list = await request(base, 'GET', '/api/blocks', null, aCookie);
  assert.strictEqual(list.body.blocks.length, 1);
  assert.strictEqual(list.body.blocks[0].name, 'Cem T.');

  const back = nextMatches(b);
  await request(base, 'DELETE', `/api/blocks/${list.body.blocks[0].id}`, {}, aCookie);
  await call(a, 'set-activity', { activity: 'block test juggling clubs' }); // trigger a recompute
  assert.ok((await back).matches.some((m) => m.id === a.id), 'visible again after unblocking');
});

test('blocking during a call ends it for both sides', async (t) => {
  const { sock: a } = await signedInSocket(base);
  const { sock: b } = await signedInSocket(base);
  t.after(() => { a.close(); b.close(); });
  await matchUp(a, b, 'call block test origami');
  const left = once(b, 'room-ended');
  const ended = once(a, 'room-ended');
  assert.deepStrictEqual(await call(a, 'block', { lastPeer: true }), { ok: true });
  assert.strictEqual((await left).reason, 'left', 'blocked person is not told they were blocked');
  await ended;
});

test('reports: validation, transcript evidence, dedupe, admin review', async (t) => {
  const { sock: a, user: aUser } = await signedInSocket(base, { firstName: 'Reporter' });
  const { sock: b, user: bUser } = await signedInSocket(base, { firstName: 'Rude' });
  const { sock: adminSock, cookie: adminCookie } = await signedInSocket(base, { email: 'admin@example.com', firstName: 'Admin' });
  const { sock: plainSock, cookie: plainCookie } = await signedInSocket(base);
  t.after(() => [a, b, adminSock, plainSock].forEach((s) => s.close()));

  await matchUp(a, b, 'report test painting');
  const got = once(a, 'chat');
  b.emit('chat', { text: 'something nasty' });
  await got;

  assert.ok((await call(a, 'report', { lastPeer: true, reason: 'made-up' })).error, 'unknown reason rejected');
  assert.deepStrictEqual(await call(a, 'report', { lastPeer: true, reason: 'harassment', details: 'Was rude' }), { ok: true });
  // A second report about the same person updates the first instead of adding another.
  assert.deepStrictEqual(await call(a, 'report', { lastPeer: true, reason: 'hate', details: 'Also hateful' }), { ok: true });

  assert.strictEqual((await request(base, 'GET', '/api/admin/reports?status=open', null, plainCookie)).status, 403, 'non-admins blocked');
  const { body } = await request(base, 'GET', '/api/admin/reports?status=open', null, adminCookie);
  const mine = body.reports.filter((r) => r.reported.email === bUser.email);
  assert.strictEqual(mine.length, 1);
  const r = mine[0];
  assert.strictEqual(r.reason, 'hate');
  assert.strictEqual(r.details, 'Also hateful');
  assert.strictEqual(r.context, 'call');
  assert.strictEqual(r.activity, 'report test painting');
  assert.strictEqual(r.reporter.email, aUser.email);
  assert.deepStrictEqual(r.transcript.map((m) => m.text), ['something nasty'], 'server-side chat log attached');
  assert.ok(lastEmail('admin@example.com'), 'admin notified by email');

  // Admin suspends: the reported user is kicked out and can't sign back in.
  const kicked = once(b, 'suspended');
  assert.deepStrictEqual((await request(base, 'POST', `/api/admin/reports/${r.id}`, { action: 'suspend', note: 'confirmed' }, adminCookie)).body, { ok: true });
  await kicked;
  const login = await request(base, 'POST', '/api/auth/login', { email: bUser.email, password: 'hunter22abc' });
  assert.strictEqual(login.status, 403);
  assert.match(login.body.error, /suspended/);
});

test('three different reporters within 24h suspend the account automatically', async (t) => {
  const { sock: target, user: targetUser } = await signedInSocket(base, { firstName: 'Target' });
  const reporters = await Promise.all([1, 2, 3].map(() => signedInSocket(base)));
  t.after(() => { target.close(); reporters.forEach((r) => r.sock.close()); });

  await call(target, 'set-activity', { activity: 'auto suspend test chess' });
  for (const r of reporters) await call(r.sock, 'set-activity', { activity: 'auto suspend test chess' });
  await settle();

  const suspended = once(target, 'suspended');
  for (const [i, r] of reporters.entries()) {
    assert.deepStrictEqual(await call(r.sock, 'report', { target: target.id, reason: 'spam' }), { ok: true }, `report ${i + 1}`);
  }
  await suspended;
  assert.strictEqual((await request(base, 'POST', '/api/auth/login', { email: targetUser.email, password: 'hunter22abc' })).status, 403);
});

test('admin can unsuspend', async () => {
  const { cookie: adminCookie } = await request(base, 'POST', '/api/auth/login', { email: 'admin@example.com', password: 'hunter22abc' });
  const { body } = await request(base, 'GET', '/api/admin/suspended', null, adminCookie);
  assert.ok(body.users.length >= 1);
  const u = body.users.find((x) => x.name.startsWith('Target'));
  assert.match(u.reason, /Automatically suspended/);
  await request(base, 'POST', `/api/admin/users/${u.id}/unsuspend`, {}, adminCookie);
  assert.strictEqual((await request(base, 'POST', '/api/auth/login', { email: u.email, password: 'hunter22abc' })).status, 200);
});

test('you can report the person from your last call after it ends, but not yourself', async (t) => {
  const { sock: a } = await signedInSocket(base);
  const { sock: b } = await signedInSocket(base);
  t.after(() => { a.close(); b.close(); });
  await matchUp(a, b, 'after call report test pottery');
  const left = once(a, 'room-ended');
  b.emit('leave-room');
  await left;
  assert.deepStrictEqual(await call(a, 'report', { lastPeer: true, reason: 'other' }), { ok: true });
  assert.ok((await call(a, 'report', { target: a.id, reason: 'other' })).error);
  assert.ok((await call(a, 'report', { reason: 'other' })).error, 'no target');
});
