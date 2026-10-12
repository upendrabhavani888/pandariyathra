/** How the app's single data object is split into records, and put back together. */
export const ARRAY_COLLS = ['yatras', 'devotees', 'teamLeads', 'vehicles', 'dist', 'volunteers', 'trainLeaders', 'rooms'];
export const LIST_COLS = ['stations', 'airlines', 'airports', 'ownModes', 'cancelReasons', 'accommodation', 'darshan'];
export const META_KEYS = ['idv3', 'codev4', 'trSeeded', '_deleted', 'counter'];
export const SETTING_KEYS = ['logo', 'logobox', 'logotrim'];
export const COLLS = ['yatras', 'devotees', 'teamLeads', 'vehicles', 'dist', 'volunteers', 'trainLeaders', 'rooms', 'trains', 'trainInfo', 'lists', 'meta', 'settings'];

const idOf = (c, r) => String(c === 'trains' ? r.no : r.id);

/** data (the app's object, as saved in a backup) -> [{coll,id,data}] */
export function splitDB(data = {}) {
  const out = [];
  for (const c of ARRAY_COLLS) for (const r of data[c] || []) out.push({ coll: c, id: idOf(c, r), data: r });
  for (const r of data.trains || []) out.push({ coll: 'trains', id: idOf('trains', r), data: r });
  for (const [k, v] of Object.entries(data.trainInfo || {})) out.push({ coll: 'trainInfo', id: String(k), data: v });
  for (const l of LIST_COLS) if (Array.isArray(data[l])) out.push({ coll: 'lists', id: l, data: data[l] });
  const flags = {};
  for (const k of META_KEYS) if (data[k] !== undefined) flags[k] = data[k];
  out.push({ coll: 'meta', id: 'flags', data: flags });
  return out;
}

/** [{coll,id,data}] -> the app's object */
export function joinDB(records) {
  const db = { trainInfo: {} };
  for (const c of ARRAY_COLLS) db[c] = [];
  db.trains = [];
  for (const l of LIST_COLS) db[l] = [];
  for (const r of records) {
    if (ARRAY_COLLS.includes(r.coll) || r.coll === 'trains') db[r.coll].push(r.data);
    else if (r.coll === 'trainInfo') db.trainInfo[r.id] = r.data;
    else if (r.coll === 'lists') db[r.id] = r.data;
    else if (r.coll === 'meta') Object.assign(db, r.data);
  }
  for (const c of ARRAY_COLLS) db[c].sort((a, b) => Number(a.id) - Number(b.id));
  db.trains.sort((a, b) => String(a.no).localeCompare(String(b.no)));
  return db;
}
