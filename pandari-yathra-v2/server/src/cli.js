// Run on the server itself, for when nobody can sign in:   node src/cli.js <command>
//   list-users                     show the accounts
//   reset-password <username>      give that person a new temporary password (they must change it at next sign-in)
//   backup                         make today's database copy now
import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { hashPassword } from './crypto.js';
import { backupOnce } from './backup.js';

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list-users') {
  for (const u of db.prepare('SELECT id,username,name,role,active,last_login FROM users ORDER BY id').all())
    console.log(`${String(u.id).padEnd(4)}${u.username.padEnd(20)}${u.role.padEnd(9)}${u.active ? 'active ' : 'OFF    '}${u.name}${u.last_login ? '  (last: ' + u.last_login + ')' : ''}`);
} else if (cmd === 'reset-password' && arg) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(arg);
  if (!u) { console.error(`No user called "${arg}". Try: node src/cli.js list-users`); process.exit(1); }
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', r = crypto.randomBytes(12);
  const pw = [...r.subarray(0, 9)].map((x) => A[x % A.length]).join('') + '7' + A[r[9] % 24] + 'K';
  db.prepare('UPDATE users SET pw=?, must_change=1, active=1, token_ver=token_ver+1 WHERE id=?').run(hashPassword(pw), u.id);
  audit('command line', 'password_reset', 'users', u.id, { username: u.username });
  console.log(`New temporary password for ${u.username}: ${pw}\nThey will be asked to choose their own at the next sign-in.`);
} else if (cmd === 'backup') {
  const f = await backupOnce();
  console.log(f ? `Backup written: ${f}` : "Today's backup already exists.");
} else {
  console.log('Commands: list-users | reset-password <username> | backup');
  process.exit(cmd ? 1 : 0);
}
db.close();
