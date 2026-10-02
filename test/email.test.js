const test = require('node:test');
const assert = require('node:assert');
const { start, stop, request, newUser, signedInSocket, lastEmail, once, call, Client } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

test('new accounts must confirm their email before matching', async () => {
  const u = newUser();
  const reg = await request(base, 'POST', '/api/auth/register', u);
  assert.strictEqual(reg.body.user.emailVerified, false);

  const mail = lastEmail(u.email, 'verify');
  assert.ok(mail, 'verification email sent');
  assert.match(mail.text, /^Welcome, /);

  // Socket is refused until verified.
  const s = Client(base, { forceNew: true, extraHeaders: { cookie: reg.cookie } });
  assert.strictEqual((await once(s, 'connect_error')).message, 'unverified');
  s.close();

  const bad = await request(base, 'POST', '/api/auth/verify-email', { token: 'nope' });
  assert.strictEqual(bad.status, 400);

  const ok = await request(base, 'POST', '/api/auth/verify-email', { token: mail.token }, reg.cookie);
  assert.strictEqual(ok.body.user.emailVerified, true);
  // Single use.
  assert.strictEqual((await request(base, 'POST', '/api/auth/verify-email', { token: mail.token })).status, 400);

  const s2 = Client(base, { forceNew: true, extraHeaders: { cookie: reg.cookie } });
  await once(s2, 'connect');
  s2.close();
});

test('signing in to an unconfirmed account sends a fresh link only if the last one is old', async () => {
  const db = require('../db');
  const u = newUser();
  await request(base, 'POST', '/api/auth/register', u);
  const first = lastEmail(u.email, 'verify').token;

  // Right after signup: no second email.
  const soon = await request(base, 'POST', '/api/auth/login', { email: u.email, password: u.password });
  assert.strictEqual(soon.body.verificationSent, false);
  assert.strictEqual(lastEmail(u.email, 'verify').token, first);

  // Pretend the link was sent 20 minutes ago (e.g. before email was working).
  db.prepare("UPDATE email_tokens SET created_at = created_at - 1200000 WHERE purpose = 'verify'").run();
  const later = await request(base, 'POST', '/api/auth/login', { email: u.email, password: u.password });
  assert.strictEqual(later.body.verificationSent, true);
  await new Promise((r) => setImmediate(r));
  const fresh = lastEmail(u.email, 'verify').token;
  assert.notStrictEqual(fresh, first);
  assert.strictEqual((await request(base, 'POST', '/api/auth/verify-email', { token: first })).status, 400, 'old link replaced');
  assert.strictEqual((await request(base, 'POST', '/api/auth/verify-email', { token: fresh })).status, 200);
});

test('resend verification requires sign-in and has a cooldown', async () => {
  const u = newUser();
  const reg = await request(base, 'POST', '/api/auth/register', u);
  const again = await request(base, 'POST', '/api/auth/resend-verification', {}, reg.cookie);
  assert.strictEqual(again.status, 429, 'cooldown right after signup');
  assert.strictEqual((await request(base, 'POST', '/api/auth/resend-verification', {})).status, 401);
});

test('forgot → reset password', async () => {
  const u = newUser();
  const reg = await request(base, 'POST', '/api/auth/register', u);

  // Unknown emails get the same response and no email.
  const ghost = await request(base, 'POST', '/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.deepStrictEqual(ghost.body, { ok: true });
  assert.strictEqual(lastEmail('ghost@example.com'), null);

  const r = await request(base, 'POST', '/api/auth/forgot-password', { email: u.email.toUpperCase() });
  assert.deepStrictEqual(r.body, { ok: true });
  await new Promise((res) => setImmediate(res));
  const mail = lastEmail(u.email, 'reset');
  assert.ok(mail, 'reset email sent');

  // Weak password is rejected without burning the token.
  const weak = await request(base, 'POST', '/api/auth/reset-password', { token: mail.token, password: 'short' });
  assert.strictEqual(weak.status, 400);
  assert.ok(weak.body.fields.password);

  const done = await request(base, 'POST', '/api/auth/reset-password', { token: mail.token, password: 'brandnew123' });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.user.emailVerified, true, 'reset proves email ownership');
  assert.ok(done.cookie);

  // Old session is revoked, old password no longer works, new one does.
  assert.strictEqual((await request(base, 'GET', '/api/auth/me', null, reg.cookie)).status, 401);
  assert.strictEqual((await request(base, 'POST', '/api/auth/login', { email: u.email, password: u.password })).status, 401);
  assert.strictEqual((await request(base, 'POST', '/api/auth/login', { email: u.email, password: 'brandnew123' })).status, 200);
  // Token is single use.
  assert.strictEqual((await request(base, 'POST', '/api/auth/reset-password', { token: mail.token, password: 'another123' })).status, 400);
});

test('password reset disconnects open tabs', async () => {
  const { sock, user } = await signedInSocket(base);
  await request(base, 'POST', '/api/auth/forgot-password', { email: user.email });
  await new Promise((res) => setImmediate(res));
  const dropped = once(sock, 'disconnect');
  await request(base, 'POST', '/api/auth/reset-password', { token: lastEmail(user.email, 'reset').token, password: 'brandnew123' });
  assert.strictEqual(await dropped, 'io server disconnect');
  sock.close();
});

test('room-start carries short-lived TURN credentials', async (t) => {
  const crypto = require('crypto');
  const { sock: a } = await signedInSocket(base);
  const { sock: b } = await signedInSocket(base);
  t.after(() => { a.close(); b.close(); });
  await call(a, 'set-activity', { activity: 'turn test baking bread' });
  await call(b, 'set-activity', { activity: 'turn test baking bread' });
  const inc = once(a, 'incoming-request');
  await call(b, 'send-request', { to: a.id });
  await inc;
  const room = once(a, 'room-start');
  await call(a, 'respond-request', { from: b.id, accept: true });
  const { iceServers } = await room;
  const turn = iceServers.find((s) => s.username);
  assert.ok(turn.urls.includes('turn:203.0.113.7:3478?transport=udp'));
  assert.ok(turn.urls.includes('turns:turn.example.com:443?transport=tcp'));
  const [expiry] = turn.username.split(':');
  assert.ok(Number(expiry) > Date.now() / 1000 && Number(expiry) < Date.now() / 1000 + 13 * 3600);
  const expected = crypto.createHmac('sha1', 'test-turn-secret').update(turn.username).digest('base64');
  assert.strictEqual(turn.credential, expected);
});
