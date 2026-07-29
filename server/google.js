/* =========================================================
   Google連携ヘルパー（カレンダー連携＋Googleでログイン）
   - OAuth2（Authorization Code）のURL生成・トークン交換・リフレッシュ
   - Googleでログイン（OpenID Connect）：id_tokenから本人情報を取得
   - トークンのAES-256-GCM暗号化・復号（TOKEN_ENCRYPTION_KEY使用）
   - watch（push通知）チャンネルの登録・停止
   - イベントの一覧取得・作成・更新・削除
   すべてNode標準のfetch/cryptoのみで実装（追加npm依存なし）
   ========================================================= */
const crypto = require('node:crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY; // 64桁hex（32byte）
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // 例: https://ops-nittyou-app.onrender.com

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const LOGIN_SCOPE = 'openid email profile';

function redirectUri() {
  return `${PUBLIC_BASE_URL}/api/auth/google/callback`;
}
/* ログイン用は別のリダイレクトURIを使う（カレンダー連携用と役割が違うため混ざらないようにする） */
function loginRedirectUri() {
  return `${PUBLIC_BASE_URL}/api/auth/google/login/callback`;
}

/* ---------- 暗号化 ---------- */
function encrypt(text) {
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(payload) {
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, 'hex');
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/* ---------- state（CSRF対策・staffId改ざん防止） ---------- */
function signState(staffId) {
  const payload = JSON.stringify({ staffId, nonce: crypto.randomBytes(8).toString('hex') });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_ENCRYPTION_KEY).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function verifyState(state) {
  const [b64, sig] = String(state || '').split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_ENCRYPTION_KEY).update(b64).digest('base64url');
  // 長さが違うと timingSafeEqual が例外を投げるため、先に長さを確認する
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return payload.staffId;
  } catch {
    return null;
  }
}

/* ---------- OAuth ---------- */
function getAuthUrl(staffId) {
  const state = signState(staffId);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

/* ---------- Googleでログイン（OpenID Connect） ----------
   カレンダー連携とは別物。カレンダーの権限は要求せず、本人確認（メール・氏名）だけを取得する */
/* purpose は 'login'（通常のログイン）／'login-remember'（次回から自動ログインにチェック済み）／
   'staff'（スタッフ登録）のいずれか。戻ってきたときに state から用途を判別して処理を分ける */
function getLoginAuthUrl(purpose = 'login') {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: loginRedirectUri(),
    response_type: 'code',
    scope: LOGIN_SCOPE,
    // 毎回アカウント選択画面を出す（共用端末で前の人のアカウントに入ってしまうのを防ぐ）
    prompt: 'select_account',
    state: signState(purpose),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/* Googleで本人確認が済んだ情報を、フォーム送信まで一時的に持ち回すための署名付きトークン。
   DBに書かずに済ませるため、内容をHMACで署名してURLに載せる。改ざんすると検証に失敗する */
function signPayload(obj) {
  const b64 = Buffer.from(JSON.stringify({ ...obj, ts: Date.now() }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_ENCRYPTION_KEY).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function verifyPayload(token, maxAgeMs = 30 * 60 * 1000) {
  const [b64, sig] = String(token || '').split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_ENCRYPTION_KEY).update(b64).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload.ts || Date.now() - payload.ts > maxAgeMs) return null; // 古いものは受け付けない
    return payload;
  } catch {
    return null;
  }
}

async function exchangeLoginCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: loginRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`login token exchange failed: ${await res.text()}`);
  return res.json(); // { access_token, id_token, expires_in, ... }
}

/* id_token から本人情報を取り出す。
   このトークンはGoogleのトークンエンドポイントからHTTPSで直接受け取ったものなので、
   Googleの仕様上あらためて署名を検証する必要はない（aud/issだけ念のため確認する）。 */
function parseIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('id_tokenの形式が不正です');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('id_tokenの発行先が一致しません');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) {
    throw new Error('id_tokenの発行元が不正です');
  }
  if (!claims.email) throw new Error('メールアドレスを取得できませんでした');
  return {
    sub: claims.sub,
    email: String(claims.email).toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: claims.name || claims.given_name || '',
    picture: claims.picture || '',
  };
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`token refresh failed: ${body}`);
    /* invalid_grant は「リフレッシュトークンが失効した／取り消された」状態。
       何度やり直しても回復しないので、呼び出し側が「連携切れ」として
       扱えるように印を付ける。ここを普通のエラーと区別しないと、
       本人は連携済みのつもりなのに予定が反映されない状態が続いてしまう */
    if (/invalid_grant/.test(body)) err.code = 'REFRESH_REVOKED';
    throw err;
  }
  return res.json(); // { access_token, expires_in, ... }
}

/* 有効なアクセストークンを返す。期限切れならリフレッシュしてDB更新もコールバックで依頼する */
async function getValidAccessToken(tokenRow, onRefreshed) {
  const expiry = new Date(tokenRow.token_expiry).getTime();
  if (Date.now() < expiry - 60000) {
    return decrypt(tokenRow.access_token);
  }
  const refreshToken = decrypt(tokenRow.refresh_token);
  const refreshed = await refreshAccessToken(refreshToken);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await onRefreshed(encrypt(refreshed.access_token), newExpiry);
  return refreshed.access_token;
}

/* ---------- watch（push通知）チャンネル ---------- */
async function startWatch(accessToken, staffId, calendarId = 'primary') {
  const channelId = 'ops-' + crypto.randomBytes(12).toString('hex');
  const channelToken = crypto.randomBytes(16).toString('hex');
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000; // 6日後（最大7日制限に対する安全マージン）
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: channelId,
      type: 'web_hook',
      address: `${PUBLIC_BASE_URL}/api/webhooks/google-calendar`,
      token: channelToken,
      expiration: String(expiration),
    }),
  });
  if (!res.ok) throw new Error(`watch failed: ${await res.text()}`);
  const data = await res.json();
  return { channelId, resourceId: data.resourceId, channelToken, expiration: new Date(Number(data.expiration || expiration)).toISOString() };
}

async function stopWatch(accessToken, channelId, resourceId) {
  await fetch(`${CAL_API}/channels/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: channelId, resourceId }),
  }).catch(() => {}); // ベストエフォート（失敗しても連携解除自体は継続）
}

/* ---------- イベント同期 ---------- */
async function listChangedEvents(accessToken, calendarId, syncToken) {
  const params = new URLSearchParams({ singleEvents: 'true' });
  if (syncToken) params.set('syncToken', syncToken);
  else params.set('timeMin', new Date().toISOString());
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 410) {
    // syncTokenが無効化された場合はフルリストで取り直す
    return listChangedEvents(accessToken, calendarId, null);
  }
  if (!res.ok) throw new Error(`events.list failed: ${await res.text()}`);
  const data = await res.json();
  return { items: data.items || [], nextSyncToken: data.nextSyncToken || null };
}

async function createEvent(accessToken, calendarId, event) {
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`events.insert failed: ${await res.text()}`);
  return res.json();
}
async function updateEvent(accessToken, calendarId, eventId, event) {
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`events.patch failed: ${await res.text()}`);
  return res.json();
}
async function deleteEvent(accessToken, calendarId, eventId) {
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 410 && res.status !== 404) throw new Error(`events.delete failed: ${await res.text()}`);
}

module.exports = {
  encrypt, decrypt,
  getAuthUrl, verifyState, exchangeCode, refreshAccessToken, getValidAccessToken,
  getLoginAuthUrl, exchangeLoginCode, parseIdToken, loginRedirectUri,
  signPayload, verifyPayload,
  startWatch, stopWatch, listChangedEvents,
  createEvent, updateEvent, deleteEvent,
};
