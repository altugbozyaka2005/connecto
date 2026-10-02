// Background searches ("keep looking after I close the tab") and the requests people send them.
const db = require('./db');
const mail = require('./mail');
const { analyze } = require('./matcher');

const DURATIONS_H = [3, 12, 24, 72];
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unanswered requests disappear after a week
const ACCEPTED_TTL_MS = 48 * 60 * 60 * 1000; // "both want to connect" lasts two days
const MAX_REQUESTS_PER_DAY = 20;
const EMAIL_EVERY_MS = 3 * 60 * 60 * 1000; // at most one notification email per 3 hours

// accountId -> { accountId, activity, profile, createdAt, expiresAt }
const searches = new Map();
function load() {
  searches.clear();
  const rows = db.prepare(`SELECT b.* FROM background_searches b JOIN users u ON u.id = b.user_id
                           WHERE b.expires_at > ? AND u.banned_at IS NULL`).all(Date.now());
  for (const r of rows) searches.set(r.user_id, toEntry(r));
}
const toEntry = (r) => ({ accountId: r.user_id, activity: r.activity, profile: analyze(r.activity), createdAt: r.created_at, expiresAt: r.expires_at });
load();

// Expired searches and stale requests are cleared every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of searches) if (s.expiresAt <= now) searches.delete(id);
  db.prepare('DELETE FROM background_searches WHERE expires_at <= ?').run(now);
  db.prepare("DELETE FROM connect_requests WHERE (status = 'pending' AND created_at < ?) OR (status = 'accepted' AND updated_at < ?) OR (status = 'declined' AND updated_at < ?)")
    .run(now - PENDING_TTL_MS, now - ACCEPTED_TTL_MS, now - PENDING_TTL_MS);
}, 5 * 60 * 1000).unref();

function active() {
  const now = Date.now();
  return [...searches.values()].filter((s) => s.expiresAt > now);
}

function get(accountId) {
  const s = searches.get(accountId);
  return s && s.expiresAt > Date.now() ? s : null;
}

function start(accountId, activity, hours) {
  const now = Date.now();
  const expiresAt = now + hours * 60 * 60 * 1000;
  db.prepare(`INSERT INTO background_searches (user_id, activity, created_at, expires_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET activity = excluded.activity, created_at = excluded.created_at, expires_at = excluded.expires_at`)
    .run(accountId, activity, now, expiresAt);
  const entry = toEntry({ user_id: accountId, activity, created_at: now, expires_at: expiresAt });
  searches.set(accountId, entry);
  return entry;
}

function stop(accountId) {
  db.prepare('DELETE FROM background_searches WHERE user_id = ?').run(accountId);
  searches.delete(accountId);
}

// ---------- Requests ----------

const live = (r) => (r.status === 'pending' && Date.now() - r.created_at < PENDING_TTL_MS)
  || (r.status === 'accepted' && Date.now() - r.updated_at < ACCEPTED_TTL_MS);

// The open request between two people, either direction.
function between(a, b) {
  const r = db.prepare(`SELECT * FROM connect_requests WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
                        AND status IN ('pending', 'accepted') ORDER BY created_at DESC LIMIT 1`).get(a, b, b, a);
  return r && live(r) ? r : null;
}

function forAccount(accountId) {
  return db.prepare(`SELECT * FROM connect_requests WHERE (from_id = ? OR to_id = ?) AND status IN ('pending', 'accepted')
                     ORDER BY updated_at DESC`).all(accountId, accountId).filter(live);
}

// Returns { request, status: 'pending'|'accepted' } or { error }.
function request(fromId, toId, activity) {
  if (fromId === toId) return { error: 'That’s you.' };
  const existing = between(fromId, toId);
  if (existing) {
    // They already asked us: asking back means both want it.
    if (existing.status === 'pending' && existing.to_id === fromId) {
      db.prepare("UPDATE connect_requests SET status = 'accepted', updated_at = ? WHERE id = ?").run(Date.now(), existing.id);
      return { request: { ...existing, status: 'accepted' }, status: 'accepted' };
    }
    return { request: existing, status: existing.status };
  }
  const sentToday = db.prepare('SELECT COUNT(*) AS n FROM connect_requests WHERE from_id = ? AND created_at > ?')
    .get(fromId, Date.now() - 24 * 60 * 60 * 1000).n;
  if (sentToday >= MAX_REQUESTS_PER_DAY) return { error: 'You’ve sent a lot of requests today. Try again tomorrow.' };
  const now = Date.now();
  const { lastInsertRowid } = db.prepare('INSERT INTO connect_requests (from_id, to_id, activity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(fromId, toId, activity || '', now, now);
  return { request: db.prepare('SELECT * FROM connect_requests WHERE id = ?').get(lastInsertRowid), status: 'pending' };
}

// Answer a request sent to you. Returns the request or null.
function respond(requestId, toId, accept) {
  const r = db.prepare("SELECT * FROM connect_requests WHERE id = ? AND to_id = ? AND status = 'pending'").get(requestId, toId);
  if (!r || !live(r)) return null;
  db.prepare('UPDATE connect_requests SET status = ?, updated_at = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', Date.now(), r.id);
  return { ...r, status: accept ? 'accepted' : 'declined' };
}

// Withdraw your own pending request.
function cancel(requestId, fromId) {
  db.prepare("DELETE FROM connect_requests WHERE id = ? AND from_id = ? AND status = 'pending'").run(requestId, fromId);
}

// Both want to talk: lets them call each other directly when both are online.
function connected(a, b) {
  return between(a, b)?.status === 'accepted';
}

// They had their call: nothing left to show in the inbox.
function settle(a, b) {
  db.prepare(`DELETE FROM connect_requests WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).run(a, b, b, a);
}

// ---------- Email ----------

// Sends at most one email per EMAIL_EVERY_MS to people who haven't turned it off.
function notify(accountId, kind, { name, activity }) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(accountId);
  if (!u || !u.notify_email || u.banned_at || !u.email_verified_at) return;
  if (u.notified_at && Date.now() - u.notified_at < EMAIL_EVERY_MS) return;
  db.prepare('UPDATE users SET notified_at = ? WHERE id = ?').run(Date.now(), accountId);
  mail.sendConnectNotice(u, { kind, name, activity }).catch((err) => console.error('Notice email failed:', err.message));
}

function setNotify(accountId, on) {
  db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(on ? 1 : 0, accountId);
}

module.exports = {
  DURATIONS_H, active, get, start, stop, request, respond, cancel, connected, settle, between, forAccount, notify, setNotify,
};
