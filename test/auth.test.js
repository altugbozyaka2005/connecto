const test = require('node:test');
const assert = require('node:assert');
const { start, stop, request, newUser, signedInSocket, Client } = require('./helpers');
const { ageOn } = require('../auth');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

test('register validates every field', async () => {
  const today = new Date();
  const seventeen = `${today.getUTCFullYear() - 17}-01-01`;
  const r = await request(base, 'POST', '/api/auth/register', newUser({
    firstName: '', lastName: '<script>', email: 'nope', password: 'short', dateOfBirth: seventeen, gender: 'robot', acceptTerms: false,
  }));
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(Object.keys(r.body.fields).sort(), ['acceptTerms', 'dateOfBirth', 'email', 'firstName', 'gender', 'lastName', 'password']);
  assert.match(r.body.fields.dateOfBirth, /at least 18/);

  const badDate = await request(base, 'POST', '/api/auth/register', newUser({ dateOfBirth: '2001-02-31' }));
  assert.ok(badDate.body.fields.dateOfBirth);
  const noDigit = await request(base, 'POST', '/api/auth/register', newUser({ password: 'onlyletters' }));
  assert.ok(noDigit.body.fields.password);
});

test('age calculation respects birthdays', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  assert.strictEqual(ageOn(new Date('2008-10-01T00:00:00Z'), now), 18);
  assert.strictEqual(ageOn(new Date('2008-10-02T00:00:00Z'), now), 17);
});

test('register → me → logout → login', async () => {
  const u = newUser({ firstName: 'Ada', lastName: 'lovelace', email: 'Ada@Example.com' });
  const reg = await request(base, 'POST', '/api/auth/register', u);
  assert.strictEqual(reg.status, 201);
  assert.ok(reg.cookie.startsWith('connecto_sid='));
  assert.strictEqual(reg.body.user.displayName, 'Ada L.');
  assert.strictEqual(reg.body.user.email, 'ada@example.com');
  assert.ok(!('password_hash' in reg.body.user) && !('passwordHash' in reg.body.user));

  const dup = await request(base, 'POST', '/api/auth/register', { ...u, email: 'ADA@example.com' });
  assert.strictEqual(dup.status, 409);

  const me = await request(base, 'GET', '/api/auth/me', null, reg.cookie);
  assert.strictEqual(me.body.user.firstName, 'Ada');

  await request(base, 'POST', '/api/auth/logout', {}, reg.cookie);
  assert.strictEqual((await request(base, 'GET', '/api/auth/me', null, reg.cookie)).status, 401);

  const wrong = await request(base, 'POST', '/api/auth/login', { email: u.email, password: 'wrongpass1' });
  assert.strictEqual(wrong.status, 401);
  const unknown = await request(base, 'POST', '/api/auth/login', { email: 'ghost@example.com', password: 'whatever1' });
  assert.strictEqual(unknown.body.error, wrong.body.error, 'must not reveal which emails exist');

  const ok = await request(base, 'POST', '/api/auth/login', { email: 'ada@example.com', password: u.password });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await request(base, 'GET', '/api/auth/me', null, ok.cookie)).status, 200);
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b',
  });
  assert.strictEqual(res.status, 415);
});

test('update profile photo', async () => {
  const reg = await request(base, 'POST', '/api/auth/register', newUser());
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const r = await request(base, 'PATCH', '/api/auth/me', { avatar }, reg.cookie);
  assert.strictEqual(r.body.user.avatar, avatar);
  const bad = await request(base, 'PATCH', '/api/auth/me', { avatar: 'javascript:alert(1)' }, reg.cookie);
  assert.strictEqual(bad.status, 400);
});

test('sockets require a session, and logout disconnects them', async () => {
  const anon = Client(base, { forceNew: true });
  const err = await new Promise((r) => anon.once('connect_error', r));
  assert.strictEqual(err.message, 'unauthorized');
  anon.close();

  const { sock, cookie } = await signedInSocket(base);
  const dropped = new Promise((r) => sock.once('disconnect', r));
  await request(base, 'POST', '/api/auth/logout', {}, cookie);
  assert.strictEqual(await dropped, 'io server disconnect');
  sock.close();
});
