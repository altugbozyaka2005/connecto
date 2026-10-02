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
`);

// Migrations for databases created before a column existed.
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!columns.has('email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
if (!columns.has('banned_at')) db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
if (!columns.has('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT');

module.exports = db;
