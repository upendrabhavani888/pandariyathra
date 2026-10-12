import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import { db, audit, getMeta, setMeta } from './db.js';
import { config, DATA_DIR } from './config.js';
import { hashPassword, verifyPassword, pwProblem, newRecoveryCode, signToken, verifyToken } from './crypto.js';
import { defaultAccess, normalizeAccess, ROLES, can } from './perms.js';

export const router = Router();
const json = express.json({ limit: '1mb' });
const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------------------------------------------------------------- users
const parseAccess = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
export function publicUser(u) {
  const access = u.role === 'admin' ? defaultAccess('admin') : normalizeAccess(u.role, parseAccess(u.access));
  return { id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, must: !!u.must_change, access, last: u.last_login || '', created: u.created_at };
}
const aclHash = (u) => crypto.createHash('sha1').update(JSON.stringify([u.role, u.active, u.access, u.must])).digest('hex').slice(0, 12);
export const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
const activeAdmins = (exceptId = 0) => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(exceptId).n;
const findUser = (name) => db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(name || '').trim());
export const meFor = (req) => ({ ...req.user, acl: aclHash(req.user), impBy: req.imp ? { id: req.imp.id, name: req.imp.name } : null, claude: !!config.anthropicKey });

// ---------------------------------------------------------------- one-time setup code (so a stranger cannot claim the Admin account)
const SETUP_FILE = path.join(DATA_DIR, '.setup-code');
export function prepareSetupCode() {
  if (userCount() > 0) { fs.rmSync(SETUP_FILE, { force: true }); return null; }
  if (!fs.existsSync(SETUP_FILE)) fs.writeFileSync(SETUP_FILE, crypto.randomBytes(4).toString('hex').toUpperCase(), { mode: 0o600 });
  return fs.readFileSync(SETUP_FILE, 'utf8').trim();
}

// ---------------------------------------------------------------- slowing down password guessing
const fails = new Map();
const NOW = () => Date.now();
function lockLeft(key) { const f = fails.get(key); return f && f.until > NOW() ? Math.ceil((f.until - NOW()) / 1000) : 0; }
function noteFail(key, limit, lockMs) {
  const f = fails.get(key) || { n: 0, until: 0, first: NOW() };
  if (NOW() - f.first > 600000) { f.n = 0; f.first = NOW(); }
  f.n++;
  if (f.n >= limit) { f.until = NOW() + lockMs; f.n = 0; f.first = NOW(); }
  fails.set(key, f);
}
setInterval(() => { for (const [k, f] of fails) if (f.until < NOW() && NOW() - f.first > 600000) fails.delete(k); }, 600000).unref();
export function _resetLimits() { fails.clear(); }
function checkLimits(req, username) {
  const w = Math.max(lockLeft('u:' + String(username).toLowerCase()), lockLeft('ip:' + req.ip));
  if (w) throw httpErr(429, `Too many wrong tries. Wait ${w} seconds and try again`, { wait: w });
}
function failed(req, username) { noteFail('u:' + String(username).toLowerCase(), 5, 60000); noteFail('ip:' + req.ip, 30, 300000); }

// ---------------------------------------------------------------- middleware
const OK_WHEN_MUST = /^\/(me|auth\/(password|logout|status))$/;
export function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw httpErr(401, 'Sign in first');
    let p; try { p = verifyToken(h.slice(7)); } catch { throw httpErr(401, 'Your sign-in has expired. Please sign in again'); }
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.uid);
    if (!u || !u.active || u.token_ver !== p.tv) throw httpErr(401, 'Please sign in again');
    if (p.imp) {
      const a = db.prepare('SELECT * FROM users WHERE id=?').get(p.imp);
      if (!a || !a.active || a.role !== 'admin' || a.token_ver !== p.itv) throw httpErr(401, 'Please sign in again');
      req.imp = { id: a.id, name: a.name, username: a.username, ver: a.token_ver };
    }
    req.user = publicUser(u);
    if (u.must_change && !OK_WHEN_MUST.test(req.path)) throw httpErr(403, 'Choose a new password first', { must: true });
    next();
  } catch (e) { next(e); }
}
export const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : next(httpErr(403, 'Only an Admin can do this')));
const tokenFor = (u, imp) => signToken(imp ? { uid: u.id, tv: u.token_ver, imp: imp.id, itv: imp.token_ver } : { uid: u.id, tv: u.token_ver });

// ---------------------------------------------------------------- public routes
router.get('/auth/status', (req, res) => {
  const setup = userCount() === 0;
  res.json({ setup, needsCode: setup && !!prepareSetupCode(), claude: !!config.anthropicKey, app: 'pandari-yathra', v: 2 });
});

router.post('/auth/setup', json, (req, res) => {
  if (userCount() > 0) throw httpErr(409, 'This portal is already set up');
  const code = prepareSetupCode();
  const { name, username, password, setupCode } = req.body || {};
  checkLimits(req, 'setup');
  if (!code || String(setupCode || '').trim().toUpperCase() !== code) { failed(req, 'setup'); throw httpErr(403, 'The setup code is not right. It is printed where the server starts (or saved in the data folder as .setup-code)'); }
  if (!String(name || '').trim()) throw httpErr(422, 'Enter your name');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(String(username || ''))) throw httpErr(422, 'Username: 3 to 30 letters, numbers, dot, dash or underscore');
  const pr = pwProblem(password, username); if (pr) throw httpErr(422, pr);
  const info = db.prepare('INSERT INTO users(username,name,role,pw,access,last_login) VALUES (?,?,?,?,?,datetime(\'now\'))').run(String(username).trim(), String(name).trim(), 'admin', hashPassword(password), '{}');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const recovery = newRecoveryCode();
  setMeta('recovery_hash', hashPassword(recovery)); setMeta('recovery_uid', u.id);
  fs.rmSync(SETUP_FILE, { force: true });
  req.user = publicUser(u); audit(req, 'setup', 'users', u.id, { username: u.username });
  res.status(201).json({ token: tokenFor(u), user: publicUser(u), recoveryCode: recovery });
});

router.post('/auth/login', json, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw httpErr(422, 'Enter your username and password');
  checkLimits(req, username);
  const u = findUser(username);
  const ok = u && u.active && verifyPassword(password, u.pw);
  if (!ok) {
    failed(req, username); audit(String(username).slice(0, 40), 'login_failed', 'users', u?.id ?? null, { ip: req.ip });
    throw httpErr(401, u && !u.active ? 'This account is switched off. Ask the Admin' : 'The username or password is not right');
  }
  fails.delete('u:' + String(username).toLowerCase());
  db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(u.id);
  req.user = publicUser(u); audit(req, 'login', 'users', u.id);
  res.json({ token: tokenFor(u), user: publicUser(u), must: !!u.must_change });
});

router.post('/auth/recover', json, (req, res) => {
  const { code, password } = req.body || {};
  checkLimits(req, 'recover');
  const hash = getMeta('recovery_hash'), uid = Number(getMeta('recovery_uid'));
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!hash || !u) throw httpErr(404, 'No recovery code is set up on this server');
  if (!verifyPassword(String(code || '').trim().toUpperCase(), hash)) { failed(req, 'recover'); throw httpErr(403, 'That recovery code is not right'); }
  const pr = pwProblem(password, u.username); if (pr) throw httpErr(422, pr);
  db.prepare('UPDATE users SET pw=?, active=1, must_change=0, token_ver=token_ver+1 WHERE id=?').run(hashPassword(password), u.id);
  const recovery = newRecoveryCode(); setMeta('recovery_hash', hashPassword(recovery));
  req.user = publicUser(u); audit(req, 'recover', 'users', u.id);
  res.json({ ok: true, recoveryCode: recovery });
});

// ---------------------------------------------------------------- signed-in routes
router.get('/me', requireAuth, (req, res) => res.json(meFor(req)));
router.post('/auth/logout', requireAuth, json, (req, res) => { audit(req, 'logout'); res.json({ ok: true }); });

router.post('/auth/password', requireAuth, json, (req, res) => {
  if (req.imp) throw httpErr(403, 'You cannot change a password while signed in as someone else');
  const { current, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!row.must_change && !verifyPassword(current, row.pw)) throw httpErr(403, 'The current password is not right');
  const pr = pwProblem(password, row.username); if (pr) throw httpErr(422, pr);
  db.prepare('UPDATE users SET pw=?, must_change=0, token_ver=token_ver+1 WHERE id=?').run(hashPassword(password), row.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(row.id);
  audit(req, 'password_changed', 'users', u.id);
  res.json({ token: tokenFor(u), user: publicUser(u) });
});

router.post('/auth/impersonate', requireAuth, requireAdmin, json, (req, res) => {
  if (req.imp) throw httpErr(403, 'You are already signed in as someone else');
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.body?.id));
  if (!t || !t.active) throw httpErr(404, 'That person cannot be signed in as');
  if (t.id === req.user.id) throw httpErr(422, 'That is you');
  const adminRow = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  audit(req, 'impersonate_start', 'users', t.id, { target: t.username });
  res.json({ token: tokenFor(t, adminRow), user: publicUser(t), impBy: { id: adminRow.id, name: adminRow.name } });
});
router.post('/auth/back', requireAuth, json, (req, res) => {
  if (!req.imp) throw httpErr(400, 'You are not signed in as someone else');
  const adminRow = db.prepare('SELECT * FROM users WHERE id=?').get(req.imp.id);
  audit(req, 'impersonate_end', 'users', req.user.id);
  res.json({ token: tokenFor(adminRow), user: publicUser(adminRow) });
});

// ---------------------------------------------------------------- user management (Admin)
router.get('/users', requireAuth, requireAdmin, (req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser) }));

router.post('/users', requireAuth, requireAdmin, json, (req, res) => {
  const { name, username, role, password } = req.body || {};
  if (!String(name || '').trim()) throw httpErr(422, 'Enter the name');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(String(username || ''))) throw httpErr(422, 'Username: 3 to 30 letters, numbers, dot, dash or underscore');
  if (!ROLES.includes(role)) throw httpErr(422, 'Choose a profile');
  if (findUser(username)) throw httpErr(409, 'That username is already used');
  const pr = pwProblem(password, username); if (pr) throw httpErr(422, 'Password: ' + pr);
  const info = db.prepare('INSERT INTO users(username,name,role,pw,must_change,access) VALUES (?,?,?,?,1,?)').run(String(username).trim(), String(name).trim(), role, hashPassword(password), JSON.stringify(defaultAccess(role)));
  audit(req, 'user_created', 'users', info.lastInsertRowid, { username, role });
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)) });
});

router.put('/users/:id', requireAuth, requireAdmin, json, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw httpErr(404, 'Not found');
  const { name, username, role } = req.body || {};
  if (!String(name || '').trim()) throw httpErr(422, 'Enter the name');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(String(username || ''))) throw httpErr(422, 'Username: 3 to 30 letters, numbers, dot, dash or underscore');
  const dup = findUser(username); if (dup && dup.id !== u.id) throw httpErr(409, 'That username is already used');
  const newRole = u.id === req.user.id ? u.role : role;
  if (!ROLES.includes(newRole)) throw httpErr(422, 'Choose a profile');
  if (u.role === 'admin' && newRole !== 'admin' && activeAdmins(u.id) === 0) throw httpErr(409, 'There must be at least one active Admin');
  const changed = newRole !== u.role;
  db.prepare('UPDATE users SET name=?, username=?, role=?, access=?, token_ver=token_ver+? WHERE id=?').run(String(name).trim(), String(username).trim(), newRole, changed ? JSON.stringify(defaultAccess(newRole)) : u.access, changed ? 1 : 0, u.id);
  audit(req, 'user_updated', 'users', u.id, { username, role: newRole, accessReset: changed });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)), accessReset: changed });
});

router.put('/users/:id/access', requireAuth, requireAdmin, json, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw httpErr(404, 'Not found');
  if (u.role === 'admin') throw httpErr(422, 'Admins can use every function');
  const access = normalizeAccess(u.role, req.body?.access);
  db.prepare('UPDATE users SET access=? WHERE id=?').run(JSON.stringify(access), u.id);
  audit(req, 'access_changed', 'users', u.id, { view: access.view.length, edit: access.edit.length });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

router.post('/users/:id/password', requireAuth, requireAdmin, json, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw httpErr(404, 'Not found');
  const pr = pwProblem(req.body?.password, u.username); if (pr) throw httpErr(422, pr);
  db.prepare('UPDATE users SET pw=?, must_change=1, token_ver=token_ver+1 WHERE id=?').run(hashPassword(req.body.password), u.id);
  audit(req, 'password_reset', 'users', u.id);
  res.json({ ok: true });
});

router.post('/users/:id/active', requireAuth, requireAdmin, json, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw httpErr(404, 'Not found');
  const active = req.body?.active ? 1 : 0;
  if (u.id === req.user.id) throw httpErr(422, 'You cannot switch yourself off');
  if (!active && u.role === 'admin' && activeAdmins(u.id) === 0) throw httpErr(409, 'There must be at least one active Admin');
  db.prepare('UPDATE users SET active=?, token_ver=token_ver+1 WHERE id=?').run(active, u.id);
  audit(req, active ? 'user_on' : 'user_off', 'users', u.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw httpErr(404, 'Not found');
  if (u.id === req.user.id) throw httpErr(422, 'You cannot delete yourself');
  if (u.role === 'admin' && activeAdmins(u.id) === 0) throw httpErr(409, 'There must be at least one active Admin');
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(req, 'user_deleted', 'users', u.id, { username: u.username });
  res.json({ ok: true });
});
