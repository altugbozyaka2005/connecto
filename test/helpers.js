// Shared helpers: boots the server on a random port with an in-memory database.
process.env.DB_PATH = ':memory:';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.MAIL_TRANSPORT = 'memory';
process.env.TURN_SECRET = 'test-turn-secret';
process.env.TURN_HOST = '203.0.113.7';
process.env.TURN_TLS_HOST = 'turn.example.com';
const { io: Client } = require('socket.io-client');
const { server, io } = require('../server');
const { outbox } = require('../mail');

// Newest email sent to `to`, plus the token from its link.
function lastEmail(to, kind) {
  const mail = [...outbox].reverse().find((m) => m.to === to && (!kind || m.text.includes(`?${kind}=`)));
  if (!mail) return null;
  const m = mail.text.match(/\?(verify|reset)=([A-Za-z0-9_-]+)/);
  return { ...mail, token: m && m[2] };
}

async function start() {
  await new Promise((r) => server.listen(0, r));
  return `http://localhost:${server.address().port}`;
}

function stop() {
  io.close();
  server.close();
}

async function request(base, method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: setCookie && setCookie.split(';')[0] };
}

let n = 0;
function newUser(overrides = {}) {
  n++;
  return {
    firstName: `User${String.fromCharCode(64 + n)}`,
    lastName: 'Tester',
    email: `user${n}_${Date.now()}@example.com`,
    password: 'hunter22abc',
    dateOfBirth: '1995-06-15',
    gender: 'prefer_not',
    acceptTerms: true,
    ...overrides,
  };
}

// Registers a user, confirms their email, and opens a signed-in socket for them.
async function signedInSocket(base, overrides) {
  const reg = await request(base, 'POST', '/api/auth/register', newUser(overrides));
  if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
  await request(base, 'POST', '/api/auth/verify-email', { token: lastEmail(reg.body.user.email, 'verify').token });
  const sock = Client(base, { forceNew: true, extraHeaders: { cookie: reg.cookie } });
  await new Promise((r, j) => { sock.once('connect', r); sock.once('connect_error', j); });
  return { sock, cookie: reg.cookie, user: reg.body.user };
}

const once = (sock, ev) => new Promise((r) => sock.once(ev, r));
const call = (sock, ev, p) => new Promise((r) => sock.emit(ev, p, r));

module.exports = { start, stop, request, newUser, signedInSocket, lastEmail, once, call, Client };
