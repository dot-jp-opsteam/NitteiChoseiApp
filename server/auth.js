/* =========================================================
   認証ヘルパー
   - パスワードのハッシュ化・検証（scrypt）
   - セッショントークンの生成・検証（DBには sha256(token) のみ保存）
   - Cookieのシリアライズ・簡易パース
   すべてNode標準のcrypto/utilのみで実装（追加npm依存なし）
   ========================================================= */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'ops_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

/* ---------- パスワードハッシュ ---------- */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---------- セッショントークン ---------- */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

/* ---------- Cookie ---------- */
function serializeSessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function serializeClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function getSessionTokenFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

/* ---------- 秘密鍵の定数時間比較（招待キー検証用） ---------- */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  hashPassword, verifyPassword,
  newSessionToken, hashToken, sessionExpiry,
  serializeSessionCookie, serializeClearCookie, parseCookies, getSessionTokenFromReq,
  safeEqual,
};
