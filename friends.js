// Mutual friendships. Someone becomes your friend only when you've both said yes after a call,
// so nobody is ever told they were turned down.
const db = require('./db');

// accountId -> Set of friend accountIds (the table is the source of truth).
const friendsOf = new Map();
function link(a, b) {
  if (!friendsOf.has(a)) friendsOf.set(a, new Set());
  if (!friendsOf.has(b)) friendsOf.set(b, new Set());
  friendsOf.get(a).add(b);
  friendsOf.get(b).add(a);
}
for (const r of db.prepare('SELECT user_a, user_b FROM friendships').all()) link(r.user_a, r.user_b);

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

function areFriends(a, b) {
  return !!friendsOf.get(a)?.has(b);
}

function friendIds(accountId) {
  return [...(friendsOf.get(accountId) || [])];
}

function incomingRequestIds(accountId) {
  return db.prepare('SELECT from_id FROM friend_requests WHERE to_id = ? ORDER BY created_at DESC').all(accountId).map((r) => r.from_id);
}

// Returns 'friends' if this completes a mutual yes, otherwise 'pending'.
function request(fromId, toId) {
  if (fromId === toId) throw new Error('Cannot befriend yourself.');
  if (areFriends(fromId, toId)) return 'friends';
  const theirs = db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(toId, fromId);
  if (theirs) {
    db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(fromId, toId, toId, fromId);
    const [a, b] = pair(fromId, toId);
    db.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)').run(a, b, Date.now());
    link(fromId, toId);
    return 'friends';
  }
  db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').run(fromId, toId, Date.now());
  return 'pending';
}

// "Not now" on a request: drop it quietly.
function decline(fromId, toId) {
  db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(fromId, toId);
}

// Unfriend (or block): removes the friendship and any pending requests either way.
function remove(a, b) {
  const [x, y] = pair(a, b);
  db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(x, y);
  db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(a, b, b, a);
  friendsOf.get(a)?.delete(b);
  friendsOf.get(b)?.delete(a);
}

module.exports = { areFriends, friendIds, incomingRequestIds, request, decline, remove };
