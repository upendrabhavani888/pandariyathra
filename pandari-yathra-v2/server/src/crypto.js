import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

// ---- passwords: salted scrypt ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [, s, h] = String(stored).split('$');
    const got = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
  } catch { return false; }
}
export const pwProblem = (pw, username) => {
  pw = String(pw || '');
  if (pw.length < 8) return 'Use at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number';
  if (pw.toLowerCase() === String(username || '').toLowerCase()) return 'The password cannot be the same as the username';
  return '';
};
export const newRecoveryCode = () => 'RC-' + [1, 2, 3, 4].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');

// ---- Govt ID numbers: AES-256-GCM at rest ----
export function encryptField(plain) {
  if (plain == null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.idKey, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc1:' + [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decryptField(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('enc1:')) return blob;
  try {
    const [iv, tag, enc] = blob.slice(5).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', config.idKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ---- login tokens ----
export const signToken = (payload) => jwt.sign(payload, config.jwtSecret, { expiresIn: `${config.tokenHours}h` });
export const verifyToken = (t) => jwt.verify(t, config.jwtSecret);
