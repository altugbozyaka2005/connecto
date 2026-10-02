// Writes a consistent snapshot of the SQLite database to $BACKUP_DIR and keeps the last 14.
// On the VPS it runs daily from cron:  docker exec connecto-connecto-1 node scripts/backup.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'connecto.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 14;

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(BACKUP_DIR, `connecto-${stamp}.db`);

const db = new DatabaseSync(DB_PATH);
// VACUUM INTO produces a clean, consistent copy even while the app is writing.
db.prepare('VACUUM INTO ?').run(target);
db.close();

const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^connecto-.*\.db$/.test(f)).sort().slice(0, -KEEP);
for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
console.log(`Backup written: ${target} (removed ${old.length} old)`);
