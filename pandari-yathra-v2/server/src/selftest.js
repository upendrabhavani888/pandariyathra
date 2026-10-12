// Runs the real server on a temporary database and tests it through its API:  npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'py2-test-'));
const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? pass++ : fail++; console.log(`${c ? '  PASS' : '  FAIL'}  ${m}${!c && x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 300) : ''}`); };
const section = (s) => console.log(`\n${s}`);

// ---- a pretend Claude
let lastClaude = null;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { lastClaude = { headers: req.headers, body: JSON.parse(b || '{}') }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_ticket', input: { pnr: '1234567890' } }] })); });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// ---- the real server
const webDir = path.join(dir, 'web'); fs.mkdirSync(webDir); fs.writeFileSync(path.join(webDir, 'index.html'), '<html>app</html>');
const child = spawn(process.execPath, [path.join(here, 'index.js')], { env: { ...process.env, PORT, DATA_DIR: path.join(dir, 'data'), WEB_DIR: webDir, ANTHROPIC_API_KEY: 'sk-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
for (let i = 0; i < 100 && !out.includes('server on'); i++) await new Promise((r) => setTimeout(r, 100));
if (!out.includes('server on')) { console.log('server did not start:\n' + out); process.exit(1); }

async function call(method, url, token, body, extra = {}) {
  const r = await fetch(BASE + url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', null, { username: u, password: p }));

let raw;
try {
  section('First-time setup');
  let r = await call('GET', '/api/auth/status');
  ok(r.body.setup === true && r.body.needsCode === true && r.body.claude === true, 'a new server asks for setup, with a setup code', r.body);
  const code = fs.readFileSync(path.join(dir, 'data', '.setup-code'), 'utf8').trim();
  ok(out.includes(code), 'the setup code is printed where the server starts');
  r = await call('POST', '/api/auth/setup', null, { name: 'Hari', username: 'admin', password: 'Admin#2026x', setupCode: 'WRONG' });
  ok(r.status === 403, 'setup with a wrong code is refused');
  r = await call('POST', '/api/auth/setup', null, { name: 'Hari', username: 'admin', password: 'short', setupCode: code });
  ok(r.status === 422, 'a weak password is refused', r.body);
  r = await call('POST', '/api/auth/setup', null, { name: 'Hari Prasad', username: 'admin', password: 'Admin#2026x', setupCode: code });
  ok(r.status === 201 && r.body.token && /^RC-/.test(r.body.recoveryCode) && r.body.user.role === 'admin', 'setup creates the Admin and gives a recovery code', r.body);
  let admin = r.body.token; const recovery = r.body.recoveryCode;
  ok(!fs.existsSync(path.join(dir, 'data', '.setup-code')), 'the setup code is removed once used');
  r = await call('POST', '/api/auth/setup', null, { name: 'Eve', username: 'eve', password: 'Eve#2026xx', setupCode: code });
  ok(r.status === 409, 'a second setup is refused');
  raw = new Database(path.join(dir, 'data', 'yatra.db'), { readonly: true });
  const pwRow = raw.prepare("SELECT pw FROM users WHERE username='admin'").get().pw;
  ok(pwRow.startsWith('scrypt$') && !pwRow.includes('Admin#2026x'), 'passwords are stored as salted hashes, never in clear');

  section('Signing in and slowing down guessing');
  r = await login('admin', 'wrong-password1'); ok(r.status === 401, 'a wrong password is refused');
  for (let i = 0; i < 5; i++) r = await login('ghost', 'nope' + i + 'aaaa');
  ok(r.status === 401, 'five wrong tries are each refused');
  r = await login('ghost', 'nope6aaaa');
  ok(r.status === 429 && r.body.wait > 0, 'then sign-in makes them wait', r.body);
  r = await login('ghost', 'whatever123'); ok(r.status === 429, 'even another try is refused while waiting');
  r = await login('ADMIN', 'Admin#2026x'); ok(r.status === 200 && r.body.user.username === 'admin', 'a right password works (username not case sensitive)', r.body);
  admin = r.body.token;
  r = await call('GET', '/api/me', null); ok(r.status === 401, 'no token, no access');
  r = await call('GET', '/api/me', 'garbage'); ok(r.status === 401, 'a fake token is refused');

  section('Recovery code');
  r = await call('POST', '/api/auth/recover', null, { code: 'RC-0000-0000-0000-0000', password: 'New#Pass2026' }); ok(r.status === 403, 'a wrong recovery code is refused');
  r = await call('POST', '/api/auth/recover', null, { code: recovery.toLowerCase(), password: 'New#Pass2026' }); ok(r.status === 200 && /^RC-/.test(r.body.recoveryCode) && r.body.recoveryCode !== recovery, 'the right code resets the Admin password and issues a new code', r.body);
  r = await call('GET', '/api/me', admin); ok(r.status === 401, 'the old sign-in stopped working after the reset');
  r = await login('admin', 'New#Pass2026'); ok(r.status === 200, 'the new password works'); admin = r.body.token;

  section('Managing users');
  r = await call('POST', '/api/users', admin, { name: 'Chitra Creator', username: 'chitra', role: 'creator', password: 'Temp#1234ab' });
  ok(r.status === 201 && r.body.user.must === true && r.body.user.access.edit.includes('devotees'), 'Admin adds a Creator with the Creator default access', r.body);
  const chitraId = r.body.user.id;
  r = await call('POST', '/api/users', admin, { name: 'Vijay Viewer', username: 'vijay', role: 'viewer', password: 'Temp#1234ab' }); const vijayId = r.body.user.id;
  r = await call('POST', '/api/users', admin, { name: 'Dup', username: 'CHITRA', role: 'creator', password: 'Temp#1234ab' }); ok(r.status === 409, 'a duplicate username is refused');
  r = await call('POST', '/api/users', admin, { name: 'Weak', username: 'weak1', role: 'creator', password: 'abc' }); ok(r.status === 422, 'a weak temporary password is refused');
  r = await login('chitra', 'Temp#1234ab'); let chitra = r.body.token; ok(r.body.must === true, 'a new person must choose their own password');
  r = await call('GET', '/api/sync?since=0', chitra); ok(r.status === 403 && r.body.must === true, 'until then nothing else works', r.body);
  r = await call('POST', '/api/auth/password', chitra, { password: 'Mine#5678cd' }); ok(r.status === 200 && r.body.token, 'choosing a new password works (no current password needed the first time)', r.body); const chitraOld = chitra; chitra = r.body.token;
  r = await call('GET', '/api/me', chitraOld); ok(r.status === 401, 'the temporary sign-in stopped working');
  r = await call('GET', '/api/users', chitra); ok(r.status === 403, 'a Creator cannot manage users');
  r = await login('vijay', 'Temp#1234ab'); let vijay = (await call('POST', '/api/auth/password', r.body.token, { password: 'Vij#5678cd' })).body.token;
  r = await call('PUT', `/api/users/${vijayId}/access`, admin, { access: { view: ['devotees', 'rep_bus', 'nonsense'], edit: ['devotees', 'al_bus'] } });
  ok(r.status === 200 && r.body.user.access.edit.length === 0 && r.body.user.access.view.includes('devotees') && !r.body.user.access.view.includes('nonsense'), 'a Viewer can never be given change access, and unknown functions are dropped', r.body.user.access);
  r = await call('PUT', `/api/users/${chitraId}/access`, admin, { access: { view: ['rep_bus'], edit: ['devotees', 'rep_bus'] } });
  ok(r.body.user.access.view.includes('rep_bus') && !r.body.user.access.edit.includes('rep_bus'), 'view-only functions cannot be given change access', r.body.user.access);
  r = await call('PUT', `/api/users/1`, admin, { name: 'Hari', username: 'admin', role: 'viewer' }); ok(r.body.user.role === 'admin', 'an Admin cannot demote themselves');
  r = await call('POST', '/api/users/1/active', admin, { active: false }); ok(r.status === 422, 'an Admin cannot switch themselves off');
  r = await call('DELETE', '/api/users/1', admin); ok(r.status === 422, 'an Admin cannot delete themselves');

  section('Shared data: records, versions and conflicts');
  // give Chitra a realistic Creator again for the data tests
  await call('PUT', `/api/users/${chitraId}/access`, admin, { access: { view: ['rep_sum', 'guide'], edit: ['devotees', 'cancelled', 'al_bus', 'people', 'lists', 'instr'] } });
  const dev = (id, extra = {}) => ({ id, yatra: 1, yatra_id: `PY-2026-Y1-000${id}`, team_lead_id: 1, name: 'Ramesh Kumar', age: 45, gender: 'Male', accommodation: 'Bhakta Niwas', room_no: '12', bus_no: 'Bus 1', govt_id_type: 'Aadhaar', govt_id_number: '234567890123', darshan: 'Free Darshan', tickets: { onward: { train_no: '16541', pnr: '8123456790' }, return: null, additional: [] }, ...extra });
  r = await call('POST', '/api/sync', admin, { ops: [
    { coll: 'yatras', id: '1', base: 0, data: { id: 1, code: 'Y1', counter: 0, name: 'Pandari Yathra', start: '2026-11-13', end: '2026-11-19', instructions: 'Be kind', slots: [] } },
    { coll: 'teamLeads', id: '1', base: 0, data: { id: 1, name: 'Suresh Babu', mobile: '9845012345' } },
    { coll: 'devotees', id: '1', base: 0, data: dev(1) },
    { coll: 'devotees', id: '2', base: 0, data: dev(2, { name: 'Lakshmi Devi', govt_id_number: '987654321098' }) },
    { coll: 'lists', id: 'stations', base: 0, data: ['Hosur (HSRA)', 'Solapur (SUR)'] },
    { coll: 'meta', id: 'flags', base: 0, data: { idv3: true, codev4: true } },
  ] });
  ok(r.status === 200 && r.body.results.every((x) => x.status === 'ok' && x.version === 1), 'Admin saves a batch of records', r.body);
  const rawRow = raw.prepare("SELECT data FROM records WHERE coll='devotees' AND id='1'").get().data;
  ok(!rawRow.includes('234567890123') && rawRow.includes('enc1:'), 'Govt ID numbers are encrypted in the database file', rawRow.slice(0, 200));
  r = await call('GET', '/api/sync?since=0', admin);
  ok(r.body.full && r.body.changes.find((c) => c.coll === 'devotees' && c.id === '1').data.govt_id_number === '234567890123' && r.body.rev >= 1, 'Admin reads them back, Govt ID decrypted', r.body.rev);
  const rev1 = r.body.rev, epoch = r.body.epoch;
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '1', base: 1, data: dev(1, { room_no: '14' }) }] });
  ok(r.status === 200 && r.body.results[0].version === 2, 'an edit made on the latest version is saved', r.body);
  r = await call('GET', `/api/sync?since=${rev1}&epoch=${epoch}`, chitra);
  ok(!r.body.full && r.body.changes.length === 1 && r.body.changes[0].data.room_no === '14', 'other people receive only what changed since they last looked', r.body.changes.length);
  // two people edit the same record from the same starting point
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '1', base: 2, data: dev(1, { room_no: '20' }) }] });
  r = await call('POST', '/api/sync', chitra, { ops: [{ coll: 'devotees', id: '1', base: 2, data: dev(1, { room_no: '30', age: 46 }) }, { coll: 'devotees', id: '2', base: 1, data: dev(2, { name: 'Lakshmi D', govt_id_number: '987654321098' }) }] });
  ok(r.status === 409 && r.body.results.find((x) => x.id === '1').status === 'conflict' && r.body.results.find((x) => x.id === '1').current.data.room_no === '20', 'the second person is told about the clash and shown the current record', r.body.results);
  const lak = raw.prepare("SELECT data FROM records WHERE coll='devotees' AND id='2'").get().data;
  ok(!lak.includes('Lakshmi D"'), 'nothing from that batch was applied (all or nothing)', lak.slice(0, 120));

  section('What each profile may change (enforced by the server)');
  r = await call('POST', '/api/sync', chitra, { ops: [{ coll: 'devotees', id: '1', base: 3, data: dev(1, { room_no: '21', name: 'Ramesh K', tickets: { onward: { train_no: '99999', pnr: '0000000000' }, return: null, additional: [] }, govt_id_number: '000000000000' }) }] });
  ok(r.status === 200 && r.body.results[0].status === 'ok', 'a Creator saves a devotee');
  r = await call('GET', '/api/sync?since=0', admin); const d1 = r.body.changes.find((c) => c.coll === 'devotees' && c.id === '1').data;
  ok(d1.name === 'Ramesh K' && d1.room_no === '21', 'the details they may change were saved', d1);
  ok(d1.tickets.onward.pnr === '8123456790' && d1.govt_id_number === '234567890123', 'tickets and the Govt ID, which they may not change, kept their stored value', d1.tickets);
  r = await call('GET', '/api/sync?since=0', chitra); const c1 = r.body.changes.find((c) => c.coll === 'devotees' && c.id === '1').data;
  ok(c1.govt_id_number === undefined && c1.govt_id_type === undefined && c1.tickets === undefined, 'and they are not even sent the Govt ID or the tickets they have no function for', Object.keys(c1));
  r = await call('POST', '/api/sync', chitra, { ops: [{ coll: 'devotees', id: '1', base: 4, data: null }] }); ok(r.results === undefined && r.body.results[0].status === 'denied', 'a Creator cannot delete a devotee');
  r = await call('POST', '/api/sync', chitra, { ops: [{ coll: 'vehicles', id: '5', base: 0, data: { id: 5, name: 'Bus 1' } }, { coll: 'rooms', id: '5', base: 0, data: { id: 5 } }, { coll: 'trainInfo', id: '16541', base: 0, data: { number: '16541' } }] });
  ok(r.body.results[0].status === 'ok' && r.body.results[1].status === 'denied' && r.body.results[2].status === 'denied', 'buses are allowed, rooms and train timetables are not (no function for them)', r.body.results.map((x) => x.status));
  r = await call('POST', '/api/sync', chitra, { ops: [{ coll: 'yatras', id: '1', base: 1, data: { id: 1, code: 'Y1', counter: 0, name: 'HACKED', start: '2026-11-13', end: '2026-11-19', instructions: 'New instructions', slots: [] } }] });
  r = await call('GET', '/api/sync?since=0', admin); const y1 = r.body.changes.find((c) => c.coll === 'yatras' && c.id === '1').data;
  ok(y1.instructions === 'New instructions' && y1.name === 'Pandari Yathra', 'she can edit the instructions but not rename the yatra', y1);
  r = await call('POST', '/api/sync', vijay, { ops: [{ coll: 'devotees', id: '1', base: 4, data: dev(1, { room_no: '99' }) }, { coll: 'teamLeads', id: '9', base: 0, data: { id: 9, name: 'X', mobile: '1' } }] });
  ok(r.body.results.every((x) => x.status === 'denied'), 'a Viewer cannot change anything', r.body.results);
  r = await call('GET', '/api/sync?since=0', vijay);
  ok(r.body.changes.some((c) => c.coll === 'devotees') && !r.body.changes.some((c) => c.coll === 'dist') && !r.body.changes.find((c) => c.coll === 'devotees').data.govt_id_number, 'a Viewer sees devotees but not Govt IDs', r.body.changes.length);
  await call('PUT', `/api/users/${vijayId}/access`, admin, { access: { view: ['instr'], edit: [] } });
  r = await call('GET', '/api/sync?since=0', vijay); ok(!r.body.changes.some((c) => c.coll === 'devotees'), 'someone with no devotee function is not sent devotees at all');
  ok(r.body.me.acl !== undefined, 'every reply carries the person\'s current access, so changes by the Admin apply at once');
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '2', base: 1, data: null }] }); ok(r.body.results[0].status === 'ok', 'Admin can delete a devotee');
  r = await call('GET', `/api/sync?since=${rev1}&epoch=${epoch}`, admin); ok(r.body.changes.some((c) => c.id === '2' && c.deleted === true), 'a delete reaches other people as a delete');
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '2', base: 0, data: dev(2, { name: 'Recreated' }) }] }); ok(r.body.results[0].status === 'ok', 'an id can be created again after it was deleted');
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'nonsense', id: '1', base: 0, data: {} }] }); ok(r.status === 422, 'unknown collections are refused');

  section('Yatra IDs');
  const batches = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/api/ids/reserve', admin, { yatra: '1', n: 3 })));
  const nums = batches.flatMap((b) => [b.body.from, b.body.from + 1, b.body.to]).sort((a, b) => a - b);
  ok(new Set(nums).size === 60 && nums[0] === 1 && nums[59] === 60, '20 people asking at once get 60 different, gapless numbers', nums.slice(0, 8));
  r = await call('POST', '/api/ids/reserve', vijay, { yatra: '1', n: 1 }); ok(r.status === 403, 'a Viewer cannot take numbers');

  section('Starting the Yatra ID numbers again');
  r = await call('POST', '/api/ids/reserve', admin, { yatra: '1', n: 2 }); const genBefore = r.body.gen;
  r = await call('POST', '/api/ids/reset', admin, { yatra: '1', last: 0 }); ok(r.status === 200 && r.body.gen === genBefore + 1, 'a person with the Manage Yatras function can reset a yatra\'s numbering', r.body);
  r = await call('POST', '/api/ids/reserve', admin, { yatra: '1', n: 3 }); ok(r.body.from === 1 && r.body.to === 3 && r.body.gen === genBefore + 1, 'new numbers start again from 1, in a new generation', r.body);
  r = await call('GET', '/api/sync?since=0', admin); ok(r.body.idgens['1'] === genBefore + 1, 'everyone is told the numbering was reset (so they drop numbers they had set aside)', r.body.idgens);
  r = await call('POST', '/api/ids/reset', chitra, { yatra: '1', last: 0 }); ok(r.status === 403, 'a person without that function cannot');
  r = await call('POST', '/api/ids/reset', admin, { yatra: '1', last: -5 }); ok(r.status === 422, 'nonsense numbers are refused');
  // two devotees may not share a Yatra ID in the same yatra
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '41', base: 0, data: dev(41, { yatra_id: 'PY-2026-Y1-0777' }) }] }); ok(r.body.results[0].status === 'ok', 'a devotee is saved with a Yatra ID');
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '42', base: 0, data: dev(42, { yatra_id: 'PY-2026-Y1-0777' }) }] });
  ok(r.body.results[0].status === 'denied' && r.body.results[0].reason === 'duplicate_id', 'a second devotee with the same Yatra ID in that yatra is refused', r.body.results);
  const vers = Object.fromEntries((await call('GET', '/api/sync?since=0', admin)).body.changes.filter((c) => c.coll === 'devotees').map((c) => [c.id, c.version]));
  r = await call('POST', '/api/sync', admin, { ops: [{ coll: 'devotees', id: '41', base: vers['41'], data: dev(41, { yatra_id: 'PY-2026-Y1-0001' }) }, { coll: 'devotees', id: '1', base: vers['1'], data: dev(1, { yatra_id: 'PY-2026-Y1-0002' }) }, { coll: 'devotees', id: '2', base: vers['2'], data: dev(2, { yatra_id: 'PY-2026-Y1-0003' }) }] });
  ok(r.status === 200 && r.body.results.every((x) => x.status === 'ok'), 'but renumbering many devotees in one go (IDs moving around) is accepted', r.body.results.map((x) => x.status + (x.reason || '')));

  section('Signing in as someone else');
  r = await call('POST', '/api/auth/impersonate', admin, { id: chitraId }); ok(r.status === 200 && r.body.impBy.name === 'Hari', 'Admin can sign in as a user', r.body);
  const imp = r.body.token;
  r = await call('GET', '/api/me', imp); ok(r.body.username === 'chitra' && r.body.impBy.id === 1, 'the server knows it is Admin acting as her');
  r = await call('GET', '/api/users', imp); ok(r.status === 403, 'while acting as her you cannot manage users');
  r = await call('POST', '/api/auth/impersonate', imp, { id: vijayId }); ok(r.status === 403, 'no signing in as someone else from inside it');
  r = await call('POST', '/api/auth/password', imp, { current: 'x', password: 'Another#123' }); ok(r.status === 403, 'and you cannot change her password');
  r = await call('POST', '/api/auth/impersonate', chitra, { id: vijayId }); ok(r.status === 403, 'a Creator cannot sign in as anyone');
  r = await call('POST', '/api/auth/back', imp); ok(r.status === 200 && r.body.user.username === 'admin', 'Back returns to the Admin account');
  r = await call('GET', '/api/audit?limit=500', admin);
  ok(r.body.rows.some((x) => x.action === 'impersonate_start') && r.body.rows.some((x) => x.action === 'update' && x.coll === 'devotees'), 'the log records it', r.body.total);

  section('Audit log');
  const text = JSON.stringify(r.body.rows);
  ok(!text.includes('234567890123') && !text.includes('Admin#2026x') && !text.includes('Temp#1234ab') && !text.includes('enc1:'), 'the log never holds a Govt ID, password or encrypted value');
  ok(r.body.rows.some((x) => x.action === 'login_failed') && r.body.rows.some((x) => x.imp_by === 'admin'), 'failed sign-ins and "done while acting as" are recorded');
  r = await call('GET', '/api/audit', chitra); ok(r.status === 403, 'only an Admin can read the log');

  section('Switching off, deleting, password reset');
  r = await call('POST', `/api/users/${chitraId}/active`, admin, { active: false }); ok(r.status === 200, 'Admin switches a person off');
  r = await call('GET', '/api/me', chitra); ok(r.status === 401, 'their sign-in stops at once');
  r = await login('chitra', 'Mine#5678cd'); ok(r.status === 401 && /switched off/.test(r.body.error), 'and they cannot sign in');
  await call('POST', `/api/users/${chitraId}/active`, admin, { active: true });
  r = await call('POST', `/api/users/${chitraId}/password`, admin, { password: 'Reset#4321zz' }); ok(r.status === 200, 'Admin resets a password');
  r = await login('chitra', 'Reset#4321zz'); ok(r.body.must === true, 'and the person must choose their own again');
  r = await call('POST', '/api/users', admin, { name: 'Second', username: 'admin2', role: 'admin', password: 'Admin2#2026x' }); const a2 = r.body.user.id;
  r = await call('DELETE', `/api/users/${a2}`, admin); ok(r.status === 200, 'an Admin can be deleted when another remains');
  r = await call('POST', `/api/users/${vijayId}/active`, admin, { active: false }); r = await call('DELETE', `/api/users/${vijayId}`, admin); ok(r.status === 200, 'a person can be deleted');

  const reset0 = await login('chitra', 'Reset#4321zz'); const ct = (await call('POST', '/api/auth/password', reset0.body.token, { password: 'Final#7890yy' })).body.token;

  section('Recovery from the command line');
  r = await call('POST', '/api/users', admin, { name: 'Cli Person', username: 'cli1', role: 'creator', password: 'Temp#1234ab' });
  const cliTok = (await call('POST', '/api/auth/password', (await login('cli1', 'Temp#1234ab')).body.token, { password: 'Cli#5678cdx' })).body.token;
  const cli = spawnSync(process.execPath, [path.join(here, 'cli.js'), 'reset-password', 'cli1'], { env: { ...process.env, DATA_DIR: path.join(dir, 'data') }, encoding: 'utf8' });
  const tmp = /temporary password for cli1: (\S+)/.exec(cli.stdout)?.[1];
  ok(cli.status === 0 && tmp, 'someone on the server can give a person a new temporary password', cli.stdout + cli.stderr);
  r = await login('cli1', tmp); ok(r.status === 200 && r.body.must === true, 'it works, and the person must choose their own', r.body);
  r = await call('GET', '/api/me', cliTok); ok(r.status === 401, 'and the person\'s old sign-in stopped working');
  r = await call('GET', '/api/audit?limit=500', admin); ok(r.body.rows.some((x) => x.action === 'password_reset' && x.username === 'command line'), 'the log records it as done from the command line');
  const reset2 = r.body; void reset2;

  section('Backup and restore (also how a demo backup is imported)');
  r = await call('GET', '/api/backup', admin);
  ok(r.status === 200 && r.body.app === 'pandari-yathra' && r.body.data.devotees.length >= 2 && r.body.data.devotees.some((d) => d.govt_id_number === '234567890123') && r.body.data.users.length === 0, 'Admin downloads a backup in the same format as the standalone demo', r.body.data && Object.keys(r.body.data));
  const backup = r.body;
  r = await call('GET', '/api/backup', ct); ok(r.status === 403, 'only an Admin can download it');
  const demo = { app: 'pandari-yathra', v: 1, logo: 'data:image/png;base64,AAAA', data: { yatras: [{ id: 7, code: 'Y7', counter: 3, name: 'Imported', start: '2027-01-01', end: '2027-01-05' }], devotees: [{ id: 5, yatra: 7, yatra_id: 'PY-2027-Y7-0009', team_lead_id: 1, name: 'From Demo', age: 30, gender: 'Male', govt_id_number: '111122223333', tickets: { onward: null, return: null, additional: [] } }], teamLeads: [{ id: 1, name: 'T', mobile: '9' }], trains: [{ no: '16541', name: 'X' }], trainInfo: { 16541: { number: '16541', name: 'X', route: [] } }, stations: ['A'], idv3: true, users: [{ id: 1, username: 'x', hash: 'y' }], auth: { z: 1 } } };
  r = await call('POST', '/api/restore', admin, demo); ok(r.status === 200 && r.body.counts.devotees === 1, 'a backup from the standalone demo can be imported', r.body);
  r = await call('GET', '/api/sync?since=0', admin);
  ok(r.body.changes.some((c) => c.coll === 'yatras' && c.data.name === 'Imported') && !r.body.changes.some((c) => c.coll === 'devotees' && c.data.name === 'Ramesh K') && r.body.changes.some((c) => c.coll === 'settings' && c.id === 'logo'), 'it replaces what was there (including the logo)');
  ok(r.body.epoch !== epoch, 'and everyone is told to reload');
  ok(!r.body.changes.some((c) => JSON.stringify(c).includes('"hash"')), 'demo user accounts are not imported');
  r = await call('GET', `/api/sync?since=${rev1}&epoch=${epoch}`, admin); ok(r.body.full === true, 'someone holding old data is told to start fresh');
  r = await call('POST', '/api/ids/reserve', admin, { yatra: '7', n: 1 }); ok(r.body.from === 10, 'Yatra IDs carry on after the highest number already used (PY-…-0009 -> 10)', r.body);
  const rawAfter = raw.prepare("SELECT data FROM records WHERE coll='devotees'").get().data; ok(!rawAfter.includes('111122223333'), 'imported Govt IDs are encrypted too');
  r = await call('POST', '/api/restore', admin, { nonsense: true }); ok(r.status === 422, 'a file that is not a backup is refused');
  r = await call('POST', '/api/restore', ct, demo); ok(r.status === 403, 'only an Admin can restore');
  void backup;

  section('Reading tickets with Claude (key stays on the server)');
  await call('PUT', `/api/users/${chitraId}/access`, admin, { access: { view: [], edit: ['tickets'] } });
  r = await call('POST', '/api/claude', ct, { model: 'claude-evil', max_tokens: 99999, temperature: 0, tools: [{ name: 'record_ticket', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'record_ticket' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }] });
  ok(r.status === 200 && lastClaude.headers['x-api-key'] === 'sk-test-key' && lastClaude.body.model !== 'claude-evil' && lastClaude.body.max_tokens <= 4000, 'the server adds its own key and fixes the model and size', lastClaude?.body);
  r = await call('POST', '/api/claude', ct, { messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }); ok(r.status === 422, 'web search or other built-in tools are refused');
  r = await call('POST', '/api/claude', null, { messages: [{ role: 'user', content: 'x' }] }); ok(r.status === 401, 'signing in is required');
  await call('PUT', `/api/users/${chitraId}/access`, admin, { access: { view: ['guide'], edit: [] } });
  r = await call('POST', '/api/claude', ct, { messages: [{ role: 'user', content: 'x' }] }); ok(r.status === 403, 'a person who cannot add tickets cannot use it');

  section('The web app');
  r = await call('GET', '/'); ok(r.status === 200 && r.body.includes('app') && r.headers.get('cache-control') === 'no-store' && r.headers.get('x-frame-options') === 'DENY', 'the app is served with safe headers');
  r = await call('GET', '/api/nothing', admin); ok(r.status === 404, 'unknown API paths give a clean 404');
  r = await call('GET', '/api/health'); ok(r.status === 200 && r.body.ok, 'there is a health check for monitoring');
} catch (e) { fail++; console.log('  FAIL  test crashed:', e.stack); }

child.kill('SIGTERM'); mock.close(); raw?.close?.();
await new Promise((r) => setTimeout(r, 300));
const back = path.join(dir, 'data', 'backups');
console.log(fs.existsSync(back) && fs.readdirSync(back).length ? '\n  (a nightly-style backup file was written on start-up)' : '');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
