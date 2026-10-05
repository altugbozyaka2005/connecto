// Background searches ("keep looking after I close the tab") and the requests people send them.
const db = require('./db');
const mail = require('./mail');
const { analyze } = require('./matcher');

const DURATIONS_H = [3, 12, 24, 72];
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unanswered requests disappear after a week
const ACCEPTED_TTL_MS = 48 * 60 * 60 * 1000; // "both want to connect" lasts two days
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // "recently connected" shows a week
const MAX_REQUESTS_PER_DAY = 20;
const MEETING_GRACE_MS = 2 * 60 * 60 * 1000; // a scheduled meeting stays joinable 2h after its start
const MAX_SLOTS = 3;
const SLOT_MIN_AHEAD_MS = 5 * 60 * 1000;
const SLOT_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const REMIND_BEFORE_MS = 10 * 60 * 1000;
const EMAIL_EVERY_MS = 3 * 60 * 60 * 1000; // at most one notification email per 3 hours

const MAX_SEARCHES = 3; // background searches per person at once

// searchId -> { id, accountId, activity, profile, createdAt, expiresAt }
const searches = new Map();
function load() {
  searches.clear();
  const rows = db.prepare(`SELECT b.* FROM background_searches b JOIN users u ON u.id = b.user_id
                           WHERE b.expires_at > ? AND u.banned_at IS NULL`).all(Date.now());
  for (const r of rows) searches.set(r.id, toEntry(r));
}
const toEntry = (r) => ({ id: r.id, accountId: r.user_id, activity: r.activity, profile: analyze(r.activity), createdAt: r.created_at, expiresAt: r.expires_at });
load();

// Expired searches and stale requests are cleared every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of searches) if (s.expiresAt <= now) searches.delete(id);
  db.prepare('DELETE FROM background_searches WHERE expires_at <= ?').run(now);
  // A scheduled meeting keeps the connection alive until shortly after it starts.
  db.prepare(`DELETE FROM connect_requests WHERE (status = 'pending' AND created_at < ?)
              OR (status = 'accepted' AND updated_at < ? AND (meeting_at IS NULL OR meeting_at < ?))
              OR (status = 'declined' AND updated_at < ?)`)
    .run(now - PENDING_TTL_MS, now - ACCEPTED_TTL_MS, now - MEETING_GRACE_MS, now - PENDING_TTL_MS);
  db.prepare("DELETE FROM connect_requests WHERE status = 'done' AND updated_at < ?").run(now - HISTORY_TTL_MS);
}, 5 * 60 * 1000).unref();

function active() {
  const now = Date.now();
  return [...searches.values()].filter((s) => s.expiresAt > now);
}

// One person's running searches, newest first.
function forUser(accountId) {
  return active().filter((s) => s.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt);
}

const has = (accountId) => forUser(accountId).length > 0;

// Starts a new search, or updates search `id` (wording and duration). Returns the entry or { error }.
function start(accountId, activity, hours, id = null) {
  const now = Date.now();
  const expiresAt = now + hours * 60 * 60 * 1000;
  const mine = forUser(accountId);
  const existing = id ? mine.find((s) => s.id === id)
    // Starting the same search again just extends it.
    : mine.find((s) => s.activity.toLowerCase() === activity.toLowerCase());
  if (id && !existing) return { error: 'That background search has ended.' };
  if (existing) {
    db.prepare('UPDATE background_searches SET activity = ?, created_at = ?, expires_at = ? WHERE id = ?').run(activity, now, expiresAt, existing.id);
    const entry = toEntry({ id: existing.id, user_id: accountId, activity, created_at: now, expires_at: expiresAt });
    searches.set(entry.id, entry);
    return entry;
  }
  if (mine.length >= MAX_SEARCHES) return { error: `You can run up to ${MAX_SEARCHES} background searches. Stop one first.` };
  const { lastInsertRowid } = db.prepare('INSERT INTO background_searches (user_id, activity, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(accountId, activity, now, expiresAt);
  const entry = toEntry({ id: Number(lastInsertRowid), user_id: accountId, activity, created_at: now, expires_at: expiresAt });
  searches.set(entry.id, entry);
  return entry;
}

// Stops one search, or all of them when no id is given.
function stop(accountId, id = null) {
  if (id) {
    db.prepare('DELETE FROM background_searches WHERE id = ? AND user_id = ?').run(id, accountId);
    if (searches.get(id)?.accountId === accountId) searches.delete(id);
    return;
  }
  db.prepare('DELETE FROM background_searches WHERE user_id = ?').run(accountId);
  for (const s of forUser(accountId)) searches.delete(s.id);
}

// ---------- Requests ----------

const live = (r) => (r.status === 'pending' && Date.now() - r.created_at < PENDING_TTL_MS)
  || (r.status === 'accepted' && (Date.now() - r.updated_at < ACCEPTED_TTL_MS || (r.meeting_at && r.meeting_at > Date.now() - MEETING_GRACE_MS)));

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

// ---------- Scheduling ----------

// The open, accepted connection with this id that `accountId` is part of.
function openConnection(id, accountId) {
  const r = db.prepare("SELECT * FROM connect_requests WHERE id = ? AND status = 'accepted' AND (from_id = ? OR to_id = ?)").get(id, accountId, accountId);
  return r && live(r) ? r : null;
}

// Propose 1-3 times (ms) to meet. Replaces any earlier proposal or meeting. Returns the row or { error }.
function propose(id, accountId, slots) {
  const r = openConnection(id, accountId);
  if (!r) return { error: 'That connection is no longer open.' };
  const now = Date.now();
  const clean = [...new Set((Array.isArray(slots) ? slots : []).map(Number))]
    .filter((t) => Number.isFinite(t) && t > now + SLOT_MIN_AHEAD_MS && t < now + SLOT_MAX_AHEAD_MS)
    .sort((a, b) => a - b);
  if (!clean.length) return { error: 'Pick at least one time from now on.' };
  if (clean.length > MAX_SLOTS) return { error: `Propose up to ${MAX_SLOTS} times.` };
  db.prepare('UPDATE connect_requests SET proposed_by = ?, proposed_slots = ?, meeting_at = NULL, reminded_at = NULL, updated_at = ? WHERE id = ?')
    .run(accountId, JSON.stringify(clean), now, r.id);
  return db.prepare('SELECT * FROM connect_requests WHERE id = ?').get(r.id);
}

// The other side picks one of the proposed times.
function pick(id, accountId, slot) {
  const r = openConnection(id, accountId);
  if (!r || !r.proposed_slots || r.proposed_by === accountId) return { error: 'Those times are no longer open.' };
  const t = Number(slot);
  if (!JSON.parse(r.proposed_slots).includes(t)) return { error: 'Pick one of the proposed times.' };
  if (t < Date.now()) return { error: 'That time has passed. Suggest another one.' };
  db.prepare('UPDATE connect_requests SET proposed_by = NULL, proposed_slots = NULL, meeting_at = ?, reminded_at = NULL, updated_at = ? WHERE id = ?')
    .run(t, Date.now(), r.id);
  return db.prepare('SELECT * FROM connect_requests WHERE id = ?').get(r.id);
}

// Cancel a proposal or a scheduled meeting; you're back to "ready to talk".
function unschedule(id, accountId) {
  const r = openConnection(id, accountId);
  if (!r) return null;
  db.prepare('UPDATE connect_requests SET proposed_by = NULL, proposed_slots = NULL, meeting_at = NULL, reminded_at = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), r.id);
  return r;
}

// Meetings starting within the next few minutes that haven't been reminded yet (marks them).
function dueReminders() {
  const now = Date.now();
  const rows = db.prepare(`SELECT * FROM connect_requests WHERE status = 'accepted' AND meeting_at IS NOT NULL
                           AND reminded_at IS NULL AND meeting_at <= ? AND meeting_at > ?`).all(now + REMIND_BEFORE_MS, now - MEETING_GRACE_MS);
  for (const r of rows) db.prepare('UPDATE connect_requests SET reminded_at = ? WHERE id = ?').run(now, r.id);
  return rows;
}

// They talked through a background connection in the last week ("call again" is allowed).
function talkedRecently(a, b) {
  return !!db.prepare(`SELECT 1 FROM connect_requests WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
                       AND status = 'done' AND updated_at > ?`).get(a, b, b, a, Date.now() - HISTORY_TTL_MS);
}

// They had their call: the request becomes history ("recently connected").
function settle(a, b) {
  db.prepare(`UPDATE connect_requests SET status = 'done', updated_at = ?
              WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND status IN ('pending', 'accepted')`)
    .run(Date.now(), a, b, b, a);
}

// Blocking: forget everything between them, including history.
function forget(a, b) {
  db.prepare('DELETE FROM connect_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(a, b, b, a);
}

function history(accountId) {
  return db.prepare(`SELECT * FROM connect_requests WHERE (from_id = ? OR to_id = ?) AND status = 'done' AND updated_at > ?
                     ORDER BY updated_at DESC LIMIT 20`).all(accountId, accountId, Date.now() - HISTORY_TTL_MS);
}

// ---------- Email ----------

// Sends at most one email per EMAIL_EVERY_MS to people who haven't turned it off.
// `urgent` (meeting times and reminders) skips the throttle: missing those means missing the meeting.
function notify(accountId, kind, { name, activity, at, urgent = false }) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(accountId);
  if (!u || !u.notify_email || u.banned_at || !u.email_verified_at) return;
  if (!urgent && u.notified_at && Date.now() - u.notified_at < EMAIL_EVERY_MS) return;
  if (!urgent) db.prepare('UPDATE users SET notified_at = ? WHERE id = ?').run(Date.now(), accountId);
  mail.sendConnectNotice(u, { kind, name, activity, at }).catch((err) => console.error('Notice email failed:', err.message));
}

function setNotify(accountId, on) {
  db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(on ? 1 : 0, accountId);
}

module.exports = {
  DURATIONS_H, MAX_SEARCHES, active, forUser, has, start, stop, request, respond, cancel, connected, settle, forget, history, between, forAccount, notify, setNotify,
  propose, pick, unschedule, dueReminders, talkedRecently, MAX_SLOTS,
};
