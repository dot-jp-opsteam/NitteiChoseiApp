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

   【デプロイ時の注意】
   render.yaml で rootDir: server を指定しているため、Renderは
   server/ の中が変わらないpushではビルドをスキップする。
   画面まわり（index.html / style.css）だけを直したときは
   デプロイが起動しないので、render.yaml の buildFilter で
   配信対象のファイルもビルド対象に含めている。
   それでも反映されない場合は、Renderの管理画面から
   Manual Deploy を実行すること。
   ========================================================= */
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const express = require('express');
const google = require('./google');
const auth = require('./auth');
const mail = require('./mail');

const PORT = process.env.PORT || 8080;
/* パスワード再設定リンクの有効時間。長すぎると危険、短すぎるとメール到着前に切れるため60分 */
const RESET_TOKEN_MINUTES = 60;
const GOOGLE_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY && process.env.PUBLIC_BASE_URL);
/* 「Googleでログイン」はカレンダー連携と同じ資格情報を使うが、Google Cloud Console 側に
   ログイン用のリダイレクトURI（/api/auth/google/login/callback）を登録し終えるまでは
   ボタンを押してもGoogleがエラーを返す。設定完了後に GOOGLE_LOGIN_ENABLED=true を
   指定してもらうことで、中途半端に壊れた状態が本番に出ないようにしている。 */
const GOOGLE_LOGIN_ENABLED = GOOGLE_ENABLED && process.env.GOOGLE_LOGIN_ENABLED === 'true';
/* スタッフ登録を許可するメールアドレスのドメイン。ドットジェイピーから配布される
   Googleアカウント（例: reandoro_azuma@dot-jp.or.jp）だけがスタッフになれる */
const STAFF_EMAIL_DOMAIN = process.env.STAFF_EMAIL_DOMAIN || 'dot-jp.or.jp';
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
  await client.execute(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
  /* ドットから配布されたアカウントの名簿。管理者がスタッフを名前で検索して支部に追加するために使う。
     今はCSV取り込みだけだが、将来 Google Workspace のディレクトリ検索に差し替えられるよう
     source 列で出所を区別している */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS directory (
      email TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      kana TEXT,
      branch_hint TEXT,
      search_key TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    // パスワード変更画面で「現在のパスワード」欄を出すかの判定に使う（値そのものは返さない）
    has_password: !!row.password_hash,
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

/* ---------- directory（スタッフ名簿）テーブル操作 ----------
   「あずま」で azuma_reandoro@dot-jp.or.jp を引けるようにするため、
   氏名・かな・メールアドレスをまとめて1本の検索キーにしておく。
   全角/半角・大文字小文字・カタカナ/ひらがな・空白の違いを吸収する */
function normalizeSearchText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    // カタカナをひらがなに寄せる（「アズマ」でも「あずま」でも当たるように）
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
function buildSearchKey({ email, fullName, kana }) {
  return normalizeSearchText([fullName, kana, email, String(email || '').split('@')[0]].join(' '));
}
async function upsertDirectoryRow({ email, fullName, kana, branchHint, source }) {
  const mail = String(email || '').trim().toLowerCase();
  await client.execute({
    sql: `INSERT INTO directory (email, full_name, kana, branch_hint, search_key, source, updated_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(email) DO UPDATE SET
            full_name=excluded.full_name, kana=excluded.kana, branch_hint=excluded.branch_hint,
            search_key=excluded.search_key, source=excluded.source, updated_at=excluded.updated_at`,
    args: [mail, fullName, kana || null, branchHint || null,
      buildSearchKey({ email: mail, fullName, kana }), source, new Date().toISOString()],
  });
}
async function searchDirectory(q, limit = 30) {
  const key = normalizeSearchText(q);
  if (!key) return [];
  // LIKE のワイルドカードを打ち消してから部分一致で引く
  const pattern = `%${key.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rs = await client.execute({
    sql: `SELECT email, full_name, kana, branch_hint FROM directory
          WHERE search_key LIKE ? ESCAPE '\\' ORDER BY full_name LIMIT ?`,
    args: [pattern, limit],
  });
  return rs.rows.map((r) => ({ email: r.email, full_name: r.full_name, kana: r.kana, branch_hint: r.branch_hint }));
}
async function directoryStatus() {
  const rs = await client.execute('SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM directory');
  return { count: Number(rs.rows[0].c || 0), updated_at: rs.rows[0].u || null };
}

/* ---------- sessions テーブル操作 ---------- */
/* remember=true（「次回から自動ログイン」）なら7日、そうでなければ12時間で失効する */
async function createSessionRow(userId, remember) {
  const token = auth.newSessionToken();
  await client.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    args: [auth.hashToken(token), userId, new Date().toISOString(), auth.sessionExpiry(remember)],
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
    // code はフロント側で「セッション切れ」と「パスワード違いなどの業務上の401」を
    // 見分けるために使う。これが無いと、パスワード変更に失敗しただけでログアウトしてしまう
    if (!user || user.status !== 'active') return res.status(401).json({ error: '認証が必要です', code: 'unauthenticated' });
    req.authUser = user;
    // パスワード変更時に「今使っている端末だけ残す」判定に使う
    req.authSessionTokenHash = auth.hashToken(token);
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
/* 支部管理者（branch_admin）は自分の支部のユーザーだけを操作できる。
   全体管理者（admin）は今までどおり全支部を操作できる */
function requireBranchAdmin(req, res, next) {
  const r = req.authUser.role;
  if (r !== 'admin' && r !== 'branch_admin') return res.status(403).json({ error: '権限がありません' });
  if (r === 'branch_admin' && !req.authUser.branch_id) {
    return res.status(403).json({ error: '所属支部が未設定のため操作できません' });
  }
  next();
}
function canManageBranch(user, branchId) {
  if (user.role === 'admin') return true;
  return !!branchId && branchId === user.branch_id;
}
/* 支部管理者が触ってよい相手か。自分より上の権限（admin）は触らせない */
function canManageUser(actor, target) {
  if (!target) return false;
  if (actor.role === 'admin') return true;
  if (target.role === 'admin') return false;
  return target.branch_id === actor.branch_id;
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

/* =========================================================
   データの見える範囲・変えてよい範囲（ロール別）

   以前は GET /api/db が全支部の面談も他人あてのメール本文もそのまま全員に返しており、
   PUT /api/db もログインさえしていれば何でも書き換えられる状態だった。
   ここで「見える範囲（scopeDBForUser）」「書き戻しの合成（mergeScoped）」
   「変更内容の検証（validateDiff）」の3段構えで制限する。
   ========================================================= */

/* その人が見てよいデータだけに絞り込む */
function scopeDBForUser(obj, user, users) {
  if (user.role === 'admin') return obj;
  const branchId = user.branch_id;
  const isIntern = user.role === 'intern';
  const userById = new Map(users.map((u) => [u.id, u]));
  const inBranch = (id) => {
    const u = userById.get(id);
    return !!u && u.branch_id === branchId;
  };

  const interviews = (obj.interviews || []).filter((iv) =>
    isIntern ? iv.intern_id === user.id : (iv.staff_id === user.id || inBranch(iv.intern_id)));
  const events = (obj.events || []).filter((e) => e.branch_id === branchId);
  const eventIds = new Set(events.map((e) => e.id));
  const event_responses = (obj.event_responses || []).filter((r) => eventIds.has(r.event_id));
  // メールは当事者だけ。以前は全員が全員分の本文を読めていた
  const emails = (obj.emails || []).filter((m) => m.receiver_id === user.id || m.sender_id === user.id);
  // branch_id を持たない通知は、この仕組みを入れる前の古いレコード
  const notifications = (obj.notifications || []).filter((n) => !n.branch_id || n.branch_id === branchId);

  /* 空き日程は面談の予約画面で必要なので自支部のスタッフ分を返す。
     ただしインターン生には予定の中身（「アルバイト」など私的な情報）を伏せ、
     時間帯だけを渡す */
  const availability = {};
  for (const [id, av] of Object.entries(obj.availability || {})) {
    const u = userById.get(id);
    if (!u || u.branch_id !== branchId) continue;
    availability[id] = isIntern
      ? {
        weekly: av.weekly,
        blocks: (av.blocks || []).map((b) => ({ id: b.id, start: b.start, end: b.end, kind: b.kind })),
      }
      : av;
  }
  return { ...obj, interviews, events, event_responses, emails, notifications, availability };
}

/* 絞り込んだデータを受け取ったクライアントが書き戻してきたとき、
   その人には見えていなかった分を元のデータから戻して1つに合成する。
   これをしないと、見えていないデータが保存のたびに消えてしまう */
function mergeScoped(oldDB, clientDB, user, users) {
  if (user.role === 'admin') return { ...clientDB, emails: oldDB.emails || [] };
  const visible = scopeDBForUser(oldDB, user, users);
  const merged = { ...oldDB };
  for (const key of ['interviews', 'events', 'event_responses', 'notifications']) {
    const visibleIds = new Set((visible[key] || []).map((x) => x.id));
    const hidden = (oldDB[key] || []).filter((x) => !visibleIds.has(x.id));
    merged[key] = [...hidden, ...(clientDB[key] || [])];
  }
  merged.branches = clientDB.branches || oldDB.branches || [];
  // メール履歴はサーバー（POST /api/mail/send）だけが書き込む
  merged.emails = oldDB.emails || [];
  /* 空き日程は自分の分だけを採用し、他人の分は送られてきても黙って捨てる。
     403で弾かないのは、インターン生には予定名を伏せた「削った状態」で渡しているため。
     送り返された内容と元データを直接比べると、正常な保存まで毎回はじいてしまう。
     ここで採用しなければ他人の予定は決して書き換わらないので、これで十分に防げている */
  merged.availability = { ...(oldDB.availability || {}) };
  if (clientDB.availability && clientDB.availability[user.id]) {
    merged.availability[user.id] = clientDB.availability[user.id];
  }
  return merged;
}

const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const byId = (list) => new Map((list || []).map((x) => [x.id, x]));

/* 変更内容が、その人に許されたものかを1件ずつ確かめる。
   1件でも許されない変更があれば、その保存はまるごと拒否する（一部だけ適用しない） */
function validateDiff(oldDB, newDB, actor, users) {
  const errs = [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const sameBranch = (id) => {
    const u = userById.get(id);
    return !!u && u.branch_id === actor.branch_id;
  };
  const isAdmin = actor.role === 'admin';
  const isStaffLike = ['staff', 'branch_admin', 'admin'].includes(actor.role);

  // ---- 支部：全体管理者のみ ----
  if (!isAdmin && !sameJSON(oldDB.branches, newDB.branches)) {
    errs.push('支部を変更できるのは全体管理者だけです');
  }

  // ---- 面談 ----
  const oldIv = byId(oldDB.interviews);
  const newIv = byId(newDB.interviews);
  for (const [id, iv] of newIv) {
    const prev = oldIv.get(id);
    if (!prev) {
      if (iv.intern_id !== actor.id) errs.push('面談を申請できるのは本人だけです');
      else if (iv.status !== 'applied') errs.push('申請時のステータスが不正です');
    } else if (!sameJSON(prev, iv)) {
      if (!isStaffLike) errs.push('面談を変更する権限がありません');
      else if (!isAdmin && iv.staff_id !== actor.id && !sameBranch(iv.intern_id)) {
        errs.push('他の支部の面談は変更できません');
      }
    }
  }
  for (const [id, prev] of oldIv) {
    if (newIv.has(id)) continue;
    // 本人が申請中のものを取り下げる場合のみ許す
    if (!isAdmin && !(prev.intern_id === actor.id && prev.status === 'applied')) {
      errs.push('この面談を削除する権限がありません');
    }
  }

  // ---- イベント ----
  const oldEv = byId(oldDB.events);
  const newEv = byId(newDB.events);
  for (const [id, ev] of newEv) {
    const prev = oldEv.get(id);
    if (!prev) {
      if (actor.role === 'intern') errs.push('イベントを作成する権限がありません');
      else if (!isAdmin && ev.branch_id !== actor.branch_id) errs.push('他の支部のイベントは作成できません');
      else if (ev.creator_id !== actor.id) errs.push('作成者が不正です');
    } else if (!sameJSON(prev, ev)) {
      if (!isAdmin && prev.creator_id !== actor.id) errs.push('このイベントを編集する権限がありません');
    }
  }
  const removedEventIds = new Set([...oldEv.keys()].filter((id) => !newEv.has(id)));
  for (const id of removedEventIds) {
    const prev = oldEv.get(id);
    if (!isAdmin && prev.creator_id !== actor.id) errs.push('このイベントを削除する権限がありません');
  }

  // ---- イベント回答：自分の回答だけ ----
  const oldRs = byId(oldDB.event_responses);
  const newRs = byId(newDB.event_responses);
  for (const [id, r] of newRs) {
    const prev = oldRs.get(id);
    if ((!prev || !sameJSON(prev, r)) && r.user_id !== actor.id) {
      errs.push('他の人の出欠回答は変更できません');
    }
  }
  for (const [id, prev] of oldRs) {
    if (newRs.has(id)) continue;
    // イベントごと削除された場合は、その回答も一緒に消えてよい
    if (removedEventIds.has(prev.event_id)) continue;
    if (!isAdmin && prev.user_id !== actor.id) errs.push('他の人の出欠回答は削除できません');
  }

  // ---- 空き日程：自分の分だけ ----
  const avKeys = new Set([...Object.keys(oldDB.availability || {}), ...Object.keys(newDB.availability || {})]);
  for (const key of avKeys) {
    if (key === actor.id || isAdmin) continue;
    if (!sameJSON((oldDB.availability || {})[key], (newDB.availability || {})[key])) {
      errs.push('他の人の空き時間は変更できません');
    }
  }

  // ---- 通知：追加のみ。消して履歴を隠せないようにする ----
  const newNotiIds = new Set((newDB.notifications || []).map((n) => n.id));
  if (!isAdmin && (oldDB.notifications || []).some((n) => !newNotiIds.has(n.id))) {
    errs.push('通知は削除できません');
  }

  // ---- メール履歴：専用APIでのみ変更する ----
  if (!sameJSON(oldDB.emails, newDB.emails)) {
    errs.push('メール履歴はこの方法では変更できません');
  }

  return [...new Set(errs)];
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
    // 登録直後はそのタブ限りのログイン。自動ログインはログイン画面のチェックで選んでもらう
    const token = await createSessionRow(user.id, false);
    res.json({ ok: true, token, user: toPublicUser(user) });
  } catch (e) {
    console.error('インターン生登録に失敗しました', e);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

/* 旧・秘密キー付き招待URL（?staff=...）による登録。
   スタッフ登録は /staff のGoogle確認方式に一本化したため廃止した。
   古いURLがブックマークやLINEに残っていても、新しい手順へ案内できるように残してある */
app.post('/api/auth/register-staff', async (req, res) => {
  return res.status(410).json({
    error: 'スタッフ登録の方法が変わりました。ドットから配布されたGoogleアカウントで、スタッフ登録ページからお手続きください。',
    staffSignupUrl: `${process.env.PUBLIC_BASE_URL || ''}/staff`,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, remember } = req.body || {};
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
    if (row.status !== 'active') return res.status(403).json({ error: 'このアカウントではログインできません' });
    const token = await createSessionRow(row.id, remember === true);
    res.json({ ok: true, token, user: toPublicUser(row) });
  } catch (e) {
    console.error('ログインに失敗しました', e);
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await deleteSessionByToken(auth.getSessionTokenFromReq(req));
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.authUser) });
});

// ログイン画面が「Googleでログイン」ボタンを出してよいかを判断するための設定。認証不要
function authConfig() {
  return {
    googleLogin: GOOGLE_LOGIN_ENABLED,
    passwordReset: mail.MAIL_ENABLED,
    staffEmailDomain: STAFF_EMAIL_DOMAIN,
  };
}
app.get('/api/auth/config', (req, res) => res.json(authConfig()));

/* 起動時に必要な情報をまとめて返す。
   以前は config → me → db → branches を順番に呼んでおり、
   通信の往復が3〜4回積み重なっていた。Renderの無料枠は海外リージョンで
   1往復あたりの待ち時間が大きいため、ここを1回にまとめる効果が大きい。
   認証は任意（トークンが無ければ未ログインとして返す） */
app.get('/api/bootstrap', async (req, res) => {
  try {
    const config = authConfig();
    const token = auth.getSessionTokenFromReq(req);
    const user = token ? await getUserBySessionToken(token) : null;
    const obj = await readDB();

    if (!user || user.status !== 'active') {
      return res.json({ config, user: null, branches: obj?.branches || [] });
    }
    const users = await listActiveUsers();
    const db = obj ? scopeDBForUser(obj, user, users) : {};
    db.users = scopeUsers(users, user);
    res.json({ config, user: toPublicUser(user), db });
  } catch (e) {
    console.error('起動情報の取得に失敗しました', e);
    res.status(500).json({ error: '起動情報の取得に失敗しました' });
  }
});

/* ---------- Googleでログイン（OpenID Connect） ----------
   カレンダー連携（/api/auth/google/start）とは別経路。カレンダーの権限は要求しない */
app.get('/api/auth/google/login', (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return res.redirect('/?login_error=disabled');
  // 「次回から自動ログイン」の選択は、Googleへ行って戻ってくる間 state に預けて持ち回す
  res.redirect(google.getLoginAuthUrl(req.query.remember === '1' ? 'login-remember' : 'login'));
});

/* スタッフ登録の入口。ドットから配布された @dot-jp.or.jp のGoogleアカウントで
   本人確認してもらってから、氏名と所属支部を入力する画面に進む */
app.get('/api/auth/staff-signup/google', (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return res.redirect('/staff?staff_error=disabled');
  res.redirect(google.getLoginAuthUrl('staff'));
});

app.get('/api/auth/google/login/callback', async (req, res) => {
  if (!GOOGLE_LOGIN_ENABLED) return res.redirect('/?login_error=disabled');
  const { code, state, error } = req.query;
  const purpose = google.verifyState(state);
  const isStaffSignup = purpose === 'staff';
  const remember = purpose === 'login-remember';
  const fail = (key) => res.redirect(isStaffSignup ? `/staff?staff_error=${key}` : `/?login_error=${key}`);
  if (error) return fail('cancelled');
  if (!code || !['login', 'login-remember', 'staff'].includes(purpose)) return fail('state');
  try {
    const tokens = await google.exchangeLoginCode(code);
    const profile = google.parseIdToken(tokens.id_token);
    // 未確認のメールアドレスを信用すると、他人のメールを騙って既存アカウントを乗っ取れてしまう
    if (!profile.emailVerified) return fail('unverified');

    if (isStaffSignup) {
      // ドットから配布されたアカウント以外はスタッフ登録できない
      if (!profile.email.endsWith(`@${STAFF_EMAIL_DOMAIN}`)) return fail('domain');
      const existing = (await findUserByGoogleSub(profile.sub)) || (await findUserByEmail(profile.email));
      if (existing) return fail('already');
      // 氏名と所属支部を入力してもらうため、確認済みの情報を署名付きで持ち回す
      const t = google.signPayload({ email: profile.email, sub: profile.sub, name: profile.name, picture: profile.picture });
      return res.redirect(`/staff?verified=${encodeURIComponent(t)}`);
    }

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

    if (user.status !== 'active') return fail('inactive');

    const token = await createSessionRow(user.id, remember);
    // トークンはURLフラグメント（#以降）で渡す。フラグメントはサーバーに送信されず
    // Refererにも載らないため、アクセスログや中継サーバーにトークンが残らない
    res.redirect(`/#token=${encodeURIComponent(token)}&remember=${remember ? 1 : 0}&login=google`);
  } catch (e) {
    console.error('Googleログインに失敗しました', e);
    return fail('failed');
  }
});

/* スタッフ登録の完了。Googleで確認済みのメールアドレスに、氏名と所属支部を添えて申請する */
app.post('/api/auth/staff-signup', async (req, res) => {
  const { token, full_name, branch_id } = req.body || {};
  const verified = google.verifyPayload(token);
  if (!verified) {
    return res.status(400).json({ error: '確認の有効期限が切れました。お手数ですが、最初からやり直してください。' });
  }
  if (!verified.email.endsWith(`@${STAFF_EMAIL_DOMAIN}`)) {
    return res.status(403).json({ error: `${STAFF_EMAIL_DOMAIN} のアカウントでのみ登録できます` });
  }
  if (!full_name || !String(full_name).trim()) return res.status(400).json({ error: '氏名を入力してください' });
  if (!branch_id) return res.status(400).json({ error: '所属支部を選択してください' });
  try {
    const obj = await readDB();
    if (!(obj?.branches || []).some((b) => b.id === branch_id)) {
      return res.status(400).json({ error: '選択された支部が存在しません' });
    }
    if ((await findUserByGoogleSub(verified.sub)) || (await findUserByEmail(verified.email))) {
      return res.status(409).json({ error: 'このアカウントは既に登録されています' });
    }
    // 承認フローは廃止。ドット配布アカウントで本人確認済みのため、登録と同時に即アクティブにする
    const user = await insertUser({
      email: verified.email,
      passwordHash: '',
      nickname: String(full_name).trim(),
      role: 'staff',
      branchId: branch_id,
      status: 'active',
      googleSub: verified.sub,
      avatarUrl: verified.picture || null,
    });
    // 登録直後はそのタブ限りのログイン（register-internと同じ扱い）
    const token = await createSessionRow(user.id, false);
    res.json({ ok: true, token, user: toPublicUser(user) });
  } catch (e) {
    console.error('スタッフ登録に失敗しました', e);
    res.status(500).json({ error: '登録に失敗しました' });
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

/* パスワード変更。Googleだけで登録した人はパスワードを持たないため、
   その場合に限り現在のパスワードなしで初回設定できるようにしている */
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: '新しいパスワードは8文字以上で入力してください' });
  }
  try {
    const row = await findUserById(req.authUser.id);
    if (!row) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (row.password_hash) {
      if (!current_password) return res.status(400).json({ error: '現在のパスワードを入力してください' });
      if (!(await auth.verifyPassword(current_password, row.password_hash))) {
        return res.status(401).json({ error: '現在のパスワードが正しくありません' });
      }
    }
    await client.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [await auth.hashPassword(String(new_password)), req.authUser.id],
    });
    // 変更前に発行済みのセッションを無効化する（漏れていた場合に他の端末を追い出すため）。
    // 今使っている端末だけは残し、ログインし直さずに済むようにする
    await client.execute({
      sql: 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
      args: [req.authUser.id, req.authSessionTokenHash || ''],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('パスワード変更に失敗しました', e);
    res.status(500).json({ error: '変更に失敗しました' });
  }
});

/* ---------- パスワードを忘れたとき ---------- */
/* 申請。メールアドレスが登録済みかどうかに関わらず必ず同じ応答を返す。
   「そのアドレスは登録されていません」と答えると、誰が登録しているかを外部から
   調べられてしまうため */
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'メールアドレスを入力してください' });
  if (!mail.MAIL_ENABLED) {
    return res.status(503).json({ error: 'メール送信が未設定のため、この機能は現在ご利用いただけません。管理者にお問い合わせください。' });
  }
  const ok = { ok: true, message: 'ご入力のメールアドレス宛に再設定用のメールをお送りしました。届かない場合は迷惑メールフォルダもご確認ください。' };
  try {
    const row = await findUserByEmail(email);
    if (!row || row.status !== 'active') return res.json(ok);

    // 同じ人の未使用リンクは無効化してから新しく発行する（古いリンクが生き続けないように）
    await client.execute({ sql: 'DELETE FROM password_resets WHERE user_id = ?', args: [row.id] });

    const token = auth.newSessionToken();
    const now = new Date();
    await client.execute({
      sql: 'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [
        auth.hashToken(token), row.id, now.toISOString(),
        new Date(now.getTime() + RESET_TOKEN_MINUTES * 60 * 1000).toISOString(),
      ],
    });

    const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
    await mail.sendPasswordResetMail({
      to: row.email,
      nickname: row.nickname,
      url: `${base}/?reset=${token}`,
      minutes: RESET_TOKEN_MINUTES,
    });
    res.json(ok);
  } catch (e) {
    console.error('パスワード再設定メールの送信に失敗しました', e);
    res.status(500).json({ error: 'メールの送信に失敗しました。時間をおいて再度お試しください。' });
  }
});

/* リンクを開いた時点での有効性チェック。無効なら入力画面を出さずに済ませる */
app.get('/api/auth/reset-check', async (req, res) => {
  const row = await findValidReset(req.query.token);
  res.json({ valid: !!row, nickname: row ? row.nickname : null });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });
  }
  try {
    const row = await findValidReset(token);
    if (!row) {
      return res.status(400).json({ error: 'このリンクは期限切れか、既に使用済みです。お手数ですが再度お手続きください。' });
    }
    await client.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [await auth.hashPassword(String(new_password)), row.user_id],
    });
    // リンクは使い捨て。同時に全端末のログインを解除する（乗っ取られていた場合に締め出すため）
    await client.execute({
      sql: 'UPDATE password_resets SET used_at = ? WHERE token_hash = ?',
      args: [new Date().toISOString(), row.token_hash],
    });
    await client.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [row.user_id] });
    res.json({ ok: true });
  } catch (e) {
    console.error('パスワード再設定に失敗しました', e);
    res.status(500).json({ error: '再設定に失敗しました' });
  }
});

/* 有効な再設定リンクを1件返す。期限切れ・使用済み・存在しないときはnull */
async function findValidReset(token) {
  if (!token) return null;
  const rs = await client.execute({
    sql: `SELECT r.token_hash, r.user_id, r.expires_at, u.nickname
            FROM password_resets r JOIN users u ON u.id = r.user_id
           WHERE r.token_hash = ? AND r.used_at IS NULL`,
    args: [auth.hashToken(String(token))],
  });
  const row = rs.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/* ---------- 管理者：スタッフ登録URL ----------
   秘密キー付きの招待URLは廃止。@dot-jp.or.jp のGoogleアカウントを持っている人だけが
   登録できるため、URL自体は誰に知られても問題ない */
app.get('/api/admin/staff-invite-url', requireAuth, requireBranchAdmin, (req, res) => {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/staff`, domain: STAFF_EMAIL_DOMAIN });
});

/* ---------- 管理者：ユーザー管理 ---------- */
app.patch('/api/admin/users/:id', requireAuth, requireBranchAdmin, async (req, res) => {
  const { nickname, branch_id, role } = req.body || {};
  if (!nickname || !['intern', 'staff', 'branch_admin', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'nickname・roleは必須です' });
  }
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (!canManageUser(req.authUser, target)) {
      return res.status(403).json({ error: '他の支部のユーザーは操作できません' });
    }
    // 支部管理者が自分より上の権限を作ったり、相手を他支部へ移したりできないようにする
    if (req.authUser.role !== 'admin') {
      if (role === 'admin') return res.status(403).json({ error: '全体管理者にする権限がありません' });
      if (branch_id !== req.authUser.branch_id) {
        return res.status(403).json({ error: '他の支部へは移動できません' });
      }
    }
    await updateUserRow(req.params.id, { nickname, branchId: branch_id, role });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '更新に失敗しました' });
  }
});
app.delete('/api/admin/users/:id', requireAuth, requireBranchAdmin, async (req, res) => {
  if (req.params.id === req.authUser.id) return res.status(400).json({ error: '自分自身は削除できません' });
  try {
    if (!canManageUser(req.authUser, await findUserById(req.params.id))) {
      return res.status(403).json({ error: '他の支部のユーザーは操作できません' });
    }
    await deleteUserRow(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '削除に失敗しました' });
  }
});

/* ---------- 管理者：スタッフ名簿（ドット配布アカウントの一覧） ----------
   名簿は全支部共通の元データなので、取り込みは全体管理者だけが行う。
   検索は支部管理者もできる（見つけた人を自分の支部に追加するため） */
app.get('/api/admin/directory/status', requireAuth, requireBranchAdmin, async (req, res) => {
  try {
    res.json({ ...(await directoryStatus()), domain: STAFF_EMAIL_DOMAIN });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});

/* CSV/TSVを貼り付けて名簿を取り込む。列は「氏名, メールアドレス, かな, 支部」を想定し、
   見出し行があれば列名から位置を判定する（順番が違っても取り込めるように） */
app.post('/api/admin/directory/import', requireAuth, requireAdmin, async (req, res) => {
  const text = String((req.body || {}).text || '');
  if (!text.trim()) return res.status(400).json({ error: '取り込む内容を貼り付けてください' });
  const HEADERS = {
    name: ['氏名', '名前', 'フルネーム', 'name', 'full_name', 'fullname'],
    email: ['メールアドレス', 'メール', 'mail', 'email', 'address'],
    kana: ['かな', 'カナ', 'ふりがな', 'フリガナ', 'kana', 'yomi'],
    branch: ['支部', '所属支部', 'branch'],
  };
  const splitLine = (line) => (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim().replace(/^"|"$/g, ''));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let idx = { name: 0, email: 1, kana: 2, branch: 3 };
  const first = splitLine(lines[0]);
  const looksLikeHeader = first.some((c) => HEADERS.email.includes(c.toLowerCase()) || HEADERS.email.includes(c));
  if (looksLikeHeader) {
    idx = { name: -1, email: -1, kana: -1, branch: -1 };
    first.forEach((cell, i) => {
      const v = cell.toLowerCase();
      for (const key of Object.keys(HEADERS)) {
        if (HEADERS[key].includes(cell) || HEADERS[key].includes(v)) idx[key] = i;
      }
    });
    lines.shift();
    if (idx.email < 0) return res.status(400).json({ error: 'メールアドレスの列が見つかりませんでした' });
  }
  const errors = [];
  let imported = 0;
  try {
    for (const [i, line] of lines.entries()) {
      const cells = splitLine(line);
      const email = String(cells[idx.email] || '').toLowerCase();
      const fullName = idx.name >= 0 ? String(cells[idx.name] || '').trim() : '';
      if (!email) { errors.push(`${i + 1}行目: メールアドレスがありません`); continue; }
      if (!email.endsWith(`@${STAFF_EMAIL_DOMAIN}`)) {
        errors.push(`${i + 1}行目: ${email} は @${STAFF_EMAIL_DOMAIN} ではありません`);
        continue;
      }
      await upsertDirectoryRow({
        email,
        // 氏名が空でも検索できるよう、メールのローカル部で代用する
        fullName: fullName || email.split('@')[0],
        kana: idx.kana >= 0 ? String(cells[idx.kana] || '').trim() : '',
        branchHint: idx.branch >= 0 ? String(cells[idx.branch] || '').trim() : '',
        source: 'csv',
      });
      imported += 1;
    }
    res.json({ ok: true, imported, skipped: errors.length, errors: errors.slice(0, 20), ...(await directoryStatus()) });
  } catch (e) {
    console.error('名簿の取り込みに失敗しました', e);
    res.status(500).json({ error: '取り込みに失敗しました' });
  }
});

/* 名簿を名前・かな・メールで検索する。既にアプリに登録済みの人には目印を付けて返す */
app.get('/api/admin/directory/search', requireAuth, requireBranchAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ results: [] });
  try {
    const rows = await searchDirectory(q);
    const results = [];
    for (const r of rows) {
      const existing = await findUserByEmail(r.email);
      results.push({
        ...r,
        registered: !!existing,
        registered_branch_id: existing ? existing.branch_id : null,
        registered_status: existing ? existing.status : null,
      });
    }
    res.json({ results });
  } catch (e) {
    console.error('名簿検索に失敗しました', e);
    res.status(500).json({ error: '検索に失敗しました' });
  }
});

/* 名簿から選んだ人を、その場でスタッフとして支部に登録する。
   本人の操作を待たずに使える状態にするため status は active。
   パスワードは持たせず、本人は @dot-jp.or.jp のGoogleログインで入る
   （初回ログイン時にメールアドレスが一致してこのアカウントに紐付く） */
app.post('/api/admin/staff', requireAuth, requireBranchAdmin, async (req, res) => {
  const { email, full_name, branch_id } = req.body || {};
  const mailAddr = String(email || '').trim().toLowerCase();
  const name = String(full_name || '').trim();
  if (!mailAddr) return res.status(400).json({ error: 'メールアドレスが必要です' });
  if (!name) return res.status(400).json({ error: '氏名を入力してください' });
  if (!branch_id) return res.status(400).json({ error: '所属支部を選択してください' });
  if (!mailAddr.endsWith(`@${STAFF_EMAIL_DOMAIN}`)) {
    return res.status(400).json({ error: `@${STAFF_EMAIL_DOMAIN} のアカウントのみ登録できます` });
  }
  if (!canManageBranch(req.authUser, branch_id)) {
    return res.status(403).json({ error: '自分の支部にのみ登録できます' });
  }
  try {
    const obj = await readDB();
    if (!(obj?.branches || []).some((b) => b.id === branch_id)) {
      return res.status(400).json({ error: '選択された支部が存在しません' });
    }
    if (await findUserByEmail(mailAddr)) {
      return res.status(409).json({ error: 'このアカウントは既に登録されています' });
    }
    const user = await insertUser({
      email: mailAddr,
      passwordHash: '',
      nickname: name,
      role: 'staff',
      branchId: branch_id,
      status: 'active',
    });
    res.json({ ok: true, user: toPublicUser(user) });
  } catch (e) {
    console.error('スタッフの追加に失敗しました', e);
    res.status(500).json({ error: '登録に失敗しました' });
  }
});

/* ---------- メール送信 ----------
   面談の確定・不成立（kind='fixed'/'failed'）だけは実際にメールを送る。
   Meet/Zoomリンクの送付などはアプリ内の履歴に残すだけ。
   履歴はサーバーだけが書き込む（PUT /api/db 側では emails を受け付けない）ため、
   クライアントの持っている情報が古くても履歴が消えることはない */
const REAL_MAIL_KINDS = ['fixed', 'failed'];

app.post('/api/mail/send', requireAuth, async (req, res) => {
  const { receiver_id, subject, body, kind } = req.body || {};
  const actor = req.authUser;
  if (!['staff', 'branch_admin', 'admin'].includes(actor.role)) {
    return res.status(403).json({ error: '権限がありません' });
  }
  if (!receiver_id) return res.status(400).json({ error: '宛先が必要です' });
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: '件名を入力してください' });
  try {
    const receiver = await findUserById(receiver_id);
    if (!receiver) return res.status(404).json({ error: '宛先のユーザーが見つかりません' });
    if (actor.role !== 'admin' && receiver.branch_id !== actor.branch_id) {
      return res.status(403).json({ error: '他の支部の方には送信できません' });
    }

    let sent = false;
    let warning = null;
    if (REAL_MAIL_KINDS.includes(kind)) {
      if (!mail.MAIL_ENABLED) {
        warning = 'メール送信が未設定のため、履歴への記録のみ行いました。';
      } else {
        try {
          await mail.sendInterviewMail({
            to: receiver.email, nickname: receiver.nickname,
            subject: String(subject).trim(), body: String(body || ''),
          });
          sent = true;
        } catch (e) {
          // 送信に失敗しても履歴は残す。スタッフが送り直せるよう、失敗した事実は画面に返す
          console.error('面談メールの送信に失敗しました', e);
          warning = 'メールを送信できませんでした。履歴には記録しています。';
        }
      }
    }

    const db = (await readDB()) || {};
    db.emails = db.emails || [];
    db.emails.push({
      id: 'ml_' + crypto.randomBytes(4).toString('hex'),
      sender_id: actor.id, receiver_id, subject: String(subject).trim(),
      body: String(body || ''), sent_at: new Date().toISOString(), delivered: sent,
    });
    await writeDB(db);
    res.json({ ok: true, sent, warning });
  } catch (e) {
    console.error('メール送信処理に失敗しました', e);
    res.status(500).json({ error: '送信に失敗しました' });
  }
});

// 現在のDBを取得。未作成（初回アクセス）でも users だけは常に返し、branches等はフロント側のseed()投入に委ねる
app.get('/api/db', requireAuth, async (req, res) => {
  try {
    const obj = await readDB();
    const users = await listActiveUsers();
    if (!obj) return res.json({ users: scopeUsers(users, req.authUser) });
    const scoped = scopeDBForUser(obj, req.authUser, users);
    scoped.users = scopeUsers(users, req.authUser);
    res.json(scoped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db read failed' });
  }
});

/* インターン生には、面談の申し込み先として必要な自支部のスタッフだけを見せる。
   全支部の全ユーザー一覧を配る必要はない */
function scopeUsers(users, actor) {
  if (actor.role !== 'intern') return users;
  return users.filter((u) =>
    u.id === actor.id || (u.branch_id === actor.branch_id && (u.role === 'staff' || u.role === 'branch_admin')));
}

// DB全体を置き換えて保存する。users は専用APIでのみ変更するためここでは無視する
app.put('/api/db', requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
  /* 楽観ロック用。クライアントが「このバージョンを読んだうえで書き換えた」と申告してくる。
     申告と現在のバージョンがずれていれば、その間に他の人が保存したということなので、
     上書きせず409を返す。クライアントは最新を取り直して同じ操作をやり直す */
  const baseUpdatedAt = body._baseUpdatedAt;
  delete body._baseUpdatedAt;
  delete body.updatedAt;
  delete body.users;
  try {
    const oldDB = await readDB();
    // 申告が無い場合も競合扱いにする。古いクライアントが無条件に上書きするのを防ぐ
    if (oldDB && oldDB.updatedAt !== baseUpdatedAt) {
      return res.status(409).json({ error: '他の人が先に更新しました', code: 'conflict' });
    }
    const users = await listActiveUsers();

    // 初回（データがまだ無い）は支部などの初期データ投入なので、そのまま受け入れる
    if (!oldDB) {
      const updatedAt = await writeDB(body);
      return res.json({ ok: true, updatedAt });
    }

    // 送られてきた内容を、その人に見えていなかった分と合成してから権限を確かめる
    const merged = mergeScoped(oldDB, body, req.authUser, users);
    const errs = validateDiff(oldDB, merged, req.authUser, users);
    if (errs.length) {
      console.warn(`権限のない変更を拒否しました（user ${req.authUser.id} / ${req.authUser.role}）:`, errs);
      return res.status(403).json({ error: errs[0], code: 'forbidden_change', details: errs });
    }

    await syncInterviewsToGoogle(oldDB, merged, users);
    const updatedAt = await writeDB(merged);
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

/* 静的ファイルの配信。
   以前はリポジトリ直下をそのまま公開していたが、それだと設計書や render.yaml まで
   誰でも読めてしまうため、公開してよいファイルだけを明示的に許可する方式にしている。
   新しく公開したいファイルが増えたときは、この一覧に追加すること。 */
const PUBLIC_ROOT = path.join(__dirname, '..');
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/privacy.html': 'privacy.html',
  '/terms.html': 'terms.html',
  // スタッフ登録ページ。中身はアプリ本体と同じHTMLで、URLを見て画面を切り替えている
  '/staff': 'index.html',
  // Google Search Console のサイト所有権確認用。確認状態を保つため削除しないこと
  '/googlee6411894890471cb.html': 'googlee6411894890471cb.html',
};
app.get('*', (req, res) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch (e) { p = req.path; }
  // 末尾スラッシュ付きだと style.css の相対パスがずれるため、正規化してから配信する
  if (p === '/staff/') return res.redirect(301, '/staff');
  const file = PUBLIC_FILES[p];
  if (!file) return res.status(404).type('text/plain; charset=utf-8').send('ページが見つかりません');
  res.sendFile(path.join(PUBLIC_ROOT, file));
});

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
