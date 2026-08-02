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
  /* ---------- 一斉に書き込まれるデータの置き場 ----------
     store（DB全体で1行のJSON）は、誰か1人が保存すると他の全員の保存が
     はじかれる仕組みのため、大人数が同時に操作するデータを置くと破綻する。
     依頼の確認・イベントの出欠・面談の申請は「配ったあと全員が一斉に押す」
     性質があるので、1件1行のテーブルに分けて置く。
     こうすると各自が別々の行に書くだけになり、待ち合わせが発生しない。 */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      branch_id TEXT,
      subject TEXT NOT NULL,
      body TEXT,
      target_label TEXT,
      recipient_ids TEXT NOT NULL,   -- JSON配列。あて先は送信時に固定されるので分解しない
      created_at TEXT NOT NULL
    )
  `);
  /* 「確認しました」を依頼の行に配列で持つと、300人が同じ1行を奪い合うことになる。
     1人1行にすることで、何人が同時に押しても衝突しない */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS request_reads (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS event_responses (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      response TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (event_id, user_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT,
      msg TEXT,
      branch_id TEXT,
      at TEXT NOT NULL
    )
  `);
  for (const ddl of [
    'CREATE INDEX IF NOT EXISTS idx_requests_branch ON requests(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_request_reads_user ON request_reads(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_responses_event ON event_responses(event_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_branch ON notifications(branch_id)',
  ]) await client.execute(ddl);

  // 既存DBへの追加カラム。既に存在する場合のエラーは無視する
  for (const ddl of [
    'ALTER TABLE users ADD COLUMN google_sub TEXT',   // Googleでログイン用
    'ALTER TABLE users ADD COLUMN avatar_url TEXT',   // Googleでログイン用
    'ALTER TABLE users ADD COLUMN staff_id TEXT',     // インターン生の担当スタッフ
    'ALTER TABLE google_tokens ADD COLUMN calendar_name TEXT', // 全体予定表の表示名
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

/* ---------- storeの読み書き ----------
   DB全体を1行のJSONで持っているため、素直に実装すると
   「1リクエストごとにTursoへ往復し、数MBのJSONをparseする」ことになる。
   500人規模だと1リクエストあたり約5MBのヒープを使い、
   Render無料プランの512MBでは同時30リクエスト程度で枯渇する。

   そこでパース済みの内容をプロセス内に1つだけ持ち、読み出しはそれを使う。
   【前提】このアプリを動かすインスタンスは常に1つであること。
   複数インスタンスに増やすと、片方の書き込みがもう片方に伝わらず
   古い内容を返してしまう。増やす場合はこのキャッシュを外すこと。 */
let dbCache = null;          // { obj, updatedAt } パース済みの内容
let dbCacheLoaded = false;   // 「storeがまだ空」も正しく覚えておくための旗

async function loadDBFromStore() {
  const rs = await client.execute('SELECT data, updated_at FROM store WHERE id = 1');
  const row = rs.rows[0];
  dbCache = row ? { obj: JSON.parse(row.data), updatedAt: row.updated_at } : null;
  dbCacheLoaded = true;
}

/* 読み取り専用の用途で使う。返り値を書き換えてはいけない（キャッシュ本体そのもの）。
   書き換えたい場合は readDBForWrite() を使うこと */
async function readDB() {
  if (!dbCacheLoaded) await loadDBFromStore();
  if (!dbCache) return null;
  // updatedAt は保存のたびに変わるので、都度この場で載せる
  return { ...dbCache.obj, updatedAt: dbCache.updatedAt };
}

/* 中身を書き換えてから writeDB() する用途。キャッシュを壊さないよう複製を返す */
async function readDBForWrite() {
  if (!dbCacheLoaded) await loadDBFromStore();
  if (!dbCache) return null;
  return { ...structuredClone(dbCache.obj), updatedAt: dbCache.updatedAt };
}

/* 書き込みに失敗したときに呼ぶ。次回の読み出しでTursoから取り直す。
   readDB() が返すのは浅い複製なので、途中まで書き換えた内容が
   キャッシュ側に残っている可能性がある。そのまま配ると
   「保存に失敗したのに画面には反映されている」状態になるため、捨てて読み直す */
function invalidateDBCache() {
  dbCache = null;
  dbCacheLoaded = false;
}

/* ---------- store から専用テーブルへの引っ越し ----------
   以前は依頼・出欠・通知も store の中に入れていた。
   一度だけ行に展開して移し、store 側からは取り除く。
   移し終えた印を store に残し、二度は動かさない */
const MIGRATION_FLAG = 'movedToTablesV1';

async function migrateStoreToTables() {
  await withDBLock(async () => {
    const db = await readDBForWrite();
    if (!db || db[MIGRATION_FLAG]) return;

    let moved = 0;
    for (const rq of db.requests || []) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO requests (id, sender_id, branch_id, subject, body, target_label, recipient_ids, created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [rq.id, rq.sender_id, rq.branch_id || null, rq.subject || '', rq.body || '',
          rq.target_label || null, JSON.stringify(rq.recipient_ids || []), rq.created_at || new Date().toISOString()],
      });
      for (const r of rq.read_by || []) {
        await client.execute({
          sql: 'INSERT OR IGNORE INTO request_reads (request_id, user_id, read_at) VALUES (?,?,?)',
          args: [rq.id, r.user_id, r.at || new Date().toISOString()],
        });
      }
      moved++;
    }
    for (const er of db.event_responses || []) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO event_responses (id, event_id, user_id, response, updated_at) VALUES (?,?,?,?,?)`,
        args: [er.id, er.event_id, er.user_id, er.response, new Date().toISOString()],
      });
      moved++;
    }
    for (const n of db.notifications || []) {
      await client.execute({
        sql: 'INSERT OR IGNORE INTO notifications (id, type, msg, branch_id, at) VALUES (?,?,?,?,?)',
        args: [n.id, n.type || null, n.msg || '', n.branch_id || null, n.at || new Date().toISOString()],
      });
      moved++;
    }

    delete db.requests;
    delete db.event_responses;
    delete db.notifications;
    db[MIGRATION_FLAG] = true;
    await writeDB(db);
    console.log(`依頼・出欠・通知を専用テーブルへ移しました（${moved}件）`);
  });
}

/* ---------- 専用テーブルの読み書き ---------- */
const parseIds = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };

/* 依頼を、フロントが期待する形（read_by 付き）に組み立てて返す */
async function listRequestsFor(user) {
  const isAdmin = user.role === 'admin';
  const rs = isAdmin
    ? await client.execute('SELECT * FROM requests')
    : await client.execute({
      // 自分が送ったもの、または自分があて先のもの。あて先はJSON配列なので部分一致で絞ってから厳密に確認する
      sql: 'SELECT * FROM requests WHERE sender_id = ? OR recipient_ids LIKE ?',
      args: [user.id, '%"' + user.id + '"%'],
    });
  const rows = rs.rows.filter((r) => isAdmin || r.sender_id === user.id || parseIds(r.recipient_ids).includes(user.id));
  if (!rows.length) return [];
  const reads = await client.execute('SELECT * FROM request_reads');
  const byRequest = new Map();
  for (const r of reads.rows) {
    if (!byRequest.has(r.request_id)) byRequest.set(r.request_id, []);
    byRequest.get(r.request_id).push({ user_id: r.user_id, at: r.read_at });
  }
  return rows.map((r) => ({
    id: r.id, sender_id: r.sender_id, branch_id: r.branch_id,
    subject: r.subject, body: r.body, target_label: r.target_label,
    recipient_ids: parseIds(r.recipient_ids), created_at: r.created_at,
    read_by: byRequest.get(r.id) || [],
  }));
}

async function listEventResponses() {
  const rs = await client.execute('SELECT * FROM event_responses');
  return rs.rows.map((r) => ({ id: r.id, event_id: r.event_id, user_id: r.user_id, response: r.response }));
}

async function listNotificationsFor(user) {
  const rs = user.role === 'admin'
    ? await client.execute('SELECT * FROM notifications')
    : await client.execute({
      sql: 'SELECT * FROM notifications WHERE branch_id IS NULL OR branch_id = ?',
      args: [user.branch_id || null],
    });
  return rs.rows.map((r) => ({ id: r.id, type: r.type, msg: r.msg, branch_id: r.branch_id, at: r.at }));
}

/* 通知は依頼の送信などに付随して積まれる。専用APIの中から呼ぶ */
async function insertNotification({ type, msg, branch_id }) {
  await client.execute({
    sql: 'INSERT INTO notifications (id, type, msg, branch_id, at) VALUES (?,?,?,?,?)',
    args: ['nt_' + crypto.randomBytes(6).toString('hex'), type || null, msg || '', branch_id || null, new Date().toISOString()],
  });
}

async function writeDB(obj) {
  const updatedAt = new Date().toISOString();
  const { updatedAt: _ignored, ...body } = obj;
  const data = JSON.stringify(body);
  await client.execute({
    sql: `INSERT INTO store (id, data, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [data, updatedAt],
  });
  // 書けたときだけキャッシュを進める。失敗時は次回Tursoから読み直す
  dbCache = { obj: structuredClone(body), updatedAt };
  dbCacheLoaded = true;
  return updatedAt;
}

/* 「読んで、変えて、書く」の区間を1本の列にして順番に通す（実体は dblock.js）。
   PUT /api/db は楽観ロック（updatedAt照合）で守られているが、
   メール履歴の追記やGoogleカレンダーの取り込みには照合が無く、
   同時実行で片方が消える状態だった */
const { withDBLock } = require('./dblock');

/* ---------- users テーブル操作 ---------- */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, nickname: row.nickname, role: row.role,
    branch_id: row.branch_id, status: row.status,
    created_at: row.created_at, approved_at: row.approved_at,
    avatar_url: row.avatar_url || null,
    // インターン生の担当スタッフ。未設定なら null
    staff_id: row.staff_id || null,
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
async function insertUser({ email, passwordHash, nickname, role, branchId, status, googleSub, avatarUrl, staffId }) {
  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  await client.execute({
    sql: `INSERT INTO users (id, email, password_hash, nickname, role, branch_id, status, created_at, google_sub, avatar_url, staff_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    // Googleでログインしたユーザーはパスワードを持たない。空文字は verifyPassword が必ず false を返すため、
    // パスワードログインの経路からは入れない
    args: [id, String(email).toLowerCase(), passwordHash || '', nickname, role, branchId || null, status,
      new Date().toISOString(), googleSub || null, avatarUrl || null, staffId || null],
  });
  return findUserById(id);
}
/* staffId は「渡されたときだけ」書き換える。
   undefined と null を区別しないと、担当を触らない更新のたびに消えてしまう */
async function updateUserRow(id, { nickname, branchId, role, staffId }) {
  await client.execute({
    sql: 'UPDATE users SET nickname=?, branch_id=?, role=? WHERE id=?',
    args: [nickname, branchId || null, role, id],
  });
  if (staffId !== undefined) {
    await client.execute({ sql: 'UPDATE users SET staff_id=? WHERE id=?', args: [staffId || null, id] });
  }
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

/* 全体予定表（ドットジェイピーの共有カレンダー）用のトークンを入れておく予約キー。
   google_tokens は staff_id が主キーなので、人ではない行を1つ混ぜても構造は変わらない。
   ユーザーIDは 'u_' で始まるため、この名前が実在のユーザーとぶつかることはない。
   スタッフ個人の連携（面談の自動登録・面談不可の反映）とは完全に別枠にしてあり、
   取込用アカウントを連携しても誰かの個人カレンダーには影響しない */
const SHARED_CALENDAR_KEY = '__shared__';

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

/* 予定のうち、その人が見てよいものだけ。
   visibility が 'private' のものは作成者本人にしか見せない（全体管理者にも見せない）。
   visibility が無いのはこの仕組みを入れる前の古いレコードで、
   これまでどおり支部で共有しているものとして扱う */
function visibleEventsFor(obj, user) {
  return (obj.events || []).filter((e) => (e.visibility === 'private'
    ? e.creator_id === user.id
    : user.role === 'admin' || e.branch_id === user.branch_id));
}

/* store に残っている項目だけを、その人に見える範囲へ絞る。
   依頼・出欠・通知は専用テーブルへ移したのでここでは扱わない
   （GET /api/db 側でテーブルから読んで合成する） */
function scopeDBForUser(obj, user, users) {
  const events = visibleEventsFor(obj, user);
  // 全体管理者でも、他の人の「自分だけ」の予定は見えない
  if (user.role === 'admin') return { ...obj, events };
  const branchId = user.branch_id;
  const isIntern = user.role === 'intern';
  const userById = new Map(users.map((u) => [u.id, u]));
  const inBranch = (id) => {
    const u = userById.get(id);
    return !!u && u.branch_id === branchId;
  };

  const interviews = (obj.interviews || []).filter((iv) =>
    isIntern ? iv.intern_id === user.id : (iv.staff_id === user.id || inBranch(iv.intern_id)));
  // メールは当事者だけ。以前は全員が全員分の本文を読めていた
  const emails = (obj.emails || []).filter((m) => m.receiver_id === user.id || m.sender_id === user.id);

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

  // インターン先マスタは支部ごとの持ち物
  const internships = (obj.internships || []).filter((p) => p.branch_id === branchId);

  // プロフィール（所属部署・インターン先）は自支部のメンバーの分だけ
  const profiles = {};
  for (const [id, p] of Object.entries(obj.profiles || {})) {
    if (id === user.id || inBranch(id)) profiles[id] = p;
  }

  return { ...obj, interviews, events, emails, availability, internships, profiles };
}

/* 絞り込んだデータを受け取ったクライアントが書き戻してきたとき、
   その人には見えていなかった分を元のデータから戻して1つに合成する。
   これをしないと、見えていないデータが保存のたびに消えてしまう */
/* 専用テーブルへ移した項目。PUT /api/db から送られてきても採用しない。
   古い画面を開いたままのタブが、テーブル側の最新の内容を
   自分の持っている古い一覧で上書きしてしまうのを防ぐ */
const TABLE_BACKED_KEYS = ['requests', 'event_responses', 'notifications'];

function mergeScoped(oldDB, clientDB, user, users) {
  const isAdmin = user.role === 'admin';
  const visible = scopeDBForUser(oldDB, user, users);
  const merged = isAdmin ? { ...clientDB } : { ...oldDB };
  for (const key of TABLE_BACKED_KEYS) delete merged[key];
  /* 全体管理者に見えていないのは他の人の「自分だけ」の予定だけなので、
     そこだけ戻せばよい。戻さないと、管理者が保存するたびに消えてしまう */
  /* ここに並べるキーは「クライアントから送られてきた内容を採用する」もの。
     並べ忘れると、その項目は oldDB のまま＝保存が黙って捨てられる。
     実際 requests / profiles / internships の追加時に並べ忘れがあり、
     全体管理者以外の保存が消える不具合になっていた（2026-08-02修正）。
     フロントのDBに項目を増やしたら、必ずここにも足すこと */
  const keys = isAdmin
    ? ['events']
    : ['interviews', 'events'];
  for (const key of keys) {
    const visibleIds = new Set((visible[key] || []).map((x) => x.id));
    const hidden = (oldDB[key] || []).filter((x) => !visibleIds.has(x.id));
    merged[key] = [...hidden, ...(clientDB[key] || [])];
  }
  if (isAdmin) {
    merged.emails = oldDB.emails || [];
    return merged;
  }

  /* インターン先マスタ。見えていなかった他支部の分を戻したうえで、
     送られてきた分をそのまま採用する。他支部あての不正な追加をここで黙って捨てず、
     validateDiff に届けて403で知らせるため（黙って捨てると、
     登録できたつもりで消えている状態になり、今回直した不具合と同じことが起きる） */
  {
    const visibleIds = new Set((visible.internships || []).map((p) => p.id));
    const hidden = (oldDB.internships || []).filter((p) => !visibleIds.has(p.id));
    merged.internships = [...hidden, ...(clientDB.internships || [])];
  }

  /* プロフィールは、その人に見えていた範囲（自分＋自支部）だけを差し替える。
     スタッフがインターン生のインターン先を代理設定する運用があるため、
     自分の分だけに絞ってしまうと代理設定が保存できなくなる。
     まだ存在しないユーザーの分を新規に作る場合もあるので、
     「元データにあるか」ではなく「その人に見える相手か」で判断する */
  {
    const userById = new Map(users.map((u) => [u.id, u]));
    const canTouch = (id) => id === user.id || userById.get(id)?.branch_id === user.branch_id;
    merged.profiles = { ...(oldDB.profiles || {}) };
    for (const id of Object.keys(clientDB.profiles || {})) {
      if (canTouch(id)) merged.profiles[id] = clientDB.profiles[id];
    }
    // 見えていたのに送り返されてこなかったものは、その人が消したということ
    for (const id of Object.keys(visible.profiles || {})) {
      if (!Object.prototype.hasOwnProperty.call(clientDB.profiles || {}, id)) delete merged.profiles[id];
    }
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
    // 「自分だけ」の予定は本人しか見られないので、インターン生にも作らせてよい
    const isPrivate = ev.visibility === 'private';
    if (!prev) {
      if (actor.role === 'intern' && !isPrivate) errs.push('インターン生が作れるのは「自分だけ」の予定だけです');
      else if (!isAdmin && !isPrivate && ev.branch_id !== actor.branch_id) errs.push('他の支部のイベントは作成できません');
      else if (ev.creator_id !== actor.id) errs.push('作成者が不正です');
    } else if (!sameJSON(prev, ev)) {
      if (!isAdmin && prev.creator_id !== actor.id) errs.push('このイベントを編集する権限がありません');
      else if (actor.role === 'intern' && !isPrivate) errs.push('インターン生が作れるのは「自分だけ」の予定だけです');
    }
  }
  const removedEventIds = new Set([...oldEv.keys()].filter((id) => !newEv.has(id)));
  for (const id of removedEventIds) {
    const prev = oldEv.get(id);
    if (!isAdmin && prev.creator_id !== actor.id) errs.push('このイベントを削除する権限がありません');
  }

  // ---- 空き日程：自分の分だけ ----
  const avKeys = new Set([...Object.keys(oldDB.availability || {}), ...Object.keys(newDB.availability || {})]);
  for (const key of avKeys) {
    if (key === actor.id || isAdmin) continue;
    if (!sameJSON((oldDB.availability || {})[key], (newDB.availability || {})[key])) {
      errs.push('他の人の空き時間は変更できません');
    }
  }

  // ---- メール履歴：専用APIでのみ変更する ----
  if (!sameJSON(oldDB.emails, newDB.emails)) {
    errs.push('メール履歴はこの方法では変更できません');
  }

  /* 依頼・出欠・通知はここでは検証しない。専用テーブルへ移し、
     それぞれの専用APIの中で権限を確かめている */

  /* ---- インターン先マスタ：自支部のものをスタッフ側だけが編集できる ---- */
  const oldIp = byId(oldDB.internships);
  const newIp = byId(newDB.internships);
  for (const [id, ip] of newIp) {
    const prev = oldIp.get(id);
    if (prev && sameJSON(prev, ip)) continue;
    if (!isStaffLike) errs.push('インターン先を登録・変更できるのはスタッフだけです');
    else if (!isAdmin && ip.branch_id !== actor.branch_id) errs.push('他の支部のインターン先は変更できません');
    else if (!isAdmin && prev && prev.branch_id !== actor.branch_id) errs.push('他の支部のインターン先は変更できません');
  }
  for (const [id, prev] of oldIp) {
    if (newIp.has(id)) continue;
    if (!isStaffLike) errs.push('インターン先を削除できるのはスタッフだけです');
    else if (!isAdmin && prev.branch_id !== actor.branch_id) errs.push('他の支部のインターン先は削除できません');
    // 登録中の人がいるインターン先は消せない（フロントにも同じ確認があるが、そちらは迂回できる）
    else if (Object.values(newDB.profiles || {}).some((p) => p && p.internship_id === id)) {
      errs.push('登録中のインターン生がいるため削除できません');
    }
  }

  /* ---- プロフィール：自分の分。スタッフは同支部インターン生のインターン先だけ代理設定できる ---- */
  const profKeys = new Set([...Object.keys(oldDB.profiles || {}), ...Object.keys(newDB.profiles || {})]);
  for (const key of profKeys) {
    if (isAdmin || key === actor.id) continue;
    const before = (oldDB.profiles || {})[key];
    const after = (newDB.profiles || {})[key];
    if (sameJSON(before, after)) continue;
    if (!isStaffLike) { errs.push('他の人のプロフィールは変更できません'); continue; }
    if (!sameBranch(key)) { errs.push('他の支部の人のプロフィールは変更できません'); continue; }
    // スタッフでも、代理で触ってよいのはインターン先だけ（所属部署は本人が決めるもの）
    if (!sameJSON({ ...(before || {}), internship_id: null }, { ...(after || {}), internship_id: null })) {
      errs.push('他の人のプロフィールで変更できるのはインターン先だけです');
    }
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
/* 担当スタッフに選べる人だけを返す。ログイン前の登録画面から呼ぶので認証は不要。
   返すのは id と表示名だけで、メールアドレスなどは含めない。
   支部の指定は必須にして、全支部の一覧をまとめて取り出せないようにしている */
app.get('/api/auth/staff-options', async (req, res) => {
  const branchId = req.query.branch;
  if (!branchId) return res.json({ staff: [] });
  try {
    const rs = await client.execute({
      sql: `SELECT id, nickname FROM users
            WHERE status = 'active' AND branch_id = ? AND role IN ('staff','branch_admin')
            ORDER BY nickname`,
      args: [String(branchId)],
    });
    res.json({ staff: rs.rows.map((r) => ({ id: r.id, nickname: r.nickname })) });
  } catch (e) {
    console.error('担当スタッフ候補の取得に失敗しました', e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});

/* 招待URL（?staff=xxx）を開いたときに、誰の紹介かを表示するために引く。
   見つからないときもエラーにせず空で返し、登録自体は続けられるようにする */
app.get('/api/auth/invite', async (req, res) => {
  const staffId = req.query.staff;
  if (!staffId) return res.json({ staff: null });
  try {
    const rs = await client.execute({
      sql: `SELECT id, nickname, branch_id FROM users
            WHERE id = ? AND status = 'active' AND role IN ('staff','branch_admin')`,
      args: [String(staffId)],
    });
    const r = rs.rows[0];
    res.json({ staff: r ? { id: r.id, nickname: r.nickname, branch_id: r.branch_id } : null });
  } catch (e) {
    console.error('招待リンクの確認に失敗しました', e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});

/* 担当スタッフとして指定してよい相手かを確かめる。
   でたらめなIDや、他支部の人・インターン生が入るのを防ぐ */
async function validStaffIdFor(staffId, branchId) {
  if (!staffId) return null;
  const rs = await client.execute({
    sql: `SELECT id, branch_id FROM users
          WHERE id = ? AND status = 'active' AND role IN ('staff','branch_admin')`,
    args: [String(staffId)],
  });
  const row = rs.rows[0];
  if (!row) return null;
  if (branchId && row.branch_id && row.branch_id !== branchId) return null;
  return row.id;
}

app.post('/api/auth/register-intern', async (req, res) => {
  const { email, password, nickname, branch_id, staff_id } = req.body || {};
  if (!email || !password || !nickname) return res.status(400).json({ error: 'email・password・nicknameは必須です' });
  if (String(password).length < 8) return res.status(400).json({ error: 'パスワードは8文字以上で入力してください' });
  try {
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'このメールアドレスは既に登録されています' });
    const passwordHash = await auth.hashPassword(password);
    // 担当スタッフは任意。指定が不正なら黙って未設定にする（登録自体は通す）
    const staffId = await validStaffIdFor(staff_id, branch_id);
    const user = await insertUser({ email, passwordHash, nickname, role: 'intern', branchId: branch_id, status: 'active', staffId });
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
    // 専用テーブルへ移した分（依頼・出欠・通知）もここで合わせて返す
    Object.assign(db, await readTableBacked(user));
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

    /* インターン生の支部は、いちど決まったら本人には変えさせない。
       担当スタッフは同じ支部の人しか選べない作りなので（validStaffIdFor）、
       支部だけを動かせると担当と食い違ってしまう。
       初回設定（まだ支部が無い状態）だけは通す */
    const me = req.authUser;
    const keepBranch = me.role === 'intern' && me.branch_id;
    const nextBranch = keepBranch ? me.branch_id : branch_id;
    if (keepBranch && branch_id !== me.branch_id) {
      return res.status(403).json({ error: '支部の変更は担当スタッフにご依頼ください' });
    }
    await client.execute({
      sql: 'UPDATE users SET nickname = ?, branch_id = ? WHERE id = ?',
      args: [String(nickname).trim(), nextBranch, req.authUser.id],
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

/* ---------- スタッフ：インターン生を招くURL ----------
   自分のIDを付けただけのURL。開いた学生が会員登録に進むと、
   担当スタッフの欄にこの人が入る。秘密の値ではないので期限も持たせない
   （このURLが無くても、これまでどおり誰でもインターン生登録はできる） */
app.get('/api/staff/intern-invite-url', requireAuth, (req, res) => {
  const me = req.authUser;
  if (!['staff', 'branch_admin', 'admin'].includes(me.role)) {
    return res.status(403).json({ error: 'インターン生を招けるのはスタッフだけです' });
  }
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/?staff=${encodeURIComponent(me.id)}`, nickname: me.nickname });
});

/* ---------- 管理者：ユーザー管理 ---------- */
app.patch('/api/admin/users/:id', requireAuth, requireBranchAdmin, async (req, res) => {
  const { nickname, branch_id, role, staff_id } = req.body || {};
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
    /* 担当スタッフはインターン生にだけ意味がある。
       staff_id が送られてこなかったときは今の値のままにする（undefined を渡す） */
    let staffId;
    if (staff_id !== undefined) {
      staffId = role === 'intern' ? await validStaffIdFor(staff_id, branch_id) : null;
    } else if (role !== 'intern' && target.staff_id) {
      staffId = null; // インターン生でなくなったら担当は外す
    }
    await updateUserRow(req.params.id, { nickname, branchId: branch_id, role, staffId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '更新に失敗しました' });
  }
});

/* インターン生が自分の担当スタッフを自分で変える */
/* 担当スタッフの引き継ぎ。
   変更できるのは、いま担当しているスタッフ本人だけ。
   インターン生が自分で付け替えると、スタッフ側が把握しないまま
   担当から外れてしまうため、本人には触らせない（会員登録のときだけ選べる）。 */
app.patch('/api/staff/interns/:id', requireAuth, async (req, res) => {
  const me = req.authUser;
  if (me.role !== 'staff' && me.role !== 'branch_admin') {
    return res.status(403).json({ error: '権限がありません' });
  }
  try {
    const target = await findUserById(req.params.id);
    if (!target || target.role !== 'intern') {
      return res.status(404).json({ error: 'インターン生が見つかりません' });
    }
    if (target.staff_id !== me.id) {
      return res.status(403).json({ error: 'あなたが担当しているインターン生ではありません' });
    }
    // 引き継ぎ先は、同じ支部のスタッフに限る（支部をまたぐ担当を作らない）
    const staffId = await validStaffIdFor(req.body?.staff_id, target.branch_id);
    if (req.body?.staff_id && !staffId) {
      return res.status(400).json({ error: 'その担当スタッフは選べません' });
    }
    await client.execute({ sql: 'UPDATE users SET staff_id=? WHERE id=?', args: [staffId, target.id] });
    res.json({ ok: true });
  } catch (e) {
    console.error('担当スタッフの変更に失敗しました', e);
    res.status(500).json({ error: '変更に失敗しました' });
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

    // 同時に何通も送られると、照合が無いぶん片方の履歴が消えるため列に並べる
    await withDBLock(async () => {
      const db = (await readDBForWrite()) || {};
      db.emails = db.emails || [];
      db.emails.push({
        id: 'ml_' + crypto.randomBytes(4).toString('hex'),
        sender_id: actor.id, receiver_id, subject: String(subject).trim(),
        body: String(body || ''), sent_at: new Date().toISOString(), delivered: sent,
      });
      await writeDB(db);
    });
    res.json({ ok: true, sent, warning });
  } catch (e) {
    console.error('メール送信処理に失敗しました', e);
    invalidateDBCache();
    res.status(500).json({ error: '送信に失敗しました' });
  }
});

// 現在のDBを取得。未作成（初回アクセス）でも users だけは常に返し、branches等はフロント側のseed()投入に委ねる
app.get('/api/db', requireAuth, async (req, res) => {
  try {
    const obj = await readDB();
    const users = await listActiveUsers();
    if (!obj) return res.json({ users: scopeUsers(users, req.authUser), ...await readTableBacked(req.authUser) });
    const scoped = scopeDBForUser(obj, req.authUser, users);
    scoped.users = scopeUsers(users, req.authUser);
    // 専用テーブルへ移した分を合成する。画面から見える形は今までと同じ
    Object.assign(scoped, await readTableBacked(req.authUser));
    res.json(scoped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db read failed' });
  }
});

/* 専用テーブルへ移した項目を、フロントが期待するキー名で返す */
async function readTableBacked(user) {
  const [requests, event_responses, notifications] = await Promise.all([
    listRequestsFor(user), listEventResponses(), listNotificationsFor(user),
  ]);
  return { requests, event_responses, notifications };
}

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
    /* 照合してから書き込むまでの間に他の保存が入り込むと、
       せっかくの楽観ロックをすり抜けて上書きが起きる。区間ごと列に並べる */
    const result = await withDBLock(async () => {
      const oldDB = await readDB();
      // 申告が無い場合も競合扱いにする。古いクライアントが無条件に上書きするのを防ぐ
      if (oldDB && oldDB.updatedAt !== baseUpdatedAt) {
        return { status: 409, payload: { error: '他の人が先に更新しました', code: 'conflict' } };
      }
      const users = await listActiveUsers();

      // 初回（データがまだ無い）は支部などの初期データ投入なので、そのまま受け入れる
      if (!oldDB) {
        return { status: 200, payload: { ok: true, updatedAt: await writeDB(body) } };
      }

      // 送られてきた内容を、その人に見えていなかった分と合成してから権限を確かめる
      const merged = mergeScoped(oldDB, body, req.authUser, users);
      const errs = validateDiff(oldDB, merged, req.authUser, users);
      if (errs.length) {
        console.warn(`権限のない変更を拒否しました（user ${req.authUser.id} / ${req.authUser.role}）:`, errs);
        return { status: 403, payload: { error: errs[0], code: 'forbidden_change', details: errs } };
      }

      /* この中でGoogleへ通信することがあり、その間ほかの保存を待たせてしまう。
         ただし通信が走るのは面談が「確定」に変わった瞬間だけで頻度は低い。
         面談を専用APIへ移す段階で、この呼び出しもそちらへ移すこと */
      await syncInterviewsToGoogle(oldDB, merged, users);
      const updatedAt = await writeDB(merged);

      /* イベントが消えたら、その出欠回答も片付ける。
         残しても画面には出ないが、いつまでも溜まり続けてしまう */
      const newEventIds = new Set((merged.events || []).map((e) => e.id));
      const goneIds = (oldDB.events || []).map((e) => e.id).filter((id) => !newEventIds.has(id));
      for (const id of goneIds) {
        await client.execute({ sql: 'DELETE FROM event_responses WHERE event_id = ?', args: [id] });
      }
      return { status: 200, payload: { ok: true, updatedAt } };
    });
    res.status(result.status).json(result.payload);
  } catch (e) {
    console.error(e);
    invalidateDBCache();
    res.status(500).json({ error: 'db write failed' });
  }
});

/* =========================================================
   一斉に使われる操作の専用API

   これらは PUT /api/db を通さない。DB全体を1行のJSONで保存する仕組みは、
   誰か1人が保存すると他の全員の保存がはじかれるため、
   「配ったあと全員が一斉に押す」種類の操作には耐えられない。
   ここでは触る1行だけを読み書きするので、何人が同時に押しても待ち合わせが起きない。
   ========================================================= */

/* 依頼を送る。スタッフ・支部管理者だけ */
app.post('/api/requests', requireAuth, async (req, res) => {
  const actor = req.authUser;
  if (!['staff', 'branch_admin', 'admin'].includes(actor.role)) {
    return res.status(403).json({ error: '依頼を送れるのはスタッフだけです' });
  }
  const { subject, body, target_label, recipient_ids } = req.body || {};
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: '件名を入力してください' });
  const ids = Array.isArray(recipient_ids) ? recipient_ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'あて先を選んでください' });
  try {
    // あて先は自分の支部の人だけ（全体管理者は制限なし）
    if (actor.role !== 'admin') {
      const users = await listActiveUsers();
      const byId = new Map(users.map((u) => [u.id, u]));
      if (ids.some((id) => byId.get(id)?.branch_id !== actor.branch_id)) {
        return res.status(403).json({ error: '他の支部の方には送れません' });
      }
    }
    const request = {
      id: 'rq_' + crypto.randomBytes(6).toString('hex'),
      sender_id: actor.id, branch_id: actor.branch_id || null,
      subject: String(subject).trim(), body: String(body || ''),
      target_label: target_label || null, recipient_ids: ids,
      created_at: new Date().toISOString(), read_by: [],
    };
    await client.execute({
      sql: `INSERT INTO requests (id, sender_id, branch_id, subject, body, target_label, recipient_ids, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [request.id, request.sender_id, request.branch_id, request.subject,
        request.body, request.target_label, JSON.stringify(ids), request.created_at],
    });
    await insertNotification({
      type: '依頼', branch_id: actor.branch_id || null,
      msg: `${actor.nickname}さんから「${request.subject}」が届きました`,
    });
    res.json({ ok: true, request });
  } catch (e) {
    console.error('依頼の送信に失敗しました', e);
    res.status(500).json({ error: '送信に失敗しました' });
  }
});

/* 依頼を「確認しました」にする。何人が同時に押しても衝突しない。
   二度押しても状態が変わらない（同じ行を上書きするだけ） */
app.post('/api/requests/:id/read', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '依頼が見つかりません' });
    // あて先の人だけが確認できる（見えない依頼に印を付けられないようにする）
    if (!parseIds(row.recipient_ids).includes(actor.id)) {
      return res.status(403).json({ error: 'この依頼のあて先ではありません' });
    }
    const at = new Date().toISOString();
    await client.execute({
      sql: 'INSERT INTO request_reads (request_id, user_id, read_at) VALUES (?,?,?) ON CONFLICT(request_id, user_id) DO NOTHING',
      args: [req.params.id, actor.id, at],
    });
    res.json({ ok: true, read: { user_id: actor.id, at } });
  } catch (e) {
    console.error('依頼の確認に失敗しました', e);
    res.status(500).json({ error: '確認できませんでした' });
  }
});

/* イベントの出欠を答える。同じ答えをもう一度押すと取り消し（従来どおりの操作感） */
app.put('/api/events/:id/response', requireAuth, async (req, res) => {
  const actor = req.authUser;
  const { response } = req.body || {};
  try {
    const db = await readDB();
    const event = (db?.events || []).find((e) => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'イベントが見つかりません' });
    // 自分に見えないイベントには答えられない
    if (!visibleEventsFor(db, actor).some((e) => e.id === event.id)) {
      return res.status(403).json({ error: 'このイベントには回答できません' });
    }
    const cur = await client.execute({
      sql: 'SELECT * FROM event_responses WHERE event_id = ? AND user_id = ?',
      args: [event.id, actor.id],
    });
    const existing = cur.rows[0];
    if (existing && existing.response === response) {
      await client.execute({ sql: 'DELETE FROM event_responses WHERE id = ?', args: [existing.id] });
      return res.json({ ok: true, response: null });
    }
    const saved = {
      id: existing?.id || 'er_' + crypto.randomBytes(6).toString('hex'),
      event_id: event.id, user_id: actor.id, response,
    };
    await client.execute({
      sql: `INSERT INTO event_responses (id, event_id, user_id, response, updated_at) VALUES (?,?,?,?,?)
            ON CONFLICT(event_id, user_id) DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
      args: [saved.id, saved.event_id, saved.user_id, saved.response, new Date().toISOString()],
    });
    res.json({ ok: true, response: saved });
  } catch (e) {
    console.error('出欠の登録に失敗しました', e);
    res.status(500).json({ error: '回答できませんでした' });
  }
});

/* ---------- Googleカレンダー連携 ---------- */
/* 連携用のURLを返す。
   以前はここで直接Googleへリダイレクトしていたが、画面遷移（location.href）では
   Authorizationヘッダが送られないため requireAuth を必ず通れず、
   ボタンを押すとエラーのJSONが表示されるだけになっていた。
   URLだけ返して遷移はフロントに任せることで、認証を通したまま連携できる */
app.get('/api/auth/google/connect-url', requireAuth, (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).json({ error: 'Google連携は未設定です' });
  res.json({ url: google.getAuthUrl(req.authUser.id) });
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
    const isShared = staffId === SHARED_CALENDAR_KEY;
    const existingRow = await getTokenRow(staffId);
    await upsertTokenRow({
      staff_id: staffId,
      access_token: google.encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? google.encrypt(tokens.refresh_token) : existingRow.refresh_token,
      token_expiry: tokenExpiry,
      // 連携し直しても、選んである全体予定表のカレンダーは選び直さずに済むようにする
      calendar_id: isShared ? (existingRow?.calendar_id || 'primary') : 'primary',
      connected_at: new Date().toISOString(),
    });
    if (isShared) {
      /* 全体予定表は読むだけなので push通知（watch）は登録しない。
         通知先はスタッフ個人の「面談できない時間」を書き換える仕組みで、
         共有カレンダーの予定をそこに混ぜてしまうと全員の面談枠が消えてしまう */
      clearSharedCalCache();
      return res.redirect('/?shared_calendar=connected');
    }
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
    if (!row) return res.json({ connected: false, expired: false, enabled: GOOGLE_ENABLED });
    /* 行があるだけでは「連携できている」とは言えない。
       Googleのリフレッシュトークンは、本人がアクセス権を取り消したときや
       同意画面が「テスト中」だった頃に発行されたものだと失効する。
       それに気づけないと、画面には「連携済み」と出ているのに予定が反映されず、
       埋まっているはずの時間にインターン生が予約できてしまう。
       そこで実際にアクセストークンを取り直せるか確かめる。
       期限内のトークンが残っていればGoogleへの通信は起きないので、
       正常な人にとっては今までと変わらない速さで返る */
    let expired = false;
    try {
      await accessTokenFor(row);
    } catch (e) {
      if (e.code === 'REFRESH_REVOKED') expired = true;
      else throw e;
    }
    res.json({ connected: true, expired, enabled: GOOGLE_ENABLED });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '状態取得に失敗しました' });
  }
});

/* =========================================================
   全体予定表（ドットジェイピーの共有カレンダー）
   ---------------------------------------------------------
   仕組み：管理者が取込用アカウントを1つだけ連携し、表示するカレンダーを選ぶ。
   閲覧はサーバーがその1つのトークンで代表して行い、結果を全スタッフに配る。
   こうしておくと、スタッフ個人がGoogleカレンダー連携をしていなくても、
   また共有カレンダーがドメイン内限定の公開であっても、全員が同じ予定を見られる。
   予定はDBに写さず、都度Googleから取ってメモリに短時間だけ置く。
   予定表は元のGoogleカレンダー側で編集されるので、写しを持つと必ず古くなるため。
   ========================================================= */
const SHARED_CAL_TTL_MS = 5 * 60 * 1000;
const sharedCalCache = new Map(); // `${calendarId}|${timeMin}|${timeMax}` -> { at, events }

function clearSharedCalCache() { sharedCalCache.clear(); }

/* 全体予定表を見てよいのはスタッフ側だけ。インターン生には配らない */
function canSeeSharedCalendar(user) {
  return !!user && user.role !== 'intern';
}

app.get('/api/shared-calendar/status', requireAuth, async (req, res) => {
  const canManage = req.authUser.role === 'admin';
  if (!GOOGLE_ENABLED) return res.json({ enabled: false, configured: false, canManage });
  try {
    const row = await getTokenRow(SHARED_CALENDAR_KEY);
    res.json({
      enabled: true,
      canManage,
      connected: !!row,
      // カレンダーを選ぶまでは connected でも配信は始まらない
      configured: !!row && !!row.calendar_id && row.calendar_id !== 'primary',
      calendarId: row?.calendar_id || null,
      calendarName: row?.calendar_name || null,
      visible: canSeeSharedCalendar(req.authUser),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '状態取得に失敗しました' });
  }
});

/* 取込用アカウントの連携を始めるためのURLを返す。ここで選んだGoogleアカウントが
   「全体予定表を読む代表者」になる。スタッフ個人の連携とは別の行に保存される。
   リダイレクトするAPIにせずURLを返すだけにしているのは、画面遷移では
   Authorizationヘッダが送られず認証を通せないため（フロント側で遷移する） */
app.get('/api/shared-calendar/connect-url', requireAuth, requireAdmin, (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).json({ error: 'Google連携は未設定です' });
  res.json({ url: google.getAuthUrl(SHARED_CALENDAR_KEY) });
});

/* 取込用アカウントが見られるカレンダーの一覧。管理者が選ぶためのもの */
app.get('/api/shared-calendar/options', requireAuth, requireAdmin, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).json({ error: 'Google連携は未設定です' });
  try {
    const row = await getTokenRow(SHARED_CALENDAR_KEY);
    if (!row) return res.status(400).json({ error: '先に取込用アカウントを連携してください' });
    const accessToken = await accessTokenFor(row);
    res.json({ calendars: await google.listCalendars(accessToken) });
  } catch (e) {
    if (e.code === 'REFRESH_REVOKED') {
      return res.status(409).json({ error: '取込用アカウントの連携が切れています。連携し直してください。', code: 'revoked' });
    }
    console.error('カレンダー一覧の取得に失敗しました', e);
    res.status(500).json({ error: 'カレンダー一覧の取得に失敗しました' });
  }
});

/* 表示するカレンダーを決める */
app.put('/api/shared-calendar/config', requireAuth, requireAdmin, async (req, res) => {
  const calendarId = String(req.body?.calendar_id || '').trim();
  const calendarName = String(req.body?.calendar_name || '').trim();
  if (!calendarId) return res.status(400).json({ error: 'カレンダーを選んでください' });
  try {
    const row = await getTokenRow(SHARED_CALENDAR_KEY);
    if (!row) return res.status(400).json({ error: '先に取込用アカウントを連携してください' });
    await client.execute({
      sql: 'UPDATE google_tokens SET calendar_id = ?, calendar_name = ? WHERE staff_id = ?',
      args: [calendarId, calendarName || calendarId, SHARED_CALENDAR_KEY],
    });
    clearSharedCalCache();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '保存に失敗しました' });
  }
});

app.post('/api/shared-calendar/disconnect', requireAuth, requireAdmin, async (req, res) => {
  try {
    await deleteTokenRow(SHARED_CALENDAR_KEY);
    clearSharedCalCache();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '解除に失敗しました' });
  }
});

/* スタッフの画面に出す予定を返す。期間はカレンダーで開いている月の前後 */
app.get('/api/shared-calendar/events', requireAuth, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.json({ events: [], configured: false });
  if (!canSeeSharedCalendar(req.authUser)) return res.json({ events: [], configured: false });
  const timeMin = String(req.query.timeMin || '');
  const timeMax = String(req.query.timeMax || '');
  if (!timeMin || !timeMax) return res.status(400).json({ error: '期間の指定が必要です' });
  try {
    const row = await getTokenRow(SHARED_CALENDAR_KEY);
    if (!row || !row.calendar_id || row.calendar_id === 'primary') {
      return res.json({ events: [], configured: false });
    }
    const key = `${row.calendar_id}|${timeMin}|${timeMax}`;
    const hit = sharedCalCache.get(key);
    if (hit && Date.now() - hit.at < SHARED_CAL_TTL_MS) {
      return res.json({ events: hit.events, configured: true, name: row.calendar_name, cached: true });
    }
    const accessToken = await accessTokenFor(row);
    const events = await google.listEventsInRange(accessToken, row.calendar_id, timeMin, timeMax);
    sharedCalCache.set(key, { at: Date.now(), events });
    res.json({ events, configured: true, name: row.calendar_name });
  } catch (e) {
    /* ここで500を返すとカレンダー画面ごと出なくなってしまう。
       全体予定表はあくまで付け足しなので、取れなければ黙って空で返し、
       原因はサーバーのログに残す */
    if (e.code === 'REFRESH_REVOKED' || e.code === 'CALENDAR_UNAVAILABLE') {
      console.warn('全体予定表を取得できません（管理者による設定し直しが必要）', e.message || e);
      return res.json({ events: [], configured: true, error: 'unavailable' });
    }
    console.error('全体予定表の取得に失敗しました', e);
    res.json({ events: [], configured: true, error: 'failed' });
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

    /* Googleは複数のスタッフぶんの通知をほぼ同時に送ってくることがある。
       列に並べないと、後から書いたほうが先の取り込みを消してしまう */
    if (items.length) {
      await withDBLock(async () => {
        const db = await readDBForWrite();
        if (!db) return;
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
      });
    }
  } catch (e) {
    console.error('webhook処理に失敗しました', e);
    invalidateDBCache();
  }
  res.status(200).end();
});

/* 期限が近い（24時間以内）watchチャンネルを再登録する定期ジョブ */
async function renewExpiringWatches() {
  if (!GOOGLE_ENABLED) return;
  try {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rs = await client.execute({
      /* 全体予定表の行は読むだけでwatchを張っていないので、対象から外す。
         外さないと channel_expiration が常にNULLのため毎回登録しようとしてしまう */
      sql: 'SELECT staff_id FROM google_tokens WHERE staff_id <> ? AND (channel_expiration IS NULL OR channel_expiration < ?)',
      args: [SHARED_CALENDAR_KEY, soon],
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
  // 依頼・出欠・通知が store に残っていれば、一度だけ専用テーブルへ移す
  .then(() => migrateStoreToTables())
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
