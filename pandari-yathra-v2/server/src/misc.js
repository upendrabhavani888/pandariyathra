import express, { Router } from 'express';
import { db, audit, getMeta, setMeta, nextRev } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { config } from './config.js';
import { splitDB, joinDB, COLLS } from './schema.js';
import { can } from './perms.js';
import { encryptField, decryptField } from './crypto.js';

export const router = Router();
const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

router.get('/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

// ---------------------------------------------------------------- backup (Admin): the same file format the standalone demo makes
router.get('/backup', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT coll,id,data FROM records WHERE deleted=0').all().map((r) => {
    let d = JSON.parse(r.data);
    if (r.coll === 'devotees' && typeof d.govt_id_number === 'string') d = { ...d, govt_id_number: decryptField(d.govt_id_number) };
    return { coll: r.coll, id: r.id, data: d };
  });
  const logoRec = rows.find((r) => r.coll === 'settings' && r.id === 'logo');
  const data = joinDB(rows.filter((r) => r.coll !== 'settings'));
  data.users = []; data.auth = {};
  const file = { app: 'pandari-yathra', v: 1, id: 'srv' + Date.now().toString(36), at: new Date().toISOString(), data, logo: logoRec?.data?.v || '', cur: '' };
  audit(req, 'backup_downloaded', null, null, { devotees: data.devotees.length });
  res.setHeader('Content-Disposition', `attachment; filename="pandari-yathra-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(file));
});

// ---------------------------------------------------------------- restore / import a demo backup (Admin). Replaces everything.
const restore = db.transaction((req, data, logo) => {
  const recs = splitDB(data);
  if (logo) recs.push({ coll: 'settings', id: 'logo', data: { v: logo } });
  db.prepare('DELETE FROM records').run();
  db.prepare('DELETE FROM counters').run();
  const rev = nextRev();
  const ins = db.prepare("INSERT INTO records(coll,id,version,rev,deleted,data,updated_at,updated_by) VALUES (?,?,1,?,0,?,datetime('now'),?)");
  const counts = {};
  for (const r of recs) {
    let d = r.data;
    if (r.coll === 'devotees' && d && d.govt_id_number && !String(d.govt_id_number).startsWith('enc1:')) d = { ...d, govt_id_number: encryptField(String(d.govt_id_number)) };
    ins.run(r.coll, r.id, rev, JSON.stringify(d), req.user.id);
    counts[r.coll] = (counts[r.coll] || 0) + 1;
  }
  // Yatra ID counters continue after the highest number already used, so IDs are never reused
  const top = new Map();
  for (const d of data.devotees || []) { const m = /-(\d+)$/.exec(String(d.yatra_id || '')); if (m) top.set(String(d.yatra), Math.max(top.get(String(d.yatra)) || 0, Number(m[1]))); }
  for (const y of data.yatras || []) db.prepare('INSERT INTO counters(yatra,last) VALUES (?,?)').run(String(y.id), Math.max(Number(y.counter) || 0, top.get(String(y.id)) || 0));
  setMeta('epoch', Number(getMeta('epoch')) + 1);
  audit(req, 'restore', null, null, counts);
  return counts;
});
router.post('/restore', requireAuth, requireAdmin, express.json({ limit: '150mb' }), (req, res) => {
  const body = req.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  if (!Array.isArray(data.devotees) || !Array.isArray(data.yatras)) throw httpErr(422, 'This does not look like a Pandari Yathra backup file');
  const counts = restore(req, data, body.logo || data.logo || '');
  res.json({ ok: true, counts });
});

// ---------------------------------------------------------------- audit log (Admin)
router.get('/audit', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100)), offset = Math.max(0, Number(req.query.offset) || 0);
  const where = [], args = [];
  if (req.query.user) { where.push('username = ? COLLATE NOCASE'); args.push(String(req.query.user)); }
  if (req.query.action) { where.push('action = ?'); args.push(String(req.query.action)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM audit ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT id,at,username,imp_by,action,coll,rec_id,detail FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ total, rows });
});

// ---------------------------------------------------------------- ticket reading with Claude: the key stays on the server
const buckets = new Map();
router.post('/claude', requireAuth, express.json({ limit: '16mb' }), async (req, res) => {
  if (!config.anthropicKey) throw httpErr(503, 'Ticket reading with Claude is not set up on this server');
  if (!(can(req.user, 'devotees', 'edit') || can(req.user, 'tickets', 'edit') || can(req.user, 'bulk', 'edit'))) throw httpErr(403, 'Your profile cannot read tickets');
  const b = req.body || {};
  const now = Date.now(), arr = (buckets.get(req.user.id) || []).filter((t) => now - t < 60000);
  if (arr.length >= 20) throw httpErr(429, 'Too many tickets in a minute. Wait a little');
  arr.push(now); buckets.set(req.user.id, arr);
  if (!Array.isArray(b.messages) || !b.messages.length) throw httpErr(422, 'Nothing to read');
  if (b.tools && !(Array.isArray(b.tools) && b.tools.every((t) => t && t.input_schema && !t.type))) throw httpErr(422, 'That tool is not allowed');
  const body = { model: config.anthropicModel, max_tokens: Math.min(Number(b.max_tokens) || 2000, 4000), messages: b.messages };
  for (const k of ['temperature', 'system', 'tools', 'tool_choice']) if (b[k] !== undefined) body[k] = b[k];
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(`${config.anthropicBase}/v1/messages`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    const text = await r.text();
    audit(req, 'ticket_read', null, null, { status: r.status });
    res.status(r.status).type('application/json').send(text);
  } catch (e) { throw httpErr(504, e.name === 'AbortError' ? 'Claude took too long' : 'Could not reach Claude'); } finally { clearTimeout(to); }
});
