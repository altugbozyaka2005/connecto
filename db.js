const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// DB_PATH=":memory:" is used by the tests.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'connecto.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,          -- YYYY-MM-DD
    gender        TEXT,                   -- optional
    avatar        TEXT,                   -- data URL, optional
    terms_accepted_at INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,          -- sha256 of the cookie value; raw tokens are never stored
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  -- Single-use links sent by email (verify address, reset password). Only hashes are stored.
  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);

  -- A block hides both people from each other, in both directions.
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    details     TEXT,
    context     TEXT NOT NULL,      -- 'call' or 'match'
    activity    TEXT,               -- what the reported person said they were doing
    transcript  TEXT,               -- JSON chat log relayed by the server, for reports from a call
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_note TEXT
  );
  CREATE INDEX IF NOT EXISTS reports_reported ON reports(reported_id, status);
  CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_id, created_at);

  -- Friendships are mutual and stored once, with user_a < user_b.
  CREATE TABLE IF NOT EXISTS friendships (
    user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  );

  -- "Add as friend?" said by one side, waiting for the other.
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id);

  -- A search that keeps running after you close the tab (one per person).
  CREATE TABLE IF NOT EXISTS background_searches (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    activity   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- "I'd like to connect" sent to someone who isn't online right now.
  -- pending -> accepted (both want it; call when both are online) | declined.
  CREATE TABLE IF NOT EXISTS connect_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity   TEXT NOT NULL,       -- what the sender was doing when they asked
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connect_requests_to ON connect_requests(to_id, status);
  CREATE INDEX IF NOT EXISTS connect_requests_from ON connect_requests(from_id, status);
`);

// Migrations for databases created before a column existed.
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!columns.has('email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
if (!columns.has('banned_at')) db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
if (!columns.has('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT');
// Profile extras (all optional).
if (!columns.has('bio')) db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
if (!columns.has('interests')) db.exec('ALTER TABLE users ADD COLUMN interests TEXT'); // JSON array of strings
if (!columns.has('city')) db.exec('ALTER TABLE users ADD COLUMN city TEXT');
if (!columns.has('timezone')) db.exec('ALTER TABLE users ADD COLUMN timezone TEXT'); // IANA name, e.g. Europe/Istanbul
// Email notifications for background search (on by default, throttled).
if (!columns.has('notify_email')) db.exec('ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1');
if (!columns.has('notified_at')) db.exec('ALTER TABLE users ADD COLUMN notified_at INTEGER');

module.exports = db;
