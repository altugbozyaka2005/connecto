// Blocking, reporting, suspensions and the admin review API.
const express = require('express');
const db = require('./db');
const mail = require('./mail');
const { sessionFromCookieHeader, jsonOnly, displayName, isAdmin, adminEmails } = require('./auth');

const REASONS = {
  nudity: 'Nudity or sexual content',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech or symbols',
  spam: 'Spam, scam or advertising',
  underage: 'Appears to be under 18',
  violence: 'Violence, threats or self-harm',
  other: 'Something else',
};
// Reports from this many different people within the window suspend the account until reviewed.
const AUTO_SUSPEND_REPORTERS = Number(process.env.AUTO_SUSPEND_REPORTERS) || 3;
const AUTO_SUSPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_HOUR = 10;

// The realtime layer registers this so suspended users are kicked out immediately.
let onSuspend = () => {};
function setSuspendHandler(fn) { onSuspend = fn; }

// ---------- Blocks ----------
// Kept in memory as a symmetric map (accountId -> Set of accountIds) because matching checks
// every pair of searching users; the table is the source of truth.

const blockedWith = new Map();
function link(a, b) {
  if (!blockedWith.has(a)) blockedWith.set(a, new Set());
  if (!blockedWith.has(b)) blockedWith.set(b, new Set());
  blockedWith.get(a).add(b);
  blockedWith.get(b).add(a);
}
for (const r of db.prepare('SELECT blocker_id, blocked_id FROM blocks').all()) link(r.blocker_id, r.blocked_id);

function isBlocked(a, b) {
  return !!blockedWith.get(a)?.has(b);
}

function block(blockerId, blockedId) {
  if (blockerId === blockedId) return;
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blockerId, blockedId, Date.now());
  link(blockerId, blockedId);
}

function unblock(blockerId, blockedId) {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
  // Stay hidden if the other person has also blocked them.
  const reverse = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockedId, blockerId);
  if (!reverse) {
    blockedWith.get(blockerId)?.delete(blockedId);
    blockedWith.get(blockedId)?.delete(blockerId);
  }
}

// ---------- Suspensions ----------

function suspend(userId, reason) {
  db.prepare('UPDATE users SET banned_at = COALESCE(banned_at, ?), ban_reason = ? WHERE id = ?').run(Date.now(), reason, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  onSuspend(userId);
}

function unsuspend(userId) {
  db.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(userId);
}

// ---------- Reports ----------

// Returns { ok, autoSuspended } or { error }.
function createReport({ reporterId, reportedId, reason, details, context, activity, transcript }) {
  if (reporterId === reportedId) return { error: 'You can’t report yourself.' };
  if (!REASONS[reason]) return { error: 'Choose a reason for the report.' };
  const text = typeof details === 'string' ? details.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const now = Date.now();

  const recent = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?').get(reporterId, now - 60 * 60 * 1000).n;
  if (recent >= MAX_REPORTS_PER_HOUR) return { error: 'You’ve sent a lot of reports recently. Please try again later.' };

  const transcriptJson = transcript?.length ? JSON.stringify(transcript.slice(-100)) : null;
  const existing = db.prepare("SELECT id FROM reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'").get(reporterId, reportedId);
  if (existing) {
    // One open report per pair; a second one just updates it.
    db.prepare('UPDATE reports SET reason = ?, details = ?, transcript = COALESCE(?, transcript) WHERE id = ?')
      .run(reason, text || null, transcriptJson, existing.id);
  } else {
    db.prepare(`INSERT INTO reports (reporter_id, reported_id, reason, details, context, activity, transcript, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reporterId, reportedId, reason, text || null, context, activity || null, transcriptJson, now);
  }

  const reporters = db.prepare(`SELECT COUNT(DISTINCT reporter_id) AS n FROM reports
                                WHERE reported_id = ? AND status = 'open' AND created_at > ?`).get(reportedId, now - AUTO_SUSPEND_WINDOW_MS).n;
  const reported = db.prepare('SELECT * FROM users WHERE id = ?').get(reportedId);
  let autoSuspended = false;
  if (reporters >= AUTO_SUSPEND_REPORTERS && reported && !reported.banned_at) {
    suspend(reportedId, `Automatically suspended: reported by ${reporters} people within 24 hours.`);
    autoSuspended = true;
  }

  if (!existing && reported) notifyAdmins({ reported, reason, details: text, reporters, autoSuspended });
  return { ok: true, autoSuspended };
}

function notifyAdmins({ reported, reason, details, reporters, autoSuspended }) {
  const to = adminEmails();
  if (!to.length) return;
  mail.sendAdminReportEmail(to, {
    reportedName: `${reported.first_name} ${reported.last_name}`,
    reportedEmail: reported.email,
    reason: REASONS[reason],
    details,
    reporters,
    autoSuspended,
  }).catch((err) => console.error('Admin report email failed:', err.message));
}

// ---------- HTTP: own block list ----------

function requireUser(req, res, next) {
  const s = sessionFromCookieHeader(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  req.user = s.user;
  next();
}

function createBlocksRouter() {
  const router = express.Router();
  router.use(express.json(), jsonOnly, requireUser);

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT u.id, u.first_name, u.last_name, u.avatar, b.created_at FROM blocks b
                             JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).all(req.user.id);
    res.json({ blocks: rows.map((r) => ({ id: r.id, name: displayName(r), avatar: r.avatar, blockedAt: r.created_at })) });
  });

  router.delete('/:id', (req, res) => {
    unblock(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
}

// ---------- HTTP: admin review ----------

function createAdminRouter() {
  const router = express.Router();
  router.use(express.json(), jsonOnly, requireUser, (req, res, next) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
    next();
  });

  const userSummary = (prefix, r) => ({
    id: r[`${prefix}_id`],
    name: `${r[`${prefix}_first`]} ${r[`${prefix}_last`]}`,
    email: r[`${prefix}_email`],
    avatar: r[`${prefix}_avatar`] ?? null,
  });

  router.get('/reports', (req, res) => {
    const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`
      SELECT r.*,
        a.first_name AS reporter_first, a.last_name AS reporter_last, a.email AS reporter_email,
        b.first_name AS reported_first, b.last_name AS reported_last, b.email AS reported_email, b.avatar AS reported_avatar,
        b.date_of_birth AS reported_dob, b.created_at AS reported_joined, b.banned_at AS reported_banned_at,
        (SELECT COUNT(DISTINCT reporter_id) FROM reports x WHERE x.reported_id = r.reported_id) AS reported_reporters
      FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id
      ${status ? 'WHERE r.status = ?' : ''}
      ORDER BY r.created_at DESC LIMIT 200
    `).all(...(status ? [status] : []));
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        reasonLabel: REASONS[r.reason] || r.reason,
        details: r.details,
        context: r.context,
        activity: r.activity,
        transcript: r.transcript ? JSON.parse(r.transcript) : null,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note,
        reporter: userSummary('reporter', r),
        reported: {
          ...userSummary('reported', r),
          dateOfBirth: r.reported_dob,
          joinedAt: r.reported_joined,
          suspended: !!r.reported_banned_at,
          totalReporters: r.reported_reporters,
        },
      })),
    });
  });

  // action: 'dismiss' (no problem found) or 'suspend' (suspend the reported account).
  router.post('/reports/:id', (req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
    const now = Date.now();
    if (req.body?.action === 'dismiss') {
      db.prepare("UPDATE reports SET status = 'dismissed', resolved_at = ?, resolution_note = ? WHERE id = ?").run(now, note, report.id);
    } else if (req.body?.action === 'suspend') {
      suspend(report.reported_id, note || `Suspended after review of report #${report.id}.`);
      db.prepare("UPDATE reports SET status = 'actioned', resolved_at = ?, resolution_note = ? WHERE reported_id = ? AND status = 'open'")
        .run(now, note, report.reported_id);
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  });

  router.get('/suspended', (_req, res) => {
    const rows = db.prepare('SELECT id, first_name, last_name, email, avatar, banned_at, ban_reason FROM users WHERE banned_at IS NOT NULL ORDER BY banned_at DESC').all();
    res.json({ users: rows.map((u) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`, email: u.email, avatar: u.avatar, suspendedAt: u.banned_at, reason: u.ban_reason })) });
  });

  router.post('/users/:id/unsuspend', (req, res) => {
    const id = Number(req.params.id);
    unsuspend(id);
    // Pending automatic-suspension reports would re-trigger on the next report; close them.
    db.prepare("UPDATE reports SET status = 'dismissed', resolved_at = ?, resolution_note = 'Unsuspended by admin' WHERE reported_id = ? AND status = 'open'")
      .run(Date.now(), id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = {
  REASONS, isAdmin, isBlocked, block, unblock, suspend, createReport, setSuspendHandler,
  createBlocksRouter, createAdminRouter,
};
