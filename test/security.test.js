'use strict';
/**
 * Skill Atlas 1.2.0 — security regression suite.
 * Starts real server processes on temporary data folders and replays every finding from the 1.1.0 review.
 * Run: npm test
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { totpNow } = require('../security');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'prashant-admin';
const ADMIN_PW = 'Initial-Admin-Pass-2026';
const ADMIN_PW2 = 'Brand-New-Admin-Pass-2026';
let passed = 0, failed = 0;
const results = [];

/* ------------------------------------------------------------------ harness */
function startServer(dataDir, env = {}) {
  const port = 19000 + Math.floor(Math.random() * 20000);
  const out = [];
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, LOG_REQUESTS: 'false', NODE_ENV: 'test', COOKIE_SECURE: 'false', TRUSTED_PROXY_HOPS: '1', BACKUP_INTERVAL_HOURS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) return;
      try { await fetch(base + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('server did not start:\n' + out.join(''));
  })();
  return { proc, base, port, out, ready, stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); proc.kill('SIGTERM'); }) };
}
let ipCounter = 10;
class Client {
  constructor(base, ip) { this.base = base; this.cookie = ''; this.ip = ip || `198.51.100.${ipCounter++}`; }
  async req(method, p, body, headers = {}) {
    const h = { Accept: 'application/json', 'X-Forwarded-For': this.ip, ...headers };
    if (method !== 'GET') { if (!('Content-Type' in headers)) h['Content-Type'] = 'application/json'; if (!('Origin' in headers)) h.Origin = this.base; }
    if (this.cookie) h.Cookie = this.cookie;
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const r = await fetch(this.base + p, { method, headers: h, body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {})) });
    const sc = r.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = /=$/.test(v) ? '' : v; }
    let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
}
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✔ ${name}`); }
  catch (e) { failed++; results.push(`  ✘ ${name}\n      ${String(e.stack || e).split('\n').slice(0, 3).join('\n      ')}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sec-'));
const doc = (topic, extra = {}) => ({ maps: [{ id: 'm1', rootId: 'r', nodes: { r: { id: 'r', parent: null, children: [], topic, links: [], ...extra } } }], currentId: 'm1', savedAt: Date.now() });

/* ------------------------------------------------------------------ main suite */
(async () => {
  const dir = tmp();
  // A legacy file from the 1.0 demo era: must NOT be claimable by registering the same name.
  fs.mkdirSync(path.join(dir, 'users'));
  fs.writeFileSync(path.join(dir, 'users', 'prashant.json'), JSON.stringify(doc('Prashant private notes')));
  fs.writeFileSync(path.join(dir, 'pw.txt'), ADMIN_PW + '\n');
  let S = startServer(dir, { ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD_FILE: path.join(dir, 'pw.txt'), REQUIRE_ADMIN_MFA: 'true', REGISTRATION: 'invite' });
  await S.ready;
  const admin = new Client(S.base, '203.0.113.1');
  let mfaSecret, inviteCode, enrolCode;

  console.log('Skill Atlas security regression suite\n');

  await test('Headers: strict CSP (no inline script), nosniff, no-store on API, minimal health', async () => {
    const r = await new Client(S.base).req('GET', '/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(r.text, /<script>(?!<\/script>)/, 'no inline <script> blocks in index.html');
    const h = await new Client(S.base).req('GET', '/api/health');
    assert.deepEqual(h.json, { ok: true });
    const f = await fetch(S.base + '/fonts/figtree-latin-400-normal.woff2');
    assert.equal(f.headers.get('content-type'), 'font/woff2');
  });

  await test('Static files: path traversal is blocked', async () => {
    for (const p of ['/%2e%2e/server.js', '/..%2fserver.js', '/fonts/..%2f..%2fdatabase.js', '/%00']) {
      const r = await fetch(S.base + p); const t = await r.text();
      assert.ok(!t.includes('createServer') && !t.includes('better-sqlite3'), p);
    }
  });

  await test('Seeded admin must change the temporary password before anything else', async () => {
    let r = await admin.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW });
    assert.equal(r.status, 200);
    r = await admin.req('GET', '/api/me'); assert.equal(r.json.user.mustChangePassword, true);
    r = await admin.req('GET', '/api/data'); assert.equal(r.status, 403); assert.equal(r.json.code, 'password_change_required');
    r = await admin.req('POST', '/api/me/password', { currentPassword: ADMIN_PW, newPassword: 'password1234' });
    assert.equal(r.status, 400, 'common password must be rejected');
    r = await admin.req('POST', '/api/me/password', { currentPassword: ADMIN_PW, newPassword: 'my-' + ADMIN + '-secret' });
    assert.equal(r.status, 400, 'password containing username must be rejected');
    r = await admin.req('POST', '/api/me/password', { currentPassword: ADMIN_PW, newPassword: 'x'.repeat(20) + 'Y'.repeat(120) });
    assert.equal(r.status, 400, 'over-long password must be rejected');
    r = await admin.req('POST', '/api/me/password', { currentPassword: ADMIN_PW, newPassword: ADMIN_PW2 });
    assert.equal(r.status, 200);
    r = await admin.req('GET', '/api/data'); assert.equal(r.status, 200);
  });

  await test('Admin tools require two-step verification; TOTP enrolment works', async () => {
    let r = await admin.req('GET', '/api/admin/users');
    assert.equal(r.status, 403); assert.equal(r.json.code, 'mfa_setup_required');
    r = await admin.req('POST', '/api/me/mfa/setup', { password: 'wrong-password-123' }); assert.equal(r.status, 400);
    r = await admin.req('POST', '/api/me/mfa/setup', { password: ADMIN_PW2 }); assert.equal(r.status, 200);
    mfaSecret = r.json.secret; assert.match(r.json.uri, /^otpauth:\/\/totp\//);
    r = await admin.req('POST', '/api/me/mfa/enable', { code: '000000' }); assert.equal(r.status, 400);
    enrolCode = totpNow(mfaSecret);
    r = await admin.req('POST', '/api/me/mfa/enable', { code: enrolCode }); assert.equal(r.status, 200);
    r = await admin.req('GET', '/api/admin/users'); assert.equal(r.status, 200);
  });

  await test('Sign-in with two-step: code required, wrong code refused, replayed code refused', async () => {
    const c = new Client(S.base, '203.0.113.2');
    let r = await c.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2 });
    assert.equal(r.status, 401); assert.equal(r.json.code, 'mfa_required'); assert.equal(c.cookie, '');
    r = await c.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2, totp: '123456' });
    assert.equal(r.status, 401);
    // Replaying the exact code that was already used at enrolment must fail (replay protection).
    r = await c.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2, totp: enrolCode });
    assert.equal(r.status, 401, 'a TOTP code must not be accepted twice');
  });

  await test('C1: legacy maps are NOT given to whoever registers the matching username', async () => {
    let r = await admin.req('POST', '/api/admin/invites', { note: 'attacker test', hours: 1 });
    assert.equal(r.status, 201); inviteCode = r.json.code;
    const attacker = new Client(S.base, '203.0.113.3');
    r = await attacker.req('POST', '/api/register', { username: 'prashant', password: 'Attacker-Pass-2026-x', inviteCode });
    assert.equal(r.status, 201);
    r = await attacker.req('GET', '/api/data');
    assert.equal(r.json.doc.maps.length, 0, 'attacker must receive no legacy maps');
    assert.ok(!fs.existsSync(path.join(dir, 'users')), 'legacy folder must be moved out of the import path');
    r = await admin.req('GET', '/api/admin/legacy');
    assert.equal(r.json.legacy.length, 1); assert.equal(r.json.legacy[0].username, 'prashant');
  });

  await test('H3: registration needs a valid, unused invite code', async () => {
    const c = new Client(S.base, '203.0.113.4');
    let r = await c.req('POST', '/api/register', { username: 'nobody', password: 'Some-Long-Pass-2026' });
    assert.equal(r.status, 403);
    r = await c.req('POST', '/api/register', { username: 'nobody', password: 'Some-Long-Pass-2026', inviteCode: 'AAAA-BBBB-CCCC' });
    assert.equal(r.status, 403);
    r = await c.req('POST', '/api/register', { username: 'nobody2', password: 'Some-Long-Pass-2026', inviteCode });
    assert.equal(r.status, 403, 'an invite can be used only once');
  });

  await test('M1: origin check rejects missing/foreign Origin and non-JSON bodies', async () => {
    const c = new Client(S.base, '203.0.113.5');
    let r = await c.req('POST', '/api/login', JSON.stringify({ username: ADMIN, password: ADMIN_PW2 }), { 'Content-Type': 'text/plain', Origin: null });
    assert.equal(r.status, 403, 'text/plain without Origin (the 1.1.0 bypass) must be rejected');
    r = await c.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2 }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await c.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2 }, { Origin: null });
    assert.equal(r.status, 403, 'no Origin and no Sec-Fetch-Site must be rejected');
    r = await c.req('POST', '/api/login', { username: 'x-unknown', password: 'whatever-123456' }, { Origin: null, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 401, 'same-origin Fetch Metadata is accepted (then fails on credentials)');
  });

  await test('H1: spoofed X-Forwarded-For entries cannot dodge the per-IP limit', async () => {
    let limited = false;
    for (let i = 0; i < 35; i++) {
      // The attacker controls the left part; the trusted proxy appended 192.0.2.77 on the right.
      const r = await new Client(S.base, `10.0.${i}.${i}, 192.0.2.77`).req('POST', '/api/login', { username: `ghost${i}`, password: 'not-the-password-1' });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'must hit 429 within 35 attempts despite rotating spoofed IPs');
  });

  await test('H1: per-account lockout after 5 failures, across different IPs, for real and unknown users', async () => {
    for (const name of ['prashant', 'no-such-user']) {
      for (let i = 0; i < 5; i++) await new Client(S.base, `192.0.2.${100 + i}`).req('POST', '/api/login', { username: name, password: 'Wrong-Password-' + i });
      const r = await new Client(S.base, '192.0.2.200').req('POST', '/api/login', { username: name, password: 'Attacker-Pass-2026-x' });
      assert.equal(r.status, 429, `${name} must be locked (even with the right password)`);
    }
    const r = await admin.req('GET', '/api/admin/users');
    const p = r.json.users.find((u) => u.username === 'prashant');
    assert.equal((await admin.req('POST', `/api/admin/users/${p.id}/unlock`)).status, 200);
    const ok = await new Client(S.base, '192.0.2.201').req('POST', '/api/login', { username: 'prashant', password: 'Attacker-Pass-2026-x' });
    assert.equal(ok.status, 200, 'admin unlock clears the lockout');
  });

  await test('H2: change-password guessing is limited and ends the session', async () => {
    const c = new Client(S.base, '203.0.113.6');
    assert.equal((await c.req('POST', '/api/login', { username: 'prashant', password: 'Attacker-Pass-2026-x' })).status, 200);
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await c.req('POST', '/api/me/password', { currentPassword: 'guess-' + i, newPassword: 'Another-Long-Pass-2026' })).status);
    assert.ok(codes.includes(401), 'must be signed out after repeated guesses: ' + codes.join(','));
    assert.equal((await c.req('GET', '/api/me')).status, 401);
  });

  const user = new Client(S.base, '203.0.113.7');
  await test('H5: javascript: links are stripped server-side; oversize and prototype keys are rejected', async () => {
    assert.equal((await user.req('POST', '/api/login', { username: 'prashant', password: 'Attacker-Pass-2026-x' })).status, 200);
    const evil = doc('Free roadmap', { links: [
      { id: 'a', title: 'x', url: "javascript:fetch('/api/admin/users',{method:'POST'})" },
      { id: 'b', title: 'x', url: 'data:text/html,<script>alert(1)</script>' },
      { id: 'c', title: 'ok', url: 'https://developer.android.com/kotlin' },
    ], color: 'b1);background:url(https://evil/x)', status: '<img src=x>' });
    let r = await user.req('PUT', '/api/data', { baseRevision: 0, doc: evil });
    assert.equal(r.status, 200); assert.equal(r.json.removedLinks, 2);
    r = await user.req('GET', '/api/data');
    const node = r.json.doc.maps[0].nodes.r;
    assert.deepEqual(node.links.map((l) => l.url), ['https://developer.android.com/kotlin']);
    assert.equal(node.color, null); assert.equal(node.status, 'todo');
    assert.ok(r.json.doc.savedAt > 1.7e12, 'timestamps must survive sanitising');
    const rev = r.json.revision;
    r = await user.req('PUT', '/api/data', { baseRevision: rev, doc: doc('x'.repeat(201)) }); assert.equal(r.status, 400);
    const proto = JSON.parse('{"maps":[{"id":"m1","rootId":"r","nodes":{"r":{"id":"r","topic":"a"},"__proto__":{"id":"__proto__","topic":"p"}}}]}');
    r = await user.req('PUT', '/api/data', { baseRevision: rev, doc: proto }); assert.equal(r.status, 400);
    r = await user.req('PUT', '/api/data', { doc: doc('no revision') }); assert.equal(r.status, 400);
  });

  await test('M8: stale saves get 409; history keeps versions; restore works; delete needs confirmation', async () => {
    let r = await user.req('GET', '/api/data'); const rev = r.json.revision;
    r = await user.req('PUT', '/api/data', { baseRevision: rev, doc: doc('Version two') }); assert.equal(r.status, 200);
    r = await user.req('PUT', '/api/data', { baseRevision: rev, doc: doc('Stale tab') });
    assert.equal(r.status, 409, 'a stale device must not overwrite newer work'); assert.equal(r.json.code, 'conflict');
    r = await user.req('PUT', '/api/data', { baseRevision: r.json.revision, doc: doc('Kept mine'), overwrite: true }); assert.equal(r.status, 200);
    r = await user.req('DELETE', '/api/data', {}); assert.equal(r.status, 400, 'delete needs confirmation text');
    r = await user.req('DELETE', '/api/data', { confirm: 'DELETE ALL MY MAPS' }); assert.equal(r.status, 200);
    r = await user.req('GET', '/api/data/history'); const v = r.json.versions;
    assert.ok(v.length >= 2); assert.equal(v[0].reason, 'before-delete');
    r = await user.req('POST', `/api/data/history/${v[0].id}/restore`); assert.equal(r.status, 200);
    r = await user.req('GET', '/api/data'); assert.equal(r.json.doc.maps[0].nodes.r.topic, 'Kept mine');
  });

  await test('M3: save rate limit (30/min per user)', async () => {
    let r = await user.req('GET', '/api/data'); let rev = r.json.revision; let got429 = false;
    for (let i = 0; i < 40 && !got429; i++) {
      r = await user.req('PUT', '/api/data', { baseRevision: rev, doc: doc('spam ' + i) });
      if (r.status === 429) got429 = true; else rev = r.json.revision;
    }
    assert.ok(got429);
  });

  await test('M4: sensitive admin actions need password re-confirmation; last admin is protected', async () => {
    let r = await admin.req('GET', '/api/admin/users');
    const p = r.json.users.find((u) => u.username === 'prashant'); const me = r.json.users.find((u) => u.username === ADMIN);
    r = await admin.req('PATCH', `/api/admin/users/${p.id}`, { role: 'admin' }); assert.equal(r.status, 403);
    r = await admin.req('PATCH', `/api/admin/users/${p.id}`, { role: 'admin', confirmPassword: 'wrong' }); assert.equal(r.status, 403);
    r = await admin.req('PATCH', `/api/admin/users/${me.id}`, { role: 'user', confirmPassword: ADMIN_PW2 }); assert.equal(r.status, 400);
    r = await admin.req('DELETE', `/api/admin/users/${p.id}`, {}); assert.equal(r.status, 403);
    r = await admin.req('POST', `/api/admin/users/${p.id}/password`, { password: 'Temporary-Pass-2026' }); assert.equal(r.status, 403);
  });

  await test('C1: admin assigns legacy maps explicitly (with re-auth); disabled users lose their session at once', async () => {
    let r = await admin.req('GET', '/api/admin/users');
    const p = r.json.users.find((u) => u.username === 'prashant');
    r = await admin.req('POST', '/api/admin/legacy/prashant/assign', { userId: p.id }); assert.equal(r.status, 403);
    r = await admin.req('POST', '/api/admin/legacy/prashant/assign', { userId: p.id, confirmPassword: ADMIN_PW2 }); assert.equal(r.status, 200);
    r = await user.req('GET', '/api/data');
    assert.ok(r.json.doc.maps.some((m) => m.nodes[m.rootId].topic === 'Prashant private notes'));
    r = await admin.req('PATCH', `/api/admin/users/${p.id}`, { disabled: true }); assert.equal(r.status, 200);
    r = await user.req('GET', '/api/me'); assert.equal(r.status, 401, 'disabled account must be signed out immediately');
  });

  await test('M6: audit log records sign-ins, failures, lockouts and admin actions', async () => {
    const r = await admin.req('GET', '/api/admin/audit?limit=500');
    const actions = new Set(r.json.entries.map((e) => e.action));
    for (const a of ['login.success', 'login.failed', 'login.locked', 'mfa.enabled', 'admin.invite_created', 'account.registered', 'admin.reauth_failed', 'admin.legacy_assigned', 'admin.user_updated', 'password.change_blocked'])
      assert.ok(actions.has(a), 'missing audit action ' + a);
    assert.ok(!JSON.stringify(r.json).includes('Attacker-Pass-2026-x'), 'passwords must never be logged');
  });

  await test('C1: legacy files are never re-imported on restart', async () => {
    await S.stop();
    fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'users', 'someone.json'), JSON.stringify(doc('Dropped in later')));
    S = startServer(dir, { REQUIRE_ADMIN_MFA: 'true' }); await S.ready;
    assert.ok(!S.out.join('').includes('Imported'), 'no import after the first run');
    const a = new Client(S.base, '203.0.113.9');
    const r = await a.req('POST', '/api/login', { username: ADMIN, password: ADMIN_PW2, totp: totpNow(mfaSecret, Date.now() + 30000) });
    assert.equal(r.status, 200);
    const l = await a.req('GET', '/api/admin/legacy'); assert.equal(l.json.legacy.length, 0);
  });
  await S.stop();

  /* ---------- production mode checks ---------- */
  await test('Production: refuses to start without an https PUBLIC_ORIGIN', async () => {
    const P = startServer(tmp(), { NODE_ENV: 'production', COOKIE_SECURE: '', ADMIN_USERNAME: 'x-admin', ADMIN_PASSWORD: ADMIN_PW });
    await P.ready.catch(() => {}); await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(P.proc.exitCode, null, 'process must exit'); assert.match(P.out.join(''), /PUBLIC_ORIGIN/);
  });
  await test('Production: __Host- Secure cookie, HSTS, admin sessions limited to 12 h', async () => {
    const pd = tmp();
    const P = startServer(pd, { NODE_ENV: 'production', COOKIE_SECURE: '', PUBLIC_ORIGIN: 'https://atlas.example.com', ADMIN_USERNAME: 'x-admin', ADMIN_PASSWORD: ADMIN_PW, REQUIRE_ADMIN_MFA: 'true' });
    await P.ready;
    const c = new Client(P.base);
    const r = await c.req('POST', '/api/login', { username: 'x-admin', password: ADMIN_PW }, { Origin: 'https://atlas.example.com' });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /^__Host-skill_atlas_session=/); assert.match(sc, /; Secure/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
    assert.match(sc, /Max-Age=43200/);
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
    const bad = await c.req('POST', '/api/logout', {}, { Origin: P.base });
    assert.equal(bad.status, 403, 'in production only PUBLIC_ORIGIN is accepted');
    await P.stop();
  });

  /* ---------- upgrade from a 1.1.0 database ---------- */
  const OLD = process.env.OLD_VERSION_DIR;
  if (OLD && fs.existsSync(path.join(OLD, 'database.js'))) {
    await test('Upgrade: a 1.1.0 database migrates in place; old passwords still work and are re-hashed', async () => {
      const ud = tmp();
      const seed = `const d=require(${JSON.stringify(path.join(OLD, 'database.js'))});(async()=>{d.initializeSchema();const u=await d.createUser('ravi','Old-Version-Pass-2026');d.saveData(u.id,{maps:[{id:'m1',rootId:'r',nodes:{r:{id:'r',topic:'Ravi old map'}}}],currentId:'m1'});d.db.prepare("INSERT INTO legacy_data(username,document) VALUES('ghost','{\\"maps\\":[]}')").run();await d.createUser('old-admin','Old-Admin-Pass-2026','admin');d.db.close()})()`;
      await new Promise((res, rej) => { const p = spawn(process.execPath, ['-e', seed], { env: { ...process.env, DATA_DIR: ud }, cwd: OLD, stdio: 'inherit' }); p.on('exit', (c) => (c ? rej(new Error('seed failed ' + c)) : res())); });
      const U = startServer(ud, { REQUIRE_ADMIN_MFA: 'false' }); await U.ready;
      const c = new Client(U.base);
      let r = await c.req('POST', '/api/login', { username: 'ravi', password: 'Old-Version-Pass-2026' }); assert.equal(r.status, 200);
      r = await c.req('GET', '/api/data'); assert.equal(r.json.revision, 1); assert.equal(r.json.doc.maps[0].nodes.r.topic, 'Ravi old map');
      await U.stop();
      const Database = require('better-sqlite3'); const db = new Database(path.join(ud, 'skill-atlas.sqlite'), { readonly: true });
      assert.equal(db.prepare("SELECT password_params FROM users WHERE username='ravi'").get().password_params, 'scrypt:65536:8:2');
      assert.equal(db.pragma('user_version', { simple: true }), 2); db.close();
    });
  }

  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
