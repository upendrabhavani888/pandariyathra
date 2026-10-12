/** Who may see and change what. Mirrors the function list in the app, and is enforced here on the server. */
export const FUNCS = [
  'devotees', 'tickets', 'govtid', 'cancelled',
  'rep_sum', 'rep_tl', 'rep_trav', 'rep_bus', 'rep_room',
  'dist_track', 'dist_plan', 'al_bus', 'al_room', 'instr', 'annc',
  'trains', 'people', 'lists', 'bulk', 'yatras', 'brand', 'data', 'guide',
];
export const ALLF = new Set(FUNCS);
export const FRO = new Set(['rep_sum', 'rep_tl', 'rep_trav', 'rep_bus', 'rep_room', 'guide']);
export const ROLES = ['admin', 'creator', 'viewer'];

export function defaultAccess(role) {
  const rep = ['rep_sum', 'rep_tl', 'rep_trav', 'rep_bus', 'rep_room'];
  if (role === 'creator') return { view: [...rep, 'guide'], edit: ['devotees', 'tickets', 'govtid', 'cancelled', 'dist_track', 'dist_plan', 'al_bus', 'al_room', 'instr', 'annc', 'trains', 'people', 'lists', 'bulk'] };
  if (role === 'viewer') return { view: ['devotees', 'tickets', 'cancelled', ...rep, 'dist_track', 'dist_plan', 'al_bus', 'al_room', 'instr', 'annc', 'trains', 'people', 'lists', 'guide'], edit: [] };
  return { view: [...FUNCS], edit: FUNCS.filter((f) => !FRO.has(f)) };
}

/** Clean an access object: known functions only, viewers cannot change anything, view-only functions cannot be changed. */
export function normalizeAccess(role, a = {}) {
  let edit = [...new Set((a.edit || []).filter((k) => ALLF.has(k)))];
  if (role === 'viewer') edit = [];
  const moved = edit.filter((k) => FRO.has(k));
  edit = edit.filter((k) => !FRO.has(k));
  const view = [...new Set([...(a.view || []), ...moved].filter((k) => ALLF.has(k) && !edit.includes(k)))];
  return { view, edit };
}

export function can(user, fn, mode = 'view') {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!ALLF.has(fn)) return false;
  const a = user.access || {};
  const ed = (a.edit || []).includes(fn) && user.role !== 'viewer' && !FRO.has(fn);
  if (mode === 'edit') return ed;
  return ed || (a.view || []).includes(fn) || (a.edit || []).includes(fn);
}
const any = (user, fns, mode) => fns.some((f) => can(user, f, mode));

// ---- reading -------------------------------------------------------------
const DEV_READ = ['devotees', 'tickets', 'cancelled', 'rep_sum', 'rep_tl', 'rep_trav', 'rep_bus', 'rep_room', 'dist_track', 'dist_plan', 'al_bus', 'al_room'];
const TICKET_READ = ['tickets', 'rep_trav', 'dist_track', 'dist_plan'];

export function canRead(coll, user) {
  switch (coll) {
    case 'devotees': case 'teamLeads': case 'vehicles': case 'rooms': return any(user, DEV_READ, 'view') || (coll === 'teamLeads' && can(user, 'people', 'view'));
    case 'dist': return any(user, ['dist_track', 'dist_plan'], 'view');
    default: return true;           // yatras, lists, trains, trainInfo, volunteers, trainLeaders, meta, settings: needed by many screens
  }
}

/** Hide what this person may not see inside a record. Govt ID numbers and tickets are only sent when a function needs them. */
export function filterRead(coll, user, data) {
  if (coll !== 'devotees' || user.role === 'admin') return data;
  const d = { ...data };
  if (!can(user, 'govtid', 'view')) { delete d.govt_id_number; delete d.govt_id_type; delete d.govt_id_enc; }
  if (!any(user, TICKET_READ, 'view')) delete d.tickets;
  return d;
}

// ---- writing -------------------------------------------------------------
const WRITE = {
  teamLeads: ['people'], volunteers: ['people'], trainLeaders: ['people'],
  trains: ['lists'], lists: ['lists'], trainInfo: ['trains'],
  vehicles: ['al_bus'], rooms: ['al_room'], dist: ['dist_track', 'dist_plan'],
  settings: ['brand'], meta: null,
};
function groupFns(coll, key) {
  if (coll === 'devotees') {
    if (key === 'bus_no') return ['al_bus', 'devotees'];
    if (key === 'accommodation' || key === 'room_no') return ['al_room', 'devotees'];
    if (key === 'govt_id_type' || key === 'govt_id_number') return ['govtid'];
    if (key === 'tickets') return ['tickets'];
    if (key === 'status' || key === 'cancels') return ['devotees', 'cancelled'];
    return ['devotees'];
  }
  if (coll === 'yatras') {
    if (key === 'instructions') return ['instr'];
    if (key === 'announce') return ['annc'];
    if (key === 'accommodation' || key === 'darshan' || key === 'slots') return ['lists'];
    return ['yatras'];
  }
  return WRITE[coll];
}

/** May this person create or delete a record in the collection? */
export function canCreate(coll, user) {
  if (user.role === 'admin') return true;
  if (coll === 'meta') return true;
  if (coll === 'devotees') return can(user, 'devotees', 'edit');
  if (coll === 'yatras') return can(user, 'yatras', 'edit');
  return any(user, WRITE[coll] || [], 'edit');
}
export const canDelete = (coll, user) => (coll === 'devotees' ? user.role === 'admin' : canCreate(coll, user));

/**
 * What would be stored if this person saved `incoming` over `existing`?
 * Fields they may not change keep their stored value. Returns null when they may not write here at all.
 */
export function mergeWrite(coll, user, existing, incoming) {
  if (user.role === 'admin' || coll === 'meta') return incoming;
  if (Array.isArray(incoming) || !['devotees', 'yatras'].includes(coll)) return canCreate(coll, user) ? incoming : null;
  if (!existing && !canCreate(coll, user)) return null;
  const out = {};
  const keys = new Set([...Object.keys(incoming || {}), ...Object.keys(existing || {})]);
  for (const k of keys) {
    const allowed = any(user, groupFns(coll, k), 'edit');
    const src = allowed ? incoming : (existing || {});
    if (src && Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}
