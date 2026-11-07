'use strict';
/**
 * Skill Atlas data layer (SQLite via better-sqlite3).
 * Schema version 2 (Skill Atlas 1.2.0). Upgrades a 1.1.0 database in place.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const sec = require('./security');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'skill-atlas.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const MAX_USERS = Number(process.env.MAX_USERS) || 50;
const MAX_SESSIONS_PER_USER = 10;
const HISTORY_KEEP = 20;
const HISTORY_MIN_GAP_MS = 5 * 60 * 1000;
const LOCK_AFTER = 5;

const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------------ password hashing */
// OWASP-listed scrypt profile (N=2^16, r=8, p=2 ≈ 64 MiB). Parameters are stored per user so they can be raised later.
const SCRYPT = { N: 65536, r: 8, p: 2, keylen: 64 };
const SCRYPT_TAG = `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}`;
const LEGACY_TAG = 'scrypt:32768:8:1'; // Skill Atlas 1.1.0
const parseTag = (tag) => { const [, N, r, p] = String(tag || LEGACY_TAG).split(':').map(Number); return { N, r, p, keylen: 64 }; };

// Concurrency limit: each hash uses ~64 MiB and a libuv thread. Excess requests are queued, then rejected.
const MAX_HASHES = Number(process.env.MAX_CONCURRENT_HASHES) || 4;
const MAX_HASH_QUEUE = 64;
let activeHashes = 0; const hashQueue = [];
function acquireHash() {
  if (activeHashes < MAX_HASHES) { activeHashes++; return Promise.resolve(); }
  if (hashQueue.length >= MAX_HASH_QUEUE) return Promise.reject(httpError(503, 'The server is busy. Try again in a moment.'));
  return new Promise((resolve) => hashQueue.push(resolve));
}
function releaseHash() { const next = hashQueue.shift(); if (next) next(); else activeHashes--; }
async function scryptRaw(password, salt, params) {
  await acquireHash();
  try {
    return await new Promise((resolve, reject) => crypto.scrypt(password, salt, params.keylen, {
      N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 16 * 1024 * 1024,
    }, (e, k) => (e ? reject(e) : resolve(k))));
  } finally { releaseHash(); }
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptRaw(password, salt, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), params: SCRYPT_TAG };
}
const DUMMY = { salt: crypto.randomBytes(16).toString('hex'), hash: crypto.randomBytes(64).toString('hex'), params: SCRYPT_TAG };
async function verifyPassword(password, row) {
  const r = row && row.password_hash ? row : DUMMY; // always do the work, so timing doesn't reveal unknown users
  const actual = await scryptRaw(String(password), Buffer.from(r.password_salt || r.salt, 'hex'), parseTag(r.password_params || r.params));
  const expected = Buffer.from(r.password_hash || r.hash, 'hex');
  return r !== DUMMY && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function validateNewPassword(password, username) {
  const problem = sec.checkPasswordPolicy(password, username);
  if (problem) throw httpError(400, problem);
  if (await sec.isBreachedPassword(password)) throw httpError(400, 'That password has appeared in a known data breach. Choose a different one.');
}

/* ------------------------------------------------------------------ schema & migrations */
function columnExists(table, col) { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
function addColumn(table, col, def) { if (!columnExists(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }

function initializeSchema() {
  // Version 1 tables (Skill Atlas 1.1.0) — kept identical so old databases upgrade cleanly.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      document TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_data (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      document TEXT NOT NULL
    );
  `);
  const version = db.pragma('user_version', { simple: true });
  if (version < 2) {
    db.transaction(() => {
      addColumn('users', 'password_params', `TEXT NOT NULL DEFAULT '${LEGACY_TAG}'`);
      addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('users', 'totp_secret', 'TEXT');
      addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('users', 'last_login_at', 'INTEGER');
      addColumn('sessions', 'last_seen_at', 'INTEGER');
      addColumn('user_data', 'revision', 'INTEGER NOT NULL DEFAULT 1');
      addColumn('legacy_data', 'imported_at', 'INTEGER');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS login_failures (
          username TEXT PRIMARY KEY COLLATE NOCASE,
          count INTEGER NOT NULL,
          locked_until INTEGER NOT NULL DEFAULT 0,
          last_failed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_data_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          document TEXT NOT NULL,
          maps_count INTEGER NOT NULL,
          reason TEXT NOT NULL,
          saved_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS history_user ON user_data_history(user_id, saved_at);
        CREATE TABLE IF NOT EXISTS invites (
          code_hash TEXT PRIMARY KEY,
          hint TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          used_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          actor_id INTEGER,
          actor TEXT,
          action TEXT NOT NULL,
          target TEXT,
          ip TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);
      `);
      // 1.1.0 data written by the old demo login cannot be trusted to belong to a username.
      db.prepare('UPDATE legacy_data SET imported_at = COALESCE(imported_at, ?)').run(Date.now());
      db.pragma('user_version = 2');
    })();
  }
}
initializeSchema();

const meta = {
  get: (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value,
  set: (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
};

/* ------------------------------------------------------------------ audit log */
function audit(actor, action, target, ip, detail) {
  try {
    db.prepare('INSERT INTO audit_log (ts, actor_id, actor, action, target, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), actor?.id ?? null, actor?.username ?? (typeof actor === 'string' ? actor : null), action, target == null ? null : String(target), ip || null, detail ? JSON.stringify(detail).slice(0, 1000) : null);
  } catch (e) { console.error('audit write failed', e.message); }
}
function listAudit({ limit = 100, before } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = before
    ? db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(Number(before), lim)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(lim);
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
function pruneAudit() { db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - 365 * 86400000); }

/* ------------------------------------------------------------------ legacy import (one time, no auto-claim) */
function importLegacyFiles() {
  if (meta.get('legacy_files_imported')) return 0;
  const legacyDir = path.join(DATA_DIR, 'users');
  let count = 0;
  if (fs.existsSync(legacyDir)) {
    const insert = db.prepare('INSERT OR IGNORE INTO legacy_data (username, document, imported_at) VALUES (?, ?, ?)');
    for (const name of fs.readdirSync(legacyDir)) {
      if (!name.endsWith('.json')) continue;
      let username;
      try { username = decodeURIComponent(name.slice(0, -5)).trim().toLowerCase(); } catch { continue; }
      if (!/^[\w.@-]{2,40}$/.test(username)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(legacyDir, name), 'utf8'));
        if (!parsed || !Array.isArray(parsed.maps)) continue;
        if (insert.run(username, JSON.stringify(parsed), Date.now()).changes) count++;
      } catch { /* skip malformed files */ }
    }
    // Move the files out of the import path so they can never be re-imported.
    try { fs.renameSync(legacyDir, `${legacyDir}.migrated-${Date.now()}`); } catch (e) { console.warn('Could not rename legacy folder:', e.message); }
  }
  meta.set('legacy_files_imported', Date.now());
  return count;
}
function listLegacy() {
  return db.prepare('SELECT username, document, imported_at FROM legacy_data ORDER BY username').all().map((r) => {
    let maps = 0; try { maps = JSON.parse(r.document).maps.length; } catch { /* ignore */ }
    const match = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(r.username);
    return { username: r.username, maps, bytes: Buffer.byteLength(r.document), importedAt: r.imported_at, matchingUserId: match?.id ?? null };
  });
}
function assignLegacy(username, userId) {
  const row = db.prepare('SELECT document FROM legacy_data WHERE username = ? COLLATE NOCASE').get(username);
  if (!row) throw httpError(404, 'No legacy maps found for that name.');
  if (!getUserById(userId)) throw httpError(404, 'User not found.');
  let legacy;
  try { legacy = sec.sanitizeDocument(JSON.parse(row.document)).doc; } catch (e) { throw httpError(400, 'Legacy maps are malformed: ' + e.message); }
  const current = JSON.parse(loadData(userId).document);
  const usedIds = new Set(current.maps.map((m) => m.id));
  for (const m of legacy.maps) { while (usedIds.has(m.id)) m.id = 'm' + crypto.randomBytes(5).toString('hex'); usedIds.add(m.id); }
  const merged = { maps: [...current.maps, ...legacy.maps], currentId: current.currentId || legacy.currentId, savedAt: Date.now() };
  const cleaned = sec.sanitizeDocument(merged).doc;
  db.transaction(() => {
    forceSave(userId, cleaned, 'legacy-assign');
    db.prepare('DELETE FROM legacy_data WHERE username = ? COLLATE NOCASE').run(username);
  })();
  return legacy.maps.length;
}
function deleteLegacy(username) { return db.prepare('DELETE FROM legacy_data WHERE username = ? COLLATE NOCASE').run(username).changes > 0; }

/* ------------------------------------------------------------------ users */
function publicUser(u) {
  return u && {
    id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.created_at,
    mustChangePassword: !!u.must_change_password, mfaEnabled: !!u.totp_enabled, lastLoginAt: u.last_login_at ?? null,
  };
}
const USER_COLS = 'id, username, role, disabled, created_at, must_change_password, totp_enabled, last_login_at';
const getUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
function getUserById(id) { return publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)); }
function findUserRow(username) { return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim()); }
function listUsers() { return db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at, id`).all().map(publicUser); }
function userCount() { return db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
function activeAdminCount() { return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n; }

const USER_RE = /^[\w.@-]{2,40}$/;
/**
 * @param {object} opts { role, mustChangePassword, inviteCode, requireInvite }
 */
async function createUser(username, password, opts = {}) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!USER_RE.test(normalized)) throw httpError(400, 'Use 2–40 letters, numbers, dots, dashes or underscores for your username.');
  await validateNewPassword(password, normalized);
  const credentials = await hashPassword(password);
  try {
    return db.transaction(() => {
      if (userCount() >= MAX_USERS) throw httpError(403, 'This Skill Atlas server has reached its account limit.');
      let invite = null;
      if (opts.requireInvite) {
        invite = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(normalizeInvite(opts.inviteCode)));
        if (!invite || invite.used_at || invite.expires_at < Date.now()) throw httpError(403, 'That invite code is invalid or has expired.');
      }
      const inserted = db.prepare(`INSERT INTO users (username, password_salt, password_hash, password_params, role, disabled, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(normalized, credentials.salt, credentials.hash, credentials.params, opts.role === 'admin' ? 'admin' : 'user', opts.mustChangePassword ? 1 : 0, Date.now());
      if (invite) db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(inserted.lastInsertRowid, Date.now(), invite.code_hash);
      return getUserById(inserted.lastInsertRowid);
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw httpError(409, 'That username is already registered.');
    throw error;
  }
}
function updateUser(id, { role, disabled }) {
  const user = getUserRow(id);
  if (!user) return null;
  const nextRole = role ?? user.role;
  const nextDisabled = disabled ?? !!user.disabled;
  return db.transaction(() => {
    // Re-check inside the transaction so two admins can't remove the last admin concurrently.
    if (user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || nextDisabled) && activeAdminCount() <= 1)
      throw httpError(400, 'At least one active administrator must remain.');
    db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(nextRole, Number(nextDisabled), id);
    if (nextDisabled || nextRole !== user.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return getUserById(id);
  })();
}
function deleteUser(id) {
  return db.transaction(() => {
    const user = getUserRow(id);
    if (!user) return false;
    if (user.role === 'admin' && !user.disabled && activeAdminCount() <= 1) throw httpError(400, 'At least one active administrator must remain.');
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  })();
}
async function resetUserPassword(id, password) {
  const user = getUserRow(id);
  if (!user) return false;
  await validateNewPassword(password, user.username);
  const c = await hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, password_params = ?, must_change_password = 1 WHERE id = ?').run(c.salt, c.hash, c.params, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  clearFailures(user.username);
  return true;
}
async function changeUserPassword(id, currentPassword, newPassword, keepToken) {
  const user = getUserRow(id);
  if (!user || !await verifyPassword(currentPassword, user)) return false;
  if (currentPassword === newPassword) throw httpError(400, 'Choose a new password that is different from the current one.');
  await validateNewPassword(newPassword, user.username);
  const c = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, password_params = ?, must_change_password = 0 WHERE id = ?').run(c.salt, c.hash, c.params, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(id, sha256(keepToken || ''));
  })();
  return true;
}
/** Re-authentication for sensitive actions (admin "sudo"). */
async function confirmPassword(id, password) { const user = getUserRow(id); return !!user && await verifyPassword(String(password || ''), user); }

/* ------------------------------------------------------------------ login & lockout */
function lockState(username) {
  const row = db.prepare('SELECT * FROM login_failures WHERE username = ? COLLATE NOCASE').get(username);
  return row && row.locked_until > Date.now() ? row.locked_until : 0;
}
function recordFailure(username) {
  const now = Date.now();
  const row = db.prepare('SELECT count FROM login_failures WHERE username = ? COLLATE NOCASE').get(username);
  const count = (row?.count || 0) + 1;
  const lockedUntil = count >= LOCK_AFTER ? now + Math.min(2 ** (count - LOCK_AFTER), 60) * 60_000 : 0;
  db.prepare(`INSERT INTO login_failures (username, count, locked_until, last_failed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, last_failed_at = excluded.last_failed_at`)
    .run(username, count, lockedUntil, now);
  return lockedUntil;
}
function clearFailures(username) { db.prepare('DELETE FROM login_failures WHERE username = ? COLLATE NOCASE').run(username); }
function pruneFailures() { db.prepare('DELETE FROM login_failures WHERE last_failed_at < ? AND locked_until < ?').run(Date.now() - 86400000, Date.now()); }

/**
 * Returns { user } on success or { error: 'invalid' | 'locked' | 'mfa_required', lockedUntil? }.
 * Lockout applies to any username (existing or not), so it doesn't reveal which accounts exist.
 */
async function authenticate(username, password, totpCode) {
  const name = String(username || '').trim().toLowerCase();
  const lockedUntil = lockState(name);
  const row = findUserRow(name);
  const ok = await verifyPassword(String(password || ''), row); // always hashed, even when locked or unknown
  if (lockedUntil) return { error: 'locked', lockedUntil };
  if (!row || !ok || row.disabled) return { error: 'invalid', lockedUntil: recordFailure(name) || undefined };
  if (row.totp_enabled) {
    if (!totpCode) return { error: 'mfa_required' };
    const step = sec.verifyTotp(row.totp_secret, totpCode, row.totp_last_step);
    if (!step) return { error: 'invalid', mfa: true, lockedUntil: recordFailure(name) || undefined };
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
  }
  clearFailures(name);
  // Transparently upgrade hashes created with older scrypt parameters.
  if (row.password_params !== SCRYPT_TAG) {
    const c = await hashPassword(String(password));
    db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, password_params = ? WHERE id = ?').run(c.salt, c.hash, c.params, row.id);
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { user: getUserById(row.id) };
}
function unlockUser(username) { clearFailures(String(username).toLowerCase()); }

/* ------------------------------------------------------------------ two-step verification (TOTP) */
function startMfaSetup(id) {
  const user = getUserRow(id);
  if (!user) throw httpError(404, 'User not found.');
  if (user.totp_enabled) throw httpError(400, 'Two-step verification is already on.');
  const secret = sec.newTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?').run(secret, id);
  return { secret, uri: sec.totpUri(secret, user.username) };
}
function enableMfa(id, code) {
  const user = getUserRow(id);
  if (!user?.totp_secret || user.totp_enabled) throw httpError(400, 'Start two-step setup first.');
  const step = sec.verifyTotp(user.totp_secret, code, 0);
  if (!step) throw httpError(400, 'That code didn’t match. Check the time on your phone and try the newest code.');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, id);
  return true;
}
async function disableMfa(id, password, code) {
  const user = getUserRow(id);
  if (!user?.totp_enabled) throw httpError(400, 'Two-step verification is not on.');
  if (!await verifyPassword(String(password || ''), user)) throw httpError(400, 'Password is incorrect.');
  if (!sec.verifyTotp(user.totp_secret, code, user.totp_last_step)) throw httpError(400, 'That code didn’t match.');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?').run(id);
  return true;
}
function resetMfa(id) {
  const r = db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?').run(id);
  if (r.changes) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return r.changes > 0;
}

/* ------------------------------------------------------------------ sessions */
function createSession(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), userId, now, now + ttlMs, now);
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
      (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`).run(userId, userId, MAX_SESSIONS_PER_USER);
  })();
  return token;
}
function getSession(token, idleMs) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const hash = sha256(token);
  const row = db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.must_change_password, u.totp_enabled, u.last_login_at,
      s.expires_at, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.disabled || (idleMs && now - (row.last_seen_at || 0) > idleMs)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - (row.last_seen_at || 0) > 60_000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash);
  return publicUser(row);
}
function destroySession(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }
function pruneSessions() { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

/* ------------------------------------------------------------------ invites */
const normalizeInvite = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function createInvite(adminId, hours = 48, note = '') {
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion; 12 chars ≈ 60 bits
  const raw = Array.from({ length: 12 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
  const code = raw.match(/.{4}/g).join('-');
  const h = Math.max(1, Math.min(24 * 30, Number(hours) || 48));
  db.prepare('INSERT INTO invites (code_hash, hint, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(normalizeInvite(code)), raw.slice(0, 4), String(note || '').slice(0, 80), adminId, Date.now(), Date.now() + h * 3600000);
  return { code, expiresAt: Date.now() + h * 3600000 };
}
function listInvites() {
  return db.prepare(`SELECT i.code_hash, i.hint, i.note, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name
    FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`).all()
    .map((r) => ({ id: r.code_hash.slice(0, 16), hint: r.hint + '-…', note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by_name }));
}
function deleteInvite(id) { return db.prepare("DELETE FROM invites WHERE substr(code_hash, 1, 16) = ?").run(String(id)).changes > 0; }

/* ------------------------------------------------------------------ map data, revisions & history */
const EMPTY_DOC = JSON.stringify({ maps: [], currentId: null, savedAt: 0 });
function loadData(userId) {
  const row = db.prepare('SELECT document, revision FROM user_data WHERE user_id = ?').get(userId);
  return row ? { document: row.document, revision: row.revision } : { document: EMPTY_DOC, revision: 0 };
}
function snapshot(userId, row, reason, force) {
  if (!row) return;
  const last = db.prepare('SELECT saved_at FROM user_data_history WHERE user_id = ? ORDER BY saved_at DESC LIMIT 1').get(userId);
  if (!force && last && Date.now() - last.saved_at < HISTORY_MIN_GAP_MS) return;
  let mapsCount = 0; try { mapsCount = JSON.parse(row.document).maps.length; } catch { /* ignore */ }
  db.prepare('INSERT INTO user_data_history (user_id, revision, document, maps_count, reason, saved_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, row.revision, row.document, mapsCount, reason, Date.now());
  db.prepare(`DELETE FROM user_data_history WHERE user_id = ? AND id NOT IN
    (SELECT id FROM user_data_history WHERE user_id = ? ORDER BY saved_at DESC LIMIT ?)`).run(userId, userId, HISTORY_KEEP);
}
function writeDoc(userId, doc, revision) {
  db.prepare(`INSERT INTO user_data (user_id, document, updated_at, revision) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, revision = excluded.revision`)
    .run(userId, JSON.stringify(doc), Date.now(), revision);
}
/** Optimistic concurrency: the caller must send the revision it last saw. Returns { revision } or { conflict, revision }. */
function saveData(userId, doc, baseRevision, overwrite) {
  return db.transaction(() => {
    const row = db.prepare('SELECT document, revision FROM user_data WHERE user_id = ?').get(userId);
    const current = row ? row.revision : 0;
    if (baseRevision !== current) return { conflict: true, revision: current };
    snapshot(userId, row, overwrite ? 'conflict' : 'autosave', !!overwrite);
    writeDoc(userId, doc, current + 1);
    return { revision: current + 1 };
  })();
}
function forceSave(userId, doc, reason) {
  const row = db.prepare('SELECT document, revision FROM user_data WHERE user_id = ?').get(userId);
  snapshot(userId, row, reason, true);
  const next = (row ? row.revision : 0) + 1;
  writeDoc(userId, doc, next);
  return next;
}
function deleteData(userId) {
  return db.transaction(() => {
    const row = db.prepare('SELECT document, revision FROM user_data WHERE user_id = ?').get(userId);
    snapshot(userId, row, 'before-delete', true); // recoverable from history
    db.prepare('DELETE FROM user_data WHERE user_id = ?').run(userId);
  })();
}
function listHistory(userId) {
  return db.prepare('SELECT id, revision, maps_count, reason, saved_at, length(document) AS bytes FROM user_data_history WHERE user_id = ? ORDER BY saved_at DESC')
    .all(userId).map((r) => ({ id: r.id, revision: r.revision, maps: r.maps_count, reason: r.reason, savedAt: r.saved_at, bytes: r.bytes }));
}
function restoreHistory(userId, historyId) {
  return db.transaction(() => {
    const h = db.prepare('SELECT document FROM user_data_history WHERE id = ? AND user_id = ?').get(historyId, userId);
    if (!h) throw httpError(404, 'That version no longer exists.');
    return forceSave(userId, JSON.parse(h.document), 'before-restore');
  })();
}

/* ------------------------------------------------------------------ admin bootstrap */
async function seedAdmin(username, password) {
  if (db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) return null;
  if (!username || !password) {
    if (userCount()) { console.warn('No administrator exists. Set ADMIN_USERNAME and ADMIN_PASSWORD_FILE to bootstrap one.'); return null; }
    throw new Error('First-run setup needs ADMIN_USERNAME and ADMIN_PASSWORD_FILE (or ADMIN_PASSWORD).');
  }
  if (findUserRow(username)) throw new Error(`Cannot create administrator: the username "${username}" is already taken by a regular account.`);
  return createUser(username, password, { role: 'admin', mustChangePassword: true });
}

/* ------------------------------------------------------------------ backups */
async function backupNow(dir = path.join(DATA_DIR, 'backups'), keep = Number(process.env.BACKUP_KEEP) || 7) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `skill-atlas-${stamp}.sqlite`);
  await db.backup(file); // consistent online backup (safe with WAL), unlike copying the file
  const old = fs.readdirSync(dir).filter((f) => /^skill-atlas-.*\.sqlite$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function housekeeping() { pruneSessions(); pruneFailures(); pruneAudit(); }

module.exports = {
  db, DB_FILE, initializeSchema, importLegacyFiles, listLegacy, assignLegacy, deleteLegacy,
  seedAdmin, createUser, updateUser, deleteUser, resetUserPassword, changeUserPassword, confirmPassword,
  authenticate, unlockUser, startMfaSetup, enableMfa, disableMfa, resetMfa,
  createSession, getSession, destroySession, pruneSessions,
  createInvite, listInvites, deleteInvite,
  loadData, saveData, deleteData, listHistory, restoreHistory,
  listUsers, getUserById, findUserRow, activeAdminCount, userCount,
  audit, listAudit, backupNow, housekeeping, SCRYPT_TAG,
};
