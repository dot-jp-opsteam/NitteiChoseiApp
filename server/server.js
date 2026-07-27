/* =========================================================
   OPS日調アプリ バックエンド
   - 既存のlocalStorage DBオブジェクトをそのままJSONとして1行で保持
   - GET /api/db  : 現在のDBを返す（未作成なら null）
   - PUT /api/db  : DB全体を置き換えて保存（フロントのsave()相当）
     保存時に、面談ステータスが「確定」に変わった行を検出してGoogleカレンダーに
     イベントを作成し、確定が取り消された行のイベントを削除する（フェーズ1）
   - 静的ファイル（index.html / style.css）もこのサーバーで配信
   - DB接続先：
     - TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が設定されていれば Turso（本番）
     - 未設定ならローカルファイル ./ops_nittyou.local.db（開発用）
   - Googleカレンダー連携（フェーズ1）：
     - GET  /api/auth/google/start?staffId=xxx      連携開始（Google同意画面へリダイレクト）
     - GET  /api/auth/google/callback               OAuthコールバック（トークン保存・watch登録）
     - POST /api/auth/google/disconnect {staffId}    連携解除
     - GET  /api/google/status?staffId=xxx           連携状態確認
     - POST /api/webhooks/google-calendar            Googleからのpush通知受信
   ========================================================= */
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const express = require('express');
const google = require('./google');
const auth = require('./auth');

const PORT = process.env.PORT || 8080;
const GOOGLE_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY && process.env.PUBLIC_BASE_URL);
/* 「Googleでログイン」はカレンダー連携と同じ資格情報を使うが、Google Cloud Console 側に
   ログイン用のリダイレクトURI（/api/auth/google/login/callback）を登録し終えるまでは
   ボタンを押してもGoogleがエラーを返す。設定完了後に GOOGLE_LOGIN_ENABLED=true を
   指定してもらうことで、中途半端に壊れた状態が本番に出ないようにしている。 */
const GOOGLE_LOGIN_ENABLED = GOOGLE_ENABLED && process.env.GOOGLE_LOGIN_ENABLED === 'true';
const STAFF_SIGNUP_SECRET = process.env.STAFF_SIGNUP_SECRET || '';
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'change-me-immediately';

const client = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: `file:${path.join(__dirname, 'ops_nittyou.local.db')}` }
);

async function initDB() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS store (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS google_tokens (
      staff_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expiry TEXT NOT NULL,
      calendar_id TEXT NOT NULL DEFAULT 'primary',
      channel_id TEXT,
      resource_id TEXT,
      channel_token TEXT,
      channel_expiration TEXT,
      sync_token TEXT,
      connected_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      role TEXT NOT NULL,
      branch_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
  // 既存DBへの追加カラム（Googleでログイン用）。既に存在する場合のエラーは無視する
  for (const ddl of [
    'ALTER TABLE users ADD COLUMN google_sub TEXT',
    'ALTER TABLE users ADD COLUMN avatar_url TEXT',
  ]) {
    try {
      await client.execute(ddl);
    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) throw e;
    }
  }

  const countRs = await client.execute('SELECT COUNT(*) as c FROM users');
  if (Number(countRs.rows[0].c) === 0) {
    if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD) {
      console.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD が未設定です。デフォルトの仮パスワードで初期管理者を作成します。必ずログイン後すぐにパスワードを変更するか、環境変数を設定して再デプロイしてください。');
    }
    const passwordHash = await auth.hashPassword(SEED_ADMIN_PASSWORD);
    await client.execute({
      sql: `INSERT INTO users (id, email, password_hash, nickname, role, branch_id, status, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: ['u_' + crypto.randomBytes(6).toString('hex'), SEED_ADMIN_EMAIL.toLowerCase(), passwordHash, '管理者', 'admin', null, 'active', new Date().toISOString()],
    });
    console.log(`初期管理者アカウントを作成しました（email: ${SEED_ADMIN_EMAIL}）`);
  }
}

async function readDB() {
  const rs = await client.execute('SELECT data, updated_at FROM store WHERE id = 1');
  const row = rs.rows[0];
  if (!row) return null;
  const obj = JSON.parse(row.data);
  obj.updatedAt = row.updated_at;
  return obj;
}

async function writeDB(obj) {
  const updatedAt = new Date().toISOString();
  const data = JSON.stringify(obj);
  await client.execute({
    sql: `INSERT INTO store (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [data, updatedAt],
  });
  return updatedAt;
}

/* ---------- users テーブル操作 ---------- */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, nickname: row.nickname, role: row.role,
    branch_id: row.branch_id, status: row.status,
    created_at: row.created_at, approved_at: row.approved_at,
    avatar_url: row.avatar_url || null,
    // Googleでログインしたばかりで所属支部が未設定のとき、フロント側で初回設定画面を出すための目印。
    // 管理者は特定の支部に属さない運用のため対象外
    needs_profile: row.role !== 'admin' && !row.branch_id,
  };
}
async function findUserByEmail(email) {
  const rs = await client.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email || '').toLowerCase()] });
  return rs.rows[0] || null;
}
async function findUserByGoogleSub(sub) {
  if (!sub) return null;
  const rs = await client.execute({ sql: 'SELECT * FROM users WHERE google_sub = ?', args: [String(sub)] });
  return rs.rows[0] || null;
}
async function linkGoogleAccount(id, { googleSub, avatarUrl }) {
  await client.execute({
    sql: 'UPDATE users SET google_sub = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
    args: [String(googleSub), avatarUrl || null, id],
  });
}
async function findUserById(id) {
  const rs = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  return rs.rows[0] || null;
}
async function listActiveUsers() {
  const rs = await client.execute({ sql: "SELECT * FROM users WHERE status = 'active'" });
  return rs.rows.map(toPublicUser);
}
async function listPendingStaff() {
  const rs = await client.execute({ sql: "SELECT * FROM users WHERE role = 'staff' AND status = 'pending' ORDER BY created_at" });
  return rs.rows.map(toPublicUser);
}
async function insertUser({ email, passwordHash, nickname, role, branchId, status, googleSub, avatarUrl }) {
  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  await client.execute({
    sql: `INSERT INTO users (id, email, password_hash, nickname, role, branch_id, status, created_at, google_sub, avatar_url)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    // Googleでログインしたユーザーはパスワードを持たない。空文字は verifyPassword が必ず false を返すため、
    // パスワードログインの経路からは入れない
    args: [id, String(email).toLowerCase(), passwordHash || '', nickname, role, branchId || null, status,
      new Date().toISOString(), googleSub || null, avatarUrl || null],
  });
  return findUserById(id);
}
async function approveStaffRow(id, approvedBy) {
  await client.execute({
    sql: "UPDATE users SET status='active', approved_at=?, approved_by=? WHERE id=? AND role='staff' AND status='pending'",
    args: [new Date().toISOString(), approvedBy, id],
  });
}
async function rejectStaffRow(id) {
  await client.execute({ sql: "DELETE FROM users WHERE id=? AND role='staff' AND status='pending'", args: [id] });
}
async function updateUserRow(id, { nickname, branchId, role }) {
  await client.execute({
    sql: 'UPDATE users SET nickname=?, branch_id=?, role=? WHERE id=?',
    args: [nickname, branchId || null, role, id],
  });
}
async function deleteUserRow(id) {
  await client.execute({ sql: 'DELETE FROM users WHERE id=?', args: [id] });
  await client.execute({ sql: 'DELETE FROM sessions WHERE user_id=?', args: [id] });
}

/* ---------- sessions テーブル操作 ---------- */
async function createSessionRow(userId) {
  const token = auth.newSessionToken();
  await client.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [auth.hashToken(token), userId, new Date().toISOString(), auth.sessionExpiry()],
  });
  return token;
}
async function getUserBySessionToken(token) {
  if (!token) return null;
  const rs = await client.execute({ sql: 'SELECT * FROM sessions WHERE token_hash = ?', args: [auth.hashToken(token)] });
  const session = rs.rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await client.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [session.token_hash] });
    return null;
  }
  return findUserById(session.user_id);
}
async function deleteSessionByToken(token) {
  if (!token) return;
  await client.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [auth.hashToken(token)] });
}

/* ---------- 認証ミドルウェア ---------- */
async function requireAuth(req, res, next) {
  try {
    const token = auth.getSessionTokenFromReq(req);
    const user = await getUserBySessionToken(token);
    if (!user || user.status !== 'active') return res.status(401).json({ error: '認証が必要です' });
    req.authUser = user;
    next();
  } catch (e) {
    console.error('認証チェックに失敗しました', e);
    res.status(500).json({ error: '認証チェックに失敗しました' });
  }
}
function requireAdmin(req, res, next) {
  if (req.authUser.role !== 'admin') return res.status(403).json({ error: '権限がありません' });
  next();
}

/* ---------- google_tokens テーブル操作 ---------- */
async function getTokenRow(staffId) {
  const rs = await client.execute({ sql: 'SELECT * FROM google_tokens WHERE staff_id = ?', args: [staffId] });
  return rs.rows[0] || null;
}
async function getTokenRowByChannel(channelId) {
  const rs = await client.execute({ sql: 'SELECT * FROM google_tokens WHERE channel_id = ?', args: [channelId] });
  return rs.rows[0] || null;
}
async function upsertTokenRow(row) {
  await client.execute({
    sql: `INSERT INTO google_tokens
            (staff_id, access_token, refresh_token, token_expiry, calendar_id, channel_id, resource_id, channel_token, channel_expiration, sync_token, connected_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(staff_id) DO UPDATE SET
            access_token=excluded.access_token, refresh_token=excluded.refresh_token, token_expiry=excluded.token_expiry,
            calendar_id=excluded.calendar_id, channel_id=excluded.channel_id, resource_id=excluded.resource_id,
            channel_token=excluded.channel_token, channel_expiration=excluded.channel_expiration,
            sync_token=excluded.sync_token, connected_at=excluded.connected_at`,
    args: [row.staff_id, row.access_token, row.refresh_token, row.token_expiry, row.calendar_id || 'primary',
      row.channel_id || null, row.resource_id || null, row.channel_token || null, row.channel_expiration || null,
      row.sync_token || null, row.connected_at],
  });
}
async function updateAccessToken(staffId, encryptedAccessToken, expiryIso) {
  await client.execute({
    sql: 'UPDATE google_tokens SET access_token = ?, token_expiry = ? WHERE staff_id = ?',
    args: [encryptedAccessToken, expiryIso, staffId],
  });
}
async function updateWatch(staffId, { channelId, resourceId, channelToken, expiration }) {
  await client.execute({
    sql: 'UPDATE google_tokens SET channel_id=?, resource_id=?, channel_token=?, channel_expiration=? WHERE staff_id=?',
    args: [channelId, resourceId, channelToken, expiration, staffId],
  });
}
async function updateSyncToken(staffId, syncToken) {
  await client.execute({ sql: 'UPDATE google_tokens SET sync_token = ? WHERE staff_id = ?', args: [syncToken, staffId] });
}
async function deleteTokenRow(staffId) {
  await client.execute({ sql: 'DELETE FROM google_tokens WHERE staff_id = ?', args: [staffId] });
}

async function accessTokenFor(tokenRow) {
  return google.getValidAccessToken(tokenRow, (enc, exp) => updateAccessToken(tokenRow.staff_id, enc, exp));
}

/* watchを（再）登録する。失敗しても連携自体は継続（次回の定期ジョブで再試行） */
async function registerWatch(staffId, accessToken, calendarId) {
  const watch = await google.startWatch(accessToken, staffId, calendarId);
  await updateWatch(staffId, { channelId: watch.channelId, resourceId: watch.resourceId, channelToken: watch.channelToken, expiration: watch.expiration });
}

/* ---------- 面談確定/取消をGoogleカレンダーへ反映（PUT /api/db 保存時） ----------
   確定した面談は、担当スタッフ・インターン生それぞれが個別にGoogle連携していれば
   両者のカレンダーに独立してイベントを作成する（片方だけの連携でも動作する） */
const IV_GOOGLE_SYNC_TARGETS = [
  { userIdField: 'staff_id', eventIdField: 'googleEventId', summary: (intern) => `面談: ${intern ? intern.nickname : ''}さん` },
  { userIdField: 'intern_id', eventIdField: 'googleEventIdIntern', summary: (intern, staff) => `面談: ${staff ? staff.nickname : ''}さんと` },
];

async function deleteGoogleEventFor(userId, eventId) {
  if (!userId || !eventId) return;
  try {
    const tokenRow = await getTokenRow(userId);
    if (!tokenRow) return;
    const accessToken = await accessTokenFor(tokenRow);
    await google.deleteEvent(accessToken, tokenRow.calendar_id, eventId);
  } catch (e) {
    console.warn(`Googleイベント削除に失敗しました（user ${userId}, event ${eventId}）`, e.message || e);
  }
}

async function syncInterviewsToGoogle(oldDB, newBody, users) {
  if (!GOOGLE_ENABLED) return;
  const oldMap = new Map((oldDB?.interviews || []).map((iv) => [iv.id, iv]));
  const newIds = new Set((newBody.interviews || []).map((iv) => iv.id));

  for (const iv of newBody.interviews || []) {
    const old = oldMap.get(iv.id);
    const wasFixed = old && old.status === 'fixed';
    const isFixed = iv.status === 'fixed';
    const intern = (users || []).find((u) => u.id === iv.intern_id);
    const staff = (users || []).find((u) => u.id === iv.staff_id);

    for (const t of IV_GOOGLE_SYNC_TARGETS) {
      const userId = iv[t.userIdField];
      try {
        if (isFixed && !iv[t.eventIdField] && old && old[t.eventIdField] && wasFixed) {
          // 同一面談に対する保存リクエストがほぼ同時に届いた場合、後発リクエストは
          // クライアント側が把握していない直前のgoogleEventIdを引き継ぐ（上書き消失防止）
          iv[t.eventIdField] = old[t.eventIdField];
        } else if (!wasFixed && isFixed && iv.confirmed_datetime) {
          if (!userId) continue;
          const tokenRow = await getTokenRow(userId);
          if (!tokenRow) {
            console.log(`Googleカレンダー未連携のためスキップ（interview ${iv.id}, user ${userId}）`);
            continue;
          }
          const accessToken = await accessTokenFor(tokenRow);
          const start = new Date(iv.confirmed_datetime);
          const end = new Date(start.getTime() + 30 * 60000);
          const created = await google.createEvent(accessToken, tokenRow.calendar_id, {
            summary: t.summary(intern, staff),
            description: `OPS日調アプリで確定した面談です。\n面談方法: ${iv.meeting_type === 'zoom' ? 'Zoom' : 'Google Meet'}`,
            start: { dateTime: start.toISOString(), timeZone: 'Asia/Tokyo' },
            end: { dateTime: end.toISOString(), timeZone: 'Asia/Tokyo' },
          });
          iv[t.eventIdField] = created.id;
          console.log(`Googleカレンダーにイベントを作成しました（interview ${iv.id}, user ${userId}, event ${created.id}）`);
        } else if (wasFixed && !isFixed && old[t.eventIdField]) {
          await deleteGoogleEventFor(userId, old[t.eventIdField]);
          iv[t.eventIdField] = null;
        }
      } catch (e) {
        console.warn(`Googleカレンダー同期に失敗しました（interview ${iv.id}, ${t.eventIdField}）`, e.message || e);
      }
    }
  }

  // アプリ側で削除された確定済み面談のイベントも掃除する
  for (const old of oldDB?.interviews || []) {
    if (!newIds.has(old.id) && old.status === 'fixed') {
      for (const t of IV_GOOGLE_SYNC_TARGETS) {
        await deleteGoogleEventFor(old[t.userIdField], old[t.eventIdField]);
      }
    }
  }
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ログイン画面（未認証）で支部選択に使う。認証情報は含まない
app.get('/api/branches', async (req, res) => {
  try {
    const obj = await readDB();
    res.json({ branches: obj?.branches || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});

/* ---------- 認証 ---------- */
app.post('/api/auth/register-intern', async (req, res) => {
  const { email, password, nickname, branch_id } = req.body || {};
  if (!email || !password || !nickname) return res.status(400).json({ error: 'email・password・nicknameは必須です' });
  if (String(password).length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });
  try {
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
    const passwordHash = await auth.hashPassword(password);
    const user = await insertUser({ email, passwordHash, nickname, role: 'intern', branchId: branch_id, status: 'active' });
    const token = await createSessionRow(user.id);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(token));
    res.json({ ok: true, user: toPublicUser(user) });
  } catch (e) {
    console.error('インターン生登録に失敗しました', e);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

app.post('/api/auth/register-staff', async (req, res) => {
  const { email, password, nickname, branch_id, inviteKey } = req.body || {};
  if (!STAFF_SIGNUP_SECRET || !auth.safeEqual(inviteKey, STAFF_SIGNUP_SECRET)) {
    return res.status(403).json({ error: '招待リンクが無効です' });
  }
  if (!email || !password || !nickname) return res.status(400).json({ error: 'email・password・nicknameは必須です' });
  if (String(password).length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });
  try {
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
    const passwordHash = await auth.hashPassword(password);
    await insertUser({ email, passwordHash, nickname, role: 'staff', branchId: branch_id, status: 'pending' });
    res.json({ ok: true, pending: true });
  } catch (e) {
    console.error('スタッフ登録に失敗しました', e);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email・passwordは必須です' });
  try {
    const row = await findUserByEmail(email);
    // Googleでのみ登録したアカウントはパスワードを持たない。原因が分かる案内を返す
    if (row && !row.password_hash) {
      return res.status(401).json({ error: 'このアカウントはGoogleで登録されています。下の「Googleでログイン」からお進みください。' });
    }
    if (!row || !(await auth.verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません' });
    }
    if (row.status === 'pending') return res.status(403).json({ error: '管理者の承認待ちです。承認までしばらくお待ちください。' });
    if (row.status !== 'active') return res.status(403).json({ error: 'このアカウントではログインできません' });
    const token = await createSessionRow(row.id);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(token));
    res.json({ ok: true, user: toPublicUser(row) });
  } catch (e) {
    console.error('ログインに失敗しました', e);
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = auth.getSessionTokenFromReq(req);
  await deleteSessionByToken(token);
  res.setHeader('Set-Cookie', auth.serializeClearCookie());
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.authUser) });
});

// ログイン画面が「Googleでログイン」ボタンを出してよいかを判断するための設定。認証不要
app.get('/api/auth/config', (req, res) => {
  res.json({ googleLogin: GOOGLE_LOGIN_ENABLED });
});

/* ---------- Googleでログイン（OpenID Connect） ----------
   カレンダー連携（/api/auth/google/start）とは別経路。カレンダーの権限は要求しない */
app.get('/api/auth/google/login', (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return res.redirect('/?login_error=disabled');
  res.redirect(google.getLoginAuthUrl());
});

app.get('/api/auth/google/login/callback', async (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return res.redirect('/?login_error=disabled');
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?login_error=cancelled');
  if (!code || google.verifyState(state) !== 'login') return res.redirect('/?login_error=state');
  try {
    const tokens = await google.exchangeLoginCode(code);
    const profile = google.parseIdToken(tokens.id_token);
    // 未確認のメールアドレスを信用すると、他人のメールを騙って既存アカウントを乗っ取れてしまう
    if (!profile.emailVerified) return res.redirect('/?login_error=unverified');

    let user = await findUserByGoogleSub(profile.sub);
    if (!user) {
      // 同じメールアドレスで既にパスワード登録済みなら、そのアカウントにGoogleを紐付ける
      const byEmail = await findUserByEmail(profile.email);
      if (byEmail) {
        await linkGoogleAccount(byEmail.id, { googleSub: profile.sub, avatarUrl: profile.picture });
        user = await findUserById(byEmail.id);
      } else {
        // 初めての人はインターン生として即利用開始。所属支部はログイン後の初回設定画面で選んでもらう
        user = await insertUser({
          email: profile.email,
          passwordHash: '',
          nickname: profile.name || profile.email.split('@')[0],
          role: 'intern',
          branchId: null,
          status: 'active',
          googleSub: profile.sub,
          avatarUrl: profile.picture,
        });
      }
    }

    if (user.status === 'pending') return res.redirect('/?login_error=pending');
    if (user.status !== 'active') return res.redirect('/?login_error=inactive');

    const token = await createSessionRow(user.id);
    res.setHeader('Set-Cookie', auth.serializeSessionCookie(token));
    res.redirect('/?login=google');
  } catch (e) {
    console.error('Googleログインに失敗しました', e);
    res.redirect('/?login_error=failed');
  }
});

// Googleで初めてログインした人が、ニックネームと所属支部を設定する
app.post('/api/auth/complete-profile', requireAuth, async (req, res) => {
  const { nickname, branch_id } = req.body || {};
  if (!nickname || !String(nickname).trim()) return res.status(400).json({ error: 'ニックネームを入力してください' });
  if (!branch_id) return res.status(400).json({ error: '所属支部を選択してください' });
  try {
    const obj = await readDB();
    const exists = (obj?.branches || []).some((b) => b.id === branch_id);
    if (!exists) return res.status(400).json({ error: '選択された支部が存在しません' });
    await client.execute({
      sql: 'UPDATE users SET nickname = ?, branch_id = ? WHERE id = ?',
      args: [String(nickname).trim(), branch_id, req.authUser.id],
    });
    res.json({ ok: true, user: toPublicUser(await findUserById(req.authUser.id)) });
  } catch (e) {
    console.error('プロフィール設定に失敗しました', e);
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

/* ---------- 管理者：スタッフ招待URL ---------- */
app.get('/api/admin/staff-invite-url', requireAuth, requireAdmin, (req, res) => {
  if (!STAFF_SIGNUP_SECRET) return res.status(500).json({ error: 'STAFF_SIGNUP_SECRETが未設定です' });
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/?staff=${encodeURIComponent(STAFF_SIGNUP_SECRET)}` });
});

/* ---------- 管理者：ユーザー管理 ---------- */
app.get('/api/admin/pending-staff', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ pending: await listPendingStaff() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});
app.post('/api/admin/approve-staff', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userIdが必要です' });
  try {
    await approveStaffRow(userId, req.authUser.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '承認に失敗しました' });
  }
});
app.post('/api/admin/reject-staff', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userIdが必要です' });
  try {
    await rejectStaffRow(userId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '却下に失敗しました' });
  }
});
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { nickname, branch_id, role } = req.body || {};
  if (!nickname || !['intern', 'staff', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'nickname・roleは必須です' });
  }
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    await updateUserRow(req.params.id, { nickname, branchId: branch_id, role });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '更新に失敗しました' });
  }
});
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.authUser.id) return res.status(400).json({ error: '自分自身は削除できません' });
  try {
    await deleteUserRow(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '削除に失敗しました' });
  }
});

// 現在のDBを取得。未作成（初回アクセス）でも users だけは常に返し、branches等はフロント側のseed()投入に委ねる
app.get('/api/db', requireAuth, async (req, res) => {
  try {
    const obj = await readDB();
    const users = await listActiveUsers();
    if (!obj) return res.json({ users });
    obj.users = users;
    res.json(obj);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db read failed' });
  }
});

// DB全体を置き換えて保存する（既存save()の置き換え先）。users は専用APIでのみ変更するためここでは無視する
app.put('/api/db', requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
  delete body.users;
  try {
    const oldDB = await readDB();
    const users = await listActiveUsers();
    await syncInterviewsToGoogle(oldDB, body, users);
    const updatedAt = await writeDB(body);
    res.json({ ok: true, updatedAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db write failed' });
  }
});

/* ---------- Googleカレンダー連携 ---------- */
app.get('/api/auth/google/start', requireAuth, (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).send('Google連携は未設定です');
  const staffId = String(req.query.staffId || '');
  if (!staffId) return res.status(400).send('staffIdが必要です');
  if (staffId !== req.authUser.id) return res.status(403).send('本人以外は連携できません');
  res.redirect(google.getAuthUrl(staffId));
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).send('Google連携は未設定です');
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?google=error');
  const staffId = google.verifyState(state);
  if (!staffId || !code) return res.status(400).send('不正なリクエストです');
  try {
    const tokens = await google.exchangeCode(code);
    if (!tokens.refresh_token) {
      // 既に連携済みでGoogleがrefresh_tokenを返さなかった場合。既存の値を維持する
      const existing = await getTokenRow(staffId);
      if (!existing) throw new Error('refresh_tokenが取得できませんでした。再度連携をお試しください。');
    }
    const tokenExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await upsertTokenRow({
      staff_id: staffId,
      access_token: google.encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? google.encrypt(tokens.refresh_token) : (await getTokenRow(staffId)).refresh_token,
      token_expiry: tokenExpiry,
      calendar_id: 'primary',
      connected_at: new Date().toISOString(),
    });
    try {
      await registerWatch(staffId, tokens.access_token, 'primary');
    } catch (e) {
      console.warn('watch登録に失敗しました（連携自体は完了）', e.message || e);
    }
    res.redirect('/?google=connected');
  } catch (e) {
    console.error('Google連携に失敗しました', e);
    res.redirect('/?google=error');
  }
});

app.post('/api/auth/google/disconnect', requireAuth, async (req, res) => {
  const staffId = String(req.body?.staffId || '');
  if (!staffId) return res.status(400).json({ error: 'staffIdが必要です' });
  if (staffId !== req.authUser.id) return res.status(403).json({ error: '本人以外は解除できません' });
  try {
    const tokenRow = await getTokenRow(staffId);
    if (tokenRow) {
      if (tokenRow.channel_id) {
        try {
          const accessToken = await accessTokenFor(tokenRow);
          await google.stopWatch(accessToken, tokenRow.channel_id, tokenRow.resource_id);
        } catch (e) {
          console.warn('watch停止に失敗しました', e.message || e);
        }
      }
      await deleteTokenRow(staffId);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '連携解除に失敗しました' });
  }
});

app.get('/api/google/status', requireAuth, async (req, res) => {
  const staffId = String(req.query.staffId || '');
  if (!staffId) return res.status(400).json({ error: 'staffIdが必要です' });
  if (staffId !== req.authUser.id) return res.status(403).json({ error: '本人以外は確認できません' });
  try {
    const row = await getTokenRow(staffId);
    res.json({ connected: !!row, enabled: GOOGLE_ENABLED });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '状態取得に失敗しました' });
  }
});

// Googleからのpush通知受信（面談不可時間へ外部予定を反映）
app.post('/api/webhooks/google-calendar', async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(200).end();
  const channelId = req.get('X-Goog-Channel-ID');
  const channelToken = req.get('X-Goog-Channel-Token');
  const resourceState = req.get('X-Goog-Resource-State');
  try {
    if (!channelId) return res.status(200).end();
    const tokenRow = await getTokenRowByChannel(channelId);
    if (!tokenRow || tokenRow.channel_token !== channelToken) return res.status(200).end();
    if (resourceState === 'sync') return res.status(200).end(); // 登録直後の確認通知は無視

    const accessToken = await accessTokenFor(tokenRow);
    const { items, nextSyncToken } = await google.listChangedEvents(accessToken, tokenRow.calendar_id, tokenRow.sync_token);
    if (nextSyncToken) await updateSyncToken(tokenRow.staff_id, nextSyncToken);

    const db = await readDB();
    if (db && items.length) {
      db.availability = db.availability || {};
      db.availability[tokenRow.staff_id] = db.availability[tokenRow.staff_id] || { weekly: undefined, blocks: [] };
      let blocks = db.availability[tokenRow.staff_id].blocks || [];
      const changedIds = new Set(items.map((e) => e.id));
      blocks = blocks.filter((b) => !(b.kind === 'external-google' && changedIds.has(b.googleEventId)));
      for (const ev of items) {
        if (ev.status === 'cancelled') continue;
        const start = ev.start && (ev.start.dateTime || ev.start.date);
        const end = ev.end && (ev.end.dateTime || ev.end.date);
        if (!start || !end) continue;
        blocks.push({
          id: 'gcal_' + ev.id,
          googleEventId: ev.id,
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          note: ev.summary || '外部予定',
          kind: 'external-google',
        });
      }
      db.availability[tokenRow.staff_id].blocks = blocks;
      await writeDB(db);
    }
  } catch (e) {
    console.error('webhook処理に失敗しました', e);
  }
  res.status(200).end();
});

/* 期限が近い（24時間以内）watchチャンネルを再登録する定期ジョブ */
async function renewExpiringWatches() {
  if (!GOOGLE_ENABLED) return;
  try {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rs = await client.execute({
      sql: 'SELECT staff_id FROM google_tokens WHERE channel_expiration IS NULL OR channel_expiration < ?',
      args: [soon],
    });
    for (const row of rs.rows) {
      const tokenRow = await getTokenRow(row.staff_id);
      if (!tokenRow) continue;
      try {
        const accessToken = await accessTokenFor(tokenRow);
        if (tokenRow.channel_id) {
          await google.stopWatch(accessToken, tokenRow.channel_id, tokenRow.resource_id);
        }
        await registerWatch(tokenRow.staff_id, accessToken, tokenRow.calendar_id);
        console.log(`watchチャンネルを再登録しました: ${tokenRow.staff_id}`);
      } catch (e) {
        console.warn(`watch再登録に失敗しました（${row.staff_id}）`, e.message || e);
      }
    }
  } catch (e) {
    console.error('watch再登録ジョブでエラーが発生しました', e);
  }
}

// 静的ファイル（index.html, style.css）をこのサーバーから配信
app.use(express.static(path.join(__dirname, '..')));

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`OPS日調アプリ サーバー起動: http://localhost:${PORT}`);
      console.log(`DB接続先: ${process.env.TURSO_DATABASE_URL ? 'Turso（本番）' : 'ローカルファイル（開発用）'}`);
      console.log(`Googleカレンダー連携: ${GOOGLE_ENABLED ? '有効' : '未設定（環境変数を確認してください）'}`);
      if (GOOGLE_ENABLED) {
        renewExpiringWatches();
        setInterval(renewExpiringWatches, 6 * 60 * 60 * 1000); // 6時間ごと
      }
    });
  })
  .catch((e) => {
    console.error('DB初期化に失敗しました', e);
    process.exit(1);
  });
