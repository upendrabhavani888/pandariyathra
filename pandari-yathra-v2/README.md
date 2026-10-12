# Pandari Yathra: server edition (v2)

The complete portal (Master List, Add devotee, Reports, Distribution, Allocation, Cancelled, Trains, Instructions and
Yatra Announcement, Bulk upload, dark theme, the three profiles with function access, "Sign in as") running on **one
shared database**, with **real accounts** that the server enforces.

| | Standalone demo | This server edition |
|---|---|---|
| Data | in each person's browser | on the server, shared by everyone, live |
| Accounts | a lock on that browser | real accounts, checked by the server on every request |
| Govt ID numbers | in the browser | encrypted in the database |
| Ticket reading with Claude | key in the browser | key stays on the server |
| Activity log, nightly backups | no | yes |

The screens are the same code as the demo (`web/template.html`), so both behave alike. `web/standalone-demo.html` is the
no-server demo, if you want it.

## Try it on your own computer

Needs Node 20 or newer (tested on 22).

```bash
npm run setup           # installs the server's few dependencies
npm start               # prints a FIRST-TIME SETUP CODE, then listens on http://localhost:4000
```

Open http://localhost:4000, enter the setup code, create the Admin account, and write down the **recovery code** you are shown.
Then use the profile icon (top right) → **User settings** to add people.

## Putting it on the internet (domain + server)

I tested the app. I could not test your hosting, so go through these steps one at a time and check each.

1. **Domain.** Register one (for example `yatra.yourname.org`) at any registrar. Turn on domain privacy and auto-renew.
2. **A server.** Rent a small Linux server (a VPS) running Ubuntu 22.04 or 24.04, in a region near your users. 1 GB of memory is plenty.
3. **DNS.** At the registrar, add an **A record**: name `yatra` (or `@` for the bare domain) pointing to the server's IP address. It can take minutes to a few hours to spread.
4. **Install Node 22** on the server (see https://nodejs.org or NodeSource), then copy this folder to `/opt/pandari-yathra` and install:
   ```bash
   sudo useradd --system --home /opt/pandari-yathra --shell /usr/sbin/nologin pandari
   sudo mkdir -p /var/lib/pandari-yathra && sudo chown pandari:pandari /var/lib/pandari-yathra
   cd /opt/pandari-yathra && sudo npm run setup
   ```
5. **Secrets.** `sudo cp deploy/pandari-yathra.env.example /etc/pandari-yathra.env`, then `sudo chown root:pandari /etc/pandari-yathra.env && sudo chmod 640 /etc/pandari-yathra.env` (only root and the app's own user can read it), then edit it with `sudo nano /etc/pandari-yathra.env`:
   put a different `openssl rand -hex 32` value in `ID_ENC_KEY` and `JWT_SECRET`, and (optional) your `ANTHROPIC_API_KEY`.
   **Keep a copy of `ID_ENC_KEY` somewhere safe, away from the server.** Without it the stored Govt ID numbers cannot be read.
6. **Run it all the time.**
   ```bash
   sudo cp deploy/pandari-yathra.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now pandari-yathra
   sudo journalctl -u pandari-yathra -n 30      # shows the FIRST-TIME SETUP CODE
   ```
7. **HTTPS.** The app speaks plain http on port 4000 on the server itself; a web server in front adds HTTPS. With **Caddy**
   (it gets the certificate for you): install Caddy, put `deploy/Caddyfile` in `/etc/caddy/Caddyfile` with your domain, and
   `sudo systemctl reload caddy`. (nginx users: `deploy/nginx.conf.example`.) Open only ports 22, 80 and 443:
   `sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`.
8. **First visit.** Open `https://yatra.yourdomain.org`, enter the setup code, create the Admin. The setup code only exists
   until the Admin is created, so a stranger finding the site first cannot take it over.
9. **Bring your data in** (optional). In the standalone demo: Tools → Logo and backup → **Download data only (.json)**.
   On the server: Tools → Logo and backup → **Restore from a backup file**. That replaces everything on the server with the file.

## Looking after it

- **Nightly copy.** The server writes a consistent copy of its database every night to `DATA_DIR/backups/` and keeps the last 14.
  Make another copy off the server (`deploy/offsite-backup.sh` is a starting point). **Also keep the Govt ID key** (`ID_ENC_KEY`, or the
  `.enckey` file in the data folder if you did not set one).
- **Backup file.** As Admin, Tools → Logo and backup → **Download backup (.json)**. It holds Govt ID numbers in clear text, so keep it safe.
- **Restoring a nightly copy.** `sudo systemctl stop pandari-yathra`, copy the chosen `yatra-YYYY-MM-DD.db` over `DATA_DIR/yatra.db`
  (delete `yatra.db-wal` and `yatra.db-shm` if present), `sudo systemctl start pandari-yathra`.
- **Nobody can sign in?** The Admin can use **Forgot password** on the sign-in page with the recovery code. If that is lost too, run this on the server
  (always as the `pandari` user, never as root, or the database files would get the wrong owner):
  ```bash
  sudo -u pandari bash -c 'set -a; . /etc/pandari-yathra.env; set +a; cd /opt/pandari-yathra/server && node src/cli.js list-users'
  sudo -u pandari bash -c 'set -a; . /etc/pandari-yathra.env; set +a; cd /opt/pandari-yathra/server && node src/cli.js reset-password <username>'
  ```
  The second one prints a new temporary password; the person must choose their own at the next sign-in.
- **Updating.** Stop the service, replace the files (keep `DATA_DIR`), `npm run setup`, start the service. The database upgrades itself.
- **Rebuilding the web app** after editing `web/template.html`: `npm install` then `npm run build:web`.
- **Activity log.** Profile icon → Activity log (Admin). It never records Govt ID numbers, passwords or ticket files.

## How it works

- Everything is stored as small **records** (a devotee, a yatra, a vehicle…), each with a **version**. The screens load them, show
  them, and send back only what changed. If two people change the same record at the same moment, the first save wins; the second
  person is told and sees the winner. The devotee form also refuses to save over a record someone changed while it was open.
- Screens check for others' changes every 4 seconds, so people see each other's work without reloading. If the connection drops,
  changes stay on screen and are sent when it returns (the small Saved / Saving / Offline label shows the state).
- **Yatra IDs** are handed out by the server, so two people never get the same one. They are reserved in small blocks, so a number
  can be skipped if someone closes the page before using theirs. A number is never repeated.
- **Profiles and functions.** Admin, Creator and Viewer are starting points. Each person gets a list of functions (Master List, Bus
  Allocation, Instructions, Manage Yatras…) as "can view" or "can change". The **server** enforces what each person may change (a
  change to a field they may not touch is ignored) and only sends Govt ID numbers and tickets to people whose functions need them.
- **Tickets** are read and then discarded. The ticket file is never stored.
- **Sign-in:** passwords are salted scrypt hashes; wrong tries slow down (5 tries, then a minute); a new person must choose their own
  password; switching someone off or changing their password ends their sign-in at once; sign-ins last 12 hours.

## Things to know (honest limits)

- Tested with a few people at once and 500 devotees (about a second to load and to save a big batch). It is one server with one
  SQLite database, which suits a group like this, not thousands of simultaneous users.
- People with a function that uses devotee data (a report, allocation, the Master List) are sent the basic devotee details; what they
  see on screen follows their functions, but that part is hidden by the screens, not by the server. Govt ID numbers and tickets are
  held back by the server.
- Signing out clears the browser's sign-in but does not cancel it on the server; it simply expires after 12 hours.
- Anyone signed in with a function that adds tickets can use your Claude key through the server (limited to 20 reads a minute each).
- There is no password reset by email. The Admin resets passwords, and the recovery code or the command line covers the Admin.
- Data from the old v1 server is not migrated (v1 had a different design). Use the demo's backup file route above if you have data to bring.
- The ticket reader for photos and tricky layouts needs an Anthropic key and uses a little of your Anthropic credit.

## Tests

`npm test` starts the server on a temporary database and runs about 100 checks on sign-in, accounts, permissions, conflicts,
encryption, impersonation, the log, backup/restore and the Claude proxy.

## Folders

```
server/src/   the server (index, auth, sync, perms, misc, backup, cli, schema, db, crypto, config, selftest)
web/          index.html (the app served), template.html (its source), standalone-demo.html (no server)
tools/        build-web.mjs
deploy/       service file, Caddyfile, nginx example, env example, off-server backup example
```
