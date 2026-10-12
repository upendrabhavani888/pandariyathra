import express, { Router } from 'express';
import { db, audit, getMeta, nextRev } from './db.js';
import { requireAuth, meFor } from './auth.js';
import { COLLS } from './schema.js';
import { canRead, filterRead, mergeWrite, canCreate, canDelete, can } from './perms.js';
import { encryptField, decryptField } from './crypto.js';

export const router = Router();
const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => ((o[k] = sortKeys(v[k])), o), {}) : v);
const canon = (v) => JSON.stringify(sortKeys(v));
const getRow = (coll, id) => db.prepare('SELECT * FROM records WHERE coll=? AND id=?').get(coll, id);

/** stored (Govt ID encrypted) -> readable by the app */
const plain = (coll, d) => (coll === 'devotees' && d && typeof d.govt_id_number === 'string' ? { ...d, govt_id_number: decryptField(d.govt_id_number) } : d);
/** what we store: Govt ID encrypted; unchanged IDs keep their old ciphertext so nothing changes for nothing */
function seal(coll, merged, storedOld) {
  if (coll !== 'devotees' || !merged || typeof merged.govt_id_number !== 'string' || !merged.govt_id_number) return merged;
  if (merged.govt_id_number.startsWith('enc1:')) return merged;
  if (storedOld && decryptField(storedOld.govt_id_number) === merged.govt_id_number) return { ...merged, govt_id_number: storedOld.govt_id_number };
  return { ...merged, govt_id_number: encryptField(merged.govt_id_number) };
}
/** one record as this person is allowed to see it */
export function viewOf(coll, user, row) {
  if (!row || row.deleted) return null;
  return filterRead(coll, user, plain(coll, JSON.parse(row.data)));
}

router.get('/sync', requireAuth, (req, res) => {
  const since = Number(req.query.since) || 0;
  const epoch = getMeta('epoch');
  const full = since === 0 || String(req.query.epoch || '') !== String(epoch);
  const rows = full ? db.prepare('SELECT * FROM records WHERE deleted=0').all() : db.prepare('SELECT * FROM records WHERE rev>?').all(since);
  const changes = [];
  for (const r of rows) {
    if (!canRead(r.coll, req.user)) continue;
    changes.push(r.deleted ? { coll: r.coll, id: r.id, version: r.version, deleted: true } : { coll: r.coll, id: r.id, version: r.version, data: viewOf(r.coll, req.user, r) });
  }
  const idgens = Object.fromEntries(db.prepare('SELECT yatra,gen FROM counters').all().map((c) => [c.yatra, c.gen]));
  res.json({ rev: Number(getMeta('rev')), epoch, full, changes, me: meFor(req), idgens });
});

const evaluate = db.transaction((req, ops) => {
  const user = req.user, plan = [], results = [];
  let conflict = false;
  const yid = (d) => `${d && d.yatra}|${d && d.yatra_id}`;
  for (const op of ops) {
    const { coll, id } = op;
    const ex = getRow(coll, id), live = ex && !ex.deleted;
    const cur = ex ? ex.version : 0, base = Number(op.base) || 0;
    if (!(base === cur || (ex && ex.deleted && base === 0))) { conflict = true; results.push({ coll, id, status: 'conflict', current: { version: cur, data: live && canRead(coll, user) ? viewOf(coll, user, ex) : null } }); continue; }
    if (op.data === null) {                                    // delete
      if (!live) { results.push({ coll, id, status: 'noop', version: cur }); continue; }
      if (!canDelete(coll, user)) { results.push({ coll, id, status: 'denied', current: { version: cur, data: viewOf(coll, user, ex) } }); continue; }
      plan.push({ kind: 'delete', coll, id, ex }); results.push({ coll, id, status: 'ok', version: cur + 1 }); continue;
    }
    const old = live ? JSON.parse(ex.data) : null;
    const merged = mergeWrite(coll, user, old ? plain(coll, old) : null, op.data);
    if (merged === null) { results.push({ coll, id, status: 'denied', current: { version: cur, data: live ? viewOf(coll, user, ex) : null } }); continue; }
    const stored = seal(coll, merged, old);
    if (live && JSON.stringify(stored) === ex.data) {
      // nothing would change. If they tried to change something they may not, say so; otherwise it is simply already saved
      const view = filterRead(coll, user, plain(coll, stored));
      if (canon(op.data) !== canon(view)) results.push({ coll, id, status: 'denied', current: { version: cur, data: view } });
      else results.push({ coll, id, status: 'noop', version: cur });
      continue;
    }
    plan.push({ kind: 'upsert', coll, id, ex, stored });
    const view = filterRead(coll, user, plain(coll, stored));
    results.push({ coll, id, status: 'ok', version: cur + 1, ...(JSON.stringify(view) !== JSON.stringify(op.data) ? { data: view } : {}) });
  }
  // a Yatra ID can only belong to one devotee of a yatra (checked on the final state of the whole batch, so IDs can be swapped or renumbered)
  const owners = new Map();
  for (const r of db.prepare("SELECT id, json_extract(data,'$.yatra') yt, json_extract(data,'$.yatra_id') yi FROM records WHERE coll='devotees' AND deleted=0").all()) if (r.yi) owners.set(`${r.yt}|${r.yi}`, new Set([...(owners.get(`${r.yt}|${r.yi}`) || []), r.id]));
  const mine = plan.filter((p) => p.coll === 'devotees');
  for (const p of mine) {
    if (p.ex && !p.ex.deleted) { const o = JSON.parse(p.ex.data); owners.get(yid(o))?.delete(p.id); }
    if (p.kind === 'upsert') { const k = yid(p.stored); owners.set(k, (owners.get(k) || new Set()).add(p.id)); }
  }
  for (const p of mine) {
    if (p.kind !== 'upsert' || !p.stored.yatra_id || (owners.get(yid(p.stored)) || new Set()).size < 2) continue;
    plan.splice(plan.indexOf(p), 1);
    const res = results.find((x) => x.coll === p.coll && x.id === p.id), cur = p.ex ? p.ex.version : 0;
    Object.assign(res, { status: 'denied', reason: 'duplicate_id', current: { version: cur, data: p.ex && !p.ex.deleted ? viewOf(p.coll, user, p.ex) : null } }); delete res.version; delete res.data;
  }
  if (conflict) {
    // nothing was applied. Give back the current state of every record in the batch so the app can put them all right
    for (const r of results) {
      if (r.status === 'conflict') continue;
      const ex = getRow(r.coll, r.id);
      r.status = 'skipped';
      r.current = { version: ex ? ex.version : 0, data: ex && !ex.deleted && canRead(r.coll, user) ? viewOf(r.coll, user, ex) : null };
      delete r.version; delete r.data;
    }
    return { conflict: true, results, rev: Number(getMeta('rev')) };
  }
  let rev = Number(getMeta('rev'));
  if (plan.length) {
    rev = nextRev();
    const up = db.prepare(`INSERT INTO records(coll,id,version,rev,deleted,data,updated_at,updated_by) VALUES (?,?,?,?,?,?,datetime('now'),?)
      ON CONFLICT(coll,id) DO UPDATE SET version=excluded.version, rev=excluded.rev, deleted=excluded.deleted, data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
    for (const p of plan) {
      const v = (p.ex ? p.ex.version : 0) + 1;
      if (p.kind === 'delete') up.run(p.coll, p.id, v, rev, 1, null, user.id);
      else up.run(p.coll, p.id, v, rev, 0, JSON.stringify(p.stored), user.id);
    }
    // the log: one line per change, or one line for a big batch. Never any Govt ID, password or file.
    if (plan.length > 20) {
      const by = {}; for (const p of plan) by[p.coll] = (by[p.coll] || 0) + 1;
      audit(req, 'bulk_write', null, null, by);
    } else for (const p of plan) {
      const d = p.kind === 'upsert' ? JSON.parse(JSON.stringify(plain(p.coll, p.stored))) : (p.ex && JSON.parse(p.ex.data)) || {};
      const label = d.name || d.item || d.no || undefined;
      audit(req, p.kind === 'delete' ? 'delete' : p.ex && !p.ex.deleted ? 'update' : 'create', p.coll, p.id, label ? { label: String(label).slice(0, 80) } : null);
    }
  }
  return { conflict: false, results, rev };
});

router.post('/sync', requireAuth, express.json({ limit: '60mb' }), (req, res) => {
  const raw = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (raw.length > 6000) throw httpErr(413, 'Too many changes in one go');
  const map = new Map();
  for (const o of raw) {
    if (!o || !COLLS.includes(o.coll) || typeof o.id !== 'string' || !o.id || o.id.length > 80) throw httpErr(422, 'Unknown record');
    if (o.data !== null && (typeof o.data !== 'object')) throw httpErr(422, 'A record must be an object or a list');
    if (o.data && JSON.stringify(o.data).length > 4_000_000) throw httpErr(413, 'A record is too large');
    map.set(o.coll + ':' + o.id, o);
  }
  const out = evaluate(req, [...map.values()]);
  res.status(out.conflict ? 409 : 200).json({ ok: !out.conflict, rev: out.rev, epoch: getMeta('epoch'), results: out.results });
});

// ---------------------------------------------------------------- Yatra IDs: handed out by the server so two people never get the same number
const reserve = db.transaction((yatra, n) => {
  db.prepare('INSERT OR IGNORE INTO counters(yatra,last) VALUES (?,0)').run(yatra);
  db.prepare('UPDATE counters SET last=last+? WHERE yatra=?').run(n, yatra);
  return db.prepare('SELECT last,gen FROM counters WHERE yatra=?').get(yatra);
});
router.post('/ids/reserve', requireAuth, express.json(), (req, res) => {
  if (!(can(req.user, 'devotees', 'edit') || can(req.user, 'bulk', 'edit') || can(req.user, 'tickets', 'edit'))) throw httpErr(403, 'Your profile cannot add devotees');
  const yatra = String(req.body?.yatra ?? '');
  const n = Math.max(1, Math.min(200, Number(req.body?.n) || 1));
  if (!yatra || yatra.length > 40) throw httpErr(422, 'Which yatra?');
  const c = reserve(yatra, n);
  res.json({ from: c.last - n + 1, to: c.last, gen: c.gen });
});

/** Start a yatra's numbers again. The app renumbers the devotees it knows, then sets the counter to how many there are. */
router.post('/ids/reset', requireAuth, express.json(), (req, res) => {
  if (!can(req.user, 'yatras', 'edit')) throw httpErr(403, 'Your profile cannot reset the numbering');
  const yatra = String(req.body?.yatra ?? ''), last = Number(req.body?.last);
  if (!yatra || yatra.length > 40 || !Number.isInteger(last) || last < 0 || last > 9999999) throw httpErr(422, 'Which yatra, and what number?');
  db.prepare('INSERT OR IGNORE INTO counters(yatra,last) VALUES (?,0)').run(yatra);
  db.prepare('UPDATE counters SET last=?, gen=gen+1 WHERE yatra=?').run(last, yatra);
  audit(req, 'ids_reset', 'yatras', yatra, { last });
  res.json({ ok: true, gen: db.prepare('SELECT gen FROM counters WHERE yatra=?').get(yatra).gen });
});
