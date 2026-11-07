'use strict';
/**
 * Security helpers shared by the server and database layers:
 *  - safeUrl / sanitizeDocument: whitelist-based cleaning of saved maps (blocks javascript: links, oversized fields,
 *    prototype-pollution keys, unknown properties)
 *  - checkPasswordPolicy: length, common-password and optional breached-password (HIBP k-anonymity) checks
 *  - TOTP (RFC 6238) for two-step verification, using only node:crypto
 */
const crypto = require('node:crypto');

/* ------------------------------------------------------------ limits */
const LIMITS = Object.freeze({
  maps: 200,
  nodesPerMap: 2000,
  nodesTotal: 10000,
  topic: 200,
  desc: 20000,
  pointers: 100,
  pointerText: 500,
  links: 50,
  linkTitle: 200,
  url: 2048,
  tags: 30,
  tag: 40,
  id: 64,
});
const PALETTE = new Set(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']);
const STATUSES = new Set(['todo', 'learning', 'done']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** Returns a normalised http(s) URL or null. Anything else (javascript:, data:, vbscript:, file:…) is rejected. */
function safeUrl(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.url) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null; // no credentials embedded in links
    return u.href.length <= LIMITS.url ? u.href : null;
  } catch { return null; }
}

const isId = (v) => typeof v === 'string' && ID_RE.test(v) && !FORBIDDEN_KEYS.has(v);
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : d); // canvas positions
const timestamp = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.floor(v) : Date.now());
function text(v, max, label) {
  const s = v == null ? '' : String(v);
  if (s.length > max) throw new ValidationError(`${label} is longer than ${max.toLocaleString('en')} characters.`);
  return s;
}

/**
 * Rebuilds a saved document from scratch, copying only known fields.
 * Throws ValidationError for structural problems and oversize fields; silently drops unsafe links.
 * @returns {{ doc: object, removedLinks: number }}
 */
function sanitizeDocument(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.maps)) throw new ValidationError('Expected an object with a "maps" array.');
  if (input.maps.length > LIMITS.maps) throw new ValidationError(`Too many maps (limit ${LIMITS.maps}).`);
  let total = 0, removedLinks = 0;
  const seenMapIds = new Set();
  const maps = input.maps.map((m) => {
    if (!m || typeof m !== 'object' || !isId(m.id) || !isId(m.rootId) || !m.nodes || typeof m.nodes !== 'object' || Array.isArray(m.nodes))
      throw new ValidationError('One of the maps is malformed.');
    if (seenMapIds.has(m.id)) throw new ValidationError('Two maps share the same id.');
    seenMapIds.add(m.id);
    const entries = Object.entries(m.nodes);
    if (entries.length > LIMITS.nodesPerMap) throw new ValidationError(`A map has too many topics (limit ${LIMITS.nodesPerMap}).`);
    total += entries.length;
    if (total > LIMITS.nodesTotal) throw new ValidationError(`Too many topics across all maps (limit ${LIMITS.nodesTotal}).`);
    const ids = new Set(entries.map(([id]) => id));
    if (!ids.has(m.rootId)) throw new ValidationError('A map is missing its central topic.');
    const nodes = Object.create(null);
    for (const [id, n] of entries) {
      if (!isId(id) || !n || typeof n !== 'object') throw new ValidationError('A topic has an invalid id.');
      const parent = id === m.rootId ? null : (isId(n.parent) && ids.has(n.parent) && n.parent !== id ? n.parent : m.rootId);
      const children = Array.isArray(n.children) ? [...new Set(n.children.filter((c) => isId(c) && ids.has(c) && c !== id && c !== m.rootId))] : [];
      const pointers = Array.isArray(n.pointers) ? n.pointers : [];
      const links = Array.isArray(n.links) ? n.links : [];
      const tags = Array.isArray(n.tags) ? n.tags : [];
      if (pointers.length > LIMITS.pointers) throw new ValidationError(`A topic has too many pointers (limit ${LIMITS.pointers}).`);
      if (links.length > LIMITS.links) throw new ValidationError(`A topic has too many links (limit ${LIMITS.links}).`);
      if (tags.length > LIMITS.tags) throw new ValidationError(`A topic has too many tags (limit ${LIMITS.tags}).`);
      const cleanLinks = [];
      for (const l of links) {
        if (!l || typeof l !== 'object') continue;
        const url = safeUrl(l.url);
        if (!url) { removedLinks++; continue; }
        cleanLinks.push({ id: isId(l.id) ? l.id : crypto.randomBytes(6).toString('hex'), title: text(l.title, LIMITS.linkTitle, 'A link title'), url });
      }
      nodes[id] = {
        id,
        parent,
        children,
        topic: text(n.topic, LIMITS.topic, 'A topic name') || 'Untitled',
        desc: text(n.desc, LIMITS.desc, 'A description'),
        pointers: pointers.filter((p) => p && typeof p === 'object').map((p) => ({
          id: isId(p.id) ? p.id : crypto.randomBytes(6).toString('hex'),
          text: text(p.text, LIMITS.pointerText, 'A pointer'),
          done: p.done === true,
        })),
        links: cleanLinks,
        tags: tags.map((t) => text(t, LIMITS.tag, 'A tag')).filter(Boolean),
        status: STATUSES.has(n.status) ? n.status : 'todo',
        color: PALETTE.has(n.color) ? n.color : null,
        collapsed: n.collapsed === true,
        x: finite(n.x),
        y: finite(n.y),
      };
    }
    return { id: m.id, rootId: m.rootId, nodes, auto: m.auto !== false, created: timestamp(m.created), updated: timestamp(m.updated) };
  });
  const currentId = typeof input.currentId === 'string' && seenMapIds.has(input.currentId) ? input.currentId : (maps[0]?.id ?? null);
  // JSON round-trip turns the null-prototype node objects back into plain objects.
  return { doc: JSON.parse(JSON.stringify({ maps, currentId, savedAt: timestamp(input.savedAt) })), removedLinks };
}

/* ---------------------------------------------------------- passwords */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
// Small built-in deny list; the optional HIBP check catches the long tail.
const COMMON = new Set(`password1234 password12345 password123456 123456789012 1234567890123 qwertyuiopas qwerty123456
qwertyuiop12 iloveyou1234 welcome12345 welcome@1234 admin1234567 administrator letmein12345 changeme1234 passw0rd1234
p@ssw0rd1234 p@ssword1234 monkey123456 football1234 baseball1234 superman1234 trustno11234 sunshine1234 princess1234
abc123456789 abcdefghijkl 111111111111 000000000000 aaaaaaaaaaaa india@123456 pune@1234567 skillatlas12 skill-atlas1
skillatlas123 mindmap12345 password@123 password#123 qwerty@12345 asdfghjkl123 zxcvbnm12345`.split(/\s+/));

function checkPasswordPolicy(password, username) {
  if (typeof password !== 'string') return 'Enter a password.';
  const len = [...password].length;
  if (len < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (len > PASSWORD_MAX) return `Password must be no more than ${PASSWORD_MAX} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(0123456789|1234567890|abcdefghij)/.test(lower))
    return 'That password is too common. Choose something less predictable, such as a few unrelated words.';
  if (username && username.length >= 3 && lower.includes(String(username).toLowerCase()))
    return 'Your password must not contain your username.';
  return null;
}

/** HIBP Pwned Passwords range API (k-anonymity: only the first 5 hex chars of the SHA-1 leave the server). Fails open. */
async function isBreachedPassword(password) {
  if (process.env.HIBP_CHECK !== 'true') return false;
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const r = await fetch('https://api.pwnedpasswords.com/range/' + sha1.slice(0, 5), {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'skill-atlas-password-check' },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const suffix = sha1.slice(5);
    return (await r.text()).split('\n').some((line) => { const [s, n] = line.trim().split(':'); return s === suffix && Number(n) > 0; });
  } catch { return false; }
}

/* --------------------------------------------------------------- TOTP */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
const TOTP_STEP = 30;
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
/** Verifies a 6-digit code within ±1 step. Returns the matched step, or 0. Steps <= lastStep are rejected (no replay). */
function verifyTotp(secretB32, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return 0;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 1000 / TOTP_STEP);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, s)); const got = Buffer.from(String(code).trim());
    if (crypto.timingSafeEqual(expected, got)) return s;
  }
  return 0;
}
function totpUri(secretB32, username, issuer = 'Skill Atlas') {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
}
const totpNow = (secretB32, now = Date.now()) => hotp(base32Decode(secretB32), Math.floor(now / 1000 / TOTP_STEP)); // used by tests

module.exports = {
  LIMITS, ValidationError, safeUrl, sanitizeDocument,
  PASSWORD_MIN, PASSWORD_MAX, checkPasswordPolicy, isBreachedPassword,
  newTotpSecret, verifyTotp, totpUri, totpNow,
};
