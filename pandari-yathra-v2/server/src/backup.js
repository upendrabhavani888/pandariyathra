import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { db } from './db.js';

/** One consistent copy of the database per day (kept: the last BACKUP_KEEP). Returns the file, or null if today's already exists. */
export async function backupOnce() {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `yatra-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) return null;
  await db.backup(file);
  const all = fs.readdirSync(dir).filter((f) => /^yatra-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - config.backupKeep))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}
