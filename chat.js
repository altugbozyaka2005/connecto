// Direct messages between connected people (both said yes to a background connect) and friends.
const db = require('./db');
const friends = require('./friends');
const safety = require('./safety');

const MAX_LENGTH = 2000;
const PAGE = 50;
const BURST = { n: 15, ms: 10 * 1000 }; // at most 15 messages per 10 seconds
const DAILY = 1000;

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

// accountId -> Set of connected accountIds (the table is the source of truth).
const connectedTo = new Map();
function link(a, b) {
  if (!connectedTo.has(a)) connectedTo.set(a, new Set());
  if (!connectedTo.has(b)) connectedTo.set(b, new Set());
  connectedTo.get(a).add(b);
  connectedTo.get(b).add(a);
}
for (const r of db.prepare('SELECT user_a, user_b FROM connections').all()) link(r.user_a, r.user_b);

function connect(a, b) {
  if (a === b) return;
  const [x, y] = pair(a, b);
  db.prepare('INSERT OR IGNORE INTO connections (user_a, user_b, created_at) VALUES (?, ?, ?)').run(x, y, Date.now());
  link(a, b);
}

// Blocking removes the connection (messages are kept for moderation, but nobody can see or send more).
function disconnect(a, b) {
  const [x, y] = pair(a, b);
  db.prepare('DELETE FROM connections WHERE user_a = ? AND user_b = ?').run(x, y);
  connectedTo.get(a)?.delete(b);
  connectedTo.get(b)?.delete(a);
}

const isConnected = (a, b) => !!connectedTo.get(a)?.has(b);
const connectionIds = (accountId) => [...(connectedTo.get(accountId) || [])];
const canMessage = (a, b) => a !== b && !safety.isBlocked(a, b) && (isConnected(a, b) || friends.areFriends(a, b));

// Everyone you can message: connections and friends.
function contacts(accountId) {
  return [...new Set([...connectionIds(accountId), ...friends.friendIds(accountId)])].filter((id) => !safety.isBlocked(accountId, id));
}

const sentAt = new Map(); // accountId -> recent send times
function rateLimited(accountId) {
  const now = Date.now();
  const times = (sentAt.get(accountId) || []).filter((t) => now - t < BURST.ms);
  if (times.length >= BURST.n) return true;
  times.push(now);
  sentAt.set(accountId, times);
  const today = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_id = ? AND created_at > ?').get(accountId, now - 24 * 60 * 60 * 1000).n;
  return today >= DAILY;
}

// Returns { message } or { error }.
function send(fromId, toId, body) {
  const text = typeof body === 'string' ? body.replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim() : '';
  if (!text) return { error: 'Type a message first.' };
  if (text.length > MAX_LENGTH) return { error: `Messages can be up to ${MAX_LENGTH} characters.` };
  if (!canMessage(fromId, toId)) return { error: 'You can only message people you’ve connected with.' };
  if (rateLimited(fromId)) return { error: 'You’re sending messages too fast. Wait a moment.' };
  const now = Date.now();
  const { lastInsertRowid } = db.prepare('INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)').run(fromId, toId, text, now);
  return { message: { id: Number(lastInsertRowid), from: fromId, to: toId, body: text, at: now } };
}

const toMessage = (r) => ({ id: r.id, from: r.from_id, to: r.to_id, body: r.body, at: r.created_at, read: !!r.read_at });

// Newest PAGE messages between two people, older than message id `before` (oldest first).
function history(a, b, before = null) {
  const rows = db.prepare(`SELECT * FROM messages WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
                           AND id < ? ORDER BY id DESC LIMIT ?`).all(a, b, b, a, before || Number.MAX_SAFE_INTEGER, PAGE + 1);
  const more = rows.length > PAGE;
  return { messages: rows.slice(0, PAGE).reverse().map(toMessage), more };
}

function markRead(readerId, otherId) {
  return db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').run(Date.now(), readerId, otherId).changes;
}

// Per contact: the last message and how many you haven't read.
function summaries(accountId) {
  const out = new Map();
  const last = db.prepare(`SELECT m.* FROM messages m JOIN (
                             SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS other, MAX(id) AS id
                             FROM messages WHERE from_id = ? OR to_id = ? GROUP BY other
                           ) l ON m.id = l.id`).all(accountId, accountId, accountId);
  for (const r of last) {
    const other = r.from_id === accountId ? r.to_id : r.from_id;
    out.set(other, { last: { body: r.body.slice(0, 120), at: r.created_at, mine: r.from_id === accountId }, unread: 0 });
  }
  for (const r of db.prepare('SELECT from_id, COUNT(*) AS n FROM messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id').all(accountId)) {
    if (out.has(r.from_id)) out.get(r.from_id).unread = r.n;
  }
  return out;
}

const connectedSince = (a, b) => {
  const [x, y] = pair(a, b);
  return db.prepare('SELECT created_at FROM connections WHERE user_a = ? AND user_b = ?').get(x, y)?.created_at || null;
};

// The latest messages between two people, for a report (names resolved by the caller).
function transcript(a, b) {
  return db.prepare(`SELECT * FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
                     ORDER BY id DESC LIMIT 100`).all(a, b, b, a).reverse();
}

module.exports = {
  MAX_LENGTH, connect, disconnect, isConnected, connectionIds, canMessage, contacts, send, history, markRead, summaries, connectedSince, transcript,
};
