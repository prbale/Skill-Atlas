# Skill Atlas 1.2.0

A mind-map web app for tracking the skills you are learning.

The map shows only topic names. Click a topic to open its details panel: description, key pointers you can tick off, learning links, tags, status and branch colour.

**Docker image:** `skill-atlas:1.2.0`
**What changed in this release, and why:** see [SECURITY.md](SECURITY.md)

---

## Production deployment (HTTPS)

You need:

- a server with Docker and the Compose plugin
- a domain name pointing at the server
- ports 80 and 443 open

The stack runs two containers:

- **app** listens only on an internal Docker network. It is never published to the internet.
- **Caddy** handles HTTPS and gets and renews the certificate automatically.

```bash
unzip skill-atlas-1.2.0.zip && cd skill-atlas

# 1. Settings
cp .env.example .env
nano .env                      # set SITE_DOMAIN, PUBLIC_ORIGIN and ADMIN_USERNAME

# 2. First administrator password (read once, on first start only)
mkdir -p secrets
openssl rand -base64 24 > secrets/admin_password.txt
cat secrets/admin_password.txt # note it for step 4

# 3. Start
docker compose up -d --build
docker compose logs -f app     # wait for "Skill Atlas 1.2.0 on http://0.0.0.0:8080"
```

**4. Finish setup in the browser.** Open `https://<your domain>` and sign in as `ADMIN_USERNAME` with the password from step 2. Then:
1. Choose your own password when asked.
2. Click **Turn on two-step** in the sidebar and scan the QR code with an authenticator app. Administrator tools stay locked until you do this.
3. Open **Administration → Invites** and create an invite code for each person who should get an account.

**5. Optional: remove the bootstrap password file.** After the first sign-in you can replace its contents with anything; it is not read again once an administrator exists.
```bash
openssl rand -base64 24 > secrets/admin_password.txt
```

### Updating from 1.1.0

Stop the old container and start 1.2.0 with **the same data volume**. The database upgrades itself in place:

- Existing passwords keep working and are re-hashed with stronger settings at each user's next sign-in.
- Any 1.1.0 sessions are kept.
- Maps from the old demo version are **not** given to anyone automatically. They wait under **Administration → Old maps** until you assign them.

Take a backup before you upgrade (see Backups).

### Local trial on your own computer

This runs over plain HTTP and is bound to your computer only. Never use it on a server.
```bash
mkdir -p secrets && echo 'choose-a-long-local-password' > secrets/admin_password.txt
docker compose -f docker-compose.dev.yml up -d --build      # → http://localhost:8080
```

Or without Docker (Node.js 22+):
```bash
npm ci
ADMIN_USERNAME=prashant-admin ADMIN_PASSWORD='choose-a-long-local-password' npm run dev
npm test          # security regression suite
```

---

## Configuration

Set these in `.env`; `docker-compose.yml` passes them to the app.

| Variable | Default (production) | Meaning |
|---|---|---|
| `SITE_DOMAIN` | required | Domain Caddy gets a certificate for, e.g. `atlas.example.com` |
| `PUBLIC_ORIGIN` | required | `https://` + your domain. The app refuses to start in production without it. Requests from any other origin are rejected. |
| `ADMIN_USERNAME` | empty | First administrator, used only when no administrator exists. Avoid `admin`. |
| `ADMIN_PASSWORD_FILE` | `/run/secrets/admin_password` | File holding the first admin's password (`ADMIN_PASSWORD` also works, but files keep it out of `docker inspect`) |
| `REGISTRATION` | `invite` | `invite`: an invite code is needed · `closed`: admins create accounts · `open`: anyone can sign up |
| `MAX_USERS` | `50` | Account limit |
| `REQUIRE_ADMIN_MFA` | `true` | Administrator tools need two-step verification |
| `HIBP_CHECK` | `true` | Reject passwords found in known breaches. Only the first 5 characters of a SHA-1 hash leave the server. |
| `TRUSTED_PROXY_HOPS` | `1` | Number of proxies in front of the app. Used to find the real client IP for rate limits and the activity log. |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_DAYS` | `30` / `7` | Maximum session age / sign out after this long without use |
| `ADMIN_SESSION_TTL_HOURS` | `12` | Administrators sign in again after this |
| `MAX_BODY_BYTES` | `2097152` (2 MB) | Largest save accepted, so effectively the per-user storage quota |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `7` | Built-in database backups into `/data/backups` (`0` turns them off) |
| `COOKIE_SECURE` | `true` | Must stay `true` in production; only the local trial uses `false` |

---

## Administration

Open **Administration** in the sidebar (administrators only, with two-step on).

| Tab | What you can do |
|---|---|
| **Users** | Create accounts with a temporary password (the person must change it at first sign-in), make users admins or remove admin rights, disable or enable accounts, reset passwords, reset two-step verification, clear a sign-in lockout, and delete accounts. Changing roles, resetting and deleting ask for your password again. |
| **Invites** | Create single-use invite codes (valid 1–7 days) and revoke unused ones. The code is shown only once. |
| **Activity log** | Sign-ins, failed sign-ins, lockouts, password and two-step changes, and every admin action, with time and IP address. Kept for 365 days. |
| **Old maps** | Maps from the 1.0 demo era. Assign each set to the right account, or delete it. |

### Break-glass commands (on the server)

Use these if you lose your phone or forget your password. They can't be reached over the internet.

```bash
docker compose exec app node scripts/admin-cli.js list-users
docker compose exec app node scripts/admin-cli.js reset-mfa prashant-admin
docker compose exec app node scripts/admin-cli.js reset-password prashant-admin   # prints a temporary password
docker compose exec app node scripts/admin-cli.js unlock prashant-admin
docker compose exec app node scripts/admin-cli.js backup
```

---

## Backups

1. **Built in.** Every 24 hours the app writes a consistent SQLite snapshot to `/data/backups` and keeps the last 7. Copy them off the server:
   ```bash
   docker compose cp app:/data/backups ./atlas-backups
   ```
2. **Continuous, off-site (recommended).** Fill in the `LITESTREAM_*` values in `.env` for an S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2), then:
   ```bash
   docker compose --profile backup up -d
   ```
   The restore command is in `litestream.yml`. **Test a restore once.**
3. **Per user.** Everyone can download their own maps via **More (⋯) → Export or back up**. The server also keeps each user's last 20 versions; use **More → Version history** to restore one.

Never copy `skill-atlas.sqlite` while the app is running. In WAL mode a plain copy can be incomplete; use the methods above instead.

---

## Behind Cloudflare (optional)

### Cloudflare Access: the strongest setup for a private tool
Put the whole site behind Cloudflare Zero Trust → **Access**. It is free for up to 50 users. People then sign in with Google, GitHub or a one-time email code at Cloudflare before they can even reach the Skill Atlas login page.

### Real client IP with the Cloudflare proxy
If the orange-cloud proxy is on, tell Caddy to trust Cloudflare's addresses and pass on the real client IP.

1. Add this to the top of `Caddyfile`. Get the current IP ranges from https://www.cloudflare.com/ips/.
   ```
   {
      servers {
         trusted_proxies static <Cloudflare IPv4 and IPv6 ranges>
      }
   }
   ```
2. In the site block, change the proxy line to:
   ```
   reverse_proxy app:8080 {
	header_up X-Forwarded-For {client_ip}
   }
   ```
3. Keep `TRUSTED_PROXY_HOPS=1`.
4. Check that **Activity log** shows real visitor IPs, not Cloudflare's.

---

## Security model

**Accounts**
- scrypt password hashing (N=2^16, r=8, p=2), with parameters stored per user so they can be raised later
- passwords of 12–128 characters, with common, username-based and breached passwords refused
- generic sign-in errors, with constant work even for unknown usernames
- lockout after 5 failures per account, growing up to 60 minutes
- TOTP two-step verification with replay protection, required for administrators

**Sessions**
- 256-bit random tokens, stored only as SHA-256 hashes
- `__Host-` cookie with `Secure`, `HttpOnly` and `SameSite=Strict`
- 30-day absolute limit, 7-day idle limit and a 12-hour limit for admins
- revoked on password change, disable, role change and two-step reset
- at most 10 sessions per user

**Requests**
- state-changing requests must be JSON and must come from `PUBLIC_ORIGIN`
- rate limits per IP and per account
- every saved document is rebuilt from an allow-list: only `http`/`https` links are kept, and fields are size-checked

**Browser**
- strict Content Security Policy: no inline scripts, fonts self-hosted
- HSTS, `nosniff`, no framing, no referrer
- the local cache is cleared on sign-out

**Data**
- optimistic revisions prevent silent overwrites between devices
- version history keeps earlier states
- daily backups, with optional Litestream replication
- an audit log of security events

**Container**
- Node 22, non-root, read-only filesystem
- all Linux capabilities dropped, `no-new-privileges`
- memory, CPU and process limits
- the app port is not published

### Known limits

This is a self-hosted local-auth app, not an audited identity service.
- There is no email verification or self-service password reset. An administrator resets passwords.
- Rate limits are kept in memory per process, so run one app container.
- The database is not encrypted at rest. Use an encrypted disk or volume; most cloud providers do this by default.

---

## Project layout

```
skill-atlas/
├── Dockerfile               two-stage build on node:22-alpine, non-root, read-only code
├── docker-compose.yml       production: app + Caddy (HTTPS) + optional Litestream
├── docker-compose.dev.yml   local trial over HTTP (bound to 127.0.0.1)
├── Caddyfile                TLS, HSTS, body limit, reverse proxy
├── litestream.yml           off-site continuous backup config
├── .env.example             settings template (copy to .env)
├── secrets/                 first-admin password file (git- and docker-ignored)
├── server.js                HTTP server, API routes, security headers
├── database.js              SQLite schema, migrations, accounts, sessions, revisions, audit
├── security.js              document sanitiser, URL rules, password policy, TOTP
├── scripts/admin-cli.js     break-glass admin commands
├── public/
│   ├── index.html           markup only
│   ├── app.js / app.css     the app (no inline code, for the strict CSP)
│   ├── fonts/               self-hosted fonts (SIL Open Font License)
│   └── vendor/qrcode.js     QR code generator for two-step setup (MIT)
└── test/security.test.js    21 security regression tests
```

## REST API

All routes are under `/api`. Every request that changes something must send `Content-Type: application/json` and come from `PUBLIC_ORIGIN`.

**Public**

| Method & path | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET /config` | Registration mode |
| `POST /login` | `{username, password, totp?}` |
| `POST /register` | `{username, password, inviteCode?}` |

**Signed-in user**

| Method & path | Purpose |
|---|---|
| `GET /me` | Current user |
| `POST /logout` | Sign out |
| `POST /me/password` | Change password |
| `POST /me/mfa/setup`, `/me/mfa/enable`, `/me/mfa/disable` | Manage two-step verification |
| `GET /data` | Your maps, returned as `{revision, doc}` |
| `PUT /data` | Save, sending `{baseRevision, doc, overwrite?}`. Returns `409` if another device saved first. |
| `DELETE /data` | Delete all your maps; send `{confirm:"DELETE ALL MY MAPS"}` |
| `GET /data/history`, `POST /data/history/:id/restore` | List and restore earlier versions |

**Administrators**

| Method & path | Purpose |
|---|---|
| `GET` / `POST /admin/users` | List and create accounts |
| `PATCH` / `DELETE /admin/users/:id` | Change or delete an account |
| `POST /admin/users/:id/password` | Reset a password |
| `POST /admin/users/:id/mfa-reset` | Reset two-step verification |
| `POST /admin/users/:id/unlock` | Clear a sign-in lockout |
| `GET` / `POST /admin/invites`, `DELETE /admin/invites/:id` | Manage invite codes |
| `GET /admin/legacy`, `POST /admin/legacy/:name/assign`, `DELETE /admin/legacy/:name` | Review and assign old maps |
| `GET /admin/audit` | Activity log |

Sensitive admin actions (role change, password or two-step reset, delete, legacy assign or delete) also need `confirmPassword`.
