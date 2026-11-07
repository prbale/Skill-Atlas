'use strict';
/**
 * Skill Atlas server 1.2.0
 * - Serves the web app from ./public (strict CSP: no inline scripts, self-hosted fonts)
 * - REST API under /api: accounts, cookie sessions, two-step verification, invites, per-user maps with revisions
 */
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const fs = require('node:fs');
const database = require('./database');
const sec = require('./security');

/* ------------------------------------------------------------------ configuration */
const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true');
const PROD = env.NODE_ENV === 'production';
const PORT = Number(env.PORT) || 8080;
const HOST = env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = Number(env.MAX_BODY_BYTES) || 2 * 1024 * 1024;
const SESSION_TTL_MS = (Number(env.SESSION_TTL_DAYS) || 30) * 86400000;
const ADMIN_SESSION_TTL_MS = (Number(env.ADMIN_SESSION_TTL_HOURS) || 12) * 3600000;
const SESSION_IDLE_MS = (Number(env.SESSION_IDLE_DAYS) || 7) * 86400000;
const COOKIE_SECURE = bool(env.COOKIE_SECURE, PROD);
const COOKIE_NAME = COOKIE_SECURE ? '__Host-skill_atlas_session' : 'skill_atlas_session';
const REGISTRATION = ['open', 'invite', 'closed'].includes(env.REGISTRATION) ? env.REGISTRATION
  : env.ALLOW_REGISTRATION === 'true' ? 'open' : 'invite'; // default: invite-only
const REQUIRE_ADMIN_MFA = bool(env.REQUIRE_ADMIN_MFA, PROD);
const TRUSTED_PROXY_HOPS = Number(env.TRUSTED_PROXY_HOPS ?? (env.TRUST_PROXY === 'true' ? 1 : 0)) || 0;
const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const HSTS = COOKIE_SECURE && bool(env.HSTS, true);
const BACKUP_INTERVAL_H = Number(env.BACKUP_INTERVAL_HOURS ?? 24);
const VERSION = require('./package.json').version;

function readSecret(name) {
  const file = env[name + '_FILE'];
  if (file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { throw new Error(`Cannot read ${name}_FILE (${file}): ${e.message}`); } }
  return env[name];
}

if (PROD) {
  const problems = [];
  if (!/^https:\/\/[^/]+$/.test(PUBLIC_ORIGIN)) problems.push('PUBLIC_ORIGIN must be set to your https:// address, e.g. https://atlas.example.com');
  if (!COOKIE_SECURE) problems.push('COOKIE_SECURE must not be false in production');
  if (problems.length) { console.error('Refusing to start:\n - ' + problems.join('\n - ')); process.exit(1); }
}

/* ------------------------------------------------------------------ utils */
const log = (...a) => console.log(new Date().toISOString(), ...a);
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

/** Client IP: the address added by the N-th trusted proxy from the right. Client-supplied entries are ignored. */
function clientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  chain.push(req.socket.remoteAddress || '?');
  return chain[Math.max(0, chain.length - 1 - TRUSTED_PROXY_HOPS)];
}
function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}
const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME];
const sessionCookie = (token, maxAgeSec) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`;

/** Same-origin check for state-changing requests: JSON only, and Origin (or Fetch Metadata) must match. */
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  const expected = PUBLIC_ORIGIN || `${COOKIE_SECURE ? 'https' : 'http'}://${req.headers.host}`;
  if (origin) return origin === expected;
  return req.headers['sec-fetch-site'] === 'same-origin';
}

/* ------------------------------------------------------------------ rate limiting (per process) */
const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  try { database.housekeeping(); } catch (e) { log('housekeeping failed', e.message); }
}, 60_000).unref();

/* ------------------------------------------------------------------ responses */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'", // node positions/colours are set via style attributes, never via <style> or scripts
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(COOKIE_SECURE ? ['upgrade-insecure-requests'] : []),
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  ...(HSTS ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};
function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { ...SECURITY_HEADERS, ...headers };
  if (buf.length > 1024 && /text|json|javascript|svg|css/.test(h['Content-Type'] || '') && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf); h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj, headers = {}) =>
  send(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, `Your maps are too large to save (limit ${(MAX_BODY / 1048576).toFixed(1)} MB). Export and remove some maps.`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(httpError(400, 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ API */
const minutes = (ts) => Math.max(1, Math.ceil((ts - Date.now()) / 60000));
const ttlFor = (user) => (user.role === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS);

async function requireRecentPassword(req, user, body) {
  if (rateLimited('sudo:' + user.id, 10, 15 * 60_000)) throw httpError(429, 'Too many password confirmations. Wait 15 minutes.');
  if (!await database.confirmPassword(user.id, body?.confirmPassword)) {
    database.audit(user, 'admin.reauth_failed', null, clientIp(req));
    throw httpError(403, 'Confirm with your current password to do this.', { code: 'reauth_failed' });
  }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';

  if (route === 'GET /api/health') return json(req, res, 200, { ok: true });
  if (route === 'GET /api/config') return json(req, res, 200, { registration: REGISTRATION });

  if (mutating && !sameOrigin(req)) return json(req, res, 403, { error: 'Request origin was rejected.' });

  /* ---------- sign in & registration ---------- */
  if (route === 'POST /api/login') {
    if (rateLimited('login:' + ip, 30, 60_000)) return json(req, res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    if (!/^[\w.@-]{2,40}$/.test(username)) return json(req, res, 401, { error: 'Username or password is incorrect.' });
    const result = await database.authenticate(username, body.password, body.totp);
    if (result.error === 'locked') {
      database.audit(username, 'login.locked', username, ip);
      return json(req, res, 429, { error: `Too many failed attempts. Try again in ${minutes(result.lockedUntil)} minute(s).` });
    }
    if (result.error === 'mfa_required') return json(req, res, 401, { error: 'Enter the 6-digit code from your authenticator app.', code: 'mfa_required' });
    if (result.error) {
      database.audit(username, result.mfa ? 'login.mfa_failed' : 'login.failed', username, ip);
      return json(req, res, 401, { error: result.mfa ? 'That code didn’t match. Try the newest code.' : 'Username or password is incorrect.', code: result.mfa ? 'mfa_required' : undefined });
    }
    const user = result.user;
    const token = database.createSession(user.id, ttlFor(user));
    database.audit(user, 'login.success', user.username, ip);
    return json(req, res, 200, { user }, { 'Set-Cookie': sessionCookie(token, Math.floor(ttlFor(user) / 1000)) });
  }

  if (route === 'POST /api/register') {
    if (REGISTRATION === 'closed') return json(req, res, 403, { error: 'New accounts can only be created by an administrator.' });
    if (rateLimited('register:' + ip, 5, 3600_000)) return json(req, res, 429, { error: 'Too many account creation attempts. Try again later.' });
    const body = await readBody(req);
    const user = await database.createUser(body.username, body.password, { requireInvite: REGISTRATION === 'invite', inviteCode: body.inviteCode });
    const token = database.createSession(user.id, ttlFor(user));
    database.audit(user, 'account.registered', user.username, ip, { via: REGISTRATION });
    return json(req, res, 201, { user }, { 'Set-Cookie': sessionCookie(token, Math.floor(ttlFor(user) / 1000)) });
  }

  /* ---------- everything below needs a session ---------- */
  const token = sessionToken(req);
  const user = database.getSession(token, SESSION_IDLE_MS);
  if (!user) return json(req, res, 401, { error: 'Please sign in.' }, { 'Set-Cookie': sessionCookie('', 0) });

  if (route === 'GET /api/me') return json(req, res, 200, { user, adminMfaRequired: REQUIRE_ADMIN_MFA });

  if (route === 'POST /api/logout') {
    database.destroySession(token);
    database.audit(user, 'logout', user.username, ip);
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (route === 'POST /api/me/password') {
    if (rateLimited('pwchange:' + user.id, 5, 15 * 60_000)) {
      database.destroySession(token); // a stolen session can't be used to brute-force the password
      database.audit(user, 'password.change_blocked', user.username, ip);
      return json(req, res, 401, { error: 'Too many attempts. You have been signed out for safety.' }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    const body = await readBody(req);
    const ok = await database.changeUserPassword(user.id, String(body.currentPassword || ''), String(body.newPassword || ''), token);
    database.audit(user, ok ? 'password.changed' : 'password.change_failed', user.username, ip);
    return ok ? json(req, res, 200, { ok: true }) : json(req, res, 400, { error: 'Current password is incorrect.' });
  }

  // Accounts with a temporary password must change it before doing anything else.
  if (user.mustChangePassword) return json(req, res, 403, { error: 'Change your temporary password to continue.', code: 'password_change_required' });

  /* ---------- two-step verification ---------- */
  if (route === 'POST /api/me/mfa/setup') {
    if (rateLimited('mfa:' + user.id, 10, 15 * 60_000)) return json(req, res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readBody(req);
    if (!await database.confirmPassword(user.id, body.password)) return json(req, res, 400, { error: 'Password is incorrect.' });
    return json(req, res, 200, database.startMfaSetup(user.id));
  }
  if (route === 'POST /api/me/mfa/enable') {
    if (rateLimited('mfa:' + user.id, 10, 15 * 60_000)) return json(req, res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readBody(req);
    database.enableMfa(user.id, body.code);
    database.audit(user, 'mfa.enabled', user.username, ip);
    return json(req, res, 200, { ok: true });
  }
  if (route === 'POST /api/me/mfa/disable') {
    if (rateLimited('mfa:' + user.id, 10, 15 * 60_000)) return json(req, res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    if (user.role === 'admin' && REQUIRE_ADMIN_MFA) return json(req, res, 400, { error: 'Administrators must keep two-step verification on.' });
    const body = await readBody(req);
    await database.disableMfa(user.id, body.password, body.code);
    database.audit(user, 'mfa.disabled', user.username, ip);
    return json(req, res, 200, { ok: true });
  }

  /* ---------- administration ---------- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return json(req, res, 403, { error: 'Administrator access is required.' });
    if (REQUIRE_ADMIN_MFA && !user.mfaEnabled) return json(req, res, 403, { error: 'Turn on two-step verification to use administrator tools.', code: 'mfa_setup_required' });
    const body = mutating ? await readBody(req) : {};

    if (route === 'GET /api/admin/users') return json(req, res, 200, { users: database.listUsers() });
    if (route === 'POST /api/admin/users') {
      const created = await database.createUser(body.username, body.password, { mustChangePassword: true });
      database.audit(user, 'admin.user_created', created.username, ip);
      return json(req, res, 201, { user: created });
    }
    const um = /^\/api\/admin\/users\/(\d+)(?:\/(password|mfa-reset|unlock))?$/.exec(url.pathname);
    if (um) {
      const targetId = Number(um[1]); const action = um[2];
      const target = database.getUserById(targetId);
      if (!target) return json(req, res, 404, { error: 'User not found.' });
      if (req.method === 'POST' && action === 'password') {
        if (targetId === user.id) return json(req, res, 400, { error: 'Use Change password for your own account.' });
        await requireRecentPassword(req, user, body);
        await database.resetUserPassword(targetId, String(body.password || ''));
        database.audit(user, 'admin.password_reset', target.username, ip);
        return json(req, res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'mfa-reset') {
        await requireRecentPassword(req, user, body);
        database.resetMfa(targetId);
        database.audit(user, 'admin.mfa_reset', target.username, ip);
        return json(req, res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'unlock') {
        database.unlockUser(target.username);
        database.audit(user, 'admin.user_unlocked', target.username, ip);
        return json(req, res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && !action) {
        if (body.role !== undefined && !['user', 'admin'].includes(body.role)) return json(req, res, 400, { error: 'Role must be user or admin.' });
        if (body.disabled !== undefined && typeof body.disabled !== 'boolean') return json(req, res, 400, { error: 'disabled must be true or false.' });
        if (targetId === user.id && ((body.role && body.role !== 'admin') || body.disabled)) return json(req, res, 400, { error: 'You cannot remove your own administrator access.' });
        if (body.role !== undefined && body.role !== target.role) await requireRecentPassword(req, user, body);
        const updated = database.updateUser(targetId, { role: body.role, disabled: body.disabled });
        database.audit(user, 'admin.user_updated', target.username, ip, { role: body.role, disabled: body.disabled });
        return json(req, res, 200, { user: updated });
      }
      if (req.method === 'DELETE' && !action) {
        if (targetId === user.id) return json(req, res, 400, { error: 'You cannot delete your own account.' });
        await requireRecentPassword(req, user, body);
        database.deleteUser(targetId);
        database.audit(user, 'admin.user_deleted', target.username, ip);
        return json(req, res, 200, { ok: true });
      }
    }
    if (route === 'GET /api/admin/invites') return json(req, res, 200, { invites: database.listInvites(), registration: REGISTRATION });
    if (route === 'POST /api/admin/invites') {
      const invite = database.createInvite(user.id, body.hours, body.note);
      database.audit(user, 'admin.invite_created', body.note || null, ip);
      return json(req, res, 201, invite);
    }
    const im = /^\/api\/admin\/invites\/([0-9a-f]{16})$/.exec(url.pathname);
    if (im && req.method === 'DELETE') {
      database.deleteInvite(im[1]);
      database.audit(user, 'admin.invite_revoked', im[1], ip);
      return json(req, res, 200, { ok: true });
    }
    if (route === 'GET /api/admin/legacy') return json(req, res, 200, { legacy: database.listLegacy() });
    const lm = /^\/api\/admin\/legacy\/([\w.@%-]{2,120})(?:\/(assign))?$/.exec(url.pathname);
    if (lm) {
      const name = decodeURIComponent(lm[1]);
      if (req.method === 'POST' && lm[2] === 'assign') {
        await requireRecentPassword(req, user, body);
        const n = database.assignLegacy(name, Number(body.userId));
        database.audit(user, 'admin.legacy_assigned', name, ip, { userId: Number(body.userId), maps: n });
        return json(req, res, 200, { ok: true, maps: n });
      }
      if (req.method === 'DELETE' && !lm[2]) {
        await requireRecentPassword(req, user, body);
        database.deleteLegacy(name);
        database.audit(user, 'admin.legacy_deleted', name, ip);
        return json(req, res, 200, { ok: true });
      }
    }
    if (route === 'GET /api/admin/audit') return json(req, res, 200, { entries: database.listAudit({ limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }) });
    return json(req, res, 404, { error: 'Unknown administrator route.' });
  }

  /* ---------- map data ---------- */
  if (route === 'GET /api/data') {
    const { document, revision } = database.loadData(user.id);
    return send(req, res, 200, `{"revision":${revision},"doc":${document}}`, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (route === 'PUT /api/data') {
    if (rateLimited('save:' + user.id, 30, 60_000)) return json(req, res, 429, { error: 'Saving too often. Try again in a moment.' });
    const body = await readBody(req);
    const base = Number(body.baseRevision);
    if (!Number.isInteger(base) || base < 0) return json(req, res, 400, { error: 'baseRevision is required.' });
    const { doc, removedLinks } = sec.sanitizeDocument(body.doc);
    const result = database.saveData(user.id, doc, base, body.overwrite === true);
    if (result.conflict) return json(req, res, 409, { error: 'Your maps were changed on another device.', code: 'conflict', revision: result.revision });
    return json(req, res, 200, { ok: true, revision: result.revision, removedLinks });
  }
  if (route === 'DELETE /api/data') {
    const body = await readBody(req);
    if (body.confirm !== 'DELETE ALL MY MAPS') return json(req, res, 400, { error: 'Confirmation text is required.' });
    database.deleteData(user.id);
    database.audit(user, 'data.deleted', user.username, ip);
    return json(req, res, 200, { ok: true });
  }
  if (route === 'GET /api/data/history') return json(req, res, 200, { versions: database.listHistory(user.id) });
  const hm = /^\/api\/data\/history\/(\d+)\/restore$/.exec(url.pathname);
  if (hm && req.method === 'POST') {
    const revision = database.restoreHistory(user.id, Number(hm[1]));
    database.audit(user, 'data.restored', user.username, ip, { historyId: Number(hm[1]) });
    return json(req, res, 200, { ok: true, revision });
  }

  return json(req, res, 404, { error: 'Unknown API route.' });
}

/* ------------------------------------------------------------------ static files */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(req, res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (rel.includes('\0')) return send(req, res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  try {
    let st = await fsp.stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file); }
  } catch {
    if (path.extname(rel)) return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(file).toLowerCase();
  const body = await fsp.readFile(file);
  send(req, res, 200, body, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
}

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && status !== 503) log('error', req.method, req.url, e.stack || e.message);
    if (!res.headersSent) json(req, res, status, { error: status >= 500 && status !== 503 ? 'Something went wrong on the server.' : e.message, code: e.code });
    else res.destroy();
  } finally {
    if (env.LOG_REQUESTS !== 'false' && req.url.startsWith('/api/')) log(req.method, req.url.split('?')[0], res.statusCode, Date.now() - t0 + 'ms');
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

async function start() {
  const imported = database.importLegacyFiles();
  if (imported) log(`Imported ${imported} legacy map document(s) for administrator review. They are not attached to any account automatically.`);
  const admin = await database.seedAdmin(env.ADMIN_USERNAME, readSecret('ADMIN_PASSWORD'));
  if (admin) {
    log(`Initial administrator created: ${admin.username} (must change password at first sign-in).`);
    if (/^(admin|administrator|root)$/i.test(admin.username)) log('Warning: choose a less predictable ADMIN_USERNAME than', admin.username);
  }
  if (BACKUP_INTERVAL_H > 0) {
    const run = () => database.backupNow().then((f) => log('Backup written', path.basename(f))).catch((e) => log('Backup failed', e.message));
    setTimeout(run, 60_000).unref();
    setInterval(run, BACKUP_INTERVAL_H * 3600_000).unref();
  }
  server.listen(PORT, HOST, () => log(`Skill Atlas ${VERSION} on http://${HOST}:${PORT} · registration=${REGISTRATION} · secure cookies=${COOKIE_SECURE} · proxy hops=${TRUSTED_PROXY_HOPS}`));
}
start().catch((error) => { log('Startup failed:', error.message); process.exit(1); });

function shutdown(sig) {
  log(`${sig} received, shutting down`);
  server.close(() => { try { database.db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server };
