# Skill Atlas 1.2.0: security fixes

Every finding from the 1.1.0 review, what was done about it, and the automated test that proves it (`npm test`).

## Critical and high

| # | Finding in 1.1.0 | Fix in 1.2.0 | Proven by test |
|---|---|---|---|
| C1 | Legacy maps were attached to whoever registered the same username, and were re-imported on every restart | Legacy import runs **once**, then the folder is renamed. Nothing is attached automatically. An admin reviews **Old maps** and assigns each set explicitly, with password re-confirmation. | *legacy maps are NOT given…*, *never re-imported on restart*, *admin assigns legacy maps explicitly* |
| H1 | Leftmost `X-Forwarded-For` was trusted, so rotating fake IPs gave unlimited sign-in attempts | `TRUSTED_PROXY_HOPS` reads the address the trusted proxy appended and ignores client-supplied entries. Lockout per account is stored in SQLite: after 5 failures the lock grows exponentially up to 60 minutes, applies across IPs, applies equally to unknown usernames and survives restarts. | *spoofed X-Forwarded-For…*, *per-account lockout…* |
| H2 | No limit on current-password guesses at `/api/me/password` | 5 attempts per 15 minutes. After that the session is **revoked**. | *change-password guessing is limited…* |
| H3 | Open registration by default | Default is `REGISTRATION=invite`: single-use, expiring, hashed invite codes. `MAX_USERS` cap and a 2 MB per-user quota. | *registration needs a valid, unused invite code* |
| H4 | App port published to the internet, no TLS layer | The production compose file publishes only Caddy (automatic HTTPS and HSTS). The app is `expose`-only on an internal network. Production refuses to start without an `https://` `PUBLIC_ORIGIN` or with insecure cookies. | *refuses to start without an https PUBLIC_ORIGIN* |
| H5 | `javascript:` and `data:` links accepted through import and the API | The server rebuilds every document from an allow-list: only `http`/`https` links survive, colour and status are allow-listed, field sizes are enforced, and `__proto__`-style keys are rejected. The client also checks links when rendering and importing. | *javascript: links are stripped server-side…* |

## Medium

| # | Finding | Fix | Test |
|---|---|---|---|
| M1 | Origin check accepted a missing Origin and non-JSON bodies | State-changing requests must be `application/json`, and `Origin` must equal `PUBLIC_ORIGIN`. If there is no Origin header, `Sec-Fetch-Site: same-origin` is required. | *origin check rejects…* |
| M2 | Maps stayed in `localStorage` after sign-out, keyed by username | The cache is keyed by user ID (`atlas:v2:<id>`), cleared on sign-out, and old v1 caches are purged. An offline copy is pushed only when it is based on the server's current revision. | Browser end-to-end check |
| M3 | 5 MB × 240 saves per minute; unbounded fields; unbounded scrypt | 2 MB body, 30 saves per minute, field limits, at most 4 concurrent hashes (with a queue, then 503), 128-character password cap, at most 10 sessions per user, container memory, CPU and process limits | *save rate limit*, *sanitiser limits* |
| M4 | Admin password always in env; default `admin`; no MFA | `ADMIN_PASSWORD_FILE` (Docker secret) is read only on first start. The seeded admin must change the password. **Admin tools need TOTP.** Admin sessions last 12 hours. Role changes, resets, deletes and legacy actions need password re-confirmation. A break-glass CLI covers lost phones. | *must change the temporary password*, *admin tools require two-step*, *re-confirmation…* |
| M5 | Node 20 is end-of-life | `node:22-alpine`, `apk upgrade` at build, digest pinning documented, `engines >=22` | Dockerfile |
| M6 | No audit trail | `audit_log` table covering sign-ins, failures, lockouts, password and two-step changes and every admin action. Kept 365 days, viewable in **Administration → Activity log**. Passwords are never logged. | *audit log records…* |
| M7 | CSP allowed inline scripts; Google Fonts | Script and CSS moved to `app.js`/`app.css`. `script-src 'self'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'none'`. Fonts self-hosted. | *strict CSP* |
| M8 | Last-write-wins, one-call wipe, no backups | Revisions with `409 Conflict` and a "which version to keep?" dialog. 20 versions of history with restore. Delete needs confirmation text and is recoverable. Daily `db.backup()` snapshots, plus an optional Litestream sidecar. | *stale saves get 409…* |

## Low

| Finding | Fix |
|---|---|
| Cookie without prefix, no idle timeout | `__Host-skill_atlas_session`; 7-day idle timeout |
| HSTS missing | Sent by both the app and Caddy (`max-age=31536000; includeSubDomains`) |
| Health endpoint revealed version and uptime | Returns `{ok:true}` only |
| No `.dockerignore`; macOS `node_modules` in the zip | `.dockerignore` excludes `node_modules`, `.env`, `secrets`, `data` and test files |
| Container hardening | `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, limits; code owned by root and read-only |
| scrypt parameters not stored | Parameters stored per user; 1.1.0 hashes are upgraded at next sign-in |
| Static path check without separator | `startsWith(PUBLIC_DIR + path.sep)`; NUL bytes rejected |
| Disabling a user | Takes effect on the very next request (sessions deleted and re-checked) |

## Reporting a problem
If you find a security issue, contact the administrator privately rather than posting it publicly.
