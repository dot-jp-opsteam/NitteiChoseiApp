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
/* 時計は日本時間で動かす。
   Renderの実行環境はUTCなので、指定しないと「9:00の枠」が UTC の9:00＝日本の18:00
   として作られ、申請ページに出ている時刻と実際の日時が9時間ずれる。
   利用者は全員日本にいるため、サーバー全体を日本時間に固定してしまうのが確実。
   Date を1度でも使う前に決める必要があるので、読み込みより先に置いてある。
   時計を見て日付を組み立てているのは server/slots.js だけ */
process.env.TZ = 'Asia/Tokyo';

const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const express = require('express');
const google = require('./google');
const auth = require('./auth');
const mail = require('./mail');
const sharedCalFilter = require('./shared-cal-filter');
const googleSyncFilter = require('./google-sync-filter');
const slots = require('./slots');
const push = require('./push');
const rateLimit = require('./ratelimit');
const { buildICalendar } = require('./ical');

const PORT = process.env.PORT || 8080;
const GOOGLE_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY && process.env.PUBLIC_BASE_URL);
/* 「Googleでログイン」はカレンダー連携と同じ資格情報を使うが、Google Cloud Console 側に
   ログイン用のリダイレクトURI（/api/auth/google/login/callback）を登録し終えるまでは
   ボタンを押してもGoogleがエラーを返す。設定完了後に GOOGLE_LOGIN_ENABLED=true を
   指定してもらうことで、中途半端に壊れた状態が本番に出ないようにしている。 */
const GOOGLE_LOGIN_ENABLED = GOOGLE_ENABLED && process.env.GOOGLE_LOGIN_ENABLED === 'true';
/* スタッフ登録を許可するメールアドレスのドメイン。ドットジェイピーから配布される
   Googleアカウント（例: reandoro_azuma@dot-jp.or.jp）だけがスタッフになれる */
const STAFF_EMAIL_DOMAIN = process.env.STAFF_EMAIL_DOMAIN || 'dot-jp.or.jp';
/* まっさらなDBに1人だけ作る管理者。ログインはGoogleなので、ここに入れるのは
   「そのGoogleアカウントのメールアドレス」。同じアドレスでGoogleログインすると
   この行に紐づき、管理者として入れる（google.js の login 側で紐付けている） */
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';

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
  /* store の中身を丸ごと取っておく場所。
     引っ越しなど、後戻りしにくい処理の前に原本をここへ複製する。
     元に戻すときは、この data をそのまま store へ書き戻せばよい */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS store_backup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      taken_at TEXT NOT NULL
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
  /* 出欠確認の依頼で使う3列を、あとから足す。
     すでにある本番のテーブルにも同じ形で足したいので ALTER TABLE で追加し、
     2回目以降は「列が既にある」エラーになるだけなので黙って進む。
       kind       … 'normal'（ふつうの依頼）か 'attend'（出欠確認）
       options    … 候補の日時。JSON配列 [{id,start,end}]
       confirmed  … 確定した候補のid。未確定なら null */
  for (const [col, type] of [['kind', 'TEXT'], ['options', 'TEXT'], ['confirmed', 'TEXT'],
    ['event_id', 'TEXT'], ['public_token', 'TEXT'], ['due_date', 'TEXT'], ['due_time', 'TEXT']]) {
    try {
      await client.execute(`ALTER TABLE requests ADD COLUMN ${col} ${type}`);
    } catch (e) {
      /* 既にあるぶんだけを見逃す。SQLiteには IF NOT EXISTS が無いのでこれで判定する。
         どんな失敗も見逃すと、通信が切れただけのときにも列が無いまま起動してしまい、
         原因の分からない不具合になる（下の users への追加と同じ扱いに揃えてある）*/
      if (!/duplicate column/i.test(e.message || '')) throw e;
    }
  }
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
  /* 出欠の回答。読んだ印と同じ考えで、1人1候補につき1行にして衝突を避ける */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS request_responses (
      request_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      response TEXT NOT NULL,        -- 'ok' | 'may' | 'no'
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, option_id, user_id)
    )
  `);
  /* 依頼の削除リスト（自分だけに効く）。1人1依頼につき1行。
     ここに行がある間、その依頼は本人の一覧から常に除外される。
     purgeRequestTrash() が7日後にこの行ごと「あて先から本人を外す」形で完全に消す */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS request_trash (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (request_id, user_id)
    )
  `);
  await client.execute('CREATE INDEX IF NOT EXISTS idx_request_trash_user ON request_trash(user_id)');
  /* 自分のGoogleカレンダーの予定に対する、このアプリだけのローカルな上書き。
     Google側の予定そのものは書き換えず、hidden=1なら表示から外し、
     それ以外は書いてある値でタイトル・時間・場所を上書きして見せる */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS my_calendar_overrides (
      user_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      start TEXT,
      end TEXT,
      all_day INTEGER,
      location TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, google_event_id)
    )
  `);
  /* 公開出欠の回答者。共有URLとは別のキーを持つ人だけが回答を変更できる。
     キーは漏えい時の影響を小さくするため、平文ではなくSHA-256だけを保存する */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS public_attendance_respondents (
      request_id TEXT NOT NULL,
      respondent_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, respondent_id),
      UNIQUE (request_id, key_hash)
    )
  `);
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_public_token ON requests(public_token)');
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
  /* 面談。締切前にインターン生が一斉に申請するため、
     store に置いたままだと大半の申請がはじかれてしまう。
     希望日時など形が固まりきっていない項目は data にJSONでまとめて持つ */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      intern_id TEXT NOT NULL,
      staff_id TEXT,
      branch_id TEXT,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  /* 支部ごとの申請リンクに使う合言葉。
     支部の一覧（/api/branches）はログイン無しで誰でも読めるので、
     store の branches には絶対に入れず、ここへ分けて持つ。
     漏れたときは作り直せばよく、古い合言葉はその時点で通らなくなる */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS branch_invites (
      branch_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT
    )
  `);
  /* iPhone / Googleカレンダーから読む個人用の購読キー。
     URLを設定画面で繰り返し表示する必要があるため、セッションとは分けて保持する。 */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS calendar_subscriptions (
      user_id TEXT PRIMARY KEY,
      subscription_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  /* メール履歴。件数がいちばん増えやすく、store に入れておくと
     関係ない保存のたびに全文を読み書きすることになる */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      receiver_id TEXT,
      subject TEXT,
      body TEXT,
      sent_at TEXT NOT NULL,
      delivered INTEGER
    )
  `);
  /* 古くなった履歴の置き場。消すのではなく移すだけにして、
     必要になったときに取り出せるようにしておく */
  await client.execute(`
    CREATE TABLE IF NOT EXISTS archived_emails (
      id TEXT PRIMARY KEY, sender_id TEXT, receiver_id TEXT,
      subject TEXT, body TEXT, sent_at TEXT NOT NULL, delivered INTEGER,
      archived_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS archived_notifications (
      id TEXT PRIMARY KEY, type TEXT, msg TEXT, branch_id TEXT,
      at TEXT NOT NULL, archived_at TEXT NOT NULL
    )
  `);
  // ブラウザのプッシュ通知の購読先。中身は push.js が受け持つ
  await push.initPushTable(client);
  for (const ddl of [
    'CREATE INDEX IF NOT EXISTS idx_requests_branch ON requests(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_request_reads_user ON request_reads(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_event_responses_event ON event_responses(event_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_branch ON notifications(branch_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_at ON notifications(at)',
    'CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender_id)',
    'CREATE INDEX IF NOT EXISTS idx_emails_receiver ON emails(receiver_id)',
    'CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at)',
    'CREATE INDEX IF NOT EXISTS idx_interviews_intern ON interviews(intern_id)',
    'CREATE INDEX IF NOT EXISTS idx_interviews_staff ON interviews(staff_id)',
    'CREATE INDEX IF NOT EXISTS idx_interviews_branch ON interviews(branch_id)',
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
    if (!process.env.SEED_ADMIN_EMAIL) {
      console.warn(`SEED_ADMIN_EMAIL が未設定です。仮の ${SEED_ADMIN_EMAIL} で初期管理者を作成します。実際に使うGoogleアカウントのメールアドレスを設定して再デプロイしてください。`);
    }
    // パスワードは持たせない。このメールアドレスでGoogleログインした人が管理者になる
    await client.execute({
      sql: `INSERT INTO users (id, email, password_hash, nickname, role, branch_id, status, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: ['u_' + crypto.randomBytes(6).toString('hex'), SEED_ADMIN_EMAIL.toLowerCase(), '', '管理者', 'admin', null, 'active', new Date().toISOString()],
    });
    console.log(`初期管理者アカウントを作成しました（email: ${SEED_ADMIN_EMAIL} / Googleでログインしてください）`);
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

/* store の原本を store_backup へ複製する。
   パースし直したものではなく、保存されている文字列をそのまま写す。
   後戻りしにくい処理を始める前に必ず呼ぶこと。
   ここで失敗したら先へ進んではいけないので、例外はそのまま投げる */
async function backupStore(reason) {
  const rs = await client.execute('SELECT data, updated_at FROM store WHERE id = 1');
  const row = rs.rows[0];
  if (!row) return false;   // まだ何も保存されていない
  await client.execute({
    sql: 'INSERT INTO store_backup (reason, data, updated_at, taken_at) VALUES (?,?,?,?)',
    args: [reason, row.data, row.updated_at, new Date().toISOString()],
  });
  console.log(`storeの原本を退避しました（理由: ${reason} / ${row.data.length}文字 / 元の更新時刻: ${row.updated_at}）`);
  return true;
}

async function migrateStoreToTables() {
  await withDBLock(async () => {
    const db = await readDBForWrite();
    if (!db || db[MIGRATION_FLAG]) return;

    // 消す前に原本を取っておく。失敗したら引っ越しそのものを中止する
    await backupStore('専用テーブルへの引っ越し前');

    let moved = 0;
    for (const rq of db.requests || []) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO requests (id, sender_id, branch_id, subject, body, target_label, recipient_ids, created_at, due_date)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [rq.id, rq.sender_id, rq.branch_id || null, rq.subject || '', rq.body || '',
          rq.target_label || null, JSON.stringify(rq.recipient_ids || []), rq.created_at || new Date().toISOString(),
          rq.due_date || null],
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
    // 面談。支部はインターン生の所属から補う（元データには入っていないことがある）
    const usersForMigration = await listActiveUsers();
    const branchOf = new Map(usersForMigration.map((u) => [u.id, u.branch_id]));
    for (const iv of db.interviews || []) {
      const { id, intern_id, staff_id, branch_id, status, created_at, ...rest } = iv;
      await client.execute({
        sql: `INSERT OR IGNORE INTO interviews (id, intern_id, staff_id, branch_id, status, data, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [id, intern_id, staff_id || null, branch_id || branchOf.get(intern_id) || null,
          status || 'applied', JSON.stringify(rest),
          created_at || new Date().toISOString(), new Date().toISOString()],
      });
      moved++;
    }
    for (const m of db.emails || []) {
      await client.execute({
        sql: 'INSERT OR IGNORE INTO emails (id, sender_id, receiver_id, subject, body, sent_at, delivered) VALUES (?,?,?,?,?,?,?)',
        args: [m.id, m.sender_id || null, m.receiver_id || null, m.subject || '', m.body || '',
          m.sent_at || new Date().toISOString(), m.delivered ? 1 : 0],
      });
      moved++;
    }

    delete db.requests;
    delete db.event_responses;
    delete db.notifications;
    delete db.emails;
    delete db.interviews;
    db[MIGRATION_FLAG] = true;
    await writeDB(db);
    console.log(`依頼・出欠・通知・メール履歴・面談を専用テーブルへ移しました（${moved}件）`);
  });
}

/* ---------- 専用テーブルの読み書き ---------- */
const parseIds = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };

/* request_id で絞って引く。1回のSQLに入れられるプレースホルダには上限があるので、
   多いときは分けて引いて1つにまとめる */
const REQUEST_ID_CHUNK = 500;
async function selectByRequestIds(sql, requestIds) {
  const ids = [...new Set(requestIds || [])];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += REQUEST_ID_CHUNK) {
    const part = ids.slice(i, i + REQUEST_ID_CHUNK);
    const rs = await client.execute({
      sql: `${sql} WHERE request_id IN (${part.map(() => '?').join(',')})`,
      args: part,
    });
    out.push(...rs.rows);
  }
  return out;
}

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
  const trash = await client.execute({ sql: 'SELECT request_id, deleted_at FROM request_trash WHERE user_id = ?', args: [user.id] });
  const trashedAt = new Map(trash.rows.map((t) => [t.request_id, t.deleted_at]));

  /* 付随する3つの表は、その人に見える依頼のぶんだけを引く。
     以前は3つとも全件を読み、取ってからJSで捨てていた。
     依頼が増えるほど、また同時に見る人が増えるほど無駄が積み上がる
     （通知1件で全員が取り直すため、300人規模で顕著になる）*/
  const ids = rows.map((r) => r.id);
  const [reads, answers, publicPeople] = await Promise.all([
    selectByRequestIds('SELECT * FROM request_reads', ids),
    selectByRequestIds('SELECT * FROM request_responses', ids),
    selectByRequestIds('SELECT request_id, respondent_id, display_name, created_at FROM public_attendance_respondents', ids),
  ]);
  const byRequest = new Map();
  for (const r of reads) {
    if (!byRequest.has(r.request_id)) byRequest.set(r.request_id, []);
    byRequest.get(r.request_id).push({ user_id: r.user_id, at: r.read_at });
  }
  const respOf = new Map();
  for (const a of answers) {
    if (!respOf.has(a.request_id)) respOf.set(a.request_id, []);
    respOf.get(a.request_id).push({ option_id: a.option_id, user_id: a.user_id, response: a.response });
  }
  const publicPeopleOf = new Map();
  // 番号の付き方をぶらさないため、登録順にそろえてから見分けを付ける
  for (const p of [...publicPeople].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (!publicPeopleOf.has(p.request_id)) publicPeopleOf.set(p.request_id, []);
    publicPeopleOf.get(p.request_id).push({ id: p.respondent_id, name: p.display_name });
  }
  for (const [rid, list] of publicPeopleOf) publicPeopleOf.set(rid, disambiguateNames(list));
  return rows.map((r) => ({
    id: r.id, sender_id: r.sender_id, branch_id: r.branch_id,
    subject: r.subject, body: r.body, target_label: r.target_label,
    recipient_ids: parseIds(r.recipient_ids), created_at: r.created_at,
    due_date: r.due_date || undefined,
    due_time: r.due_time || undefined,
    read_by: byRequest.get(r.id) || [],
    trashed_at: trashedAt.get(r.id) || null,
    kind: r.kind || 'normal',
    options: safeJson(r.options, []),
    confirmed: r.confirmed || null,
    event_id: r.event_id || null,
    public_url: r.public_token ? `/a/${r.public_token}` : undefined,
    public_respondents: publicPeopleOf.get(r.id) || [],
    responses: respOf.get(r.id) || [],
  }));
}
/* 同じ名前の回答者を見分けられるようにする。
   公開の出欠は名乗るだけで答えられるので、同姓同名も、同じ人が
   別の端末から答えて2人ぶんに増えるのも起こりうる。
   名前がそのままだと集計表に「山田 太郎」が2行並び、どちらが誰か分からない。
   先に答えた人はそのまま、あとの人に（2）（3）…を付ける。
   並びは登録順に固定してあるので、あとから回答が増えても番号は入れ替わらない */
function disambiguateNames(people) {
  const seen = new Map();
  return people.map((p) => {
    const n = (seen.get(p.name) || 0) + 1;
    seen.set(p.name, n);
    return n === 1 ? p : { ...p, name: `${p.name}（${n}）` };
  });
}

/* 壊れたJSONが入っていても画面ごと落とさない */
function safeJson(text, fallback) {
  try { const v = JSON.parse(text || ''); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}

/* 出欠の回答は、その人に見えるイベントのぶんだけ返す。
   以前は全件返しており、他支部のイベントや他人の「自分だけ」の予定に
   誰が答えたかまで配っていた */
async function listEventResponses(visibleEventIds) {
  const ids = [...new Set(visibleEventIds || [])];
  if (!ids.length) return [];
  const rows = [];
  /* SQLiteのプレースホルダには上限があるので、多いときは分けて引く */
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rs = await client.execute({
      sql: `SELECT * FROM event_responses WHERE event_id IN (${part.map(() => '?').join(',')})`,
      args: part,
    });
    rows.push(...rs.rows);
  }
  return rows.map((r) => ({ id: r.id, event_id: r.event_id, user_id: r.user_id, response: r.response }));
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

/* ---------- 古い履歴の片付け ----------
   メール履歴と通知は放っておくと際限なく増える。
   一定より古いものはアーカイブ用のテーブルへ移す。
   消さずに移すだけなので、後から必要になっても取り出せる。 */
const ARCHIVE_AFTER_DAYS = 183;   // およそ6ヶ月。ドットジェイピーの期の区切りに合わせている
const ARCHIVE_BATCH = 1000;       // 一度に動かす上限。起動を遅くしないため小分けにする

async function archiveOldRecords() {
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const archivedAt = new Date().toISOString();
  let total = 0;
  try {
    for (const t of [
      { from: 'emails', to: 'archived_emails', dateCol: 'sent_at',
        cols: 'id, sender_id, receiver_id, subject, body, sent_at, delivered' },
      { from: 'notifications', to: 'archived_notifications', dateCol: 'at',
        cols: 'id, type, msg, branch_id, at' },
    ]) {
      // 移してから消す。順番が逆だと、途中で失敗したときに記録そのものが消えてしまう
      const ins = await client.execute({
        sql: `INSERT OR IGNORE INTO ${t.to} (${t.cols}, archived_at)
              SELECT ${t.cols}, ? FROM ${t.from} WHERE ${t.dateCol} < ? LIMIT ${ARCHIVE_BATCH}`,
        args: [archivedAt, cutoff],
      });
      const moved = Number(ins.rowsAffected || 0);
      if (moved) {
        await client.execute({
          sql: `DELETE FROM ${t.from} WHERE ${t.dateCol} < ? AND id IN (SELECT id FROM ${t.to})`,
          args: [cutoff],
        });
        total += moved;
      }
    }
    if (total) console.log(`${ARCHIVE_AFTER_DAYS}日より古い履歴を${total}件アーカイブしました`);
  } catch (e) {
    // 片付けに失敗してもアプリの動作には影響しないので、記録だけ残して続行する
    console.error('古い履歴の片付けに失敗しました', e);
  }
  return total;
}

/* 不成立の面談は、一覧に残り続けると邪魔になる。1週間たったものは自動で消す。
   不成立の面談はGoogleカレンダーへ予定を作っていないので、消してもカレンダー側に影響はない */
const FAILED_INTERVIEW_KEEP_DAYS = 7;

async function deleteOldFailedInterviews() {
  const cutoff = new Date(Date.now() - FAILED_INTERVIEW_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const del = await client.execute({
      sql: `DELETE FROM interviews WHERE status = 'failed' AND updated_at < ?`,
      args: [cutoff],
    });
    const removed = Number(del.rowsAffected || 0);
    if (removed) console.log(`不成立から${FAILED_INTERVIEW_KEEP_DAYS}日たった面談を${removed}件削除しました`);
  } catch (e) {
    console.error('不成立の面談の自動削除に失敗しました', e);
  }
}

/* 削除リストにある依頼を「本人だけあて先から外す」形で完全に消す。
   依頼そのものは送った人・他のあて先には残るので、行き先はこの1行だけ。
   recipient_ids に無い（管理者が削除した等）場合は何もしない=安全に空振りする */
async function purgeRequestTrashRows(rows) {
  let removed = 0;
  for (const { request_id, user_id } of rows) {
    try {
      const rs = await client.execute({ sql: 'SELECT recipient_ids FROM requests WHERE id = ?', args: [request_id] });
      const row = rs.rows[0];
      if (row) {
        const ids = parseIds(row.recipient_ids).filter((id) => id !== user_id);
        await client.execute({
          sql: 'UPDATE requests SET recipient_ids = ? WHERE id = ?',
          args: [JSON.stringify(ids), request_id],
        });
        await client.execute({ sql: 'DELETE FROM request_reads WHERE request_id = ? AND user_id = ?', args: [request_id, user_id] });
        await client.execute({ sql: 'DELETE FROM request_responses WHERE request_id = ? AND user_id = ?', args: [request_id, user_id] });
      }
      await client.execute({ sql: 'DELETE FROM request_trash WHERE request_id = ? AND user_id = ?', args: [request_id, user_id] });
      removed++;
    } catch (e) {
      console.error(`削除リストの完全削除に失敗しました（request ${request_id} / user ${user_id}）`, e);
    }
  }
  return removed;
}

/* 期限の切れたセッションと、使い終わった／期限切れのパスワード再設定を片付ける。
   これまでは、そのセッションで誰かがアクセスしてきたときにだけ消えていたので、
   二度と使われないまま残り続ける行が溜まっていた。
   期限が切れている＝もう通らないので、消してよい */
async function purgeExpiredSessions() {
  const now = new Date().toISOString();
  try {
    const del = await client.execute({ sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now] });
    const removed = Number(del.rowsAffected || 0);
    if (removed) console.log(`期限切れのセッションを${removed}件片付けました`);
  } catch (e) {
    console.error('期限切れセッションの片付けに失敗しました', e);
  }
  /* パスワードによるログインは廃止したので、この表にはもう書き込まない。
     残っている行を片付けるためだけに残してある */
  try {
    await client.execute({ sql: 'DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', args: [now] });
  } catch (e) {
    console.error('期限切れの再設定の片付けに失敗しました', e);
  }
}

/* 削除リストへ移してから7日たったものを、毎日まとめて完全削除する */
const REQUEST_TRASH_KEEP_DAYS = 7;

async function purgeOldRequestTrash() {
  const cutoff = new Date(Date.now() - REQUEST_TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const rs = await client.execute({ sql: 'SELECT request_id, user_id FROM request_trash WHERE deleted_at < ?', args: [cutoff] });
    if (!rs.rows.length) return;
    const removed = await purgeRequestTrashRows(rs.rows.map((r) => ({ request_id: r.request_id, user_id: r.user_id })));
    if (removed) console.log(`削除リストで${REQUEST_TRASH_KEEP_DAYS}日たった依頼を${removed}件完全削除しました`);
  } catch (e) {
    console.error('削除リストの自動削除に失敗しました', e);
  }
}

/* 面談。テーブルの列とJSON部分を、画面が期待する1つの形に戻す */
function rowToInterview(r) {
  let data = {};
  try { data = JSON.parse(r.data) || {}; } catch { /* 壊れていても他の列は返す */ }
  return {
    ...data,
    id: r.id, intern_id: r.intern_id, staff_id: r.staff_id,
    branch_id: r.branch_id, status: r.status, created_at: r.created_at,
  };
}
/* インターン生は自分の面談だけ。スタッフ・支部管理者も自分が担当するものだけ
   （同じ支部でも他のスタッフの面談は見せない。2026-08-10 変更）*/
async function listInterviewsFor(user, users) {
  if (user.role === 'admin') {
    const rs = await client.execute('SELECT * FROM interviews');
    return rs.rows.map(rowToInterview);
  }
  if (user.role === 'intern') {
    const rs = await client.execute({ sql: 'SELECT * FROM interviews WHERE intern_id = ?', args: [user.id] });
    return rs.rows.map(rowToInterview);
  }
  const rs = await client.execute({ sql: 'SELECT * FROM interviews WHERE staff_id = ?', args: [user.id] });
  return rs.rows.map(rowToInterview);
}
async function getInterview(id) {
  const rs = await client.execute({ sql: 'SELECT * FROM interviews WHERE id = ?', args: [id] });
  return rs.rows[0] ? rowToInterview(rs.rows[0]) : null;
}
async function saveInterview(iv) {
  const { id, intern_id, staff_id, branch_id, status, created_at, ...rest } = iv;
  await client.execute({
    sql: `INSERT INTO interviews (id, intern_id, staff_id, branch_id, status, data, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET staff_id = excluded.staff_id, branch_id = excluded.branch_id,
            status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
    args: [id, intern_id, staff_id || null, branch_id || null, status,
      JSON.stringify(rest), created_at, new Date().toISOString()],
  });
  return iv;
}

/* メール履歴は当事者だけが読める（送った人・受け取った人）。
   以前は全員が全員分の本文を読めていた */
async function listEmailsFor(user) {
  const rs = user.role === 'admin'
    ? await client.execute('SELECT * FROM emails')
    : await client.execute({
      sql: 'SELECT * FROM emails WHERE sender_id = ? OR receiver_id = ?',
      args: [user.id, user.id],
    });
  return rs.rows.map((r) => ({
    id: r.id, sender_id: r.sender_id, receiver_id: r.receiver_id,
    subject: r.subject, body: r.body, sent_at: r.sent_at, delivered: !!r.delivered,
  }));
}

/* 候補の日時を「9/12(土) 19:00〜21:00」の形にする。
   利用者は全員日本にいるので、サーバーの時間帯に関係なく日本時間で出す。
   end_time が無い候補（終了時刻の入力欄を廃止したあとの新しい候補）は開始だけになる */
function fmtSlotJP(o) {
  if (o?.has_date === false) {
    return `${o.start_time || ''}${o.end_time ? '〜' + o.end_time : ''}（日程未定）`;
  }
  const f = (iso, opts) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...opts })
    .format(new Date(iso));
  const day = f(o.start, { month: 'numeric', day: 'numeric', weekday: 'short' });
  if (o?.has_time === false) return day;
  const from = f(o.start, { hour: '2-digit', minute: '2-digit', hour12: false });
  const to = o.end_time ? f(o.end, { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return `${day} ${from}${to ? '〜' + to : ''}`;
}

function validAttendDate(value) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!hit) return false;
  const utc = Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]));
  const d = new Date(utc);
  return d.getUTCFullYear() === Number(hit[1])
    && d.getUTCMonth() + 1 === Number(hit[2])
    && d.getUTCDate() === Number(hit[3]);
}

function todayInJapan() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function normalizeDueDate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !validAttendDate(value) || value < todayInJapan()) return undefined;
  return value;
}

/* 締切の時刻。日付が無いときは時刻だけ残っても意味がないので落とす。
   今日の過ぎた時刻はあえて弾かない（送る直前に日付をまたぐことがあり、
   そこで送信そのものを止めてしまうと打ち直しになる） */
function normalizeDueTime(value, dueDate) {
  if (value == null || value === '' || !dueDate) return null;
  if (typeof value !== 'string' || !validAttendTime(value)) return undefined;
  return value;
}

function validAttendTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizeAttendOption(raw, id) {
  const o = raw || {};
  const isLegacy = o.has_date == null && o.has_time == null && o.start;
  if (isLegacy) {
    const start = new Date(o.start);
    const end = o.end ? new Date(o.end) : new Date(start.getTime() + 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
    return { id, start: start.toISOString(), end: end.toISOString(), has_date: true, has_time: true };
  }

  const hasDate = o.has_date !== false;
  const hasTime = o.has_time === true;
  if (!hasDate && !hasTime) return null;
  const date = String(o.date || '');
  const startTime = String(o.start_time || '');
  // 終了時刻の入力欄は廃止した。指定があれば従来どおり検証して保存するが、
  // 無くても候補として成立させる（過去のデータとの後方互換のため、あれば表示する）
  const endTimeRaw = o.end_time == null ? '' : String(o.end_time);
  if (hasDate && !validAttendDate(date)) return null;
  if (hasTime && !validAttendTime(startTime)) return null;
  if (hasTime && endTimeRaw && (!validAttendTime(endTimeRaw) || endTimeRaw <= startTime)) return null;

  const normalized = { id, has_date: hasDate, has_time: hasTime };
  if (hasDate) normalized.date = date;
  if (hasTime) {
    normalized.start_time = startTime;
    if (endTimeRaw) normalized.end_time = endTimeRaw;
  }
  if (hasDate) {
    normalized.start = new Date(`${date}T${hasTime ? startTime : '01:00'}:00+09:00`).toISOString();
    if (!hasTime) {
      normalized.end = new Date(`${date}T01:30:00+09:00`).toISOString();
    } else if (endTimeRaw) {
      normalized.end = new Date(`${date}T${endTimeRaw}:00+09:00`).toISOString();
    } else {
      // 終了時刻が無いときは、確定時にGoogleカレンダーへ登録するための内部値として
      // 開始の1時間後を既定にする。end_time が無いぶん、表示（fmtSlot/fmtSlotJP）には出ない
      normalized.end = new Date(new Date(normalized.start).getTime() + 60 * 60 * 1000).toISOString();
    }
  }
  return normalized;
}

/* 出欠確認を、あて先ひとりずつのメール履歴にも残す。
   依頼の一覧を見ていない人が、メール画面からでも気づけるようにするため。
   実際の送信はしないので delivered は 0（画面では「アプリ内の記録のみ」と出る） */
async function recordAttendMails(actor, request) {
  const url = request.public_url || `${process.env.PUBLIC_BASE_URL || ''}/?req=${encodeURIComponent(request.id)}`;
  const lines = [
    `${actor.nickname}さんから出欠確認が届きました。`,
    '',
    ...(request.body ? [request.body, ''] : []),
    '【日程の候補】',
    ...request.options.map((o, i) => `  ${i + 1}. ${fmtSlotJP(o)}`),
    '',
    '下のリンクを開くと、候補ごとに ○△× で答えられます。',
    url,
  ];
  const body = lines.join('\n');
  const sentAt = new Date().toISOString();
  /* あて先の数だけ行が増えるが、1人1行にしないと「自分あて」で絞り込めない。
     古い履歴は183日でアーカイブ用テーブルへ移るので、際限なく溜まることはない */
  for (const receiverId of request.recipient_ids) {
    if (receiverId === actor.id) continue;
    await client.execute({
      sql: 'INSERT INTO emails (id, sender_id, receiver_id, subject, body, sent_at, delivered) VALUES (?,?,?,?,?,?,?)',
      args: ['ml_' + crypto.randomBytes(6).toString('hex'), actor.id, receiverId,
        `【出欠確認】${request.subject}`, body, sentAt, 0],
    });
  }
}

/* 通知は依頼の送信などに付随して積まれる。専用APIの中から呼ぶ。
   画面側が積まれた通知をその場で表示できるよう、作った1件を返す */
async function insertNotification({ type, msg, branch_id }) {
  const row = {
    id: 'nt_' + crypto.randomBytes(6).toString('hex'),
    type: type || null, msg: msg || '', branch_id: branch_id || null,
    at: new Date().toISOString(),
  };
  await client.execute({
    sql: 'INSERT INTO notifications (id, type, msg, branch_id, at) VALUES (?,?,?,?,?)',
    args: [row.id, row.type, row.msg, row.branch_id, row.at],
  });
  /* つながっている画面へ「更新があった」ことを押し出す。
     呼び出し側ではなくここに置いているのは、通知を積む場所が増えても
     送り忘れが起きないようにするため（設計書 3.3）。
     送れなくても本筋の保存は済んでいるので、失敗しても先へ進む */
  try { stream.broadcast(row.branch_id, { type: row.type || '' }); }
  catch (e) { console.warn('更新の押し出しに失敗しました', e); }
  return row;
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
const stream = require('./stream');

/* 同じ出欠確認を二重クリック・再送で同時確定しても、副作用を1回だけにする。
   Renderの単一Nodeプロセス内で確定処理を順番に通し、列に入った後でconfirmedを読み直す。 */
let attendanceConfirmChain = Promise.resolve();
function withAttendanceConfirmLock(fn) {
  const run = attendanceConfirmChain.then(fn, fn);
  attendanceConfirmChain = run.then(() => undefined, () => undefined);
  return run;
}

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
/* ユーザーを消すときは、その人にひもづく物も一緒に片付ける。
   以前は users と sessions しか消しておらず、いちばん問題なのは google_tokens で、
   消したはずの人のGoogleカレンダーへ入れる鍵がサーバーに残り続けていた。
   端末の通知先・カレンダー購読の合鍵も、放っておくと消した人へ届き続ける。

   面談・依頼・メール履歴は消さない。担当していた記録はスタッフ側が使うため
   （インターン生のアカウント廃止のときと同じ判断）。 */
async function deleteUserRow(id) {
  await client.execute({ sql: 'DELETE FROM users WHERE id=?', args: [id] });
  await client.execute({ sql: 'DELETE FROM sessions WHERE user_id=?', args: [id] });

  /* Googleカレンダーへのアクセス権。watchを張ったままだと通知も届き続けるので、
     消す前に止めておく（止められなくても、鍵を消すことのほうが大事なので先へ進む） */
  try {
    const tokenRow = await getTokenRow(id);
    if (tokenRow && tokenRow.channel_id) {
      const accessToken = await accessTokenFor(tokenRow);
      await google.stopWatch(accessToken, tokenRow.channel_id, tokenRow.resource_id);
    }
  } catch (e) {
    console.warn(`退会時のwatch停止に失敗しました（user ${id}）`, e.message || e);
  }

  for (const sql of [
    'DELETE FROM google_tokens WHERE staff_id=?',
    'DELETE FROM push_subscriptions WHERE user_id=?',
    'DELETE FROM calendar_subscriptions WHERE user_id=?',
    'DELETE FROM my_calendar_overrides WHERE user_id=?',
    'DELETE FROM request_trash WHERE user_id=?',
  ]) {
    try { await client.execute({ sql, args: [id] }); }
    catch (e) { console.warn(`退会時の片付けに失敗しました（${sql}）`, e.message || e); }
  }

  /* store 側（1行JSON）に残る本人の設定も落とす。
     読む→変える→書く なので鍵で囲む */
  try {
    await withDBLock(async () => {
      const db = await readDBForWrite();
      if (!db) return;
      let changed = false;
      if (db.availability && db.availability[id]) { delete db.availability[id]; changed = true; }
      if (db.profiles && db.profiles[id]) { delete db.profiles[id]; changed = true; }
      if (changed) await writeDB(db);
    });
  } catch (e) {
    console.warn(`退会時の設定の片付けに失敗しました（user ${id}）`, e.message || e);
    invalidateDBCache();
  }
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
    /* インターン生のログインは廃止した。ここで止めるのは、
       残っているセッションやGoogleログインなど、入口が複数あるため。
       1か所にまとめておけば、塞ぎ忘れが起きない */
    if (user.role === 'intern') {
      return res.status(401).json({
        error: 'インターン生のログインは不要になりました。支部の担当者から届いた申請用リンクをお使いください。',
        code: 'unauthenticated',
      });
    }
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

/* ---------- 面談確定/取消をGoogleカレンダーへ反映 ----------
   確定した面談は、担当スタッフ・インターン生それぞれが個別にGoogle連携していれば
   両者のカレンダーに独立してイベントを作成する（片方だけの連携でも動作する） */
const IV_GOOGLE_SYNC_TARGETS = [
  { userIdField: 'staff_id', eventIdField: 'googleEventId', summary: (intern) => `面談: ${intern ? intern.nickname : ''}さん` },
  { userIdField: 'intern_id', eventIdField: 'googleEventIdIntern', summary: (intern, staff) => `面談: ${staff ? staff.nickname : ''}さんと` },
];

/* 確定を取り消す／別日時で確定し直すと、古いGoogleイベントは
   deleteGoogleEventFor が実際に削除する。しかし、そのイベントが一度でも
   webhook経由で「外部の予定」として不可時間（availability.blocks）に
   取り込まれていた場合、Google側の削除だけではそのブロックは消えず、
   もう存在しない予定が不可時間に残り続けてしまう。
   （2026-08-10 発見。本番データに30件超のこの手のブロックが蓄積していた） */
async function removeExternalGoogleBlock(userId, googleEventId) {
  if (!userId || !googleEventId) return;
  try {
    await withDBLock(async () => {
      const db = await readDBForWrite();
      if (!db) return;
      const av = db.availability && db.availability[userId];
      if (!av || !av.blocks || !av.blocks.length) return;
      const next = googleSyncFilter.removeBlocksByEventId(av.blocks, googleEventId);
      if (next.length === av.blocks.length) return; // 該当なし。書き込みを増やさない
      db.availability[userId] = { ...av, blocks: next };
      await writeDB(db);
    });
  } catch (e) {
    console.warn(`不可時間ブロックの削除に失敗しました（user ${userId}, event ${googleEventId}）`, e.message || e);
  }
}

async function deleteGoogleEventFor(userId, eventId) {
  if (!userId || !eventId) return;
  try {
    const tokenRow = await getTokenRow(userId);
    if (tokenRow) {
      const accessToken = await accessTokenFor(tokenRow);
      await google.deleteEvent(accessToken, tokenRow.calendar_id, eventId);
    }
  } catch (e) {
    console.warn(`Googleイベント削除に失敗しました（user ${userId}, event ${eventId}）`, e.message || e);
  }
  /* Google側の削除が（未連携などの理由で）できなくても、こちらのブロックは
     掃除する。ここで諦めると、確定を取り消すたびに不可時間へゴミが積み上がる */
  await removeExternalGoogleBlock(userId, eventId);
}

/* 面談1件ぶんの同期。確定に変わったら作り、確定でなくなったら消す。
   iv を書き換えて googleEventId を持たせるので、呼び出し側はこのあと保存すること */
async function syncInterviewToGoogle(old, iv, users) {
  if (!GOOGLE_ENABLED) return iv;
  const wasFixed = old && old.status === 'fixed';
  const isFixed = iv.status === 'fixed';
  const intern = (users || []).find((u) => u.id === iv.intern_id);
  const staff = (users || []).find((u) => u.id === iv.staff_id);

  for (const t of IV_GOOGLE_SYNC_TARGETS) {
    const userId = iv[t.userIdField];
    try {
      if (!wasFixed && isFixed && iv.confirmed_datetime) {
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
          description: 'OPS日調アプリで確定した面談です。',
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
  return iv;
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

  /* インターン先マスタは支部ごとの持ち物。
     2026-08-05に画面と操作は取り除いたが、中身は消していないので読み出しは残す */
  const internships = (obj.internships || []).filter((p) => p.branch_id === branchId);

  // プロフィール（所属部署）は自支部のメンバーの分だけ
  const profiles = {};
  for (const [id, p] of Object.entries(obj.profiles || {})) {
    if (id === user.id || inBranch(id)) profiles[id] = p;
  }

  return { ...obj, events, availability, internships, profiles };
}

/* 絞り込んだデータを受け取ったクライアントが書き戻してきたとき、
   その人には見えていなかった分を元のデータから戻して1つに合成する。
   これをしないと、見えていないデータが保存のたびに消えてしまう */
/* 専用テーブルへ移した項目。PUT /api/db から送られてきても採用しない。
   古い画面を開いたままのタブが、テーブル側の最新の内容を
   自分の持っている古い一覧で上書きしてしまうのを防ぐ */
const TABLE_BACKED_KEYS = ['requests', 'event_responses', 'notifications', 'emails', 'interviews'];

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
  for (const key of ['events']) {
    const visibleIds = new Set((visible[key] || []).map((x) => x.id));
    const hidden = (oldDB[key] || []).filter((x) => !visibleIds.has(x.id));
    merged[key] = [...hidden, ...(clientDB[key] || [])];
  }
  if (isAdmin) return merged;

  /* インターン先マスタ。見えていなかった他支部の分を戻したうえで、
     送られてきた分をそのまま採用する。ここで黙って捨てず validateDiff へ届けるのは、
     403で「機能は終了しました」と伝えるため。黙って捨てると、
     登録できたつもりで消えている状態になり、以前直した不具合と同じことが起きる */
  {
    const visibleIds = new Set((visible.internships || []).map((p) => p.id));
    const hidden = (oldDB.internships || []).filter((p) => !visibleIds.has(p.id));
    merged.internships = [...hidden, ...(clientDB.internships || [])];
  }

  /* プロフィールは、その人に見えていた範囲（自分＋自支部）だけを差し替える。
     他人の分は validateDiff が403で弾く。ここで黙って捨てないのは、
     保存できたつもりで消えている状態を作らないため。
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
function validateDiff(oldDB, newDB, actor) {
  const errs = [];
  const isAdmin = actor.role === 'admin';

  // ---- 支部：全体管理者のみ ----
  if (!isAdmin && !sameJSON(oldDB.branches, newDB.branches)) {
    errs.push('支部を変更できるのは全体管理者だけです');
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
      if (prev.creator_id !== actor.id) errs.push('このイベントを編集する権限がありません');
      else if (actor.role === 'intern' && !isPrivate) errs.push('インターン生が作れるのは「自分だけ」の予定だけです');
      /* 作成した後で支部や作成者を書き換えられると、新規作成時の確認をすり抜けて
         他支部のカレンダーへ予定を差し込んだり、別人の作った予定に見せかけたりできる。
         編集のときも新規と同じ条件で確かめる */
      else if (ev.creator_id !== prev.creator_id) errs.push('予定の作成者は変更できません');
      else if (!isAdmin && !isPrivate && ev.branch_id !== actor.branch_id) {
        errs.push('他の支部のイベントには変更できません');
      }
    }
  }
  const removedEventIds = new Set([...oldEv.keys()].filter((id) => !newEv.has(id)));
  for (const id of removedEventIds) {
    const prev = oldEv.get(id);
    if (prev.creator_id !== actor.id) errs.push('このイベントを削除する権限がありません');
  }

  // ---- 空き日程：自分の分だけ ----
  const avKeys = new Set([...Object.keys(oldDB.availability || {}), ...Object.keys(newDB.availability || {})]);
  for (const key of avKeys) {
    if (key === actor.id || isAdmin) continue;
    if (!sameJSON((oldDB.availability || {})[key], (newDB.availability || {})[key])) {
      errs.push('他の人の空き時間は変更できません');
    }
  }

  /* 依頼・出欠・通知・メール履歴はここでは検証しない。専用テーブルへ移し、
     それぞれの専用APIの中で権限を確かめている */

  /* ---- インターン先マスタ：2026-08-05に受け付けをやめた ----
     インターン生がアカウントを持たなくなり、使われない機能になったため、
     画面と操作を取り除いた。ここは「古いタブが開いたままの人」からの
     書き込みを止める役。中身そのものは消していないので、
     いま入っているものは読み出せるまま残る */
  if (!sameJSON(oldDB.internships || [], newDB.internships || [])) {
    errs.push('インターン先の機能は終了しました');
  }

  /* ---- プロフィール：自分の分だけ。ほかの人の分は誰も代わりに触れない ---- */
  const profKeys = new Set([...Object.keys(oldDB.profiles || {}), ...Object.keys(newDB.profiles || {})]);
  for (const key of profKeys) {
    if (isAdmin || key === actor.id) continue;
    const before = (oldDB.profiles || {})[key];
    const after = (newDB.profiles || {})[key];
    if (sameJSON(before, after)) continue;
    errs.push('他の人のプロフィールは変更できません');
  }

  return [...new Set(errs)];
}

const app = express();
/* Renderは前段のプロキシ越しに届くので、これを言っておかないと
   req.protocol が http のままになり、URLを組み立てるところ
   （招待URL・購読URLなど）が http:// で出てしまう。
   なお回数制限の相手の見分けにはこれを当てにしていない（下の clientKey を参照）*/
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

/* 全部の応答に付ける守りの指定。
   nosniff … 中身を見て型を推測させない（テキストをスクリプトとして実行されるのを防ぐ）
   DENY    … 他所のページの枠の中にこのアプリを埋め込ませない。
             埋め込めると、透明にして上に重ね、押させたいボタンを押させることができる
   Referrer-Policy … 出欠の共有URLなど、URL自体が合鍵になっているページから
             外部リンクを踏んだときに、そのURLを相手へ渡さない */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* 回数を数えるときの「相手」の見分け方。

   req.ip をそのまま使うと、本番では数えられない。Renderは前段のプロキシが
   複数あり、trust proxy の数え方だとその**プロキシ側**のアドレスを拾ってしまう。
   プロキシは要求ごとに替わるので、毎回ちがう相手として数えられ、
   いくら叩いても上限に達しない（2026-08-12に本番で実測。ローカルでは
   プロキシが無いため正しく効いており、この差で見落としていた）。

   そこで X-Forwarded-For の**先頭**＝実際の利用者のアドレスを直接見る。
   この値は利用者が偽れるので、その気になれば制限を抜けられる。
   ただし抜けて得られるのは「自分の枠を増やす」ことだけで、
   他人を締め出すことはできない。ここで止めたいのは機械で延々と叩く動きなので、
   この作りで足りる（厳密にやるなら認証を求めることになり、
   ログイン不要という前提そのものと両立しない）。 */
function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const first = xff.split(',')[0].trim();
  return first || req.ip || (req.socket && req.socket.remoteAddress) || '';
}

/* ログイン不要の入口の回数制限。1分あたりの回数で、環境変数で加減できる。
   0 を指定すると制限しない（試験で大量に叩くときに使う）。
   書き込みは行が増えるので厳しく、読み取りは画面を開き直すだけなので緩くしてある */
const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));
const PUBLIC_WRITE_PER_MIN = num(process.env.PUBLIC_WRITE_PER_MIN, 20);
const PUBLIC_READ_PER_MIN = num(process.env.PUBLIC_READ_PER_MIN, 120);
const limitPublicWrite = rateLimit.limiter('public-write', PUBLIC_WRITE_PER_MIN, clientKey);
const limitPublicRead = rateLimit.limiter('public-read', PUBLIC_READ_PER_MIN, clientKey);

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* 更新をリアルタイムで押し出す（SSE）。
   ブラウザ標準の EventSource は Authorization ヘッダを付けられず、
   このアプリは Cookie を使わない方針（auth.js 冒頭）なので、
   画面側は fetch のストリーム読み取りで受ける。形式は SSE のまま（設計書 3.2）。

   このサーバーには圧縮ミドルウェアを入れていないので、途中で溜め込まれる心配はない。
   念のため X-Accel-Buffering でも止めてある */
app.get('/api/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const c = stream.addClient(res, req.authUser);
  stream.startHeartbeat();
  req.on('close', () => stream.removeClient(c));
});

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

/* パスワードによるログインと会員登録は廃止した。
   入口はGoogleアカウントの1本だけで、パスワードそのものを扱わない。
   - スタッフ：/staff で @dot-jp.or.jp のGoogleアカウントを確認して登録（下の staff-signup）
   - インターン生：アカウント自体が不要。支部ごとの合言葉リンク（/i/<合言葉>）から申請する
   users.password_hash 列と password_resets テーブルは、既存のDBを壊さないため残してあるが
   もう読み書きしていない。 */

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
    // 面談の確定・不成立メールを実際に送れるか。管理者の「システム設定」に出す
    mailSend: mail.MAIL_ENABLED,
    staffEmailDomain: STAFF_EMAIL_DOMAIN,
    /* ブラウザのプッシュ通知。公開鍵は名前のとおり誰に見られてもよいもので、
       これが無いと画面側が購読を作れないため boot と一緒に配る */
    push: push.PUSH_ENABLED,
    pushPublicKey: push.PUSH_ENABLED ? push.PUBLIC_KEY : '',
  };
}
app.get('/api/auth/config', (req, res) => res.json(authConfig()));

/* ---------- ブラウザのプッシュ通知 ----------
   購読は端末ごとに1つ。オンオフも端末ごとに持つ（push.js の頭のコメント参照）。
   どの口も自分の購読しか触れない */
app.post('/api/push/state', requireAuth, async (req, res) => {
  if (!push.PUSH_ENABLED) return res.json({ enabled: false, found: false });
  try {
    const state = await push.getSubscriptionState(client, req.authUser.id, (req.body || {}).endpoint);
    res.json({ enabled: true, ...state });
  } catch (e) {
    console.error('通知設定の取得に失敗しました', e);
    res.status(500).json({ error: '通知設定を読み込めませんでした' });
  }
});
app.put('/api/push/subscribe', requireAuth, async (req, res) => {
  if (!push.PUSH_ENABLED) return res.status(503).json({ error: '通知はいま使えません' });
  try {
    const saved = await push.saveSubscription(client, req.authUser.id, req.body || {});
    if (!saved) return res.status(400).json({ error: '購読情報が正しくありません' });
    res.json({ ok: true, ...saved });
  } catch (e) {
    console.error('通知の登録に失敗しました', e);
    res.status(500).json({ error: '通知を登録できませんでした' });
  }
});
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    await push.removeSubscription(client, req.authUser.id, (req.body || {}).endpoint);
    res.json({ ok: true });
  } catch (e) {
    console.error('通知の解除に失敗しました', e);
    res.status(500).json({ error: '通知を解除できませんでした' });
  }
});

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
    Object.assign(db, await readTableBacked(user, db.events));
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
        /* 初めての人はインターン生として行だけ作る。この役のままでは
           requireAuth に弾かれて何もできないが、管理者のユーザー管理に
           姿が出るので、そこでスタッフへ変えれば使えるようになる。
           @dot-jp.or.jp を持たない人（外部の協力者・個人のGmail）を
           迎え入れる道はこれしかないため、塞がないこと。
           2026-08-12に一度塞いだが、この経路が要るとの判断で戻した */
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

/* パスワードの変更・再設定のAPIはここにあったが、パスワードそのものを扱わなくなったため削除した。
   ログインできなくなった人への対応は、管理者がユーザー管理からアカウントを直すか、
   Googleアカウント側の問題なので、このアプリの外で解決する。 */

/* ---------- 管理者：スタッフ登録URL ----------
   秘密キー付きの招待URLは廃止。@dot-jp.or.jp のGoogleアカウントを持っている人だけが
   登録できるため、URL自体は誰に知られても問題ない */
app.get('/api/admin/staff-invite-url', requireAuth, requireBranchAdmin, (req, res) => {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/staff`, domain: STAFF_EMAIL_DOMAIN });
});

/* ---------- スタッフ：インターン生を招くURL ----------
   支部ごとに1本のURL。同じ支部のスタッフは全員これを配る。
   以前は「自分のIDを付けた個人ごとのURL」だったが、インターン生の会員登録を
   廃止したため、登録先ではなく申請ページの入口になった。

   合言葉は推測できない長さにしてある。配布先が広いぶん漏れることも想定し、
   作り直せるようにしてある（作り直すと古いURLはその場で通らなくなる）。 */

/* 支部の合言葉を引く。まだ無ければ作って返す。
   支部を作るたびに用意するのは忘れやすいので、最初に必要になった時点で用意する */
async function getOrCreateBranchInvite(branchId, createdBy) {
  const rs = await client.execute({
    sql: 'SELECT token FROM branch_invites WHERE branch_id = ?',
    args: [String(branchId)],
  });
  if (rs.rows[0]) return rs.rows[0].token;
  const token = crypto.randomBytes(24).toString('hex');
  await client.execute({
    sql: 'INSERT INTO branch_invites (branch_id, token, created_at, created_by) VALUES (?,?,?,?)',
    args: [String(branchId), token, new Date().toISOString(), createdBy || null],
  });
  return token;
}

/* スタッフが自分の支部の申請URLを見る。
   admin は支部を持たないことがあるので、その場合は支部を指定してもらう */
app.get('/api/staff/intern-invite-url', requireAuth, async (req, res) => {
  const me = req.authUser;
  if (!['staff', 'branch_admin', 'admin'].includes(me.role)) {
    return res.status(403).json({ error: 'インターン生を招けるのはスタッフだけです' });
  }
  // 他支部のURLを覗けないよう、admin 以外は自分の支部に固定する
  const branchId = me.role === 'admin' ? (req.query.branch_id || me.branch_id) : me.branch_id;
  if (!branchId) return res.status(400).json({ error: '支部が設定されていません' });
  try {
    const token = await getOrCreateBranchInvite(branchId, me.id);
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${base}/i/${token}`, branch_id: branchId });
  } catch (e) {
    console.error('支部の申請URLの取得に失敗しました', e);
    res.status(500).json({ error: '取得に失敗しました' });
  }
});

/* 申請URLを作り直す。漏れたときの唯一の対処なので、支部管理者以上に限る。
   古い合言葉は消すので、配り直すまで誰も申請できなくなる点に注意 */
app.post('/api/staff/intern-invite-url/regenerate', requireAuth, requireBranchAdmin, async (req, res) => {
  const me = req.authUser;
  const branchId = me.role === 'admin' ? (req.body?.branch_id || me.branch_id) : me.branch_id;
  if (!branchId) return res.status(400).json({ error: '支部が設定されていません' });
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await client.execute({
      sql: `INSERT INTO branch_invites (branch_id, token, created_at, created_by) VALUES (?,?,?,?)
            ON CONFLICT(branch_id) DO UPDATE SET token = excluded.token,
              created_at = excluded.created_at, created_by = excluded.created_by`,
      args: [String(branchId), token, new Date().toISOString(), me.id],
    });
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${base}/i/${token}`, branch_id: branchId });
  } catch (e) {
    console.error('支部の申請URLの作り直しに失敗しました', e);
    res.status(500).json({ error: '作り直しに失敗しました' });
  }
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

/* 担当スタッフの引き継ぎAPI（PATCH /api/staff/interns/:id）はここにあったが、
   呼び出し元の「担当一覧」画面を撤去したため削除した。
   担当の付け替えはユーザー管理（/api/admin/users）から行う。 */
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

    /* 履歴は専用テーブルに1行足すだけ。以前は store 全体を読み書きしており、
       同時に送ると片方の履歴が消えていた */
    const record = {
      id: 'ml_' + crypto.randomBytes(4).toString('hex'),
      sender_id: actor.id, receiver_id, subject: String(subject).trim(),
      body: String(body || ''), sent_at: new Date().toISOString(), delivered: sent,
    };
    await client.execute({
      sql: 'INSERT INTO emails (id, sender_id, receiver_id, subject, body, sent_at, delivered) VALUES (?,?,?,?,?,?,?)',
      args: [record.id, record.sender_id, record.receiver_id, record.subject,
        record.body, record.sent_at, record.delivered ? 1 : 0],
    });
    res.json({ ok: true, sent, warning, email: record });
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
    if (!obj) return res.json({ users: scopeUsers(users, req.authUser), ...await readTableBacked(req.authUser, []) });
    const scoped = scopeDBForUser(obj, req.authUser, users);
    scoped.users = scopeUsers(users, req.authUser);
    // 専用テーブルへ移した分を合成する。画面から見える形は今までと同じ
    Object.assign(scoped, await readTableBacked(req.authUser, scoped.events));
    res.json(scoped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db read failed' });
  }
});

/* 専用テーブルへ移した項目を、フロントが期待するキー名で返す。
   scopedEvents は、その人に見えるイベント（出欠の回答をそこへ絞るために使う） */
async function readTableBacked(user, scopedEvents) {
  const eventIds = (scopedEvents || []).map((e) => e.id);
  const [requests, event_responses, notifications, emails, interviews] = await Promise.all([
    listRequestsFor(user), listEventResponses(eventIds), listNotificationsFor(user),
    listEmailsFor(user), listInterviewsFor(user),
  ]);
  return { requests, event_responses, notifications, emails, interviews };
}

/* インターン生には、面談の申し込み先として必要な自支部のスタッフだけを見せる。
   全支部の全ユーザー一覧を配る必要はない */
function scopeUsers(users, actor) {
  const list = actor.role !== 'intern'
    ? users
    : users.filter((u) => u.id === actor.id
      || (u.branch_id === actor.branch_id && (u.role === 'staff' || u.role === 'branch_admin')));
  return list.map((u) => scrubEmail(u, actor));
}

/* メールアドレスは、必要な人にだけ渡す。
   以前は全スタッフのブラウザへ全員分のアドレスが配られていた。
   画面で要るのは (1) 自分のもの、(2) ユーザー管理で扱う相手のもの、
   (3) 面談メールの宛先確認 の3つで、いずれも管理者・支部管理者か本人に限られる。
   ふつうのスタッフが他人のアドレスを見る画面は無い */
function canSeeEmailOf(actor, target) {
  if (target.id === actor.id) return true;
  if (actor.role === 'admin') return true;
  if (actor.role === 'branch_admin') return target.branch_id === actor.branch_id;
  return false;
}
function scrubEmail(u, actor) {
  if (canSeeEmailOf(actor, u)) return u;
  const { email, ...rest } = u;
  return rest;
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
      const errs = validateDiff(oldDB, merged, req.authUser);
      if (errs.length) {
        console.warn(`権限のない変更を拒否しました（user ${req.authUser.id} / ${req.authUser.role}）:`, errs);
        return { status: 403, payload: { error: errs[0], code: 'forbidden_change', details: errs } };
      }

      /* Googleカレンダーへの反映は面談の専用APIへ移したので、ここでは通信しない。
         この区間は列に並んでいるため、待たせる処理を置かないこと */
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
  const { subject, body, target_label, recipient_ids, kind, options, public_access, due_date, due_time } = req.body || {};
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: '件名を入力してください' });
  const dueDate = normalizeDueDate(due_date);
  if (dueDate === undefined) return res.status(400).json({ error: '締切日が正しくありません' });
  const dueTime = normalizeDueTime(due_time, dueDate);
  if (dueTime === undefined) return res.status(400).json({ error: '締切の時刻が正しくありません' });
  /* 出欠確認のときは候補の日時が要る。候補は画面から来た値をそのまま信じず、
     日時として読める形かどうかをここで確かめる */
  const isAttend = kind === 'attend';
  const isPublic = isAttend && public_access === true;
  let ids = Array.isArray(recipient_ids) ? recipient_ids.filter(Boolean) : [];
  /* 出欠確認は送信者自身も回答者になる。公開モードは対象者が決まっていないため、
     アプリ内の固定あて先は送信者だけにする */
  ids = isPublic
    ? [actor.id]
    : [...new Set(isAttend ? [...ids, actor.id] : ids)];
  if (!ids.length) return res.status(400).json({ error: 'あて先を選んでください' });
  let opts = [];
  if (isAttend) {
    opts = (Array.isArray(options) ? options : [])
      .map((o, i) => normalizeAttendOption(o, 'op' + i));
    if (!opts.length) return res.status(400).json({ error: '候補の日時を1件以上追加してください' });
    if (opts.length > 30) return res.status(400).json({ error: '候補は30件までです' });
    if (opts.some((o) => !o)) {
      return res.status(400).json({ error: '候補の日時が正しくありません' });
    }
  }
  try {
    // あて先は自分の支部の人だけ（全体管理者は制限なし）
    if (actor.role !== 'admin') {
      const users = await listActiveUsers();
      const byId = new Map(users.map((u) => [u.id, u]));
      if (ids.some((id) => byId.get(id)?.branch_id !== actor.branch_id)) {
        return res.status(403).json({ error: '他の支部の方には送れません' });
      }
    }
    const publicToken = isPublic ? crypto.randomBytes(32).toString('base64url') : null;
    const request = {
      id: 'rq_' + crypto.randomBytes(6).toString('hex'),
      sender_id: actor.id, branch_id: actor.branch_id || null,
      subject: String(subject).trim(), body: String(body || ''),
      target_label: target_label || null, recipient_ids: ids,
      created_at: new Date().toISOString(), read_by: [],
      due_date: dueDate || undefined,
      due_time: dueTime || undefined,
      kind: isAttend ? 'attend' : 'normal', options: opts, confirmed: null, event_id: null,
      public_url: publicToken
        ? `${process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`}/a/${publicToken}`
        : undefined,
      responses: [],
    };
    await client.execute({
      sql: `INSERT INTO requests (id, sender_id, branch_id, subject, body, target_label, recipient_ids, created_at, kind, options, public_token, due_date, due_time)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [request.id, request.sender_id, request.branch_id, request.subject,
        request.body, request.target_label, JSON.stringify(ids), request.created_at,
        request.kind, JSON.stringify(opts), publicToken, dueDate, dueTime],
    });
    /* 出欠確認は、あて先ひとりずつのメール履歴にも残す。
       依頼の一覧を見ていない人でも、メール画面から気づけるようにするため。
       delivered は 0（＝アプリ内の記録のみ）。実際の送信はしていない */
    if (isAttend) await recordAttendMails(actor, request);

    const notification = await insertNotification({
      type: isAttend ? '出欠確認' : '依頼', branch_id: actor.branch_id || null,
      msg: isAttend
        ? `${actor.nickname}さんから出欠確認「${request.subject}」が届きました`
        : `${actor.nickname}さんから「${request.subject}」が届きました`,
    });
    /* 端末の通知欄にも出す。送った本人は ids に含まれる（出欠は自分も回答者）ので、
       自分の送信で自分の端末が鳴らないよう外しておく */
    push.sendToUsers(client, ids.filter((id) => id !== actor.id), 'request', {
      title: isAttend ? '参加確認が届きました' : '依頼が届きました',
      body: `${actor.nickname}さんから「${request.subject}」`,
      url: `/?req=${encodeURIComponent(request.id)}`, tag: 'request',
    }).catch((e) => console.warn('依頼の通知に失敗しました', e));
    res.json({ ok: true, request, notification });
  } catch (e) {
    console.error('依頼の送信に失敗しました', e);
    res.status(500).json({ error: '送信に失敗しました' });
  }
});

/* 公開出欠の共有URLを知っている人へ、回答に必要な最小限だけを返す。
   メールアドレス・支部のメンバー一覧など、出欠と無関係な情報は含めない */
app.get('/api/attendance/:token', limitPublicRead, async (req, res) => {
  try {
    const rs = await client.execute({
      sql: `SELECT r.*, u.nickname AS sender_name
              FROM requests r LEFT JOIN users u ON u.id = r.sender_id
             WHERE r.public_token = ? AND r.kind = 'attend'`,
      args: [String(req.params.token || '')],
    });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '出欠確認が見つかりません' });

    const [guestRows, answerRows, users] = await Promise.all([
      client.execute({
        sql: `SELECT respondent_id, display_name FROM public_attendance_respondents
               WHERE request_id = ? ORDER BY created_at`,
        args: [row.id],
      }),
      client.execute({ sql: 'SELECT option_id, user_id, response FROM request_responses WHERE request_id = ?', args: [row.id] }),
      listActiveUsers(),
    ]);
    const names = new Map(users.map((u) => [u.id, u.nickname]));
    /* 名乗るだけで答えられるので、同姓同名や同じ人の二重登録が起こりうる。
       登録順に見分けを付けてから名前として使う（disambiguateNames のコメント参照）*/
    for (const g of disambiguateNames(guestRows.rows.map((r) => ({ id: r.respondent_id, name: r.display_name })))) {
      names.set(g.id, g.name);
    }
    const grouped = new Map();
    for (const a of answerRows.rows) {
      if (!names.has(a.user_id)) continue;
      if (!grouped.has(a.user_id)) grouped.set(a.user_id, []);
      grouped.get(a.user_id).push({ option_id: a.option_id, response: a.response });
    }
    const respondents = [...grouped.entries()].map(([id, answers]) => ({
      id, name: names.get(id), answers,
    }));
    res.json({
      request: {
        id: row.id, subject: row.subject, body: row.body || '', sender_name: row.sender_name || '',
        options: safeJson(row.options, []), confirmed: row.confirmed || null,
        created_at: row.created_at, due_date: row.due_date || undefined,
        due_time: row.due_time || undefined,
      },
      respondents,
    });
  } catch (e) {
    console.error('公開出欠の取得に失敗しました', e);
    res.status(500).json({ error: '出欠確認を取得できませんでした' });
  }
});

/* アカウントを持たない人の公開回答。初回だけ回答者キーを発行し、
   2回目以降はそのキーのハッシュが一致したときだけ同じ回答を更新する */
app.put('/api/attendance/:token/response', limitPublicWrite, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const suppliedKey = String(req.body?.respondent_key || '');
  if (!name) return res.status(400).json({ error: 'お名前を入力してください' });
  if (name.length > 50) return res.status(400).json({ error: 'お名前が長すぎます' });
  try {
    const rs = await client.execute({
      sql: `SELECT * FROM requests WHERE public_token = ? AND kind = 'attend'`,
      args: [String(req.params.token || '')],
    });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '出欠確認が見つかりません' });
    if (row.confirmed) return res.status(409).json({ error: 'すでに日程が確定しています' });

    const options = safeJson(row.options, []);
    const optionIds = new Set(options.map((o) => o.id));
    const cleanAnswers = answers.filter((a) => a && optionIds.has(a.option_id)
      && ['ok', 'may', 'no'].includes(a.response));
    if (!cleanAnswers.length) return res.status(400).json({ error: '回答を選択してください' });

    let respondentId;
    let respondentKey = suppliedKey;
    const at = new Date().toISOString();
    if (suppliedKey) {
      const found = await client.execute({
        sql: `SELECT respondent_id FROM public_attendance_respondents
               WHERE request_id = ? AND key_hash = ?`,
        args: [row.id, auth.hashToken(suppliedKey)],
      });
      if (!found.rows[0]) return res.status(403).json({ error: '回答者キーが正しくありません' });
      respondentId = found.rows[0].respondent_id;
      await client.execute({
        sql: 'UPDATE public_attendance_respondents SET display_name = ?, updated_at = ? WHERE request_id = ? AND respondent_id = ?',
        args: [name, at, row.id, respondentId],
      });
    } else {
      respondentKey = crypto.randomBytes(24).toString('base64url');
      respondentId = 'guest_' + crypto.randomBytes(12).toString('base64url');
      await client.execute({
        sql: `INSERT INTO public_attendance_respondents
                (request_id, respondent_id, key_hash, display_name, created_at, updated_at)
              VALUES (?,?,?,?,?,?)`,
        args: [row.id, respondentId, auth.hashToken(respondentKey), name, at, at],
      });
    }

    const saved = [];
    for (const a of cleanAnswers) {
      await client.execute({
        sql: `INSERT INTO request_responses (request_id, option_id, user_id, response, updated_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(request_id, option_id, user_id)
              DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
        args: [row.id, a.option_id, respondentId, a.response, at],
      });
      saved.push({ option_id: a.option_id, response: a.response });
    }
    res.json({
      ok: true, respondent_key: respondentKey,
      respondent: { id: respondentId, name }, saved,
    });
  } catch (e) {
    console.error('公開出欠の回答保存に失敗しました', e);
    res.status(500).json({ error: '回答を保存できませんでした' });
  }
});

/* 通常依頼を「完了」にする。何人が同時に押しても衝突しない。
   二度押しても状態が変わらない（同じ行を上書きするだけ） */
app.post('/api/requests/:id/read', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '依頼が見つかりません' });
    if ((row.kind || 'normal') !== 'normal') {
      return res.status(400).json({ error: '出欠確認は完了の対象ではありません' });
    }
    // あて先の人だけが完了できる（見えない依頼に印を付けられないようにする）
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
    console.error('依頼の完了に失敗しました', e);
    res.status(500).json({ error: '完了できませんでした' });
  }
});

/* 完了を取り消す。複合主キーで本人の1行だけを消すため、他の人の状態には触れない。
   行がすでに無い再送も成功として扱い、通信の再試行で画面を止めない */
app.delete('/api/requests/:id/read', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '依頼が見つかりません' });
    if ((row.kind || 'normal') !== 'normal') {
      return res.status(400).json({ error: '出欠確認は完了の対象ではありません' });
    }
    if (!parseIds(row.recipient_ids).includes(actor.id)) {
      return res.status(403).json({ error: 'この依頼のあて先ではありません' });
    }
    await client.execute({
      sql: 'DELETE FROM request_reads WHERE request_id = ? AND user_id = ?',
      args: [req.params.id, actor.id],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('依頼の完了取り消しに失敗しました', e);
    res.status(500).json({ error: '完了を取り消せませんでした' });
  }
});

/* 依頼を削除リストへ移す。自分だけに効く（あて先の他の人・送った本人には見え続ける）。
   通常依頼・出欠確認のどちらも対象。管理者は recipient_ids に無くても全件が見えるため、
   あて先チェックは管理者だけ免除する */
app.post('/api/requests/:id/trash', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '依頼が見つかりません' });
    if (actor.role !== 'admin' && !parseIds(row.recipient_ids).includes(actor.id)) {
      return res.status(403).json({ error: 'この依頼のあて先ではありません' });
    }
    const at = new Date().toISOString();
    await client.execute({
      sql: 'INSERT INTO request_trash (request_id, user_id, deleted_at) VALUES (?,?,?) ON CONFLICT(request_id, user_id) DO UPDATE SET deleted_at=excluded.deleted_at',
      args: [req.params.id, actor.id, at],
    });
    res.json({ ok: true, trashed_at: at });
  } catch (e) {
    console.error('依頼の削除に失敗しました', e);
    res.status(500).json({ error: '削除できませんでした' });
  }
});

/* 削除リストから元に戻す。request_trash の行を消すだけで、依頼本体には触れない */
app.post('/api/requests/:id/restore', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    await client.execute({
      sql: 'DELETE FROM request_trash WHERE request_id = ? AND user_id = ?',
      args: [req.params.id, actor.id],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('削除リストからの復元に失敗しました', e);
    res.status(500).json({ error: '元に戻せませんでした' });
  }
});

/* 削除リストを空にする。自分の行だけを対象に、7日を待たず今すぐ完全削除する */
app.post('/api/requests/trash/empty', requireAuth, async (req, res) => {
  try {
    const rs = await client.execute({ sql: 'SELECT request_id FROM request_trash WHERE user_id = ?', args: [req.authUser.id] });
    await purgeRequestTrashRows(rs.rows.map((r) => ({ request_id: r.request_id, user_id: req.authUser.id })));
    res.json({ ok: true });
  } catch (e) {
    console.error('削除リストを空にできませんでした', e);
    res.status(500).json({ error: '削除リストを空にできませんでした' });
  }
});

/* 出欠確認に答える。候補ごとに1行なので、何人が同時に押しても衝突しない。
   まとめて送れるようにしてあるのは、○△×を1つずつ通信すると
   候補が10件あれば10往復になり、電波の悪い場所で取りこぼすため */
app.put('/api/requests/:id/response', requireAuth, async (req, res) => {
  const actor = req.authUser;
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '出欠確認が見つかりません' });
    if (row.kind !== 'attend') return res.status(400).json({ error: 'これは出欠確認ではありません' });
    // 送った本人も含めて、あて先の人だけが答えられる
    const ids = parseIds(row.recipient_ids);
    if (!ids.includes(actor.id) && row.sender_id !== actor.id) {
      return res.status(403).json({ error: 'この出欠確認のあて先ではありません' });
    }
    if (row.confirmed) return res.status(409).json({ error: 'すでに日程が確定しています' });
    // 候補にない id や、決められた3つ以外の答えは受け取らない
    let opts = [];
    try { opts = JSON.parse(row.options || '[]'); } catch (e) { opts = []; }
    const okIds = new Set(opts.map((o) => o.id));
    const at = new Date().toISOString();
    const saved = [];
    for (const a of answers) {
      if (!a || !okIds.has(a.option_id) || !['ok', 'may', 'no'].includes(a.response)) continue;
      await client.execute({
        sql: `INSERT INTO request_responses (request_id, option_id, user_id, response, updated_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(request_id, option_id, user_id)
              DO UPDATE SET response = excluded.response, updated_at = excluded.updated_at`,
        args: [req.params.id, a.option_id, actor.id, a.response, at],
      });
      saved.push({ request_id: req.params.id, option_id: a.option_id, user_id: actor.id, response: a.response, updated_at: at });
    }
    res.json({ ok: true, saved });
  } catch (e) {
    console.error('出欠の保存に失敗しました', e);
    res.status(500).json({ error: '回答を保存できませんでした' });
  }
});

/* 日程を確定する。送った本人だけ。確定した日時で予定を1件作り、
   答えてくれた人へ通知を出す */
app.post('/api/requests/:id/confirm', requireAuth, async (req, res) => withAttendanceConfirmLock(async () => {
  const actor = req.authUser;
  const optionId = req.body?.option_id;
  /* 「日程調整」は候補段階ですでに○△×を集めているので、確定後の予定で
     もう一度取り直す必要が無い（votable:false）。一方「出欠確認」は候補が
     最初から1件で、確定した瞬間が答える機会そのものなので、そこだけは
     引き続き○△×を受け付ける（votable:true）。呼び出し側がどちらの操作かを
     申告する */
  const keepVotable = req.body?.keep_votable === true;
  try {
    const rs = await client.execute({ sql: 'SELECT * FROM requests WHERE id = ?', args: [req.params.id] });
    const row = rs.rows[0];
    if (!row) return res.status(404).json({ error: '出欠確認が見つかりません' });
    if (row.kind !== 'attend') return res.status(400).json({ error: 'これは出欠確認ではありません' });
    if (row.sender_id !== actor.id && actor.role !== 'admin') {
      return res.status(403).json({ error: '確定できるのは送った本人だけです' });
    }
    if (row.confirmed) return res.status(409).json({ error: 'すでに日程が確定しています' });
    let opts = [];
    try { opts = JSON.parse(row.options || '[]'); } catch (e) { opts = []; }
    const picked = opts.find((o) => o.id === optionId);
    if (!picked) return res.status(400).json({ error: '候補が見つかりません' });

    /* 日付がない候補は、時刻の希望だけを決めるものなので予定にはしない。 */
    let event = null;
    if (picked.has_date !== false) {
      /* 予定はstore側（1行JSON）に持っているので、読む→足す→書くを鍵で囲む。
         囲まないと、同時に別の予定が作られたときにどちらかが消える */
      event = {
        id: 'ev_' + crypto.randomBytes(6).toString('hex'),
        title: row.subject,
        description: picked.has_time === false ? '' : (row.body || ''),
        has_time: picked.has_time !== false,
        start_datetime: picked.start,
        end_datetime: picked.end,
        location: '', branch_id: row.branch_id, visibility: 'branch',
        color: '#56b8ac', creator_id: actor.id, meet_url: '', zoom_url: '',
        created_at: new Date().toISOString(),
        votable: keepVotable,
      };
      await withDBLock(async () => {
        const db = await readDBForWrite();
        db.events = [...(db.events || []), event];
        await writeDB(db);
      });

      /* 出欠を送った本人がGoogle連携済みなら、同じ予定を本人のカレンダーにも作る。
         Google側の失敗でアプリ内の確定まで取り消さない。 */
      if (GOOGLE_ENABLED) {
        try {
          const tokenRow = await getTokenRow(actor.id);
          if (tokenRow) {
            const accessToken = await accessTokenFor(tokenRow);
            await google.createEvent(accessToken, tokenRow.calendar_id || 'primary', {
              summary: row.subject,
              start: { dateTime: picked.start, timeZone: 'Asia/Tokyo' },
              end: { dateTime: picked.end, timeZone: 'Asia/Tokyo' },
              ...(picked.has_time === false ? { reminders: { useDefault: false } } : {}),
            });
          }
        } catch (e) {
          console.warn(`出欠確定のGoogleカレンダー登録に失敗しました（request ${row.id}）`, e.message || e);
        }
      }
    }
    await client.execute({
      sql: 'UPDATE requests SET confirmed = ?, event_id = ? WHERE id = ?',
      args: [optionId, event?.id || null, req.params.id],
    });
    const notification = await insertNotification({
      type: '出欠確認', branch_id: row.branch_id || null,
      msg: `「${row.subject}」の日程が確定しました`,
    });
    res.json({ ok: true, confirmed: optionId, event, notification });
  } catch (e) {
    console.error('日程の確定に失敗しました', e);
    res.status(500).json({ error: '確定できませんでした' });
  }
}));

/* 通知を積む。面談の申請・確定やイベント作成に付随して呼ばれる。
   支部は本人の所属で固定する（他支部あてに流し込めないようにするため） */
app.post('/api/notifications', requireAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ ok: true, added: 0 });
  // 一度にたくさん送られても困るので上限を設ける
  if (items.length > 20) return res.status(400).json({ error: '一度に積める通知が多すぎます' });
  try {
    const added = [];
    for (const it of items) {
      if (!it || !it.msg) continue;
      added.push(await insertNotification({ type: it.type, msg: String(it.msg), branch_id: req.authUser.branch_id || null }));
    }
    res.json({ ok: true, added });
  } catch (e) {
    console.error('通知の記録に失敗しました', e);
    res.status(500).json({ error: '通知を記録できませんでした' });
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

/* ---------- アカウント無しの面談申請（支部リンク経由） ----------
   ここだけはログインを求めない。インターン生に登録の手間をかけないため。
   合言葉を知っていることが唯一の入場条件なので、
   合言葉から支部を割り出し、その支部の外へは一切手が届かないようにする。 */

/* 合言葉から支部を引く。見つからなければ null。
   有効・無効の判断はここ1か所に集約し、各APIで書き分けない */
async function branchByInviteToken(token) {
  if (!token || typeof token !== 'string') return null;
  const rs = await client.execute({
    sql: 'SELECT branch_id FROM branch_invites WHERE token = ?',
    args: [token],
  });
  if (!rs.rows[0]) return null;
  const branchId = rs.rows[0].branch_id;
  const obj = await readDB();
  const branch = (obj?.branches || []).find((b) => b.id === branchId);
  // 支部そのものが消されていたら、リンクは無効として扱う
  return branch ? { id: branchId, name: branch.name } : null;
}

/* 申請ページの最初の読み込み。支部名と、選べるスタッフの一覧を返す。
   返すのは表示に要る分だけ。メールアドレスや権限は渡さない */
app.get('/api/apply/:token', limitPublicRead, async (req, res) => {
  try {
    const branch = await branchByInviteToken(req.params.token);
    if (!branch) return res.status(404).json({ error: 'このリンクは使えません。支部の担当者に確認してください' });
    const rs = await client.execute({
      sql: `SELECT id, nickname FROM users
            WHERE branch_id = ? AND status = 'active' AND role IN ('staff','branch_admin')
            ORDER BY nickname`,
      args: [branch.id],
    });
    res.json({
      branch: { name: branch.name },
      staff: rs.rows.map((r) => ({ id: r.id, nickname: r.nickname })),
    });
  } catch (e) {
    console.error('申請ページの読み込みに失敗しました', e);
    res.status(500).json({ error: '読み込めませんでした' });
  }
});

/* 指定スタッフが選んでいる担当可能な相手か確かめたうえで、材料を集める。
   スタッフ選択・枠取得・申請の3か所で同じ確認が要るのでまとめてある */
async function applyContextFor(token, staffId) {
  const branch = await branchByInviteToken(token);
  if (!branch) return { error: 'このリンクは使えません。支部の担当者に確認してください', code: 404 };
  const rs = await client.execute({
    sql: `SELECT id, nickname, branch_id FROM users
          WHERE id = ? AND status = 'active' AND role IN ('staff','branch_admin')`,
    args: [String(staffId || '')],
  });
  const staff = rs.rows[0];
  // 他支部のスタッフを指定されても、合言葉の支部の外は認めない
  if (!staff || staff.branch_id !== branch.id) {
    return { error: 'このスタッフは選べません', code: 400 };
  }
  const obj = await readDB();
  const availability = (obj?.availability || {})[staff.id] || {};
  const ivs = await client.execute({
    sql: `SELECT * FROM interviews WHERE staff_id = ? AND status = 'fixed'`,
    args: [staff.id],
  });
  const takenMs = ivs.rows.map(rowToInterview)
    .map((iv) => new Date(iv.confirmed_datetime).getTime());
  return { branch, staff, availability, takenMs };
}

/* 選んだスタッフの空き枠を、今日から1週間ぶんの表として返す。
   画面はこれを並べるだけにして、枠の判断はサーバーだけが持つ */
app.get('/api/apply/:token/slots', limitPublicRead, async (req, res) => {
  try {
    const ctx = await applyContextFor(req.params.token, req.query.staff_id);
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });
    res.json(slots.generateWeekGrid(ctx.availability, ctx.takenMs, req.query.week));
  } catch (e) {
    console.error('空き枠の取得に失敗しました', e);
    res.status(500).json({ error: '取得できませんでした' });
  }
});

/* 本名だけで面談を申請する。
   アカウントを作らないので、intern_id は空にして名前を data に持たせる */
app.post('/api/apply/:token', limitPublicWrite, async (req, res) => {
  const { name, staff_id, choices, note, all_day } = req.body || {};
  const internName = String(name || '').trim();
  if (!internName) return res.status(400).json({ error: 'お名前を入力してください' });
  if (internName.length > 50) return res.status(400).json({ error: 'お名前が長すぎます' });

  /* 続いた30分枠は画面上でひとつの希望にまとまるが、送られてくるのは枠のままなので
     件数ではなく枠数で数える。「終日OK」で1日28枠になるため、
     見られる範囲（3週間ぶん）をすべて終日OKにしても通る幅を取ってある。
     そのうえで、際限なく送りつけられないよう上限は設ける */
  const list = [...new Set((Array.isArray(choices) ? choices : []).filter(Boolean).map(String))];
  if (!list.length) return res.status(400).json({ error: '希望する枠を選んでください' });
  if (list.length > 600) return res.status(400).json({ error: '希望する枠が多すぎます。絞ってください' });

  /* 「終日OK」で選んだ日（YYYY-MM-DD）。
     途中に埋まった時間があっても希望をひとまとめに見せるために使う。
     表示のための印なので、ここでは形だけ整えて中身は信じない */
  const allDay = [...new Set((Array.isArray(all_day) ? all_day : [])
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(0, 40);

  try {
    const ctx = await applyContextFor(req.params.token, staff_id);
    if (ctx.error) return res.status(ctx.code).json({ error: ctx.error });

    /* 画面を細工されても、埋まっている枠や受付時間外を掴まされないようにする。
       1つでも通らなければ、選び直してもらう */
    const ok = slots.selectableTimes(ctx.availability, ctx.takenMs);
    for (const iso of list) {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t) || !ok.has(t)) {
        return res.status(409).json({ error: '選んだ枠が埋まりました。選び直してください' });
      }
    }

    const iv = {
      id: 'iv_' + crypto.randomBytes(6).toString('hex'),
      intern_id: '',                 // アカウントが無いので空。名前で判別する
      intern_name: internName,
      staff_id: ctx.staff.id,
      branch_id: ctx.branch.id,
      status: 'applied',
      choices: list,
      all_day: allDay,
      // 旧項目にも入れておく（この変更を巻き戻しても申請が読めるようにする保険）
      choice1: list[0], choice2: list[1] || null, choice3: list[2] || null,
      confirmed_datetime: null,
      note: String(note || '').trim().slice(0, 500),
      created_at: new Date().toISOString(),
    };
    await saveInterview(iv);
    await insertNotification({
      type: '面談申請', branch_id: ctx.branch.id,
      msg: `${internName}さんが面談を申請しました`,
    });
    /* 端末の通知欄にも出す。届くのは担当に選ばれたスタッフだけ。
       申請の保存はもう済んでいるので、送れなくても申請は成立させる */
    push.sendToUsers(client, [ctx.staff.id], 'interview', {
      title: '面談の申請が届きました',
      body: `${internName}さんから面談の申請が届きました`,
      url: '/', tag: 'interview',
    }).catch((e) => console.warn('面談申請の通知に失敗しました', e));
    res.json({ ok: true, staff_nickname: ctx.staff.nickname });
  } catch (e) {
    console.error('面談の申請に失敗しました', e);
    res.status(500).json({ error: '申請できませんでした' });
  }
});

/* 旧・ログインした状態からの面談申請。
   インターン生のログインを廃止したため、この入口は誰も通れなくなった。
   古い画面が残っている端末に、行き先を案内できるように残してある */
app.post('/api/interviews', (req, res) => {
  return res.status(410).json({
    error: '申請の方法が変わりました。支部の担当者から届いた申請用リンクをお使いください。',
  });
});

/* 面談の状態を変える（確定・不成立・申請中に戻す）。スタッフ側だけ */
app.patch('/api/interviews/:id', requireAuth, async (req, res) => {
  const actor = req.authUser;
  if (!['staff', 'branch_admin', 'admin'].includes(actor.role)) {
    return res.status(403).json({ error: '面談を変更する権限がありません' });
  }
  const { status, confirmed_datetime } = req.body || {};
  if (!['fixed', 'failed', 'applied'].includes(status)) {
    return res.status(400).json({ error: '指定された状態が不正です' });
  }
  if (status === 'fixed' && !confirmed_datetime) {
    return res.status(400).json({ error: '確定する日時が必要です' });
  }
  try {
    const old = await getInterview(req.params.id);
    if (!old) return res.status(404).json({ error: '面談が見つかりません' });
    if (actor.role !== 'admin' && old.staff_id !== actor.id) {
      return res.status(403).json({ error: '自分が担当する面談だけ変更できます' });
    }
    const next = {
      ...old, status,
      confirmed_datetime: status === 'fixed' ? confirmed_datetime : null,
    };
    /* Googleへの反映を先に済ませてから保存する。
       先に保存すると、通信に失敗したときイベントIDを取りこぼす */
    const users = await listActiveUsers();
    await syncInterviewToGoogle(old, next, users);
    await saveInterview(next);

    let notification = null;
    if (old.status !== status && (status === 'fixed' || status === 'failed')) {
      const intern = users.find((u) => u.id === next.intern_id);
      notification = await insertNotification({
        type: status === 'fixed' ? '面談確定' : '面談不成立',
        branch_id: next.branch_id || actor.branch_id || null,
        msg: `${intern ? intern.nickname : ''}さんの面談が${status === 'fixed' ? '確定' : '不成立に'}しました`,
      });
    }
    res.json({ ok: true, interview: next, notification });
  } catch (e) {
    console.error('面談の変更に失敗しました', e);
    res.status(500).json({ error: '変更できませんでした' });
  }
});

/* 申請を取り下げる（本人が申請中のものだけ）、または
   担当スタッフが確定済み・不成立の面談を一覧から片付ける。
   どちらも、すでにGoogleカレンダーへ入れた予定は消さない（一覧の整理と、
   本人の予定を残すことは別の話のため） */
app.delete('/api/interviews/:id', requireAuth, async (req, res) => {
  const actor = req.authUser;
  try {
    const iv = await getInterview(req.params.id);
    if (!iv) return res.status(404).json({ error: '面談が見つかりません' });
    const isOwnApplied = iv.intern_id === actor.id && iv.status === 'applied';
    const isOwnDone = ['staff', 'branch_admin'].includes(actor.role)
      && iv.staff_id === actor.id && ['fixed', 'failed'].includes(iv.status);
    if (actor.role !== 'admin' && !isOwnApplied && !isOwnDone) {
      return res.status(403).json({ error: 'この面談を削除する権限がありません' });
    }
    await client.execute({ sql: 'DELETE FROM interviews WHERE id = ?', args: [iv.id] });
    res.json({ ok: true });
  } catch (e) {
    console.error('面談の削除に失敗しました', e);
    res.status(500).json({ error: '削除できませんでした' });
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
/* タイトルにこの語句を含む予定は全体予定表に出さない。
   起動時に一度だけ読む。語句を変えたらサーバーの再起動が要る */
const SHARED_CAL_EXCLUDE = sharedCalFilter.parseExcludeWords(process.env.SHARED_CALENDAR_EXCLUDE);

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
      return res.json({
        events: hit.events, configured: true, name: row.calendar_name,
        calendarId: row.calendar_id, cached: true,
      });
    }
    const accessToken = await accessTokenFor(row);
    const all = await google.listEventsInRange(accessToken, row.calendar_id, timeMin, timeMax);
    /* 外す予定はここで落としてからキャッシュに入れる。
       配る前に落とすので、除外した予定は画面側には一切渡らない */
    const events = sharedCalFilter.filterSharedEvents(all, SHARED_CAL_EXCLUDE);
    if (all.length !== events.length) {
      console.log(`全体予定表：${all.length - events.length}件を除外しました（${SHARED_CAL_EXCLUDE.join(' / ')}）`);
    }
    sharedCalCache.set(key, { at: Date.now(), events });
    /* calendarId は、画面の「全社カレンダー」ボタンから
       Googleカレンダー側を開くために渡している */
    res.json({ events, configured: true, name: row.calendar_name, calendarId: row.calendar_id });
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

/* 自分のGoogleカレンダーの予定を、日調のカレンダーに重ねて出すために返す。
   ---------------------------------------------------------
   ここが返すのは「呼んだ本人のカレンダー」だけ。他人のぶんは渡しようがないので、
   その人にしか見えないことが仕組みとして保証される。
   DBには保存しない。保存すると、Google側で消した予定が日調に残り続けるうえ、
   本人しか見てはいけない予定の写しがDBに溜まっていくため */
const myCalCache = new Map();          // key: staffId|timeMin|timeMax
const MY_CAL_TTL_MS = 60 * 1000;
/* このアプリ内だけの上書き（hidden・タイトル・時間・場所）を、Googleから取ってきた
   生の予定に重ねる。Google側には一切書き込まない。
   キャッシュは生のGoogleの結果を持たせ、上書きは呼ばれるたびにここで当てる
   （上書きを変えた直後にキャッシュのせいで古い表示に戻らないようにするため） */
async function applyMyCalOverrides(userId, events) {
  const rs = await client.execute({ sql: 'SELECT * FROM my_calendar_overrides WHERE user_id = ?', args: [userId] });
  if (!rs.rows.length) return events;
  const map = new Map(rs.rows.map((r) => [r.google_event_id, r]));
  return events
    .filter((e) => !map.get(e.id)?.hidden)
    .map((e) => {
      const o = map.get(e.id);
      if (!o) return e;
      return {
        ...e,
        title: o.title ?? e.title,
        start: o.start ?? e.start,
        end: o.end ?? e.end,
        allDay: o.all_day != null ? !!o.all_day : e.allDay,
        location: o.location ?? e.location,
      };
    });
}
app.get('/api/my-calendar/events', requireAuth, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.json({ events: [], connected: false });
  const timeMin = String(req.query.timeMin || '');
  const timeMax = String(req.query.timeMax || '');
  if (!timeMin || !timeMax) return res.status(400).json({ error: '期間の指定が必要です' });
  const me = req.authUser.id;
  try {
    const row = await getTokenRow(me);
    if (!row) return res.json({ events: [], connected: false });
    const key = `${me}|${timeMin}|${timeMax}`;
    const hit = myCalCache.get(key);
    if (hit && Date.now() - hit.at < MY_CAL_TTL_MS) {
      return res.json({ events: await applyMyCalOverrides(me, hit.events), connected: true, cached: true });
    }
    const accessToken = await accessTokenFor(row);
    /* 連携しているカレンダーが全体予定表用に差し替えられている場合でも、
       ここで見たいのは本人の予定なので primary を固定で読む */
    const events = await google.listEventsInRange(accessToken, 'primary', timeMin, timeMax);
    myCalCache.set(key, { at: Date.now(), events });
    res.json({ events: await applyMyCalOverrides(me, events), connected: true });
  } catch (e) {
    /* 取れなくてもカレンダー画面は出したいので、空で返してログに残す */
    if (e.code === 'REFRESH_REVOKED' || e.code === 'CALENDAR_UNAVAILABLE') {
      return res.json({ events: [], connected: true, error: 'unavailable' });
    }
    console.error('自分のGoogleカレンダーの取得に失敗しました', e);
    res.json({ events: [], connected: true, error: 'failed' });
  }
});

/* 自分のGoogleカレンダーの予定を、このアプリの中だけで編集する。
   Googleカレンダー本体には書き込まない（google.updateEventは呼ばない） */
app.patch('/api/my-calendar/events/:id', requireAuth, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(400).json({ error: 'Googleカレンダー連携が無効です' });
  const { title, start, end, all_day: allDay, location } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'タイトルを入力してください' });
  const s = new Date(start);
  if (!start || Number.isNaN(s.getTime())) return res.status(400).json({ error: '日時が正しくありません' });
  const isAllDay = !!allDay;
  let endVal = start;
  if (!isAllDay) {
    const en = new Date(end);
    if (!end || Number.isNaN(en.getTime()) || en <= s) {
      return res.status(400).json({ error: '終わりの時刻は、始まりより後にしてください' });
    }
    endVal = end;
  }
  await client.execute({
    sql: `INSERT INTO my_calendar_overrides (user_id, google_event_id, hidden, title, start, end, all_day, location, updated_at)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, google_event_id) DO UPDATE SET
            hidden = 0, title = excluded.title, start = excluded.start, end = excluded.end,
            all_day = excluded.all_day, location = excluded.location, updated_at = excluded.updated_at`,
    args: [req.authUser.id, req.params.id, String(title).trim(), start, endVal, isAllDay ? 1 : 0, String(location || ''), new Date().toISOString()],
  });
  myCalCache.clear();
  res.json({ ok: true });
});

/* 自分のGoogleカレンダーの予定を、このアプリの表示からだけ消す。
   Google側の予定は残ったまま（削除も google.deleteEvent も呼ばない） */
app.delete('/api/my-calendar/events/:id', requireAuth, async (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(400).json({ error: 'Googleカレンダー連携が無効です' });
  await client.execute({
    sql: `INSERT INTO my_calendar_overrides (user_id, google_event_id, hidden, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(user_id, google_event_id) DO UPDATE SET hidden = 1, updated_at = excluded.updated_at`,
    args: [req.authUser.id, req.params.id, new Date().toISOString()],
  });
  myCalCache.clear();
  res.json({ ok: true });
});

/* =========================================================
   iCalendar購読
   ---------------------------------------------------------
   subscription_key 自体が閲覧用の合鍵。発行・再発行だけはログイン必須、
   .ics はカレンダーアプリが直接読むためログイン不要にする。
   ========================================================= */
const ICAL_CACHE_TTL_MS = 5 * 60 * 1000;
const icalCache = new Map(); // userId -> { at, body }

function newCalendarSubscriptionKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function calendarSubscriptionUrl(req, key) {
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/calendar/${key}.ics`;
}

async function ensureCalendarSubscription(userId) {
  let rs = await client.execute({
    sql: 'SELECT subscription_key FROM calendar_subscriptions WHERE user_id = ?', args: [userId],
  });
  if (rs.rows[0]) return rs.rows[0].subscription_key;
  const key = newCalendarSubscriptionKey();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO calendar_subscriptions (user_id, subscription_key, created_at, updated_at)
          VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING`,
    args: [userId, key, now, now],
  });
  rs = await client.execute({
    sql: 'SELECT subscription_key FROM calendar_subscriptions WHERE user_id = ?', args: [userId],
  });
  return rs.rows[0].subscription_key;
}

function calendarRange(now = new Date()) {
  const from = new Date(now);
  from.setUTCMonth(from.getUTCMonth() - 3);
  const to = new Date(now);
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  return { from, to };
}

function inCalendarRange(value, range) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= range.from.getTime() && time <= range.to.getTime();
}

async function calendarItemsFor(user, now = new Date()) {
  const range = calendarRange(now);
  const [store, interviewRows, users] = await Promise.all([
    readDB(),
    client.execute({
      sql: `SELECT * FROM interviews
            WHERE status = 'fixed' AND (staff_id = ? OR intern_id = ?)`,
      args: [user.id, user.id],
    }),
    listActiveUsers(),
  ]);
  const userById = new Map(users.map((item) => [item.id, item]));
  const items = [];

  for (const row of interviewRows.rows) {
    const iv = rowToInterview(row);
    if (!iv.confirmed_datetime || !inCalendarRange(iv.confirmed_datetime, range)) continue;
    const otherName = user.id === iv.staff_id
      ? (userById.get(iv.intern_id)?.nickname || iv.intern_name || '面談相手')
      : (userById.get(iv.staff_id)?.nickname || '担当スタッフ');
    const start = new Date(iv.confirmed_datetime);
    items.push({
      id: `interview-${iv.id}`,
      uid: `interview-${iv.id}@ops-nittyou`,
      updatedAt: row.updated_at || iv.created_at || now,
      start,
      end: new Date(start.getTime() + 30 * 60000),
      summary: `面談: ${otherName}さん`,
      description: 'OPS日調アプリで確定した面談です。',
      location: iv.location || iv.meeting_location || '',
    });
  }

  for (const event of store?.events || []) {
    /* 購読対象は支部イベント。個人の非公開予定や他支部の予定は合鍵が正しくても出さない。 */
    if (event.visibility === 'private' || !user.branch_id || event.branch_id !== user.branch_id) continue;
    if (!inCalendarRange(event.start_datetime, range)) continue;
    const start = new Date(event.start_datetime);
    const allDay = event.has_time === false;
    const storedEnd = new Date(event.end_datetime);
    const timedEnd = Number.isFinite(storedEnd.getTime()) && storedEnd > start
      ? storedEnd : new Date(start.getTime() + 60 * 60 * 1000);
    items.push({
      id: `event-${event.id}`,
      uid: `event-${event.id}@ops-nittyou`,
      updatedAt: event.updated_at || event.created_at || now,
      allDay,
      start,
      end: allDay ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : timedEnd,
      summary: event.title || '支部イベント',
      /* 依頼本文などを購読URLの先へ広げない。必要最小限の種別だけを載せる。 */
      description: 'OPS日調アプリの支部イベントです。',
      location: event.location || '',
    });
  }
  return items.sort((a, b) => new Date(a.start) - new Date(b.start));
}

app.get('/api/calendar/subscription', requireAuth, async (req, res) => {
  try {
    const key = await ensureCalendarSubscription(req.authUser.id);
    res.json({ url: calendarSubscriptionUrl(req, key) });
  } catch (e) {
    console.error('カレンダー購読URLの発行に失敗しました', e);
    res.status(500).json({ error: '購読URLを発行できませんでした' });
  }
});

app.post('/api/calendar/subscription/regenerate', requireAuth, async (req, res) => {
  try {
    const key = newCalendarSubscriptionKey();
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO calendar_subscriptions (user_id, subscription_key, created_at, updated_at)
            VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
              subscription_key = excluded.subscription_key, updated_at = excluded.updated_at`,
      args: [req.authUser.id, key, now, now],
    });
    icalCache.delete(req.authUser.id);
    res.json({ url: calendarSubscriptionUrl(req, key) });
  } catch (e) {
    console.error('カレンダー購読キーの再発行に失敗しました', e);
    res.status(500).json({ error: '購読キーを作り直せませんでした' });
  }
});

app.get(/^\/api\/calendar\/([A-Za-z0-9_-]{32,})\.ics$/, async (req, res) => {
  try {
    const rs = await client.execute({
      sql: `SELECT u.* FROM calendar_subscriptions c
            JOIN users u ON u.id = c.user_id
            WHERE c.subscription_key = ? AND u.status = 'active'`,
      args: [req.params[0]],
    });
    const user = rs.rows[0];
    if (!user) return res.status(404).type('text/plain; charset=utf-8').send('カレンダーが見つかりません');

    const hit = icalCache.get(user.id);
    let body;
    if (hit && Date.now() - hit.at < ICAL_CACHE_TTL_MS) {
      body = hit.body;
    } else {
      body = buildICalendar(await calendarItemsFor(user), { calendarName: 'OPS日程調整' });
      icalCache.set(user.id, { at: Date.now(), body });
    }
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(200).send(body);
  } catch (e) {
    /* キーはURLに含まれるため、エラー時もreq.pathやSQL引数をログへ出さない。 */
    console.error('iCalendarの生成に失敗しました', e.message || e);
    res.status(500).type('text/plain; charset=utf-8').send('カレンダーを取得できませんでした');
  }
});

/* この人（staff_idにもintern_idにも使われるGoogle連携ユーザーID）が持つ、
   確定済み面談としてこのアプリ自身がGoogleカレンダーに書き込んだイベントID。
   webhookで戻ってきた変更がこれと一致するときは、「外部の予定」として
   取り込まない（取り込むと面談一覧と不可時間の一覧に同じ時間帯が
   二重に現れる。2026-08-10 発見・修正）。
   本人がstaff_idの行はgoogleEventId、intern_idの行はgoogleEventIdInternが
   その人自身のカレンダー上のイベントIDになる */
async function ownGoogleEventIdsFor(userId) {
  const rs = await client.execute({
    sql: "SELECT staff_id, intern_id, data FROM interviews WHERE status = 'fixed' AND (staff_id = ? OR intern_id = ?)",
    args: [userId, userId],
  });
  const ids = new Set();
  for (const row of rs.rows) {
    let data = {};
    try { data = JSON.parse(row.data) || {}; } catch { /* 壊れていても他の行は続ける */ }
    if (row.staff_id === userId && data.googleEventId) ids.add(data.googleEventId);
    if (row.intern_id === userId && data.googleEventIdIntern) ids.add(data.googleEventIdIntern);
  }
  return ids;
}

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
    const { items: allItems, nextSyncToken } = await google.listChangedEvents(accessToken, tokenRow.calendar_id, tokenRow.sync_token);
    if (nextSyncToken) await updateSyncToken(tokenRow.staff_id, nextSyncToken);

    /* このアプリ自身が面談確定で書き込んだイベントは、外部予定として
       取り込まない。含めてしまうと、確定済みの面談が「面談一覧」と
       「この日は受けられない時間」の両方に別々に現れ、同じ予定を
       二重に登録したように見えてしまう */
    const ownEventIds = await ownGoogleEventIdsFor(tokenRow.staff_id);
    const items = googleSyncFilter.excludeOwnEvents(allItems, ownEventIds);

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
  // 祝日の計算。index.html と apply.html の両方が読む
  '/holidays.js': 'holidays.js',
  /* アプリのアイコン。/favicon.ico もこのPNGを返す（拡張子ではなく
     実ファイルから型が決まるので image/png で配信される）。
     いまは120×120しか素材が無く、ホーム画面用の180pxは拡大表示になる。
     大きい原本が手に入ったら icon-120.png を差し替えてサイズ表記も直すこと */
  '/icon-120.png': 'icon-120.png',
  '/favicon.ico': 'icon-120.png',
  '/manifest.webmanifest': 'manifest.webmanifest',
  /* プッシュ通知の受け取り役。/ の直下から配らないとアプリ全体を
     受け持てない（Service Workerは自分より下の階層しか担当できない） */
  '/sw.js': 'sw.js',
  '/privacy.html': 'privacy.html',
  '/terms.html': 'terms.html',
  // スタッフ登録ページ。中身はアプリ本体と同じHTMLで、URLを見て画面を切り替えている
  '/staff': 'index.html',
  // アカウント無しの面談申請ページ。ログイン処理を一切通らないよう別ファイルにしてある
  '/apply.html': 'apply.html',
  '/attendance.html': 'attendance.html',
  // Google Search Console のサイト所有権確認用。確認状態を保つため削除しないこと
  '/googlee6411894890471cb.html': 'googlee6411894890471cb.html',
};
app.get('*', (req, res) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch (e) { p = req.path; }
  // 末尾スラッシュ付きだと style.css の相対パスがずれるため、正規化してから配信する
  if (p === '/staff/') return res.redirect(301, '/staff');
  /* 支部ごとの申請URL。合言葉の正しさはここでは見ず、ページを出してから
     APIで確かめる。ここで弾くと、正しいかどうかがURLを叩くだけで分かってしまう */
  if (/^\/i\/[A-Za-z0-9_-]+\/?$/.test(p)) {
    return res.sendFile(path.join(PUBLIC_ROOT, 'apply.html'));
  }
  if (/^\/a\/[A-Za-z0-9_-]+\/?$/.test(p)) {
    return res.sendFile(path.join(PUBLIC_ROOT, 'attendance.html'));
  }
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
      // 古い履歴の片付け。起動時に一度と、その後は1日おき
      archiveOldRecords();
      setInterval(archiveOldRecords, 24 * 60 * 60 * 1000);
      deleteOldFailedInterviews();
      setInterval(deleteOldFailedInterviews, 24 * 60 * 60 * 1000);
      purgeOldRequestTrash();
      setInterval(purgeOldRequestTrash, 24 * 60 * 60 * 1000);
      purgeExpiredSessions();
      setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000);
    });
  })
  .catch((e) => {
    console.error('DB初期化に失敗しました', e);
    process.exit(1);
  });
