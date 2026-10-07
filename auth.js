const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const mail = require('./mail');

const COOKIE = 'connecto_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_AGE = 18;
const MAX_AVATAR_BYTES = 300 * 1024;
const GENDERS = ['woman', 'man', 'nonbinary', 'other', 'prefer_not'];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;
// Links in emails are built from this, never from the request's Host header (which an attacker
// could spoof to get reset links pointing at their own site).
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// ---------- Passwords ----------
// scrypt with a per-user salt, stored as "scrypt$<salt>$<hash>".

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [, saltB64, hashB64] = String(stored).split('$');
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
// Used when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------- Sessions ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

// ---------- Email links (verification + password reset) ----------

function createEmailToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  // Only the newest link of each kind works.
  db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, purpose, now, now + (purpose === 'reset' ? RESET_TTL_MS : VERIFY_TTL_MS));
  return token;
}

// Single use: the token is deleted whether or not it was still valid.
function consumeEmailToken(token, purpose) {
  if (typeof token !== 'string' || !token) return null;
  const hash = sha256(token);
  const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?').get(hash, purpose);
  if (!row) return null;
  db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(hash);
  return row.expires_at >= Date.now() ? row.user_id : null;
}

function recentlyEmailed(userId, purpose, withinMs = EMAIL_COOLDOWN_MS) {
  const row = db.prepare('SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  return !!row && Date.now() - row.created_at < withinMs;
}

async function sendVerification(user) {
  const url = `${APP_URL}/?verify=${createEmailToken(user.id, 'verify')}`;
  await mail.sendVerificationEmail(user, url);
}

function sendReset(user) {
  const url = `${APP_URL}/?reset=${createEmailToken(user.id, 'reset')}`;
  return mail.sendPasswordResetEmail(user, url);
}

// Expired sessions and links are useless; clear them out hourly.
setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now);
}, 60 * 60 * 1000).unref();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns { sessionId, user } for a valid session cookie, else null.
function sessionFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const sessionId = sha256(token);
  const row = db.prepare(`
    SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
  `).get(sessionId);
  if (!row || row.banned_at) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionId);
    return null;
  }
  return { sessionId, user: row };
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

// ---------- Admins ----------
// Admins are listed by email in ADMIN_EMAILS (comma separated) and must have confirmed it.

const adminEmails = () =>
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

function isAdmin(user) {
  return !!user && !!user.email_verified_at && !user.banned_at && adminEmails().includes(user.email.toLowerCase());
}

// Only accept JSON bodies on writes: combined with SameSite cookies this blocks
// cross-site form posts (CSRF).
function jsonOnly(req, res, next) {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  next();
}

// ---------- Validation ----------

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function ageOn(dob, today = new Date()) {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

function parseDob(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  // Reject rollovers like 2001-02-31.
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? d : null;
}

function validAvatar(a) {
  return (
    typeof a === 'string' &&
    a.length <= MAX_AVATAR_BYTES &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a)
  );
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Include at least one letter and one number.';
  return null;
}

// Returns { errors: {field: message}, value } for a registration payload.
function validateRegistration(body = {}) {
  const errors = {};
  const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const firstName = str(body.firstName);
  const lastName = str(body.lastName);
  const email = str(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const gender = body.gender ? String(body.gender) : null;

  if (!firstName) errors.firstName = 'Enter your first name.';
  else if (firstName.length > 50 || !NAME_RE.test(firstName)) errors.firstName = 'Use letters only (max 50).';
  if (!lastName) errors.lastName = 'Enter your last name.';
  else if (lastName.length > 50 || !NAME_RE.test(lastName)) errors.lastName = 'Use letters only (max 50).';

  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';

  const pwError = passwordProblem(password);
  if (pwError) errors.password = pwError;

  const dob = parseDob(body.dateOfBirth);
  if (!dob) errors.dateOfBirth = 'Enter a valid date of birth.';
  else {
    const age = ageOn(dob);
    if (age < MIN_AGE) errors.dateOfBirth = `You must be at least ${MIN_AGE} to use Connecto.`;
    else if (age > 120) errors.dateOfBirth = 'Enter a valid date of birth.';
  }

  if (gender && !GENDERS.includes(gender)) errors.gender = 'Choose an option from the list.';
  if (body.avatar && !validAvatar(body.avatar)) errors.avatar = 'That image could not be used.';
  if (body.acceptTerms !== true) errors.acceptTerms = 'You must accept the community guidelines.';

  return {
    errors,
    value: { firstName, lastName, email, password, dateOfBirth: body.dateOfBirth, gender, avatar: body.avatar || null },
  };
}

// What the account owner sees about themselves.
function selfView(u) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    displayName: displayName(u),
    dateOfBirth: u.date_of_birth,
    gender: u.gender,
    avatar: u.avatar,
    emailVerified: !!u.email_verified_at,
    isAdmin: isAdmin(u),
    ...profileExtras(u),
  };
}

// ---------- Profile extras (bio, interests, city, time zone) ----------
// Shown to other people on match cards, so they're length-limited and stripped of control chars.

const MAX_INTERESTS = 5;

function profileExtras(u) {
  let interests = [];
  try { interests = JSON.parse(u.interests || '[]'); } catch { /* corrupt -> empty */ }
  return { bio: u.bio || '', interests, city: u.city || '', timezone: u.timezone || '' };
}

const tidy = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Returns { errors, value } with only the fields present in `body`.
function validateProfile(body = {}) {
  const errors = {};
  const value = {};
  if ('bio' in body) {
    if (typeof body.bio === 'string' && body.bio.length > 200) errors.bio = 'Keep your bio under 200 characters.';
    else value.bio = tidy(body.bio, 200) || null;
  }
  if ('city' in body) value.city = tidy(body.city, 60) || null;
  if ('timezone' in body) {
    const tz = tidy(body.timezone, 64);
    if (tz && !validTimezone(tz)) errors.timezone = 'Unknown time zone.';
    else value.timezone = tz || null;
  }
  if ('interests' in body) {
    const list = Array.isArray(body.interests) ? body.interests : [];
    const seen = new Set();
    const clean = [];
    for (const raw of list) {
      const t = tidy(raw, 24).replace(/^#/, '');
      const key = t.toLowerCase();
      if (t && !seen.has(key)) { seen.add(key); clean.push(t); }
    }
    if (clean.length > MAX_INTERESTS) errors.interests = `Pick up to ${MAX_INTERESTS} interests.`;
    else value.interests = JSON.stringify(clean);
  }
  return { errors, value };
}

// Strangers only see first name + last initial.
function displayName(u) {
  return `${u.first_name} ${u.last_name[0].toUpperCase()}.`;
}

// ---------- Rate limiting (in-memory, per IP + route) ----------

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { count: 0, reset: now + windowMs }));
    if (++h.count > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
}

// ---------- Routes ----------

// onLogout(sessionId) lets the realtime layer drop sockets tied to that session.
function createAuthRouter({ onLogout = () => {}, onSessionsRevoked = () => {} } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.use(jsonOnly);

  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_RATE_LIMIT) || 20 });

  router.post('/register', limiter, (req, res) => {
    const { errors, value } = validateRegistration(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(value.email)) {
      return res.status(409).json({ error: 'An account with this email already exists.', fields: { email: 'This email is already registered. Try signing in.' } });
    }
    const now = Date.now();
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, date_of_birth, gender, avatar, terms_accepted_at, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(value.email, hashPassword(value.password), value.firstName, value.lastName, value.dateOfBirth, value.gender, value.avatar, now, now, now);
    setSessionCookie(req, res, createSession(lastInsertRowid));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    // The account exists either way; if this email fails, the user can press "Resend".
    sendVerification(user).catch((err) => console.error('Verification email failed:', err.message));
    res.status(201).json({ user: selfView(user) });
  });

  router.post('/verify-email', limiter, (req, res) => {
    const userId = consumeEmailToken(req.body?.token, 'verify');
    if (!userId) return res.status(400).json({ error: 'This confirmation link is invalid or has expired. Sign in and press “Resend email” to get a new one.' });
    db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(Date.now(), userId);
    // If this browser is signed in as that user, hand back the updated profile.
    const s = sessionFromCookieHeader(req.headers.cookie);
    res.json({ ok: true, user: s && s.user.id === userId ? selfView(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) : null });
  });

  router.post('/resend-verification', limiter, async (req, res) => {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (!s) return res.status(401).json({ error: 'Not signed in.' });
    if (s.user.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
    if (recentlyEmailed(s.user.id, 'verify')) return res.status(429).json({ error: 'We just sent one. Please wait a minute before asking again.' });
    try {
      await sendVerification(s.user);
      res.json({ ok: true });
    } catch (err) {
      console.error('Verification email failed:', err.message);
      res.status(502).json({ error: 'We couldn’t send the email right now. Please try again shortly.' });
    }
  });

  router.post('/forgot-password', limiter, (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = EMAIL_RE.test(email) && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same answer, sent immediately, whether or not the account exists.
    if (user && !user.banned_at && !recentlyEmailed(user.id, 'reset')) {
      sendReset(user).catch((err) => console.error('Reset email failed:', err.message));
    }
    res.json({ ok: true });
  });

  router.post('/reset-password', limiter, (req, res) => {
    const pwError = passwordProblem(req.body?.password);
    if (pwError) return res.status(400).json({ error: 'Please choose a stronger password.', fields: { password: pwError } });
    const userId = consumeEmailToken(req.body?.token, 'reset');
    if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    if (db.prepare('SELECT banned_at FROM users WHERE id = ?').get(userId)?.banned_at) {
      return res.status(403).json({ error: 'This account has been suspended for breaking the community guidelines.' });
    }
    // Receiving the email also proves they own the address.
    db.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), last_login_at = ? WHERE id = ?')
      .run(hashPassword(req.body.password), Date.now(), Date.now(), userId);
    // Sign out everywhere (in case someone else had access), then sign in here.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").run(userId);
    onSessionsRevoked(userId);
    setSessionCookie(req, res, createSession(userId));
    res.json({ user: selfView(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
  });

  router.post('/login', limiter, (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (user.banned_at) return res.status(403).json({ error: 'This account has been suspended for breaking the community guidelines.' });
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    setSessionCookie(req, res, createSession(user.id));
    // Still unconfirmed? Their old link may have expired or never arrived; send a fresh one
    // (at most every 15 minutes) so they don't have to know about "Resend".
    let verificationSent = false;
    if (!user.email_verified_at && !recentlyEmailed(user.id, 'verify', 15 * 60 * 1000)) {
      sendVerification(user).catch((err) => console.error('Verification email failed:', err.message));
      verificationSent = true;
    }
    res.json({ user: selfView(user), verificationSent });
  });

  router.post('/logout', (req, res) => {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (s) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.sessionId);
      onLogout(s.sessionId);
    }
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (!s) return res.status(401).json({ error: 'Not signed in.' });
    res.json({ user: selfView(s.user) });
  });

  router.patch('/me', (req, res) => {
    const s = sessionFromCookieHeader(req.headers.cookie);
    if (!s) return res.status(401).json({ error: 'Not signed in.' });
    if ('avatar' in (req.body || {})) {
      const avatar = req.body.avatar;
      if (avatar !== null && !validAvatar(avatar)) return res.status(400).json({ error: 'That image could not be used.' });
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, s.user.id);
    }
    const { errors, value } = validateProfile(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
    for (const [field, v] of Object.entries(value)) {
      // Column names come from validateProfile's fixed set, never from the request.
      db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(v, s.user.id);
    }
    res.json({ user: selfView(db.prepare('SELECT * FROM users WHERE id = ?').get(s.user.id)) });
  });

  return router;
}

// Socket.IO middleware: only signed-in users may connect.
// Short device description for connection logs ("Chrome on macOS").
function deviceOf(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'other';
  return `${browser} on ${os}`;
}

function socketAuth(socket, next) {
  const s = sessionFromCookieHeader(socket.handshake.headers.cookie);
  const device = deviceOf(socket.handshake.headers['user-agent']);
  socket.data.device = device;
  if (process.env.NODE_ENV !== 'test' && !process.env.DB_PATH?.includes(':memory:')) {
    if (!s) console.log(`[conn] rejected: not signed in (${device}${socket.handshake.headers.cookie ? ', has a cookie' : ', no cookie'})`);
    else if (!s.user.email_verified_at) console.log(`[conn] rejected: account ${s.user.id} email not confirmed (${device})`);
  }
  if (!s) return next(new Error('unauthorized'));
  if (!s.user.email_verified_at) return next(new Error('unverified'));
  socket.data.sessionId = s.sessionId;
  socket.data.account = s.user;
  next();
}

module.exports = {
  createAuthRouter, socketAuth, sessionFromCookieHeader, jsonOnly, isAdmin, adminEmails,
  displayName, validAvatar, validateRegistration, ageOn, profileExtras,
};
