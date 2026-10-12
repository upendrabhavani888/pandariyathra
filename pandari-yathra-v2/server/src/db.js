import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'yatra.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- every piece of the app's data is a record: (collection, id) with a version for safe editing by several people
CREATE TABLE IF NOT EXISTS records (
  coll TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL, rev INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT, updated_at TEXT NOT NULL, updated_by INTEGER,
  PRIMARY KEY (coll, id)
);
CREATE INDEX IF NOT EXISTS idx_records_rev ON records(rev);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','creator','viewer')),
  pw TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT '{}',
  token_ver INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS counters (yatra TEXT PRIMARY KEY, last INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER, username TEXT, imp_by TEXT,
  action TEXT NOT NULL, coll TEXT, rec_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`);
if (!db.prepare('PRAGMA table_info(counters)').all().some((c) => c.name === 'gen')) db.exec('ALTER TABLE counters ADD COLUMN gen INTEGER NOT NULL DEFAULT 0');   // bumped when a yatra's numbering is reset
db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('rev','0')").run();
db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('epoch','1')").run();

export const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value;
export const setMeta = (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
export function nextRev() {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='rev'").run();
  return Number(getMeta('rev'));
}

/** The audit log never stores Govt ID numbers, passwords or file contents. */
export function audit(req, action, coll = null, recId = null, detail = null) {
  const u = req?.user;
  db.prepare('INSERT INTO audit(user_id,username,imp_by,action,coll,rec_id,detail) VALUES (?,?,?,?,?,?,?)').run(
    u?.id ?? null, u?.username ?? (typeof req === 'string' ? req : 'system'), req?.imp?.username ?? null, action, coll, recId == null ? null : String(recId),
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
