import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

/** A secret from the environment, or one generated once and kept in the data folder (mode 600). */
function secret(envName, file) {
  if (process.env[envName]) return process.env[envName];
  const f = path.join(DATA_DIR, file);
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: secret('JWT_SECRET', '.jwtsecret'),
  idKey: crypto.createHash('sha256').update(secret('ID_ENC_KEY', '.enckey')).digest(),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  anthropicBase: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  webDir: path.resolve(process.env.WEB_DIR || path.join(here, '..', '..', 'web')),
  tokenHours: Number(process.env.TOKEN_HOURS || 12),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1,
  backupKeep: Number(process.env.BACKUP_KEEP || 14),
};
