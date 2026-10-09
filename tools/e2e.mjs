/* =========================================================
   E2Eテスト（本物のサーバーに対する検証）

   使い方:  node tools/e2e.mjs

   やっていること:
     1. 使い捨てのDBファイルを一時領域に作る（本番にもローカル開発用DBにも触らない）
     2. server/server.js を実際に別ポートで起動する
     3. 実際のHTTP APIを叩いて結果を確かめる

   関数を直接呼ぶのではなく本物のサーバーを起動しているのは、
   「単体では正しいのに、つなぐと壊れている」種類の不具合を見つけるため。
   実際、requests / profiles / internships が保存時に消える不具合は
   この方式でしか見つけられなかった。
   ========================================================= */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// server/ 側にインストールされている @libsql/client を借りる（tools用の依存は増やさない）
const { createClient } = createRequire(path.join(ROOT, 'server', 'package.json'))('@libsql/client');
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

/* ---------- 表示の絞り込み ----------
   --quiet      失敗したものだけ出す
   --only <語>  見出しにその語を含む区画の結果だけ出す（例: --only 出欠）

   間引くのは**表示だけ**で、検査そのものは必ず全部走らせる。
   途中の区画を飛ばすと、前の区画が作ったデータが無くて後ろが壊れるため。
   全部走らせても3秒ほどしかかからない */
const CLI = process.argv.slice(2);
const QUIET = CLI.includes('--quiet');
const ONLY = (() => { const i = CLI.indexOf('--only'); return i >= 0 ? (CLI[i + 1] || '') : ''; })();
const rawLog = console.log.bind(console);
let currentSection = '';
console.log = (...args) => {
  const line = typeof args[0] === 'string' ? args[0] : '';
  // 見出しは「───────␣名前␣───────」。最後の区切り線は空白を挟まないので当たらない
  const isHeading = line.includes('─────── ');
  const isResult = /^ {2}(OK|NG) /.test(line);
  if (isHeading) currentSection = line;
  if (ONLY && (isHeading || isResult) && !currentSection.includes(ONLY)) return;
  if (QUIET && (isHeading || line.startsWith('  OK '))) return;
  rawLog(...args);
};

/* ---------- 結果の集計 ---------- */
let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}

/* ---------- テスト用DBの用意 ----------
   支部は2つ。「他支部のデータが見えてはいけない」を確かめるため、
   b2（大阪）側に、b1（東京）のテストユーザーからは決して見えてはいけないデータを置く */
/* インターン生のアカウントは廃止した。
   以前インターン生で試していた「同じ支部の他人」の役は、
   同支部のスタッフ（staff3 / staff4）が引き継いでいる。
   oldIntern は、残っているインターン生のセッションが弾かれることを確かめるためだけに使う */
const TOKENS = {
  staff: 'e2etoken_staff',       // b1のスタッフ
  staff3: 'e2etoken_staff3',     // b1のもう1人のスタッフ（同支部の他人）
  admin: 'e2etoken_admin',       // 全体管理者
  staff2: 'e2etoken_staff2',     // b2のスタッフ（他支部の代表）
  staff4: 'e2etoken_staff4',     // b1のさらにもう1人のスタッフ
  oldIntern: 'e2etoken_oldintern', // 廃止済みのインターン生（ログインできないことの確認用）
};
const USERS = [
  ['u_e2e_staff', 'e2e_staff@dot-jp.or.jp', 'staff', 'b1'],
  ['u_e2e_staff3', 'e2e_staff3@dot-jp.or.jp', 'staff', 'b1'],
  ['u_e2e_staff4', 'e2e_staff4@dot-jp.or.jp', 'staff', 'b1'],
  ['u_e2e_admin', 'e2e_admin@dot-jp.or.jp', 'admin', null],
  ['u_e2e_staff2', 'e2e_staff2@dot-jp.or.jp', 'staff', 'b2'],
  ['u_e2e_oldintern', 'e2e_oldintern@example.com', 'intern', 'b1'],
];

async function setupDB(dbPath) {
  // 前回の残骸を消してから作り直す（毎回まっさらな状態で始める）
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* 無ければよい */ }
  }
  const c = createClient({ url: 'file:' + dbPath });
  const now = new Date().toISOString();
  const exp =new Date(Date.now() + 3600e3).toISOString();
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600e3).toISOString();

  // server.js の initDB() と同じ形。起動時にCREATE TABLE IF NOT EXISTSされるので最低限だけ先に作る
  await c.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    nickname TEXT, role TEXT NOT NULL, branch_id TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, approved_at TEXT, avatar_url TEXT, staff_id TEXT, google_sub TEXT)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)`);

  for (const [id, email, role, branch] of USERS) {
    await c.execute({
      sql: 'INSERT OR REPLACE INTO users (id,email,password_hash,nickname,role,branch_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      // パスワードは使わなくなったので空。列そのものは既存DBに合わせて残っている
      args: [id, email, '', 'E2E-' + role, role, branch, 'active', now],
    });
  }
  for (const [key, token] of Object.entries(TOKENS)) {
    const userId = { staff: 'u_e2e_staff', staff3: 'u_e2e_staff3', admin: 'u_e2e_admin',
      staff2: 'u_e2e_staff2', staff4: 'u_e2e_staff4', oldIntern: 'u_e2e_oldintern' }[key];
    await c.execute({
      sql: 'INSERT OR REPLACE INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
      args: [crypto.createHash('sha256').update(token).digest('hex'), userId, now, exp],
    });
  }

  const store = {
    branches: [{ id: 'b1', name: '東京' }, { id: 'b2', name: '大阪' }],
    availability: {},
    // 面談も専用テーブルへ引っ越す対象
    interviews: [{ id: 'iv_old', intern_id: 'u_e2e_staff3', staff_id: 'u_e2e_staff', status: 'applied', choice1: '2026-03-01T10:00:00.000Z', meeting_type: 'meet', created_at: now }],
    /* メール履歴も専用テーブルへ引っ越す対象。
       1件は最近のもの、1件は1年前（アーカイブされるはず）にしておく */
    emails: [
      { id: 'ml_old', sender_id: 'u_e2e_staff', receiver_id: 'u_e2e_staff3', subject: '引っ越し前のメール', body: 'x', sent_at: now, delivered: false },
      { id: 'ml_ancient', sender_id: 'u_e2e_staff', receiver_id: 'u_e2e_staff3', subject: '1年前のメール', body: 'x', sent_at: oneYearAgo, delivered: false },
    ],
    events: [{ id: 'ev_old', creator_id: 'u_e2e_staff2', branch_id: 'b2', title: '旧イベント', date: '2026-01-01', visibility: 'branch' }],
    // b2（他支部）のデータ。b1のユーザーからは見えても触れてもいけない
    profiles: { u_e2e_staff2: { departments: ['大阪の部署'] } },
    internships: [{ id: 'ip_osaka', branch_id: 'b2', name: '大阪の企業', created_by: 'u_e2e_staff2', created_at: now }],
    /* 以下の3つは専用テーブルへ引っ越す対象。
       起動時の移行処理が正しく動くか確かめるため、あえて store 側に入れておく */
    requests: [{
      id: 'rq_osaka', branch_id: 'b2', sender_id: 'u_e2e_staff2',
      subject: '【大阪支部の内部連絡】', body: '他支部に見えてはいけない内容',
      target_label: '大阪支部全員', recipient_ids: ['u_e2e_staff2'], created_at: now,
      kind: 'attend', options: [{ id: 'op0', date: '2026-12-01', has_date: true, has_time: false }],
    }, {
      /* kind の無い昔の依頼＝タスク。タスク機能は撤去したので、
         引っ越しのあと purgeTaskRequests() で消えていなければならない */
      id: 'rq_task_old', branch_id: 'b1', sender_id: 'u_e2e_staff',
      subject: '昔のタスク', body: 'x', target_label: '個別', recipient_ids: ['u_e2e_staff3'],
      read_by: [{ user_id: 'u_e2e_staff3', at: now }], created_at: now,
    }],
    event_responses: [{ id: 'er_old', event_id: 'ev_old', user_id: 'u_e2e_staff2', response: 'yes' }],
    notifications: [
      { id: 'nt_old', type: 'info', msg: '引っ越し前の通知', branch_id: 'b2', at: now },
      { id: 'nt_ancient', type: 'info', msg: '1年前の通知', branch_id: 'b2', at: oneYearAgo },
      { id: 'nt_task', type: '依頼', msg: '昔のタスクの通知', branch_id: 'b1', at: now },
    ],
  };
  await c.execute({
    sql: 'INSERT INTO store (id,data,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
    args: [JSON.stringify(store), now],
  });
  c.close();
}

/* ---------- サーバーの起動と停止 ---------- */
function startServer(dbPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'server'),
    /* 公開ページの回数制限は切っておく。ここでは「100人が同時に申請しても
       取りこぼさないか」を1つのIPから確かめるので、制限が効くと必ず落ちる。
       制限そのものの検査は tools/test-ratelimit.mjs が受け持つ */
    env: { ...process.env,
      PORT: String(PORT),
      TURSO_DATABASE_URL: 'file:' + dbPath,
      TURSO_AUTH_TOKEN: '',
      PUBLIC_WRITE_PER_MIN: '0',
      PUBLIC_READ_PER_MIN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/db', { headers: { Authorization: 'Bearer nope' } });
      if (r.status === 401 || r.status === 200) return true;
    } catch { /* まだ起動していない */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------- APIの呼び出し ---------- */
/* トークンに null を渡すと、ログインしていない状態で叩ける。
   支部リンクからの申請はログイン不要なので、その検証に使う */
const H = (t) => (t
  ? { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }
  : { 'Content-Type': 'application/json' });

/* fetch は同じ宛先への接続を1本しか張らないため、Promise.all で並べても
   実際には順番に処理されてしまい、同時アクセスの検証にならない。
   同時アクセスの試験だけは、接続数を上げた生のHTTPで投げる */
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
function rawPost(token, pathname, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: 'localhost', port: PORT, path: pathname, method, agent,
      headers: { ...H(token), 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}
async function getDB(token) {
  const r = await fetch(BASE + '/api/db', { headers: H(token) });
  if (!r.ok) throw new Error('GET /api/db が ' + r.status);
  return r.json();
}
/* 申請ページの空き枠は週ごとの表で返るので、選べる枠を探すには週をめくる必要がある。
   受付時間が短いスタッフだと今週に空きが無いこともあるため、上限まで見に行く */
async function firstOpenSlot(token, staffId, skip = []) {
  const ng = new Set(skip);
  for (let week = 0; week <= 4; week++) {
    const r = await api(null, 'GET',
      `/api/apply/${token}/slots?staff_id=${staffId}&week=${week}`);
    for (const col of (r.json.grid || [])) {
      for (const cell of col) {
        if (cell.state === 'ok' && !ng.has(cell.iso)) return cell;
      }
    }
  }
  return null;
}
/* ある枠がまだ選べる状態かどうか。確定後に埋まったことを確かめるのに使う */
async function slotStillOpen(token, staffId, iso) {
  for (let week = 0; week <= 4; week++) {
    const r = await api(null, 'GET',
      `/api/apply/${token}/slots?staff_id=${staffId}&week=${week}`);
    for (const col of (r.json.grid || [])) {
      for (const cell of col) {
        if (cell.iso === iso) return cell.state === 'ok';
      }
    }
  }
  return false;
}
/* store の生の中身を直接のぞく（APIを通さない）。引っ越しの確認に使う */
let DB_PATH = null;
async function readStoreRaw() {
  const c = createClient({ url: 'file:' + DB_PATH });
  const rs = await c.execute('SELECT data FROM store WHERE id = 1');
  c.close();
  return JSON.parse(rs.rows[0].data);
}
/* 退避された store の原本を読む。引っ越し前の状態を確かめるのに使う */
async function readStoreBackups() {
  const c = createClient({ url: 'file:' + DB_PATH });
  const rs = await c.execute('SELECT reason, data, taken_at FROM store_backup ORDER BY id');
  c.close();
  return rs.rows;
}
/* アーカイブの確認用。テーブルの件数を直接数える */
async function countRows() {
  const c = createClient({ url: 'file:' + DB_PATH });
  const cutoff = new Date(Date.now() - 183 * 24 * 60 * 60 * 1000).toISOString();
  const one = async (sql, args = []) => Number((await c.execute({ sql, args })).rows[0].n);
  const out = {
    emails_old: await one('SELECT COUNT(*) n FROM emails WHERE sent_at < ?', [cutoff]),
    emails_recent: await one('SELECT COUNT(*) n FROM emails WHERE sent_at >= ?', [cutoff]),
    archived_emails: await one('SELECT COUNT(*) n FROM archived_emails'),
    notifications_old: await one('SELECT COUNT(*) n FROM notifications WHERE at < ?', [cutoff]),
    archived_notifications: await one('SELECT COUNT(*) n FROM archived_notifications'),
  };
  c.close();
  return out;
}

/* SSE につないで、届いた refresh を数える。
   fetch のストリームをそのまま読む（画面側と同じ受け方）。close() で切る */
async function openStream(token) {
  const ctrl = new AbortController();
  let res;
  try { res = await fetch(BASE + '/api/stream', { headers: H(token), signal: ctrl.signal }); }
  catch (e) { return { status: 0, events: [], close() { ctrl.abort(); } }; }
  const events = [];
  if (!res.ok) { ctrl.abort(); return { status: res.status, events, close() {} }; }
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: refresh')) events.push(block);
        }
      }
    } catch { /* close() で切ったとき。ここは正常 */ }
  })();
  return { status: res.status, events, close() { ctrl.abort(); } };
}
/* 条件が満たされるまで待つ。押し出しは非同期なので、決め打ちの待ち時間にしない */
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/* 専用APIの呼び出し */
async function api(token, method, pathname, payload) {
  const r = await fetch(BASE + pathname, {
    method, headers: H(token),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
let REQ_ID = null;   // テストの中で作った依頼のID
let IV_ID = null;    // テストの中で作った面談のID

async function createBrowserAttendanceFixture() {
  const day = new Date(Date.now() + 7 * 86400000);
  const at = (hour) => { const d = new Date(day); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const made = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '公開出欠の画面確認', body: 'ブラウザ確認用の使い捨てデータです。',
    target_label: '誰でも回答OK', recipient_ids: [], kind: 'attend', public_access: true,
    options: [{ start: at(13), end: at(14) }, { start: at(15), end: at(16) }],
  });
  if (made.status !== 200) throw new Error('画面確認用の公開出欠を作成できませんでした');
  return made.json.request.public_url;
}

/* フロントの mutate() と同じ流れ：受け取った内容を書き換えて丸ごと送り返す */
async function putDB(token, mutateFn) {
  const cur = await getDB(token);
  const body = { ...cur };
  delete body.users;
  mutateFn(body);
  body._baseUpdatedAt = cur.updatedAt;
  const r = await fetch(BASE + '/api/db', { method: 'PUT', headers: H(token), body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/* =========================================================
   書き込みの直列化そのものの検証（HTTPを介さない）

   本番のTursoはネットワーク越しなので「読む→書く」の間に待ちが入り、
   別の処理が割り込む。ローカルのSQLiteでは待ちが入らないため
   HTTP経由の試験では再現できない。そこで待ちを人工的に作り、
   直列化が無いと壊れること・あると壊れないことの両方を確かめる。
   ========================================================= */
/* 全体予定表の絞り込み。
   Googleカレンダーとの連携が要るためHTTP経由では試せないので、
   判定の部分だけを直接呼んで確かめる */
/* 出欠確認（依頼の一種）。候補を出す→答える→確定する、の一通りと、
   答えてはいけない人・確定してはいけない人がはじかれることを確かめる */
async function testAttendance() {
  console.log('\n─────── 出欠確認 ───────');
  const t1 = new Date(Date.now() + 7 * 86400000);
  const t2 = new Date(Date.now() + 14 * 86400000);
  const dueDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 5 * 86400000));
  const mk = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x.toISOString(); };

  const made = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: 'チーム懇親会', body: '場所は未定です',
    target_label: '支部の全インターン生', recipient_ids: ['u_e2e_staff3', 'u_e2e_staff4'],
    kind: 'attend', due_date: dueDate, due_time: '23:59',
    options: [{ start: mk(t1, 19), end: mk(t1, 21) }, { start: mk(t2, 19), end: mk(t2, 21) }],
  });
  check('出欠確認を作れる', made.status, 200);
  check('出欠確認として記録される', made.json.request?.kind, 'attend');
  check('候補が2件ある', made.json.request?.options?.length, 2);
  check('候補にidが振られる', made.json.request?.options?.[0]?.id, 'op0');
  check('締切日を付けた出欠確認を作れる', made.json.request?.due_date, dueDate);
  check('締切の時刻も残る', made.json.request?.due_time, '23:59');
  const attId = made.json.request?.id;
  check('出欠確認は送った本人もあて先に入る',
    made.json.request?.recipient_ids?.includes('u_e2e_staff'), true);
  const senderMailView = await getDB(TOKENS.staff);
  check('送った本人には自分宛てメール履歴を作らない',
    (senderMailView.emails || []).some((m) => m.subject === '【出欠確認】チーム懇親会'
      && m.receiver_id === 'u_e2e_staff'), false);

  /* 依頼の一覧を見ていない人がメール画面からでも気づけるよう、
     出欠確認はあて先ひとりずつのメール履歴にも残す */
  const mailView = await getDB(TOKENS.staff3);
  check('締切日を付けた出欠確認を読み出せる',
    (mailView.requests || []).find((r) => r.id === made.json.request?.id)?.due_date, dueDate);
  check('締切の時刻も読み出せる',
    (mailView.requests || []).find((r) => r.id === made.json.request?.id)?.due_time, '23:59');
  const attMail = (mailView.emails || []).find((m) => m.subject === '【出欠確認】チーム懇親会');
  check('出欠確認がメール履歴にも残る', !!attMail, true);
  check('あて先本人が受け取っている', attMail?.receiver_id, 'u_e2e_staff3');
  check('実際には送っていない印が付く', attMail?.delivered, false);
  check('本文に候補が並ぶ', (attMail?.body || '').includes('【日程の候補】'), true);
  check('本文に回答用のリンクが入る', (attMail?.body || '').includes(`/?req=${attId}`), true);
  const otherMail = await getDB(TOKENS.staff4);
  check('あて先の人数ぶん作られる',
    (otherMail.emails || []).some((m) => m.subject === '【出欠確認】チーム懇親会'
      && m.receiver_id === 'u_e2e_staff4'), true);
  const notForOthers = await getDB(TOKENS.staff2);
  check('あて先でない人のメールには出ない',
    (notForOthers.emails || []).some((m) => m.subject === '【出欠確認】チーム懇親会'), false);

  const noOpts = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '候補なし', target_label: 'x', recipient_ids: ['u_e2e_staff3'], kind: 'attend', options: [],
  });
  check('候補が無い出欠確認は作れない', noOpts.status, 400);

  const badDate = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '壊れた候補', target_label: 'x', recipient_ids: ['u_e2e_staff3'],
    kind: 'attend', options: [{ start: 'これは日付ではない' }],
  });
  check('日時として読めない候補ははじかれる', badDate.status, 400);

  // ---- 日付のみ・時間のみの候補 ----
  const dateKey = `${t1.getFullYear()}-${String(t1.getMonth() + 1).padStart(2, '0')}-${String(t1.getDate()).padStart(2, '0')}`;
  const dateOnlyMade = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '日付だけの候補', target_label: 'x', recipient_ids: ['u_e2e_staff3'], kind: 'attend',
    options: [{ date: dateKey, has_date: true, has_time: false }],
  });
  check('日付だけの候補を作れる', dateOnlyMade.status, 200);
  check('日付だけの印が保存される', dateOnlyMade.json.request?.options?.[0]?.has_time, false);
  check('日付だけの内部開始は01:00になる', dateOnlyMade.json.request?.options?.[0]?.start,
    new Date(`${dateKey}T01:00:00+09:00`).toISOString());
  check('日付だけの内部終了は01:30になる', dateOnlyMade.json.request?.options?.[0]?.end,
    new Date(`${dateKey}T01:30:00+09:00`).toISOString());
  const dateOnlyDone = await api(TOKENS.staff, 'POST',
    `/api/requests/${dateOnlyMade.json.request?.id}/confirm`, { option_id: 'op0' });
  check('日付だけの候補は確定できる', dateOnlyDone.status, 200);
  check('日付だけの候補はアプリ内予定になる', !!dateOnlyDone.json.event, true);
  check('日付だけのアプリ内予定は時刻非表示になる', dateOnlyDone.json.event?.has_time, false);

  const doubleConfirmMade = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '二重確定防止', target_label: 'x', recipient_ids: ['u_e2e_staff3'], kind: 'attend',
    options: [{ date: dateKey, has_date: true, has_time: false }],
  });
  const doubleConfirmResults = await Promise.all([
    api(TOKENS.staff, 'POST', `/api/requests/${doubleConfirmMade.json.request?.id}/confirm`, { option_id: 'op0' }),
    api(TOKENS.staff, 'POST', `/api/requests/${doubleConfirmMade.json.request?.id}/confirm`, { option_id: 'op0' }),
  ]);
  check('同じ出欠を同時確定しても成功は1件だけ',
    doubleConfirmResults.filter((x) => x.status === 200).length, 1);
  check('重複する確定要求は409で拒否する',
    doubleConfirmResults.filter((x) => x.status === 409).length, 1);

  const timeOnlyMade = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '時間だけの候補', target_label: 'x', recipient_ids: ['u_e2e_staff3'], kind: 'attend',
    options: [{ start_time: '20:00', end_time: '22:00', has_date: false, has_time: true }],
  });
  check('時間だけの候補を作れる', timeOnlyMade.status, 200);
  check('時間だけの開始時刻が保存される', timeOnlyMade.json.request?.options?.[0]?.start_time, '20:00');
  check('時間だけの終了時刻が保存される', timeOnlyMade.json.request?.options?.[0]?.end_time, '22:00');
  check('時間だけの候補には日付を保存しない', timeOnlyMade.json.request?.options?.[0]?.has_date, false);
  const timeOnlyDone = await api(TOKENS.staff, 'POST',
    `/api/requests/${timeOnlyMade.json.request?.id}/confirm`, { option_id: 'op0' });
  check('時間だけの候補は確定できる', timeOnlyDone.status, 200);
  check('時間だけの候補はカレンダー予定を作らない', timeOnlyDone.json.event, null);
  const afterTimeOnly = await getDB(TOKENS.staff);
  check('時間だけの確定候補が記録される',
    (afterTimeOnly.requests || []).find((r) => r.id === timeOnlyMade.json.request?.id)?.confirmed, 'op0');

  // ---- 回答 ----
  const ans = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'ok' }, { option_id: 'op1', response: 'no' }] });
  check('あて先の人は答えられる', ans.status, 200);
  check('答えた数だけ保存される', ans.json.saved?.length, 2);

  const ans2 = await api(TOKENS.staff4, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'may' }, { option_id: 'op1', response: 'ok' }] });
  check('もう1人も答えられる', ans2.status, 200);

  const senderAnswer = await api(TOKENS.staff, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'ok' }, { option_id: 'op1', response: 'may' }] });
  check('送った本人も受けた依頼として答えられる', senderAnswer.status, 200);

  const again = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'may' }] });
  check('答え直せる', again.status, 200);

  const outsider = await api(TOKENS.staff2, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'ok' }] });
  check('あて先でない人は答えられない', outsider.status, 403);

  const junk = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: '存在しない候補', response: 'ok' }, { option_id: 'op1', response: 'まる' }] });
  check('候補にないidと決まった3つ以外の答えは捨てられる', junk.json.saved?.length, 0);

  const seen = await getDB(TOKENS.staff);
  const row = (seen.requests || []).find((r) => r.id === attId);
  check('送った本人に全員の回答が見える', row?.responses?.length, 6);
  check('答え直した結果が上書きされている',
    row?.responses?.find((a) => a.user_id === 'u_e2e_staff3' && a.option_id === 'op0')?.response, 'may');

  const hidden = await getDB(TOKENS.staff2);
  check('他支部の人にはこの出欠確認自体が見えない',
    (hidden.requests || []).some((r) => r.id === attId), false);

  // ---- 確定 ----
  const byOther = await api(TOKENS.staff3, 'POST', `/api/requests/${attId}/confirm`, { option_id: 'op0' });
  check('送った本人以外は確定できない', byOther.status, 403);

  const badOpt = await api(TOKENS.staff, 'POST', `/api/requests/${attId}/confirm`, { option_id: 'op9' });
  check('無い候補では確定できない', badOpt.status, 400);

  const done = await api(TOKENS.staff, 'POST', `/api/requests/${attId}/confirm`, { option_id: 'op1' });
  check('送った本人は確定できる', done.status, 200);
  check('確定した日時で予定ができる', done.json.event?.start_datetime, mk(t2, 19));
  check('予定の名前は件名になる', done.json.event?.title, 'チーム懇親会');
  /* 「日程調整」は候補段階ですでに○△×を集めているので、確定してできた
     予定では、もう一度回答を取らない（votable:false）。keep_votable を
     送らなかったときの既定値がこれにあたる */
  check('日程調整で確定した予定は、もう出欠を取らない', done.json.event?.votable, false);

  const after = await getDB(TOKENS.staff);
  const row2 = (after.requests || []).find((r) => r.id === attId);
  check('確定した候補が記録される', row2?.confirmed, 'op1');
  check('できた予定が支部のカレンダーに入っている',
    (after.events || []).some((e) => e.id === done.json.event?.id), true);
  check('カレンダーに入った予定も出欠を取らない',
    (after.events || []).find((e) => e.id === done.json.event?.id)?.votable, false);

  const late = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'no' }] });
  check('確定後はもう答えられない', late.status, 409);

  // ---- アカウント不要の公開出欠 ----
  const publicMade = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '公開懇親会', body: '公開回答のテストです', target_label: '誰でも回答OK',
    recipient_ids: [], kind: 'attend', public_access: true, due_date: dueDate, due_time: '18:30',
    options: [{ start: mk(t1, 10), end: mk(t1, 11) }, { start: mk(t2, 10), end: mk(t2, 11) }],
  });
  check('誰でも回答OKの出欠確認を作れる', publicMade.status, 200);
  check('公開出欠にも送った本人があて先として入る',
    publicMade.json.request?.recipient_ids, ['u_e2e_staff']);
  check('公開出欠の共有URLが返る',
    /^http:\/\/localhost:8123\/a\/[A-Za-z0-9_-]+$/.test(publicMade.json.request?.public_url || ''), true);
  const publicToken = String(publicMade.json.request?.public_url || '').split('/a/')[1];

  const publicView = await api(null, 'GET', `/api/attendance/${publicToken}`);
  check('ログインせず公開出欠を見られる', publicView.status, 200);
  check('公開画面に件名が返る', publicView.json.request?.subject, '公開懇親会');
  check('公開画面に締切日が返る', publicView.json.request?.due_date, dueDate);
  check('公開画面に締切の時刻も返る', publicView.json.request?.due_time, '18:30');
  check('回答前でも結果一覧を見られる', publicView.json.respondents, []);

  const appHtml = await (await fetch(BASE + '/')).text();
  const serverSource = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  /* 公開の回答ページ。スタッフが見る出欠確認の画面（openAttendDetail）と
     同じ見た目にするため、/style.css を読んで同じクラスで組み立てている。
     このファイルに自前の <style> を持たせないこと（持たせると見た目がずれる） */
  const attendHtml = fs.readFileSync(path.join(ROOT, 'attendance.html'), 'utf8');
  check('公開回答ページはアプリと同じ style.css を読む',
    attendHtml.includes('href="/style.css"') && !attendHtml.includes('<style>'), true);
  /* 重ねて出すシートではなく1枚のページ。ボトムシートのままだとスマホで
     上に12vhぶんの黒い帯が残るので、.atpage-in で打ち消して画面いっぱいにする */
  check('公開回答ページは1枚のページとして画面いっぱいに出る',
    attendHtml.includes('class="atpage"')
      && attendHtml.includes('class="sheet atpage-in"')
      && !attendHtml.includes('class="scrim open"')
      && styleSource.includes('.sheet.atpage-in{max-height:none;border-radius:0'), true);
  /* ログインしていない人が開くページなので、アプリ本体のテーマ設定は読まない */
  check('公開回答ページの配色は常にライト',
    attendHtml.includes('<html lang="ja" data-theme="light">')
      && !attendHtml.includes("localStorage.getItem('ops_theme_v1')"), true);
  check('公開回答ページに出欠集計がある',
    attendHtml.includes('出欠集計') && attendHtml.includes('日程を押すと、誰が何を答えたかが見られます'), true);
  check('いちばん人数の多い候補に最有力が付く',
    attendHtml.includes('class="atl ') && attendHtml.includes('最有力'), true);
  /* 集計は背後に残したまま、内訳を上に重ねて出す。
     閉じ方は「外側を押す」「ESC」「出欠集計へ戻る」の3つとも残すこと */
  check('集計の行を押すと回答状況が重なって出る',
    attendHtml.includes('function openOption(')
      && attendHtml.includes('function setOptionModal(')
      && attendHtml.includes('出欠集計へ戻る')
      && styleSource.includes('.atmodal{position:fixed;inset:0;z-index:60'), true);
  check('回答状況は外側・ESC・戻るボタンの3つで閉じられる',
    attendHtml.includes('if(e.target===m)closeOption();')
      && attendHtml.includes("if(e.key==='Escape')closeOption();")
      && attendHtml.includes('class="atback" onclick="closeOption()"'), true);
  check('回答状況を開いている間は背後のページを動かさない',
    attendHtml.includes("classList.add('atmodal-lock')")
      && styleSource.includes('body.atmodal-lock{overflow:hidden}'), true);
  check('あなたの回答が候補ごとに並ぶ',
    attendHtml.includes('あなたの回答') && attendHtml.includes('候補ごとに選んでください'), true);
  /* この2つは消してはいけない。名前が無いと誰の回答か分からなくなり、
     共有URLが無いとこの画面から人に配れなくなる */
  check('名前の入力欄が残っている', attendHtml.includes('id="respondentName"'), true);
  check('共有URLのコピーが残っている',
    attendHtml.includes('id="attUrl"') && attendHtml.includes('copyShareUrl'), true);
  /* legend は flex の子として並ばず、日程が行の上に飛び出す */
  check('回答の行に fieldset と legend を使っていない',
    attendHtml.includes('<legend'), false);

  const publicModePos = appHtml.indexOf("{id:'public',label:'誰でも回答OK'}");
  check('出欠の宛先先頭に「誰でも回答OK」がある',
    publicModePos >= 0
      && publicModePos < appHtml.indexOf("{id:'all_staff',   label:'支部の全スタッフ'}"), true);
  /* 「自分」あてはタスクのための選び方だったので、タスクと一緒に外した（2026-10-05） */
  check('あて先に「自分」は無い',
    appHtml.includes("label:'自分'"), false);
  check('宛先の選び方はすべて並べる（タスク用の絞り込みは無い）',
    appHtml.includes('const modeBtns=REQ_MODES.map(') && !appHtml.includes('REQ_MODES.filter('), true);
  check('あて先が0人のときは、選び方に応じた言い方をする',
    appHtml.includes('支部にほかのスタッフがいません。「誰でも回答OK」を選ぶか、管理者にご連絡ください')
    && appHtml.includes("'あて先の相手を選んでください'"), true);
  check('日程調整を開くと公開モードが初期選択される',
    appHtml.includes("REQFORM={mode:'public',picked:[],"), true);
  check('公開モードを送信APIへ明示する',
    appHtml.includes("const publicMode=REQFORM.mode==='public';")
    && appHtml.includes('public_access:publicMode})'), true);
  /* 依頼フォームの説明文はすべて撤去した（2026-08-19）。
     「いまのあて先：○○」の行もその一部で、宛先の欄そのものを見れば分かる */
  check('依頼フォームに「いまのあて先」の行は無い',
    appHtml.includes('いまのあて先'), false);
  check('宛先の見出しは「宛先」の2文字',
    appHtml.includes('<label class="fl" style="margin-top:0">宛先</label>')
      && !appHtml.includes('あて先の選び方'), true);
  /* タスク（ふつうの依頼）は機能ごと撤去した（2026-10-05）。
     詳細・完了・取り消しの画面と、そのためだけのCSSが残っていないこと */
  check('タスクの詳細・完了の画面は残っていない',
    appHtml.includes('class="rq-body"') || appHtml.includes('class="rq-meta"')
      || appHtml.includes('completeRequest') || appHtml.includes('undoRequestCompletion')
      || appHtml.includes('hasConfirmed('), false);
  check('タスクの詳細だけで使うCSSは残っていない',
    styleSource.includes('.rq-body{') || styleSource.includes('.rq-meta{'), false);
  check('日程調整のタブは未回答と回答済みを切り替える',
    appHtml.includes('<span class="segb">未回答${pending')
      && appHtml.includes('<span class="segb">回答済み</span>')
      && !appHtml.includes('<span class="segb">完了済みの依頼</span>'), true);
  /* スタッフの「日程調整」タブは、回答を見る「面談一覧・時間」と、作成フォームを
     直接開く「候補日を送る」「空き時間を聞く」に分けた。インターン生は受け取るだけなので「日程調整」のまま */
  /* 2026-10-05：予約スケジュールを「面談一覧・時間」の直後に足した */
  check('スタッフの左メニューは「面談一覧・時間」「予約スケジュール」＋作成フォームを開く2つ',
    appHtml.includes("{id:'interviews',label:'面談一覧・時間',ic:'list'},\n    {id:'booking',label:'予約スケジュール',ic:'alarm'},\n    {id:'send',label:'候補日を送る',ic:'calendar-check',run:'openRequestForm',demo:'attend'},\n    {id:'freeform',label:'空き時間を聞く',ic:'clock',run:'openFreeslotForm',demo:'free'}")
      && appHtml.includes("{id:'requests',label:'日程調整',ic:'calendar-check'}")
      && appHtml.includes('<h1 class="page">日程調整</h1>')
      && !appHtml.includes('面談一覧・確定</') && !appHtml.includes("'面談一覧・確定'"), true);
  /* 2026-10-09：タブで切り替えるのをやめ、開いたら3つが縦に並んで一度に見えるようにした */
  check('「面談一覧・時間」に面談・日程調整・空き時間の回答がまとまっている（タブなしで一度に見える）',
    appHtml.includes('<h1 class="page">面談一覧・時間</h1>')
      && appHtml.includes("${sec('iv','list','面談',applied,internInviteCard()+interviewsPanel())}")
      && appHtml.includes("${sec('req','calendar-check','日程調整',pending,requestsPanel())}")
      && appHtml.includes("${sec('free','clock','空き時間',FSLIST.length,freeslotsPanel())}")
      && !appHtml.includes('name="ivHub"')
      && appHtml.includes("if(tab==='interviews')loadFreeslots();"), true);
  /* 2026-10-09：面談申請リンクを目立たせた。ホームと面談一覧の両方に、色の縁の入口とコピーボタン */
  check('面談申請リンクは色の縁の入口で、その場でコピーできる',
    appHtml.includes('<div class="cta ail-card" data-demo="apply">')
      && appHtml.includes('onclick="copyInternInviteLinkQuick()"')
      && appHtml.includes('const linkBtn=internInviteCard();')
      && fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8').includes('.ail-card .ail-copy'), true);
  /* カレンダー連携の入口は左メニューだけ。ホームの入口タイルにもプロフィールにも置かない */
  check('カレンダー連携の入口は左メニューだけにある',
    (appHtml.match(/openGoogleCalendarSettings\(\)"/g) || []).length === 1
      && !appHtml.includes("hex('openGoogleCalendarSettings()'")
      && !appHtml.includes("['calendar','カレンダー連携'"), true);
  check('インターン生に渡すリンクの入口は「面談申請リンク」という名前',
    appHtml.includes('<span class="sl">面談申請リンク</span>')
      && appHtml.includes('<h3>面談申請リンク</h3>')
      && !appHtml.includes('リンク作成') && !appHtml.includes('インターン生に渡すリンクを作る'), true);
  /* 3つのフォームは、送った相手の画面が見えず違いが分かりにくい。
     カーソルを乗せると回答の様子の動画（demo/*.mp4）が下に流れる */
  check('3つのフォームの入口にデモ動画のホバー表示が付いている',
    appHtml.includes('data-demo="${t.demo}"') && appHtml.includes("demo:'attend'") && appHtml.includes("demo:'free'")
      && appHtml.includes('data-demo="apply" onclick="openInternInviteLink()"')
      && appHtml.includes("'候補日を送る','候補日を出して都合を聞く',0,false,'attend'")
      && appHtml.includes("'空き時間を聞く','URLで空いている時間を集める',0,false,'free'")
      && ['attend', 'free', 'apply'].every((k) => appHtml.includes(`src:'/demo/${k}'`))
      && appHtml.includes('type="video/mp4"') && appHtml.includes('type="video/webm"'), true);
  for (const k of ['attend', 'free', 'apply']) {
    for (const [ext, mime] of [['mp4', 'video/mp4'], ['webm', 'video/webm']]) {
      const vr = await fetch(BASE + `/demo/${k}.${ext}`);
      const vbuf = Buffer.from(await vr.arrayBuffer());
      check(`デモ動画 ${k}.${ext} が配信される`, vr.status === 200 && vr.headers.get('content-type') === mime && vbuf.length > 10000, true);
      // 動画は途中から読めること（Range）。先頭だけ欲しい再生側の要求に応えられないと、再生が始まらないブラウザがある
      const rr = await fetch(BASE + `/demo/${k}.${ext}`, { headers: { Range: 'bytes=0-99' } });
      check(`デモ動画 ${k}.${ext} は途中から読める`, rr.status, 206);
    }
  }
  /* 動画は横長（16:10）。縦長は見づらいとの指示。録画の大きさ（tools/record-demos.mjs の W,H）と比を合わせる */
  check('デモ動画の表示は横長で、ある程度の大きさがある',
    styleSource.includes('.demotip{position:fixed;z-index:90;width:440px;')
      && styleSource.includes('.demotip video{display:block;width:100%;aspect-ratio:16/10;'), true);
  check('デモ動画の置き場以外は配信されない', (await fetch(BASE + '/demo/nothing.mp4')).status, 404);
  /* アイコンだけだと何のボタンか伝わらなかったので、文字ラベル付きの
     固定ボタンにしてある。「送った日程調整」の文言そのものを検査する */
  check('送った日程調整は文字ラベル付きの固定ボタンで切り替える',
    appHtml.includes('class="rq-fab"')
      && appHtml.includes('toggleSentRequests()')
      && appHtml.includes("ic(REQTAB==='sent'?'back':'send')")
      && appHtml.includes("REQTAB==='sent'?'一覧へ戻る':'送った日程調整'")
      && styleSource.includes('.rq-fab{position:fixed;'), true);
  check('依頼一覧は固定ボタンに隠れない余白を持つ',
    appHtml.includes('class="rq-list-space"') && styleSource.includes('.rq-list-space{padding-bottom:'), true);
  check('完了と取り消しの操作は残っていない',
    appHtml.includes('>完了を取り消す</button>') || appHtml.includes("toast('完了しました')"), false);
  /* 出欠は「まだ答えられるのに答えていない」ものだけを未処理として数える。
     日程を決める（確定するともう答えられない）は確定した時点で完了済みへ、
     参加を確認する（確定後の予定に答える）は答えるまで未回答に残る */
  check('未処理件数は、まだ答えられる未回答の出欠確認だけを数える',
    appHtml.includes('function requestNeedsAction(r)')
      && appHtml.includes('function attendStillAnswerable(r)')
      && appHtml.includes("return !!ev&&ev.votable===true;")
      && appHtml.includes('if(!attendStillAnswerable(r))return false;')
      && appHtml.includes('return !attendResponses(r).some(a=>a.user_id===ME.id);')
      && appHtml.includes('if(!isAttend(r))return false;')
      && appHtml.includes('function allRequests(){return (DB.requests||[]).filter(isAttend);}'), true);
  /* 答えた瞬間に一覧の振り分けまで更新する。カード1枚だけ差し替えていたころは
     再読み込みするまで受けた依頼に残り続けていた */
  check('出欠の回答後は一覧も静かに描き直す',
    appHtml.includes('async function vote(evId,resp)')
      && /renderQuiet\(\);\s*if\(ok\)toast\('回答を記録しました'\);/.test(appHtml), true);
  /* 回答済み・確認済みは出欠も通常も完了済みタブへ移る。
     以前は出欠確認だけ回答後も受けた依頼に残り続けていた */
  check('答えた出欠確認も完了済みへ移る',
    appHtml.includes('const inbox=sortInboxByDue(received.filter(requestNeedsAction))')
      && appHtml.includes('const done=received.filter(r=>!requestNeedsAction(r))'), true);
  /* 受けた依頼（未処理）は締切が早い順。締切なしは末尾、同着は新着順で並べる */
  check('受けた依頼は締切が早い順に並ぶ',
    appHtml.includes('function sortInboxByDue(list)')
      && appHtml.includes("const da=a.due_date||'9999-99-99'"), true);
  check('完了済みの依頼は新しい順のまま',
    appHtml.includes('function myRequests(){')
      && appHtml.includes('.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))'), true);
  /* 入口は「日程を決める」「空き時間を確認」の2つ。
     「タスクを追加」は別のアプリへ移ったので外した（2026-10-05） */
  check('作成ボタンは「候補日を送る」「空き時間を聞く」で、ホームからもフォームを直接開く',
    appHtml.includes('onclick="openRequestForm()">${ic(\'calendar\')}候補日を送る</button>')
      && appHtml.includes('onclick="openFreeslotForm()">${ic(\'clock\')}空き時間を聞く</button>')
      && appHtml.includes("hex('openRequestForm()','calendar-check','候補日を送る'")
      && appHtml.includes("hex('openFreeslotForm()','clock','空き時間を聞く'")
      && !appHtml.includes('タスクを追加'), true);
  check('旧「新しく送る」の入口は残っていない',
    appHtml.includes('新しく送る</button>') || appHtml.includes('openSendPicker('), false);
  /* 「参加を確認する」は機能ごと撤去した（2026-08-19）。
     日にちが決まっている予定の出欠は「日程を決める」を候補1件で使えば足りる */
  check('参加を確認するの作成画面は残っていない',
    appHtml.includes('openRsvpForm') || appHtml.includes('RSVPCAL') || appHtml.includes('submitRsvp'), false);
  check('旧「出欠を確認する」の文言は残っていない', appHtml.includes('出欠を確認する'), false);
  /* フォームの中の「送るもの」二重切り替えは撤去した。
     外で選んだのに中でもう一度選ぶ形になっていた */
  check('依頼フォームに「送るもの」の切り替えは無い',
    appHtml.includes('<label class="fl">送るもの</label>'), false);
  check('3状態の言い方は ○参加／△未定／×不参加 に統一されている',
    appHtml.includes("const ATT_LABEL={ok:'参加',may:'未定',no:'不参加'}")
      && attendHtml.includes("const ATT_LABEL={ok:'参加',may:'未定',no:'不参加'}")
      && !attendHtml.includes('参加できる')
      && !attendHtml.includes('参加できない'), true);

  /* ---- 「参加を確認する」は撤去済み（2026-08-19） ----
     過去に送った分の予定は votable:true のまま残るので、
     カレンダー側の回答欄（下の検査）は今までどおり動く */
  check('参加を確認するの入力欄は残っていない',
    appHtml.includes('id="rsvpTitle"') || appHtml.includes('id="rsvpCalWrap"'), false);

  /* 確定した出欠確認は、依頼の詳細を開いてもカレンダーと同じイベントカードを見せる。
     ○△×の回答場所はカレンダー側（event_responses）に一本化されているため、
     依頼と出欠確認の入力欄をこのカードだけに重ねている（二重に持たない） */
  check('確定済みの出欠確認はカレンダーと同じカードを流用する',
    appHtml.includes('const ev=r.confirmed?(DB.events||[]).find(e=>e.id===r.event_id):null;')
      && appHtml.includes('eventCard(ev,false)'), true);
  check('依頼から開いたイベントカードは編集・削除を出さない',
    appHtml.includes('function eventCard(ev,showEdit)')
      && appHtml.includes('showEdit&&ev.creator_id===ME.id'), true);
  check('出欠の回答場所は確定前後で自動的に切り替わる',
    appHtml.includes('function attendResponses(r)')
      && appHtml.includes('if(r.confirmed&&r.event_id){'), true);
  check('場所を入力しないイベントは行ごと表示しない',
    appHtml.includes('${ev.location?`<div class="meta">')
      && !appHtml.includes("esc(ev.location||'—')"), true);

  /* カレンダー画面の操作バー。自分のGoogleカレンダーを隠すボタンと、
     月／リストの切り替えタブは分かりにくいという指摘で取り除いた。
     全社カレンダーへ飛ぶボタンは、縁も背景も無い ghost 表示だと押せることが
     伝わらなかったので、ふつうのボタンの見た目に変え、遷移を示す矢印を足した */
  check('自分のカレンダーを隠すボタンは無い',
    appHtml.includes('toggleMyCal') || appHtml.includes('myCalHidden') || appHtml.includes('MYCAL_HIDE_KEY'), false);
  check('月／リストの切り替えタブは無い',
    appHtml.includes('calview-tabs') || appHtml.includes('function agendaView(') || appHtml.includes('function setCalMode('), false);
  check('全社カレンダーのボタンはふつうのボタンの見た目にする',
    appHtml.includes('class="btn sm" onclick="openSharedCalendarSite()"')
      && appHtml.includes("全社カレンダー${ic('chevron')}</button>")
      && !appHtml.includes('class="btn ghost sm" onclick="openSharedCalendarSite()"'), true);

  /* 「日程調整」で確定した予定は、候補段階ですでに○△×を集めているので
     もう一度取らない（votable:false のとき簡潔に表示）。「出欠確認」や
     手作りの予定は今までどおり votable:true で回答を受け付ける */
  check('votableがfalseの予定は投票欄を出さない',
    appHtml.includes('const noVote=ev.votable===false;')
      && appHtml.includes('${(!isPrivate&&!noVote)?`')
      && appHtml.includes('回答者を見る（${resp.length}）'), true);
  check('確定後の集計はvotableがfalseなら候補段階の回答をそのまま使う',
    appHtml.includes('if(ev&&ev.votable===false)return r.responses||[];'), true);
  /* keep_votable を送る口（参加を確認する）は撤去したが、サーバー側の受け口は
     残してある。過去に votable:true で作られた予定を読む側の処理と対になっており、
     消しても得るものが無いため */
  check('画面から keep_votable を送る口はもう無い',
    appHtml.includes('keep_votable'), false);

  /* 予定の作成・編集フォーム。日付は入力欄をやめ、開いた日に固定する。
     説明は一番下、色は時間のすぐ下に移した。名前は空でも「タイトルなし」になる */
  check('予定フォームに日付の入力欄が無い',
    appHtml.includes('function openEventForm(id,dateKey)')
      && !appHtml.includes('type="date" id="evDate"')
      && appHtml.includes('type="hidden" id="evDate"'), true);
  check('予定の名前は空なら「タイトルなし」になる',
    appHtml.includes('placeholder="タイトルなし"')
      && appHtml.includes("document.getElementById('evTitle').value.trim()||'タイトルなし'"), true);
  check('色は時間のすぐ下、説明はいちばん下に移した',
    (() => {
      const f = appHtml.indexOf('function openEventForm(id,dateKey)');
      const g = appHtml.indexOf('async function saveEvent(id)');
      const seg = appHtml.slice(f, g);
      const iTime = seg.indexOf('時間<span class="req">');
      const iColor = seg.indexOf('カレンダーの色');
      const iVis = seg.indexOf('この予定を見られる人');
      const iDesc = seg.indexOf('説明</label>');
      const iBtn = seg.indexOf('saveEvent(');
      return iTime > 0 && iColor > iTime && iVis > iColor && iDesc > iVis && iBtn > iDesc;
    })(), true);
  check('編集画面から予定を削除できる（作成者のみ）',
    appHtml.includes('canEdit=!ev||ev.creator_id===ME.id')
      && appHtml.includes('この予定を削除</button>'), true);

  /* 日付をタップして出た一覧。支部の予定だけは押すとその予定を開ける
     （全社カレンダーと確定済みの面談は、今までどおり見るだけ） */
  check('日付タップの一覧は支部の予定だけ押せる',
    appHtml.includes('function openDayEventDetail(evId,dayKey)')
      && appHtml.includes("openDayEventDetail('${e.id}','${key}')"), true);
  check('全社カレンダーと面談の行は押せないまま',
    (() => {
      const iShared = appHtml.indexOf('...shared.map(e=>({t:sharedDate(e),html:row(');
      const iIvs = appHtml.indexOf('...ivs.map(iv=>({t:new Date(iv.confirmed_datetime),html:row(');
      const iList = appHtml.indexOf("...list.map(e=>({t:new Date(e.start_datetime),html:row(");
      if (iShared < 0 || iIvs < 0 || iList < 0) return false;
      const sharedSeg = appHtml.slice(iShared, iIvs);
      const ivSeg = appHtml.slice(iIvs, iList);
      return !sharedSeg.includes('openDayEventDetail') && !ivSeg.includes('openDayEventDetail');
    })(), true);
  check('日程なし切替は取り除かれている', appHtml.includes('日程を設定しない'), false);
  /* 終了時刻の入力欄は廃止し、開始時刻だけを30分刻みのプルダウンで選ぶ形にした */
  check('候補一覧に時間設定のプルダウンがある',
    appHtml.includes('id="reqAddTime"') && appHtml.includes('時間を設定しない'), true);
  /* 日付は入力欄をやめてカレンダーで選ぶ形にした */
  check('候補の日付は入力欄ではなくラベルで出す',
    appHtml.includes('class="optdate"') && !appHtml.includes('id="ro_d${i}"'), true);
  check('時刻は30分刻みのプルダウンで受ける',
    appHtml.includes('<select class="optt"')
      && appHtml.includes('function setReqOptTime('), true);
  check('終了時刻の入力欄は残っていない',
    appHtml.includes('候補${i+1}の終了時刻'), false);
  check('時刻のプルダウンはダークテーマでも読める',
    styleSource.includes(':root:not([data-theme="light"]) .optt{color-scheme:dark}'), true);
  check('自前の時刻ホイールは残っていない',
    appHtml.includes('REQWHEEL') || styleSource.includes('.reqwheel'), false);
  check('数字を打ち込む時刻入力欄は残っていない',
    appHtml.includes('inputmode="numeric"') || appHtml.includes('handleReqTimeInput('), false);
  /* 定義を消した関数の呼び出しが残っていると、その場で落ちる。
     消したものは名前ごと消えていることを確かめる（実際に呼び出しが1件残っていた） */
  check('消した関数の呼び出しが残っていない',
    ['normalizeReqTime', 'handleReqTimeInput', 'handleReqTimeBlur', 'selectReqTimeInput',
     'addReqOption', 'shiftReqTimeRange', 'setReqNoDate',
     'openReqWheel', 'closeReqWheelIfOpen', 'reqWheelHTML', 'commitReqWheel',
     'reqApplyTimeChange', 'setReqWithTime']
      .filter((name) => appHtml.includes(name)), []);
  check('同じ日をふやすボタンがある',
    appHtml.includes('duplicateReqOption(') && appHtml.includes("ic('copy')"), true);
  check('ふやすボタンは時間を設定している候補だけに出す',
    appHtml.includes('${o.t1?`<button type="button" class="optcopy"'), true);
  /* 選んだ日は1件ずつ縦に積む。横に折り返すチップは一覧として読みにくかった */
  check('選んだ日程は縦1列に並べる',
    appHtml.includes('class="optrow"')
      && styleSource.includes('.optlist{display:flex;flex-direction:column'), true);
  check('候補の行は角丸の四角で、丸いピルではない',
    styleSource.includes('.optrow{') && !styleSource.includes('.optchip'), true);
  check('時間を設定するプルダウンはカレンダーの下に置く',
    appHtml.indexOf('${reqCalendarHTML()}') < appHtml.indexOf('id="reqAddTime"'), true);
  check('カレンダーの空きマスは汎用の .empty を使わない',
    appHtml.includes('class="rc-d blank"') && styleSource.includes('.rc-d.blank'), true);
  check('カレンダーのマスは高さを決め打ちにする（7列が親幅に収まらなくなるため）',
    styleSource.includes('.rc-d{height:36px'), true);
  check('出欠確認の候補は空で始まる（日付はカレンダーで選ぶ）',
    appHtml.includes("opts:[],addTime:''"), true);
  check('候補を自動で作る仕組みは残っていない',
    !appHtml.includes('addReqOption') && !appHtml.includes('shiftReqTimeRange'), true);
  check('スタッフ画面は日付だけの内部時刻を表示しない',
    appHtml.includes("if(o?.has_time===false)return fmtDate(o.start)"), true);
  check('カレンダーも日付だけの内部時刻を表示しない',
    appHtml.includes("if(ev?.has_time===false)return ''"), true);
  check('日付だけの予定編集でも内部時刻を表示しない',
    appHtml.includes('const dateOnly=ev?.has_time===false'), true);
  check('Google通知OFFは日付だけの予定に限定する',
    serverSource.includes("picked.has_time === false ? { reminders: { useDefault: false } } : {}"), true);
  check('スタッフ画面は時間だけを日程未定と表示する',
    appHtml.includes("if(o?.has_date===false)return `${o.start_time}"), true);
  /* 送ったあとに公開ページへ飛ばすと、アプリの外へ出てしまい戻れない。
     どちらのあて先でも、その場で集計シートを開く */
  check('出欠を送ったあとページ遷移しない',
    appHtml.includes('location.assign(attendShareUrl'), false);
  check('出欠を送ったあとは集計シートを開く',
    appHtml.includes("toast(`${request.recipient_ids.length}名に送りました`);")
      && /\n  openAttendDetail\(request\.id\);\n\}/.test(appHtml), true);
  check('公開出欠の詳細に共有URLを表示する',
    appHtml.includes('誰でも回答できる共有URL'), true);
  check('公開出欠は回答人数に分母を表示しない',
    appHtml.includes("isPublicAttend(r)?`${numAns}人が回答`")
      && appHtml.includes('回答人数に制限なし'), true);
  check('回答人数は実際に回答した人だけを数える',
    appHtml.includes('const numAns=attendAnswered(r).length;'), true);
  /* 締切は年を選ばせない。締切に去年を選ぶことはなく、選択肢に並べても
     押し間違いのもとになる。月日から今日以降でいちばん近い年を当てる */
  check('依頼と出欠に共通の任意締切欄がある',
    appHtml.includes('回答の締切（任意）')
      && appHtml.includes('id="reqDueMonth"')
      && appHtml.includes('id="reqDueDay"'), true);
  check('締切欄に年の入力を出さない',
    appHtml.includes('type="date" id="reqDueDate"'), false);
  check('締切の年は月日から決める',
    appHtml.includes('function dueResolveDate(')
      && appHtml.includes('dueResolveDate(REQFORM.dueMonth,REQFORM.dueDay,ymd(new Date()))'), true);
  check('締切の時刻を選べて既定は23:59',
    appHtml.includes('id="reqDueTime"') && appHtml.includes("dueTime:'23:59'"), true);
  check('締切日と時刻を送信データに含める',
    appHtml.includes('due_date:dueDate||undefined')
      && appHtml.includes('due_time:dueTime||undefined'), true);
  check('依頼一覧と詳細に締切日を表示する',
    appHtml.includes('dueRequestMeta(r)') && appHtml.includes('dueRequestDetail(r)'), true);
  check('ホームに締切通知をまとめて表示する',
    appHtml.includes('dueHomeNotice()') && appHtml.includes('class="hint due-home"'), true);
  check('締切用CSSクラスはdue接頭辞を使う',
    styleSource.includes('.due-home') && styleSource.includes('.due-date'), true);

  const publicPage = await fetch(BASE + `/a/${publicToken}`);
  const publicPageHtml = await publicPage.text();
  check('公開回答ページを配信できる', publicPage.status, 200);
  check('公開回答ページ上部に共有URL欄がある', publicPageHtml.includes('id="attUrl"'), true);
  check('公開回答ページにURLコピーボタンがある', publicPageHtml.includes('copyShareUrl()'), true);
  check('公開回答ページは日付だけの内部時刻を表示しない',
    publicPageHtml.includes('o.has_time===false'), true);
  check('公開回答ページは時間だけを日程未定と表示する',
    publicPageHtml.includes('o.has_date===false'), true);
  check('公開回答ページに名前入力がある', publicPageHtml.includes('id="respondentName"'), true);
  check('公開回答ページに結果一覧がある', publicPageHtml.includes('class="atlist"'), true);
  check('公開回答ページに締切日と期限超過表示がある',
    publicPageHtml.includes('due_date')
      && publicPageHtml.includes('締切を過ぎています')
      && publicPageHtml.includes('due-date due-detail'), true);
  /* 締切の時刻まで決めてある依頼は、その時刻を回ったところで締切。
     時刻の無い古い依頼は今までどおり、その日いっぱいを締切前として扱う */
  check('公開回答ページも締切の時刻を見る',
    publicPageHtml.includes('r.due_time')
      && publicPageHtml.includes('nowHm()>r.due_time'), true);

  const noPublicName = await api(null, 'PUT', `/api/attendance/${publicToken}/response`, {
    name: '  ', answers: [{ option_id: 'op0', response: 'ok' }],
  });
  check('公開回答は名前が必須', noPublicName.status, 400);

  const firstPublicAnswer = await api(null, 'PUT', `/api/attendance/${publicToken}/response`, {
    name: '公開 太郎',
    answers: [{ option_id: 'op0', response: 'ok' }, { option_id: 'op1', response: 'no' }],
  });
  check('アカウントなしで回答できる', firstPublicAnswer.status, 200);
  check('初回回答で回答者キーが返る',
    typeof firstPublicAnswer.json.respondent_key === 'string'
      && firstPublicAnswer.json.respondent_key.length >= 32, true);
  const respondentKey = firstPublicAnswer.json.respondent_key;

  const changedPublicAnswer = await api(null, 'PUT', `/api/attendance/${publicToken}/response`, {
    name: '公開 太郎（変更）', respondent_key: respondentKey,
    answers: [{ option_id: 'op0', response: 'may' }, { option_id: 'op1', response: 'ok' }],
  });
  check('同じブラウザ用キーで回答を変更できる', changedPublicAnswer.status, 200);

  const badPublicKey = await api(null, 'PUT', `/api/attendance/${publicToken}/response`, {
    name: 'なりすまし', respondent_key: 'invalid-key',
    answers: [{ option_id: 'op0', response: 'no' }],
  });
  check('不正な回答者キーでは変更できない', badPublicKey.status, 403);

  const publicResults = await api(null, 'GET', `/api/attendance/${publicToken}`);
  const publicPerson = publicResults.json.respondents?.find((x) => x.name === '公開 太郎（変更）');
  check('URLを知る人は回答者名を見られる', !!publicPerson, true);
  check('URLを知る人は変更後の回答を見られる',
    publicPerson?.answers?.find((x) => x.option_id === 'op0')?.response, 'may');
  const ownerPublicView = await getDB(TOKENS.staff);
  const ownerPublicRequest = (ownerPublicView.requests || []).find((r) => r.id === publicMade.json.request?.id);
  check('依頼者の集計にも公開回答者名が返る',
    ownerPublicRequest?.public_respondents?.find((x) => x.id === publicPerson?.id)?.name, '公開 太郎（変更）');

  const publicDone = await api(TOKENS.staff, 'POST',
    `/api/requests/${publicMade.json.request?.id}/confirm`, { option_id: 'op0' });
  check('公開出欠も依頼者が確定できる', publicDone.status, 200);
  const publicLate = await api(null, 'PUT', `/api/attendance/${publicToken}/response`, {
    name: '公開 太郎（変更）', respondent_key: respondentKey,
    answers: [{ option_id: 'op0', response: 'no' }],
  });
  check('公開出欠も確定後は変更できない', publicLate.status, 409);

  // ---- タスク（ふつうの依頼）はもう作れないこと（2026-10-05 撤去） ----
  const normal = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: 'ふつうの依頼', body: '本文', target_label: 'x', recipient_ids: ['u_e2e_staff3'],
  });
  check('タスクは作れない', normal.status, 400);
  const normalKind = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: 'ふつうの依頼', body: '本文', target_label: 'x', recipient_ids: ['u_e2e_staff3'], kind: 'normal',
  });
  check('kind に normal を付けてもタスクは作れない', normalKind.status, 400);

  const dueOpts = [{ date: dueDate, has_date: true, has_time: false }];
  const attendWithDue = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '締切付きの日程調整', body: '本文', target_label: '個別',
    recipient_ids: ['u_e2e_staff3'], due_date: dueDate, due_time: '17:00', kind: 'attend', options: dueOpts,
  });
  check('締切日を付けた日程調整を作れる', attendWithDue.status, 200);
  const attendWithDueView = await getDB(TOKENS.staff3);
  check('締切日を付けた日程調整を読み出せる',
    (attendWithDueView.requests || []).find((r) => r.id === attendWithDue.json.request?.id)?.due_date,
    dueDate);
  check('日程調整の締切の時刻を読み出せる',
    (attendWithDueView.requests || []).find((r) => r.id === attendWithDue.json.request?.id)?.due_time,
    '17:00');
  const noDue = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '締切なしの日程調整', recipient_ids: ['u_e2e_staff3'], kind: 'attend', options: dueOpts,
  });
  check('締切日を付けずに日程調整を作れる', noDue.json.request?.due_date, undefined);

  const badDueTime = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '不正な締切時刻', recipient_ids: ['u_e2e_staff3'], due_date: dueDate, due_time: '25:00',
    kind: 'attend', options: dueOpts,
  });
  check('時刻の形が違う締切は作れない', badDueTime.status, 400);
  /* 日付の無い時刻は締切として使えないので、黙って落として依頼そのものは通す */
  const timeOnlyDue = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '時刻だけの締切', recipient_ids: ['u_e2e_staff3'], due_time: '17:00',
    kind: 'attend', options: dueOpts,
  });
  check('日付の無い締切時刻は捨てる', [timeOnlyDue.status, timeOnlyDue.json.request?.due_time], [200, undefined]);

  const malformedDue = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '不正な締切', recipient_ids: ['u_e2e_staff3'], due_date: '2026-02-30',
    kind: 'attend', options: dueOpts,
  });
  check('実在しない締切日は作れない', malformedDue.status, 400);
  const pastDue = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '過去の締切', recipient_ids: ['u_e2e_staff3'], due_date: '2000-01-01',
    kind: 'attend', options: dueOpts,
  });
  check('昨日以前の締切日は作れない', pastDue.status, 400);

  /* ---- 出欠確認（1件だけの予定に○△×で答える、旧「出欠を確認する」とは別物） ----
     画面の submitRsvp() は「候補1件の出欠確認を作る→その場で確定する」の2手順で
     実現している。サーバー側に専用APIは無いので、ここでも同じ2手順で確かめる */
  const rsvpDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 3 * 86400000));
  const rsvpMade = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: '7月度 支部定例ミーティング', body: '今月の活動報告と来月の予定共有を行います。',
    target_label: '支部の全スタッフ', recipient_ids: ['u_e2e_staff3', 'u_e2e_staff4'],
    kind: 'attend', options: [{ date: rsvpDate, has_date: true, has_time: false }],
  });
  check('出欠確認（1件）を作れる', rsvpMade.status, 200);
  check('候補は1件だけ', rsvpMade.json.request?.options?.length, 1);
  const rsvpOptId = rsvpMade.json.request?.options?.[0]?.id;
  /* submitRsvp() は候補が1件しか無く、確定した瞬間が答える機会そのものなので、
     keep_votable:true を送って確定後も○△×を受け付け続けるようにする */
  const rsvpConfirm = await api(TOKENS.staff, 'POST', `/api/requests/${rsvpMade.json.request?.id}/confirm`,
    { option_id: rsvpOptId, keep_votable: true });
  check('その場ですぐ確定できる', rsvpConfirm.status, 200);
  const rsvpEventId = rsvpConfirm.json.event?.id;
  check('確定するとカレンダー予定ができる', !!rsvpEventId, true);
  check('カレンダー予定の名前は依頼の件名を引き継ぐ', rsvpConfirm.json.event?.title, '7月度 支部定例ミーティング');
  check('時間は設定していない予定になる', rsvpConfirm.json.event?.has_time, false);
  check('出欠確認は確定後も引き続き出欠を取る', rsvpConfirm.json.event?.votable, true);

  // 確定後の○△×は、依頼側ではなくカレンダー予定（イベント）の回答として集計される
  const rsvpVote = await api(TOKENS.staff3, 'PUT', `/api/events/${rsvpEventId}/response`, { response: 'ok' });
  check('出欠確認に確定後は支部のスタッフが回答できる', rsvpVote.status, 200);
  const rsvpView = await getDB(TOKENS.staff3);
  const rsvpReq = (rsvpView.requests || []).find((r) => r.id === rsvpMade.json.request?.id);
  check('確定した出欠確認は完了状態で読み出せる', rsvpReq?.confirmed, rsvpOptId);
  check('確定した出欠確認にはカレンダー予定のidが付く', rsvpReq?.event_id, rsvpEventId);
  check('確定後の回答がカレンダー予定の回答として残る',
    (rsvpView.event_responses || []).some((x) => x.event_id === rsvpEventId && x.user_id === 'u_e2e_staff3' && x.response === 'ok'),
    true);
}

/* 自分のGoogleカレンダーの取り込み。
   テスト環境ではGoogle連携そのものが無効なので、ここで確かめられるのは
   「連携していない人には何も返らない」「他人のぶんは要求しようがない」の2点。
   実際の取得はGoogle側の応答が要るため、ここでは扱わない */
async function testMyCalendar() {
  console.log('\n─────── 自分のGoogleカレンダーの取り込み ───────');
  const range = `?timeMin=${encodeURIComponent(new Date().toISOString())}`
    + `&timeMax=${encodeURIComponent(new Date(Date.now() + 30 * 86400000).toISOString())}`;
  const r = await api(TOKENS.staff, 'GET', '/api/my-calendar/events' + range);
  check('連携していなければ空で返る', r.json.events, []);
  check('連携していないことが分かる形で返る', r.json.connected, false);
  check('カレンダー画面を壊さないよう200で返す', r.status, 200);

  /* Google連携そのものが無効な環境では、期間の指定を見る前に空で返る。
     カレンダー画面を出せなくしないための作りなので、これで正しい */
  const noRange = await api(TOKENS.staff, 'GET', '/api/my-calendar/events');
  check('連携が無効なら期間指定が無くても空で返る', noRange.status, 200);
  check('その場合も中身は空', noRange.json.events, []);

  const noAuth = await fetch(BASE + '/api/my-calendar/events' + range);
  check('ログインしていなければ返さない', noAuth.status, 401);

  /* 誰のカレンダーを返すかは、URLではなくログインしている本人から決めている。
     他人のIDを添えても自分のぶんしか返らない（＝他人の予定は取り出せない） */
  const spoof = await api(TOKENS.staff3, 'GET', '/api/my-calendar/events' + range + '&staffId=u_e2e_staff');
  check('他人のIDを付けても他人の予定は取れない', spoof.json.connected, false);
}

/* ---------- iCalendar の文字列仕様 ---------- */
async function testICalendarFormatting() {
  console.log('\n─────── iCalendar文字列 ───────');
  let ical = null;
  try {
    ical = await import(pathToFileURL(path.join(ROOT, 'server', 'ical.js')).href);
  } catch { /* RED工程では未実装 */ }
  check('iCalendar組み立て関数を独立モジュールから読める', !!ical, true);
  if (!ical) return;

  check('本文の記号と改行をエスケープする',
    ical.escapeICalText('A,B;C\\D\r\nE\nF'), 'A\\,B\\;C\\\\D\\nE\\nF');
  check('UTC時刻をYYYYMMDDTHHMMSSZで書く',
    ical.formatICalDateTime('2026-08-08T01:02:03.456Z'), '20260808T010203Z');

  const longLine = 'SUMMARY:' + '日本語の長い予定名'.repeat(12);
  const folded = ical.foldICalLine(longLine);
  const physical = folded.split('\r\n');
  check('75オクテットを超える行を折り返す',
    physical.every((line) => Buffer.byteLength(line, 'utf8') <= 75), true);
  check('折り返した続きの行は空白で始まる',
    physical.slice(1).every((line) => line.startsWith(' ')), true);
  check('日本語を文字の途中で壊さず折り返す',
    physical.map((line, i) => i ? line.slice(1) : line).join(''), longLine);

  const calendar = ical.buildICalendar([{
    id: 'ev_all_day', allDay: true, start: '2026-08-08', end: '2026-08-09',
    updatedAt: '2026-08-01T00:00:00Z', summary: '終日の予定', description: '短い説明',
  }]);
  check('終日の予定はVALUE=DATEで書く',
    calendar.includes('DTSTART;VALUE=DATE:20260808\r\nDTEND;VALUE=DATE:20260809'), true);
  check('iCalendar全体をCRLFで終える', /\r\n$/.test(calendar) && !/(^|[^\r])\n/.test(calendar), true);
}

/* ---------- カレンダー購読（撤去済み）----------
   iPhone/Googleカレンダーへ .ics を購読させる機能は 2026-08-19 に取り除いた。
   使う人がほとんど居ないわりに、合鍵つきの公開URLという重い仕組みを
   抱え込んでいたため。戻したくなったときのために、消えていることを検査する */
async function testCalendarSubscription() {
  console.log('\n─────── カレンダー購読の撤去 ───────');
  const issued = await api(TOKENS.staff, 'GET', '/api/calendar/subscription');
  check('購読URLの発行APIは無い', issued.status, 404);
  const regen = await api(TOKENS.staff, 'POST', '/api/calendar/subscription/regenerate', {});
  check('購読キーの再発行APIは無い', regen.status, 404);
  const feed = await fetch(BASE + '/api/calendar/' + 'x'.repeat(43) + '.ics');
  check('.ics の配信口も無い', feed.status, 404);
  const appHtml = await (await fetch(BASE + '/')).text();
  check('プロフィール設定から「カレンダーに登録」を消した',
    appHtml.includes("'カレンダーに登録'") || appHtml.includes('openCalendarSubscriptionSettings'), false);
}

async function testSharedCalFilter() {
  console.log('\n─────── 全体予定表から外す予定の判定 ───────');
  const f = createRequire(path.join(ROOT, 'server', 'package.json'))('./shared-cal-filter.js');
  const words = f.parseExcludeWords(undefined);   // 未設定なら既定のOPS
  check('環境変数が未設定なら OPS を外す', words, ['ops']);

  const ev = (title) => ({ title });
  const titles = (list) => f.filterSharedEvents(list, words).map((e) => e.title);

  check('OPSチーム定例MTGは配らない', f.isExcluded('OPSチーム定例MTG', words), true);
  check('小文字のopsも配らない', f.isExcluded('ops定例', words), true);
  check('全角のＯＰＳも配らない', f.isExcluded('ＯＰＳ定例', words), true);
  check('7月分エジプト報告は配る', f.isExcluded('7月分エジプト報告', words), false);
  check('★重要★対議員請求書差止報告は配る', f.isExcluded('★重要★対議員請求書差止報告', words), false);
  check('タイトルが空でも落ちない', f.isExcluded('', words), false);

  check('一覧から除外したものだけが消える',
    titles([ev('OPSチーム定例MTG'), ev('7月分エジプト報告'), ev('ops振り返り'), ev('★重要★対議員請求書差止報告')]),
    ['7月分エジプト報告', '★重要★対議員請求書差止報告']);

  const two = f.parseExcludeWords('OPS, 研修 ');
  check('カンマ区切りで語句を増やせる', two, ['ops', '研修']);
  check('増やした語句も外れる', f.isExcluded('新人研修', two), true);

  const none = f.parseExcludeWords('');
  check('空にすれば何も外さない', f.filterSharedEvents([ev('OPS定例')], none).length, 1);
}

async function testGoogleSyncFilter() {
  console.log('\n─────── Googleカレンダーwebhook：自分が作った予定の除外 ───────');
  const f = createRequire(path.join(ROOT, 'server', 'package.json'))('./google-sync-filter.js');

  const ev = (id, summary) => ({ id, summary });
  const own = new Set(['gev_mine']);

  check('自分の面談確定イベントは除外される',
    f.excludeOwnEvents([ev('gev_mine', '面談: 田中さん'), ev('gev_other', '歯医者')], own)
      .map((e) => e.id),
    ['gev_other']);
  check('自分のイベントが無ければ何も除外しない',
    f.excludeOwnEvents([ev('gev_a', 'a'), ev('gev_b', 'b')], new Set()).length, 2);
  check('該当が無ければ空配列を返しても落ちない',
    f.excludeOwnEvents([], own).length, 0);
  check('items が undefined でも落ちない',
    f.excludeOwnEvents(undefined, own).length, 0);

  /* ここから先はサーバーのソースを直接検査する。
     テスト環境では GOOGLE_CLIENT_ID 等が無く GOOGLE_ENABLED が false になるため、
     webhook エンドポイントを実際に叩いての統合テストができない
     （早期 return で何もせず 200 を返すだけになる）。
     そのため、webhook ハンドラが上のフィルタ関数を正しく通しているかを
     ソースコードの文字列で検査する（apply.html 等の検査と同じやり方）。
     2026-08-10：面談確定でGoogleに書き込んだ自分のイベントが、
     webhook経由でそのまま「外部予定」として不可時間に二重登録されるバグを発見・修正 */
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  check('server.js が google-sync-filter を読み込んでいる',
    serverSrc.includes("require('./google-sync-filter')"), true);
  check('webhookハンドラが自分の面談イベントを除外してから取り込む',
    /app\.post\('\/api\/webhooks\/google-calendar'[\s\S]{0,2000}ownGoogleEventIdsFor[\s\S]{0,400}excludeOwnEvents/.test(serverSrc),
    true);
  check('確定済み面談のgoogleEventIdとgoogleEventIdInternの両方を集めている',
    /function ownGoogleEventIdsFor[\s\S]{0,600}googleEventId[\s\S]{0,300}googleEventIdIntern/.test(serverSrc),
    true);

  /* ---- 確定取消・作り直し時に、もう存在しないGoogle予定のブロックを掃除する ----
     2026-08-10：不成立に戻す／別日時で確定し直すたびに、Google側では
     削除済みのイベントに対応する external-google ブロックだけが
     不可時間に残り続けるバグを発見（本番データに30件超が蓄積していた）・修正 */
  const blk = (id, gid, note) => ({ id, kind: 'external-google', googleEventId: gid, note });
  check('削除したイベントに対応するブロックが取り除かれる',
    f.removeBlocksByEventId([blk('b1', 'gev_x', '面談: a'), blk('b2', 'gev_y', '面談: b')], 'gev_x')
      .map((b) => b.id),
    ['b2']);
  check('一致するブロックが無ければ何も変えない',
    f.removeBlocksByEventId([blk('b1', 'gev_x', 'x')], 'gev_zzz').map((b) => b.id),
    ['b1']);
  check('external-google以外のブロックは対象にしない',
    f.removeBlocksByEventId([{ id: 'b1', kind: 'slot', googleEventId: 'gev_x' }], 'gev_x').length,
    1);
  check('googleEventIdが空なら何も削除しない',
    f.removeBlocksByEventId([blk('b1', 'gev_x', 'x')], '').length, 1);
  check('blocksがundefinedでも落ちない',
    f.removeBlocksByEventId(undefined, 'gev_x').length, 0);

  check('deleteGoogleEventForが不可時間ブロックの掃除も行う',
    /async function deleteGoogleEventFor[\s\S]{0,600}removeExternalGoogleBlock/.test(serverSrc),
    true);
  check('removeExternalGoogleBlockがremoveBlocksByEventIdを使う',
    /async function removeExternalGoogleBlock[\s\S]{0,600}removeBlocksByEventId/.test(serverSrc),
    true);
}

async function testLockLogic() {
  console.log('\n─────── 書き込みの直列化（本番と同じ待ちを人工的に作る） ───────');
  const { withDBLock, _resetForTest } = createRequire(path.join(ROOT, 'server', 'package.json'))('./dblock.js');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // storeの「読む→変える→書く」を模した処理。待ちは本番のネットワーク相当
  const makeWorker = (state) => async () => {
    const snapshot = await sleep(5).then(() => state.value);   // 読む
    const next = [...snapshot, 'x'];                            // 変える
    await sleep(5);
    state.value = next;                                         // 書く
  };

  const bare = { value: [] };
  await Promise.all(Array.from({ length: 20 }, () => makeWorker(bare)()));
  check('直列化しないと20件の同時更新で書き込みが失われる（この失敗は想定どおり）',
    bare.value.length < 20, true);

  _resetForTest();
  const locked = { value: [] };
  await Promise.all(Array.from({ length: 20 }, () => withDBLock(makeWorker(locked))));
  check('直列化すれば20件すべてが残る', locked.value.length, 20);

  // 途中で失敗した処理があっても、後続を巻き添えにしない
  _resetForTest();
  const after = { value: [] };
  const results = await Promise.allSettled([
    withDBLock(async () => { throw new Error('わざと失敗'); }),
    withDBLock(makeWorker(after)),
    withDBLock(makeWorker(after)),
  ]);
  check('1件失敗しても後続は実行される', [results.map((r) => r.status), after.value.length],
    [['rejected', 'fulfilled', 'fulfilled'], 2]);
}

/* =========================================================
   テスト本体
   ========================================================= */
async function run() {
  console.log('\n─────── store から専用テーブルへの引っ越し ───────');
  {
    /* 起動時に一度だけ動く。テスト用DBには依頼1件・出欠1件・通知1件を
       store に入れてあるので、それがテーブル側で読めていれば移行できている */
    const admin = await getDB(TOKENS.admin);
    check('引っ越し前からあった依頼が読める', (admin.requests || []).some((r) => r.id === 'rq_osaka'), true);
    check('引っ越し前からあった出欠が読める', (admin.event_responses || []).some((r) => r.id === 'er_old'), true);
    check('引っ越し前からあった通知が読める', (admin.notifications || []).some((n) => n.id === 'nt_old'), true);
    check('出欠確認の種類と候補も引き継がれている',
      [(admin.requests || []).find((r) => r.id === 'rq_osaka')?.kind,
        (admin.requests || []).find((r) => r.id === 'rq_osaka')?.options?.length], ['attend', 1]);

    // store 側からは取り除かれているはず（二重管理になると必ず食い違う）
    const raw = await readStoreRaw();
    check('store から依頼が取り除かれている', 'requests' in raw, false);
    check('store から出欠が取り除かれている', 'event_responses' in raw, false);
    check('store から通知が取り除かれている', 'notifications' in raw, false);
    check('引っ越し済みの印が付いている', raw.movedToTablesV1, true);

    /* 引っ越しは後戻りしにくい処理なので、始める前に store の原本を
       store_backup へ複製している。取れていなければ、やり直しの手段が無いということ */
    const backups = await readStoreBackups();
    check('引っ越し前に原本が退避されている', backups.length, 1);
    check('退避した理由が記録されている', backups[0]?.reason, '専用テーブルへの引っ越し前');
    const before = JSON.parse(backups[0].data);
    check('退避した原本には引っ越し前の依頼が入っている',
      (before.requests || []).some((r) => r.id === 'rq_osaka'), true);
    check('退避した原本には引っ越し前のメールが入っている',
      (before.emails || []).some((m) => m.id === 'ml_old'), true);
    check('退避した原本には引っ越し前の面談が入っている',
      (before.interviews || []).some((iv) => iv.id === 'iv_old'), true);
    check('退避した原本にはまだ引っ越し済みの印が無い', before.movedToTablesV1 === undefined, true);
  }

  console.log('\n─────── タスク機能の撤去 ───────');
  {
    /* タスク（ふつうの依頼）は 2026-10-05 に機能ごと撤去した。
       起動時に、残っていたタスク・その通知・完了の記録の表を消す */
    const admin = await getDB(TOKENS.admin);
    check('残っていたタスクは消えている', (admin.requests || []).some((r) => r.id === 'rq_task_old'), false);
    check('タスクの通知は消えている', (admin.notifications || []).some((n) => n.id === 'nt_task'), false);
    check('出欠確認は消していない', (admin.requests || []).some((r) => r.id === 'rq_osaka'), true);
    check('読み出す依頼はすべて出欠確認', (admin.requests || []).every((r) => r.kind === 'attend'), true);
    check('依頼に完了の記録（read_by）を付けない',
      (admin.requests || []).some((r) => 'read_by' in r), false);
    const c = createClient({ url: 'file:' + DB_PATH });
    const tbl = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_reads'");
    c.close();
    check('完了の記録の表（request_reads）は無い', tbl.rows.length, 0);
  }

  console.log('\n─────── 情報漏えい（他支部のデータが見えないこと） ───────');
  {
    const intern = await getDB(TOKENS.staff3);
    const staff = await getDB(TOKENS.staff);
    check('インターン生に他支部の依頼が見えない',
      (intern.requests || []).some((r) => r.id === 'rq_osaka'), false);
    check('スタッフに他支部の依頼が見えない',
      (staff.requests || []).some((r) => r.id === 'rq_osaka'), false);
    check('インターン生に他支部のインターン先マスタが見えない',
      (intern.internships || []).some((p) => p.id === 'ip_osaka'), false);
    check('インターン生に他支部のプロフィールが見えない',
      Object.keys(intern.profiles || {}).includes('u_e2e_staff2'), false);

    const admin = await getDB(TOKENS.admin);
    check('全体管理者には他支部の依頼も見える',
      (admin.requests || []).some((r) => r.id === 'rq_osaka'), true);
  }

  console.log('\n─────── データ消失（保存した内容が残ること） ───────');
  {
    const res = await putDB(TOKENS.staff, (db) => {
      db.profiles = { ...(db.profiles || {}), u_e2e_staff: { departments: ['企画局'] } };
      db.events = [...(db.events || []), {
        id: 'ev_tokyo', creator_id: 'u_e2e_staff', branch_id: 'b1',
        title: '支部の予定', date: '2026-09-01', visibility: 'branch',
      }];
    });
    check('スタッフの保存が成功する', res.status, 200);

    const after = await getDB(TOKENS.staff);
    check('所属部署が保存されている', (after.profiles || {}).u_e2e_staff?.departments, ['企画局']);
    check('イベントが保存されている', (after.events || []).some((e) => e.id === 'ev_tokyo'), true);

    // 見えていないデータを巻き添えで消していないか（保存のたびに他支部が消えると致命的）
    const admin = await getDB(TOKENS.admin);
    check('他支部の依頼を巻き添えで消していない', (admin.requests || []).some((r) => r.id === 'rq_osaka'), true);
    check('他支部のインターン先を巻き添えで消していない', (admin.internships || []).some((p) => p.id === 'ip_osaka'), true);
    check('他支部のプロフィールを巻き添えで消していない', !!(admin.profiles || {}).u_e2e_staff2, true);
  }

  console.log('\n─────── 日程調整（専用API） ───────');
  {
    const futureDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() + 10 * 86400000));
    const opts = [{ date: futureDay, has_date: true, has_time: false }];
    const sent = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '東京の日程調整', body: 'テスト本文', target_label: '支部全員',
      recipient_ids: ['u_e2e_staff3', 'u_e2e_staff4'], kind: 'attend', options: opts,
    });
    check('スタッフが日程調整を送れる', sent.status, 200);
    REQ_ID = sent.json.request?.id;
    check('依頼IDが返る', typeof REQ_ID === 'string', true);

    const otherView = await getDB(TOKENS.staff3);
    const mine = (otherView.requests || []).find((r) => r.id === REQ_ID);
    check('あて先のスタッフに日程調整が見えている', !!mine, true);
    check('通知が積まれている', (otherView.notifications || []).some((n) => n.msg?.includes('東京の日程調整')), true);

    const other = await getDB(TOKENS.staff2);
    check('他支部のスタッフには見えない', (other.requests || []).some((r) => r.id === REQ_ID), false);

    /* 「完了」はタスクのためだけの操作だったので、APIごと外した */
    const read = await api(TOKENS.staff3, 'POST', `/api/requests/${REQ_ID}/read`);
    check('完了のAPIは無い', read.status, 404);
    const undo = await api(TOKENS.staff3, 'DELETE', `/api/requests/${REQ_ID}/read`);
    check('完了取り消しのAPIは無い', undo.status, 404);

    /* インターン生のアカウントを廃止したので、
       「送れない相手」の検証は他支部のスタッフで行う */
    const crossSend = await api(TOKENS.staff2, 'POST', '/api/requests', {
      subject: 'なりすまし', recipient_ids: ['u_e2e_staff4'], kind: 'attend', options: opts,
    });
    check('他支部の相手には日程調整を送れない', crossSend.status, 403);
    const crossBranch = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '他支部あて', recipient_ids: ['u_e2e_staff2'], kind: 'attend', options: opts,
    });
    check('他支部あてには送れない', crossBranch.status, 403);
  }

  console.log('\n─────── イベント出欠（専用API） ───────');
  {
    const mk = await putDB(TOKENS.staff, (db) => {
      db.events = [...(db.events || []), {
        id: 'ev_e2e', creator_id: 'u_e2e_staff', branch_id: 'b1',
        title: '説明会', date: '2026-09-01', visibility: 'branch',
      }];
    });
    check('イベントを作成できる', mk.status, 200);

    const v1 = await api(TOKENS.staff3, 'PUT', '/api/events/ev_e2e/response', { response: 'yes' });
    check('出欠に回答できる', v1.status, 200);
    let view = await getDB(TOKENS.staff3);
    check('回答が記録されている',
      (view.event_responses || []).some((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_staff3' && r.response === 'yes'), true);

    await api(TOKENS.staff3, 'PUT', '/api/events/ev_e2e/response', { response: 'no' });
    view = await getDB(TOKENS.staff3);
    check('回答を変えると上書きされる（重複しない）',
      (view.event_responses || []).filter((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_staff3').map((r) => r.response), ['no']);

    await api(TOKENS.staff3, 'PUT', '/api/events/ev_e2e/response', { response: 'no' });
    view = await getDB(TOKENS.staff3);
    check('同じ回答をもう一度押すと取り消される',
      (view.event_responses || []).some((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_staff3'), false);

    const outsider = await api(TOKENS.staff2, 'PUT', '/api/events/ev_e2e/response', { response: 'yes' });
    check('見えないイベントには回答できない', outsider.status, 403);
  }

  console.log('\n─────── 権限（許されない変更が拒否されること） ───────');
  {
    let res = await putDB(TOKENS.staff3, (db) => {
      db.profiles = { ...(db.profiles || {}), u_e2e_staff4: { departments: ['乗っ取り'] } };
    });
    check('インターン生が他人のプロフィールを書き換えられない', res.status, 403);

    res = await putDB(TOKENS.staff, (db) => {
      db.profiles = { ...(db.profiles || {}), u_e2e_staff3: { departments: ['代理で変更'] } };
    });
    check('スタッフでも他人のプロフィールは書き換えられない', res.status, 403);

    /* 古い画面を開いたままのタブが、専用テーブルへ移した項目を
       自分の持っている古い一覧で上書きしないこと */
    res = await putDB(TOKENS.staff, (db) => {
      db.requests = [];
      db.notifications = [];
      db.event_responses = [];
    });
    check('古い画面からの保存は受け付けても害がない', res.status, 200);
    const survived = await getDB(TOKENS.staff);
    check('依頼が消えていない', (survived.requests || []).some((r) => r.id === REQ_ID), true);
    check('通知が消えていない', (survived.notifications || []).length > 0, true);
  }

  /* 2026-08-12 のレビュー対応。
     どれも「気づかず元に戻すと、静かに穴が開く」たぐいの守りなので検査を残す */
  console.log('\n─────── 予定の作成者・支部のすり替え（2026-08-12） ───────');
  {
    // 自分の予定を1件作ってから、それを他支部・別人へ書き換えられないことを見る
    let res = await putDB(TOKENS.staff, (db) => {
      db.events = [...(db.events || []), {
        id: 'ev_own', creator_id: 'u_e2e_staff', branch_id: 'b1',
        title: '自分の予定', date: '2026-05-01', visibility: 'branch',
      }];
    });
    check('自分の支部の予定は作れる', res.status, 200);

    res = await putDB(TOKENS.staff, (db) => {
      db.events = (db.events || []).map((e) => (e.id === 'ev_own' ? { ...e, branch_id: 'b2' } : e));
    });
    check('あとから他支部へ付け替えられない', res.status, 403);

    res = await putDB(TOKENS.staff, (db) => {
      db.events = (db.events || []).map((e) => (e.id === 'ev_own' ? { ...e, creator_id: 'u_e2e_staff3' } : e));
    });
    check('あとから作成者を書き換えられない', res.status, 403);

    res = await putDB(TOKENS.staff, (db) => {
      db.events = (db.events || []).map((e) => (e.id === 'ev_own' ? { ...e, title: '題名だけ直す' } : e));
    });
    check('ふつうの編集はできる', res.status, 200);
  }

  console.log('\n─────── メールアドレスの配り先（2026-08-12） ───────');
  {
    const asStaff = await getDB(TOKENS.staff);
    const me = (asStaff.users || []).find((u) => u.id === 'u_e2e_staff');
    const other = (asStaff.users || []).find((u) => u.id === 'u_e2e_staff3');
    const otherBranch = (asStaff.users || []).find((u) => u.id === 'u_e2e_staff2');
    check('自分のアドレスは見える', me.email, 'e2e_staff@dot-jp.or.jp');
    check('同じ支部の他人のアドレスは見えない', 'email' in other, false);
    check('他支部の人のアドレスも見えない', 'email' in otherBranch, false);
    check('名前は今までどおり見える', other.nickname, 'E2E-staff');

    const asAdmin = await getDB(TOKENS.admin);
    check('全体管理者には見える（ユーザー管理で使う）',
      (asAdmin.users || []).find((u) => u.id === 'u_e2e_staff3').email, 'e2e_staff3@dot-jp.or.jp');
  }

  console.log('\n─────── イベント出欠の回答の見える範囲（2026-08-12） ───────');
  {
    /* ev_old は b2（大阪）のイベントで、そこへの回答 er_old が引っ越し済み。
       b1のスタッフには、イベントも回答も見えてはいけない */
    const asStaff = await getDB(TOKENS.staff);
    check('他支部のイベントは見えない',
      (asStaff.events || []).some((e) => e.id === 'ev_old'), false);
    check('他支部のイベントへの回答も渡らない',
      (asStaff.event_responses || []).some((r) => r.event_id === 'ev_old'), false);

    const asOwner = await getDB(TOKENS.staff2);
    check('自分の支部のイベントへの回答は見える',
      (asOwner.event_responses || []).some((r) => r.event_id === 'ev_old'), true);
  }

  console.log('\n─────── 退会したときの片付け（2026-08-12） ───────');
  {
    // 使い捨てのスタッフを作り、ひもづく物を置いてから消す
    const made = await api(TOKENS.admin, 'POST', '/api/admin/staff',
      { email: 'e2e_gone@dot-jp.or.jp', full_name: '退会する人', branch_id: 'b1' });
    check('片付け確認用のスタッフを作れた', made.status, 200);
    const goneId = made.json.user.id;
    const now = new Date().toISOString();
    const db = createClient({ url: 'file:' + DB_PATH });
    await db.execute({
      sql: `INSERT INTO google_tokens (staff_id, access_token, refresh_token, token_expiry, calendar_id, connected_at)
            VALUES (?,?,?,?,?,?)`,
      args: [goneId, 'x', 'y', now, 'primary', now],
    });
    await db.execute({
      sql: 'INSERT INTO calendar_subscriptions (user_id, subscription_key, created_at, updated_at) VALUES (?,?,?,?)',
      args: [goneId, 'k'.repeat(40), now, now],
    });

    const del = await api(TOKENS.admin, 'DELETE', `/api/admin/users/${goneId}`);
    check('退会させられる', del.status, 200);
    const left = async (table, col) => Number((await db.execute({
      sql: `SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`, args: [goneId],
    })).rows[0].n);
    check('Googleカレンダーの鍵が残らない', await left('google_tokens', 'staff_id'), 0);
    check('カレンダー購読の合鍵が残らない', await left('calendar_subscriptions', 'user_id'), 0);
    check('セッションが残らない', await left('sessions', 'user_id'), 0);
    db.close();
  }

  /* インターン先マスタは 2026-08-05 に受け付けをやめた。
     画面からは消したが、古いタブが開いたままの人が書き込めてしまわないこと。
     読み出しと、すでに入っている中身が残ることも合わせて見る */
  console.log('\n─────── インターン先（終了した機能） ───────');
  {
    let res = await putDB(TOKENS.staff, (db) => {
      db.internships = [...(db.internships || []), { id: 'ip_new', branch_id: 'b1', name: '追加できないはず' }];
    });
    check('インターン先は追加できない', res.status, 403);

    res = await putDB(TOKENS.admin, (db) => {
      db.internships = (db.internships || []).filter((p) => p.id !== 'ip_osaka');
    });
    check('全体管理者でもインターン先は削除できない', res.status, 403);

    const admin = await getDB(TOKENS.admin);
    check('もとから入っている中身は消えていない',
      (admin.internships || []).some((p) => p.id === 'ip_osaka'), true);
  }

  console.log('\n─────── 楽観ロック（同時編集の検出） ───────');
  {
    const cur = await getDB(TOKENS.staff);
    const body = { ...cur, _baseUpdatedAt: '2000-01-01T00:00:00.000Z' };
    delete body.users;
    const r = await fetch(BASE + '/api/db', { method: 'PUT', headers: H(TOKENS.staff), body: JSON.stringify(body) });
    check('古いバージョンでの保存は409で拒否される', r.status, 409);
  }

  console.log('\n─────── 同時アクセス ───────');
  {
    /* 【この検証の限界】
       ローカルのSQLiteは execute() がI/O待ちを起こさずマイクロタスクで解決するため、
       「読む→書く」の間に別のリクエストが割り込むことがない（検証済み）。
       つまりここで競合が出ないのは、直列化が効いているからとは限らない。
       本番のTursoはネットワーク越しなので割り込みが起き、競合は実際に起きうる。
       直列化そのものが働いているかは、この下の「書き込みの直列化」で確かめる。
       ここでは「多数の同時アクセスで落ちない・数が合う」ことを見ている */
    const before = (await getDB(TOKENS.admin)).emails?.length || 0;
    const N = 50;
    const statuses = await Promise.all(Array.from({ length: N }, (_, i) =>
      rawPost(TOKENS.staff, '/api/mail/send', { receiver_id: 'u_e2e_staff3', subject: '同時送信テスト' + i, body: 'x', kind: 'note' })));
    check(`メール${N}通の同時送信がすべて成功する`, statuses.every((s) => s === 200), true);
    const after = (await getDB(TOKENS.admin)).emails?.length || 0;
    check(`メール履歴が${N}件ぶん増えている（1件も消えない）`, after - before, N);

    /* 同じバージョンを土台にした同時保存は、1つだけ成功して残りは409。
       「両方200なのに片方の変更が消えている」が最も危険なので、それが起きないことを見る */
    const base = await getDB(TOKENS.staff);
    const mk = (n) => {
      const b = { ...base };
      delete b.users;
      b._baseUpdatedAt = base.updatedAt;
      b.events = [...(base.events || []), {
        id: 'ev_race' + n, creator_id: 'u_e2e_staff', branch_id: 'b1',
        title: '競合テスト' + n, date: '2026-09-02', visibility: 'branch',
      }];
      return fetch(BASE + '/api/db', { method: 'PUT', headers: H(TOKENS.staff), body: JSON.stringify(b) });
    };
    const races = await Promise.all([mk(1), mk(2), mk(3)]);
    const codes = races.map((r) => r.status).sort();
    check('同じ版を土台にした3件の同時保存は1件だけ成功する', codes, [200, 409, 409]);
    const afterRace = await getDB(TOKENS.staff);
    const saved = (afterRace.events || []).filter((e) => String(e.id).startsWith('ev_race')).length;
    check('成功した1件だけが保存されている', saved, 1);
  }

  console.log('\n─────── 面談（支部リンクからの申請） ───────');
  {
    /* インターン生のアカウントは廃止した。
       支部の合言葉つきURLから、本名だけで申請する形になっている */
    const linkRes = await api(TOKENS.staff, 'GET', '/api/staff/intern-invite-url');
    check('スタッフが支部の申請URLを取れる', linkRes.status, 200);
    const token1 = String(linkRes.json.url || '').split('/i/')[1];
    check('URLに合言葉が入っている', typeof token1 === 'string' && token1.length >= 32, true);

    const again = await api(TOKENS.staff, 'GET', '/api/staff/intern-invite-url');
    check('同じ支部なら同じURLが返る', String(again.json.url || '').split('/i/')[1], token1);
    const otherLink = await api(TOKENS.staff2, 'GET', '/api/staff/intern-invite-url');
    check('支部が違えば別のURLになる',
      String(otherLink.json.url || '').split('/i/')[1] !== token1, true);

    // 合言葉が正しくないと、支部の情報は一切出さない
    const bad = await api(null, 'GET', '/api/apply/deadbeef');
    check('でたらめな合言葉では開けない', bad.status, 404);

    const page = await api(null, 'GET', `/api/apply/${token1}`);
    check('合言葉だけで申請ページを開ける', page.status, 200);
    check('支部名が返る', page.json.branch?.name, '東京');
    const staffIds = (page.json.staff || []).map((x) => x.id).sort();
    check('選べるのは同じ支部のスタッフだけ', staffIds.join(','),
      'u_e2e_staff,u_e2e_staff3,u_e2e_staff4');
    check('メールアドレスは渡さない', 'email' in ((page.json.staff || [])[0] || {}), false);

    // 空き枠。今日から1週間ぶんの表で返る。受付時間を決めていなくても既定値で出る
    const slotRes = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff`);
    check('空き枠を取れる', slotRes.status, 200);
    check('今週から始まる', slotRes.json.week, 0);
    check('7日ぶんの表になる', (slotRes.json.days || []).length, 7);
    /* 表の左端は今日。以前は月曜始まりだったので、週の後半に開くほど
       左側が過ぎた日で埋まり、選べる枠が右端に寄っていた */
    {
      const t = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const todayKey = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
      check('表のいちばん左は今日', (slotRes.json.days || [])[0], todayKey);
      const last = new Date(t);
      last.setDate(t.getDate() + 6);
      check('表のいちばん右は6日先',
        (slotRes.json.days || [])[6],
        `${last.getFullYear()}-${p(last.getMonth() + 1)}-${p(last.getDate())}`);
      // 次の週は7日ぶんそのまま先へずれる（曜日をまたいで詰め直したりしない）
      const wk1 = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff&week=1`);
      const next = new Date(t);
      next.setDate(t.getDate() + 7);
      check('次の週は7日先から始まる',
        (wk1.json.days || [])[0],
        `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`);
    }
    /* 表の高さは全員・全曜日 9:00〜24:00 で固定（2026-10-06 から。以前は 9:00〜23:00）。
       2026-10-09 から、マス1つは「その時刻から30分」で時刻は線の横に出す。
       最後のマスは 23:30〜24:00（24:00 から始まるマスは無い。24:00 は線の横の文字だけ） */
    check('表はいつも9:00から始まる', (slotRes.json.times || [])[0], '09:00');
    check('表の最後のマスは23:30から', (slotRes.json.times || []).slice(-1)[0], '23:30');
    check('30分刻みで30マスある', (slotRes.json.times || []).length, 30);
    check('表の中身が日数ぶんある', (slotRes.json.grid || []).length, 7);
    check('表の1列が時間の数と一致する',
      (slotRes.json.grid || [])[0]?.length, (slotRes.json.times || []).length);
    check('先の週へ進める', slotRes.json.hasNext, true);
    check('前の週は無い', (await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff&week=-3`)).json.week, 0);
    const capped = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff&week=99`);
    check('先の週は上限で止まる', capped.json.week, 2);
    check('上限の週では次へ進めない', capped.json.hasNext, false);

    /* 申請画面に、選び方の説明が出ていること。
       インターン生は説明なしにこの画面へ来るので、
       どこで何を選ぶのかが分かる一文が要る（設計書 2節） */
    {
      const applyHtml = fs.readFileSync(path.join(ROOT, 'apply.html'), 'utf8');
      const GUIDE = '下のカレンダーから、<b>空いている時間帯</b>を選択してください。';
      check('申請画面にカレンダーで選ぶ旨の説明がある', applyHtml.includes(GUIDE), true);
      /* 説明は2行に短くした（2026-08-19）。長い注意書きは読まれないうえ、
         画面がその分だけ下へ伸びてカレンダーが遠のくため */
      check('選び方の説明は2行に収めてある',
        applyHtml.includes('選べる時間が多いほど日程が決まりやすくなります。')
        && !applyHtml.includes('面談の長さを決めるものではありません'), true);
      check('表の上の長い手順説明は消してある',
        applyHtml.includes('お名前と担当スタッフを選ぶと、空いている枠が表に出ます'), false);
      check('説明は担当スタッフ欄とカレンダーの間にある',
        applyHtml.indexOf('のスタッフから選べます') < applyHtml.indexOf(GUIDE)
        && applyHtml.indexOf(GUIDE) < applyHtml.indexOf('weekBlock(groups)'), true);
      /* 色付きの囲み（.hint）ではなく、本文と同じ字色で出すこと */
      check('説明は色付きの囲みにしない', applyHtml.includes('<div class="guide">'), true);
      /* 未入力のあいだだけ赤い＊を出す */
      check('お名前に必須の＊がある', applyHtml.includes('id="reqname"'), true);
      check('担当スタッフに必須の＊がある', applyHtml.includes('id="reqstaff"'), true);

      /* スマホの誤タップ対策。画面を送ろうとして表の上に指が乗っただけで
         枠が入ってしまうので、指のときは押さえてからでないと掴まない。
         ここを消すと同じ不具合が戻る */
      const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
      /* 押さえる長さ（HOLD_MS）は使い心地を見ながら動かす数字なので、値は縛らない。
         縛るのは「指のときだけ押さえてから選ぶ」という仕組みのほう */
      check('指のときだけ押さえてから選ぶ',
        applyHtml.includes("if(e.pointerType==='touch'){")
        && /var HOLD_MS=\d+;/.test(applyHtml), true);
      check('押さえる前に指が動いたら画面送りに譲る',
        applyHtml.includes('>HOLD_SLOP') && applyHtml.includes('clearApplyHold();'), true);
      check('押さえたあとのなぞりは画面送りに取られない',
        applyHtml.includes("document.addEventListener('touchmove',applyHoldMove,{passive:false})")
        && applyHtml.includes('e.preventDefault();     // ここから先は画面を動かさず'), true);
      check('動かさずに離したときは1マス選ぶ',
        applyHtml.includes('function applyHoldEnd(') && applyHtml.includes('startApplyDrag(h.cell,h.iso);'), true);
      /* 押さえ待ちの作りは受けられない時間の表（index.html）にも入れたので、
         既定のスクロールを残す指定は .apbook 限定ではなく .bt-c 全体になった */
      check('申請ページの表は既定のスクロールを残す',
        applyHtml.includes('class="booktable apbook"')
        && css.includes('.bt-c.ok,.bt-c.block{touch-action:auto'), true);
      const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      check('受けられない時間の表も押さえてからなぞる',
        indexHtml.includes('function beginAvHold(')
        && indexHtml.includes('AV_HOLD_MS') && indexHtml.includes('AV_HOLD_SLOP')
        && indexHtml.includes("document.addEventListener('touchmove',avHoldMove,{passive:false})"), true);
      check('入口タイルの薄い説明文は出さない',
        indexHtml.includes('<span class="hxd">${d}</span>'), false);
      check('入口タイルは中央に寄せ、パソコンでは横1列にする',
        css.includes('.hexrow{display:flex;justify-content:center;gap:var(--hgap)}')
        && css.includes('.hexgrid{flex-direction:row;justify-content:center;gap:var(--hgap)}')
        && css.includes('.hexrow{display:contents}'), true);
      check('選び方の一言が日時欄に出る',
        applyHtml.includes('押したまま上下になぞるとまとめて選べます'), true);

      /* 送信前の確認と、送信後の控え（2026-08-10 の指摘）。
         押した瞬間に飛んでいくと、間違いに気づく機会がまったく無かった */
      check('入力画面のボタンは送信ではなく確認へ進む',
        applyHtml.includes('onclick="goConfirm()"')
        && applyHtml.includes('件の内容を確認する'), true);
      check('確認画面では送信していないと明記する',
        applyHtml.includes('まだ送信していません。'), true);
      check('確認画面から書き直せる',
        applyHtml.includes('onclick="backToForm()"'), true);
      /* 実際に送るのは確認画面のボタンだけ。入力画面から直接 submitApply を
         呼ぶ口が復活すると、確認を挟まずに送れてしまう */
      check('submitApply を呼ぶ場所は1か所だけ',
        (applyHtml.match(/onclick="submitApply\(\)"/g) || []).length, 1);
      check('確認画面のボタン文言は「この内容で申請する」',
        applyHtml.includes('この内容で申請する'), true);
      check('送信後に控えを残す',
        applyHtml.includes('申請した内容（控え）') && applyHtml.includes('申請日時：'), true);
      check('控えをコピーできる',
        applyHtml.includes('onclick="copyReceipt()"') && applyHtml.includes('function receiptText('), true);
      check('控えは送った時点の内容で固める',
        applyHtml.includes('APPLY.receipt=sum;'), true);

      // 祝日は年をまたいでも出るよう、共通の計算ファイルから読む
      check('申請画面は祝日を手打ちしていない',
        /var HOLIDAYS=\{/.test(applyHtml), false);
      check('申請画面は共通の祝日ファイルを読む',
        applyHtml.includes('<script src="/holidays.js"></script>'), true);
    }

    /* 祝日。2026年ぶんの手打ちを規則からの計算に置き換えた（2026-08-10）。
       翌年以降も勝手に出ること、振替休日と国民の休日まで面倒を見ることを確かめる */
    {
      const holidayRes = await api(null, 'GET', '/holidays.js');
      check('holidays.js が配信されている', holidayRes.status, 200);
      const { holidaysOfYear } = createRequire(path.join(ROOT, 'server', 'package.json'))('../holidays.js');
      const y2026 = holidaysOfYear(2026);
      check('2026年の祝日は18件', Object.keys(y2026).length, 18);
      check('2026年の山の日', y2026['8-11'], '山の日');
      check('2026年の振替休日（5/3が日曜）', y2026['5-6'], '振替休日');
      check('2026年の国民の休日（9/22）', y2026['9-22'], '国民の休日');
      const y2027 = holidaysOfYear(2027);
      check('2027年も祝日が出る（手打ち切れしない）', Object.keys(y2027).length > 0, true);
      check('2027年の成人の日は1/11', y2027['1-11'], '成人の日');
      check('2027年の春分の日は3/21', y2027['3-21'], '春分の日');
      check('2027年の振替休日（3/21が日曜）', y2027['3-22'], '振替休日');
      // 2032年は敬老の日と秋分の日が1日空くので、あいだが国民の休日になる
      check('2032年の国民の休日（9/21）', holidaysOfYear(2032)['9-21'], '国民の休日');
    }

    /* ログインはGoogleだけ。パスワードの入力欄も会員登録も画面から消えていること（2026-08-10） */
    {
      const appHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      check('ログイン画面にパスワード欄が無い', appHtml.includes('id="loginPassword"'), false);
      check('会員登録の導線が無い', appHtml.includes('メールアドレスで会員登録する'), false);
      check('パスワードを忘れたの導線が無い', appHtml.includes("switchLoginView('forgot')"), false);
      check('パスワード変更の設定項目が無い', appHtml.includes('openPasswordChange()'), false);
      check('初回ログインから /staff へ進む',
        appHtml.includes('>初回ログイン</button>')
        && appHtml.includes('onclick="location.href=\'/staff\'">初回ログイン'), true);
      check('担当一覧のタブが無い', appHtml.includes("id:'myinterns'"), false);
      check('依頼の説明からインターン生が消えている',
        appHtml.includes('のスタッフ・インターン生に、連絡や出欠確認を出せます'), false);
      check('希望日時は空いている時間だと書いてある',
        appHtml.includes('第${i+1}希望（空いている時間）')
        && appHtml.includes('面談の長さではありません'), true);
      check('本体は共通の祝日ファイルを読む',
        appHtml.includes('<script src="/holidays.js"></script>')
        && !/const HOLIDAYS=\{/.test(appHtml), true);
    }

    /* ---- 2026-08-10（2回目）の改修 ---- */
    {
      const appHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
      const applySrc = fs.readFileSync(path.join(ROOT, 'apply.html'), 'utf8');
      const attendSrc = fs.readFileSync(path.join(ROOT, 'attendance.html'), 'utf8');
      const serverSource = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

      /* 既定はライト。ダークだと六角形タイルの色分けが定義されておらず、
         4つとも同じグレーになって情報が減るため */
      check('既定のテーマはライト',
        appHtml.includes("theme=t==='dark'?'dark':'light'")
        && appHtml.includes('el.setAttribute(\'data-theme\',theme)'), true);
      // OS側がダーク設定でも、style.css が届くまでの一瞬だけ黒く塗られて反転して見えるのを防ぐ
      check('起動直後の一瞬もアプリの配色に合わせる（黒フラッシュ対策）',
        appHtml.includes('el.style.colorScheme=theme')
        && appHtml.includes('document.documentElement.style.colorScheme=t')
        && applySrc.includes('<meta name="color-scheme" content="light">')
        && attendSrc.includes('<meta name="color-scheme" content="light">'), true);
      check('アドレスバーの色はライトの地色に合わせてある',
        appHtml.includes('<meta name="theme-color" content="#dbe9e7">')
        && appHtml.includes("t==='light'?'#dbe9e7':'#000000'"), true);
      /* テーマの入口はプロフィールの奥だけだと深すぎる。左メニューにも出す */
      check('テーマ切替が左メニューにもある',
        appHtml.includes('id="sbTheme" onclick="toggleTheme()"')
        && appHtml.includes('function themeSwitchLabel()')
        && appHtml.includes('function syncThemeButton()'), true);

      // アイコン。iPhoneはホーム画面に追加したときだけ通知が届くので、通知の前提でもある
      check('3つの画面すべてにアイコンがある',
        appHtml.includes('rel="apple-touch-icon" href="/icon-192.png"')
        && applySrc.includes('rel="apple-touch-icon" href="/icon-192.png"')
        && attendSrc.includes('rel="apple-touch-icon" href="/icon-192.png"'), true);
      /* アイコンの原本はベクター（icon.svg）。PNGはそこから書き出したもので、
         大きさを変えたいときは icon.svg を直してPNGを作り直す */
      check('アイコンの原本はベクターで持つ',
        appHtml.includes('rel="icon" href="/icon.svg" type="image/svg+xml"')
        && fs.existsSync(path.join(ROOT, 'icon.svg'))
        && fs.existsSync(path.join(ROOT, 'icon-192.png'))
        && fs.existsSync(path.join(ROOT, 'icon-512.png')), true);
      /* 字はフォントで書かず、線を1本ずつ置いて組んである。フォントで書くと
         端末に入っている書体しだいで太さも字形も変わってしまうため */
      check('アイコンの字は図形として描いてある',
        (() => {
          const svg = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8');
          return !svg.includes('font-family') && !svg.includes('<text');
        })(), true);
      check('ホーム画面に出る名前はアイコンと同じ「日調」',
        fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')
          .includes('"short_name": "日調"'), true);
      check('新しいアイコンはPUBLIC_FILESで配信を許可してある',
        serverSource.includes("'/icon.svg': 'icon.svg'")
        && serverSource.includes("'/icon-192.png': 'icon-192.png'")
        && serverSource.includes("'/icon-512.png': 'icon-512.png'"), true);
      check('manifest を読んでいる', appHtml.includes('rel="manifest" href="/manifest.webmanifest"'), true);
      check('検索結果用の説明文がある', appHtml.includes('<meta name="description"'), true);

      /* ---- 2026-08-19（4回目）の改修 ---- */
      {
        const cssSrc = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
        /* 面談を確定する画面の説明（「下は○○さんが空けている時間です…」）は外した。
           同じことは申請ページと希望入力（AVAIL_NOTE）でも言っている */
        check('確定画面に候補の説明文は出さない',
          appHtml.includes('この中から開始時刻を決めてください'), false);
        /* ダークでも入口タイルの枠に色が付く。以前は地に近いグレーで色が見えなかった */
        check('入口タイルの枠はダークでも色が付く',
          cssSrc.includes('--hex-line:#2f7d78;')
          && !cssSrc.includes('--hex-line:#262626'), true);
        /* カレンダーの下の一覧は撤去。日付を押して出るシートに一本化した */
        check('カレンダーの下に月の一覧を出さない',
          appHtml.includes('${m+1}月のイベント') || appHtml.includes('${listBlock}'), false);
        check('日付を押すとその日の予定のシートが開く',
          appHtml.includes(`onclick="openDaySheet('\${key}')"`), true);
        /* 依頼のタブ切り替えは、画面を読み込み直したように見えない描き方にする。
           「空き時間」タブを足したので1行では書けなくなった。
           render() ではなく renderQuiet() を通していることを見る */
        {
          const setReqTabSrc = appHtml.slice(appHtml.indexOf('function setReqTab(t){'));
          const bodyEnd = setReqTabSrc.indexOf('\n}');
          const body = setReqTabSrc.slice(0, bodyEnd);
          check('依頼のタブ切り替えは登場アニメをやり直さない',
            body.includes('renderQuiet()') && !body.includes('render();'), true);
        }
      }

      /* 面談一覧。申請からの経過時間や支部名ではなく、面談日時を優先して読む。 */
      const interviewListSource = appHtml.slice(
        appHtml.indexOf('function ivRowSub(iv)'),
        appHtml.indexOf('async function deleteInterviewRow(id)'));
      check('面談一覧の行に第1希望を出す',
        interviewListSource.includes('return `第1希望 ${fmtGroupRange(g)}`;'), true);
      check('面談一覧に担当件数・支部タグ・申請からの経過時間を出さない',
        !interviewListSource.includes('あなたが担当する面談 ${all.length}件')
        && !interviewListSource.includes('<span class="tag">${branchName(ivInternBranch(iv))}</span>')
        && !interviewListSource.includes('申請 ${fmtRel(iv.created_at)}'), true);
      check('確定済みの面談日時は強調表示する',
        interviewListSource.includes("iv.status==='fixed'?' iv-datetime':''")
        && styleCss.includes('.row .iv-datetime{font-size:16px;font-weight:800;color:var(--ink)}'), true);
      check('確定・未実施のゾーン見出しを出さない',
        !interviewListSource.includes("label:'面談予定（確定・未実施）'")
        && interviewListSource.includes("key:'fixed',label:''"), true);
      check('面談一覧を希望日が近い順に並べ替えられる',
        appHtml.includes("let IVSORT='new'")
        && appHtml.includes('function ivWishTime(iv)')
        && appHtml.includes('>希望日が近い順</button>'), true);

      /* 本命の「第1希望どおり確定」がいちばん押しやすい形になっていること */
      check('申請中の面談は第1希望を開いた状態で出す',
        appHtml.includes("IV_OPEN=new Set(iv.status==='applied'&&groups.length?[1]:[])"), true);
      check('不成立は確定の並びから外して最後に置く',
        appHtml.includes('<div class="danger-zone">')
        && appHtml.includes('>この申請を不成立にする</button>')
        && styleCss.includes('.danger-zone{'), true);

      /* 面談可能時間帯まわり。同じ画面で言葉が反転していたのを1つに揃えた */
      check('受けられる時間の用語が統一されている',
        appHtml.includes('<h3>面談を受けられる時間</h3>')
        && appHtml.includes('<h1 class="page">この日は受けられない時間</h1>')
        && !appHtml.includes('面談できない時間を登録'), true);
      check('「ホームへ戻る」が二重に出ない',
        appHtml.includes('ホームに戻る'), false);

      /* リマインド。明日の面談はカレンダーを開かないと気づけなかった */
      check('明日の面談をホームに出す',
        appHtml.includes('function tomorrowInterviews()')
        && appHtml.includes('function interviewHomeReminder()')
        && appHtml.includes('明日は面談が${list.length}件あります'), true);

      /* イベントカード。1件350pxのまま10件並ぶとホームが3,500px伸びていた */
      check('回答済みの予定カードは畳む',
        appHtml.includes('let EVOPEN=new Set()')
        && appHtml.includes('function toggleEventVote(evId)')
        && appHtml.includes('<div class="voted-row">'), true);
      check('○△×のボタンに上限幅がある', styleCss.includes('.vote3{display:flex;gap:8px;max-width:420px}'), true);

      // PCでは1カラムに縦積みせず、左右2列にしてスクロール量を減らす
      check('広い画面ではシートを2カラムにする',
        appHtml.includes('<div class="sheet2">')
        && styleCss.includes('.sheet:has(.sheet2){max-width:880px}'), true);

      /* プッシュ通知。受け取り役は /sw.js で、購読とオンオフは端末ごとに持つ */
      check('Service Worker がある',
        fs.existsSync(path.join(ROOT, 'sw.js'))
        && serverSource.includes("'/sw.js': 'sw.js'"), true);
      check('通知の設定は2種類を別々に切り替えられる',
        appHtml.includes("row('interview','面談の申請が届いたとき'")
        && appHtml.includes("row('request','参加確認が届いたとき'")
        && appHtml.includes("document.getElementById('push_interview').checked")
        && appHtml.includes("document.getElementById('push_request').checked")
        && appHtml.includes('function pushSubscribe(prefs)'), true);
      check('iPhoneにはホーム画面へ追加するよう案内する',
        appHtml.includes('function isIOSBrowser()') || appHtml.includes('const isIOSBrowser='), true);
      check('通知が使えるかはサーバーの鍵と端末の対応の両方で決まる',
        appHtml.includes('PUSH_AVAILABLE=!!boot.config.push&&!!PUSH_PUBLIC_KEY&&pushSupported()'), true);
      check('通知の口は自分の購読しか触れない',
        serverSource.includes("app.put('/api/push/subscribe', requireAuth")
        && serverSource.includes("app.post('/api/push/unsubscribe', requireAuth")
        && serverSource.includes("app.post('/api/push/state', requireAuth"), true);
      check('面談の申請は担当スタッフだけに通知する',
        serverSource.includes("push.sendToUsers(client, [ctx.staff.id], 'interview'"), true);
      check('依頼の通知は送った本人には飛ばない',
        serverSource.includes("push.sendToUsers(client, ids.filter((id) => id !== actor.id), 'request'"), true);
      // 鍵が無い環境では静かに無効のまま動くこと（ローカル開発で落ちないため）
      check('鍵が未設定なら通知は使えないと返す',
        serverSource.includes('push: push.PUSH_ENABLED')
        && serverSource.includes("pushPublicKey: push.PUSH_ENABLED ? push.PUBLIC_KEY : ''"), true);
    }

    /* スタッフの確定は、30分ボタンの一覧ではなく開始時刻の入力にする。
       打てるのは希望に含まれる枠の開始時刻だけ（設計どおり範囲外は弾く） */
    {
      const appHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      check('確定は時刻入力欄で行う', appHtml.includes('type="time" class="tin"'), true);
      check('時刻欄の右に「開始」と出る', appHtml.includes('<span class="tlab">開始</span>'), true);
      check('30分刻みに限定している', appHtml.includes('step="1800"'), true);
      check('確定後に「面談日程を確定しました」を出す',
        appHtml.includes('面談日程を確定しました'), true);
      check('確定後に学生への連絡を促す',
        appHtml.includes('まだ終わりではありません。') && appHtml.includes('必ず学生に確定した日程を連絡してください。'), true);
      check('確定後にメール作成画面へ自動で進まない',
        appHtml.includes("openSendMail(iv.intern_id,'面談確定のお知らせ'"), false);
    }

    const firstOpen = await firstOpenSlot(token1, 'u_e2e_staff');
    check('選べる枠がある', !!firstOpen, true);

    const crossSlots = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff2`);
    check('他支部のスタッフの枠は見られない', crossSlots.status, 400);

    // 申請
    const noName = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '  ', staff_id: 'u_e2e_staff', choices: [firstOpen.iso] });
    check('名前が空だと申請できない', noName.status, 400);
    const noSlot = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '山田 太郎', staff_id: 'u_e2e_staff', choices: [] });
    check('希望を選ばないと申請できない', noSlot.status, 400);
    const crossApply = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '山田 太郎', staff_id: 'u_e2e_staff2', choices: [firstOpen.iso] });
    check('他支部のスタッフには申請できない', crossApply.status, 400);
    const pastSlot = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '山田 太郎', staff_id: 'u_e2e_staff', choices: ['2020-01-01T10:00:00.000Z'] });
    check('過ぎた日時は申請できない', pastSlot.status, 409);
    /* 「終日OK」で1日28枠になるため、上限は見られる範囲をすべて選んでも通る幅にしてある。
       それでも際限なくは受け付けない */
    const tooMany = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '山田 太郎', staff_id: 'u_e2e_staff',
        choices: Array.from({ length: 601 }, (_, i) => new Date(Date.now() + i * 60000).toISOString()) });
    check('希望する枠が多すぎると断られる', tooMany.status, 400);

    /* 画面では続いた枠がひとつの希望にまとまるので、送られてくる枠は1件とは限らない。
       希望順は送った並びのまま保たれる必要がある */
    const second = await firstOpenSlot(token1, 'u_e2e_staff3');
    const third = await firstOpenSlot(token1, 'u_e2e_staff3', [second.iso]);
    const multi = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '複数希望 花子', staff_id: 'u_e2e_staff3', choices: [third.iso, second.iso] });
    check('希望を複数まとめて申請できる', multi.status, 200);
    const multiView = await getDB(TOKENS.staff3);
    const multiIv = (multiView.interviews || []).find((iv) => iv.intern_name === '複数希望 花子');
    check('送った並びのまま希望順が残る', (multiIv?.choices || []).join(','), `${third.iso},${second.iso}`);

    const applied = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '山田 太郎', staff_id: 'u_e2e_staff', choices: [firstOpen.iso], note: 'よろしくお願いします' });
    check('本名だけで面談を申請できる', applied.status, 200);
    check('相手のスタッフ名が返る', applied.json.staff_nickname, 'E2E-staff');

    // スタッフ側からの見え方
    const staffView = await getDB(TOKENS.staff);
    const mine = (staffView.interviews || []).find((iv) => iv.intern_name === '山田 太郎');
    check('担当スタッフに見える', !!mine, true);
    IV_ID = mine?.id;
    check('状態が「申請中」で作られる', mine?.status, 'applied');
    check('アカウントが無いので intern_id は空', mine?.intern_id, '');
    check('入力した本名が残る', mine?.intern_name, '山田 太郎');
    check('支部が入る', mine?.branch_id, 'b1');
    check('希望日時が保たれている', (mine?.choices || [])[0], firstOpen.iso);
    check('相談内容が残る', mine?.note, 'よろしくお願いします');

    /* 「終日OK」で申し込んだ日。途中に埋まった時間があっても
       スタッフ側で1件の希望として見せるため、日付を別に持たせている */
    const dayOf = (iso) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const allDaySlot = await firstOpenSlot(token1, 'u_e2e_staff4');
    const allDayApply = await api(null, 'POST', `/api/apply/${token1}`, {
      name: '終日 太郎', staff_id: 'u_e2e_staff4',
      choices: [allDaySlot.iso], all_day: [dayOf(allDaySlot.iso), 'これは日付ではない'],
    });
    check('終日OKつきで申請できる', allDayApply.status, 200);
    const allDayView = await getDB(TOKENS.staff4);
    const allDayIv = (allDayView.interviews || []).find((iv) => iv.intern_name === '終日 太郎');
    check('終日OKの日が残る', (allDayIv?.all_day || []).join(','), dayOf(allDaySlot.iso));
    check('日付の形でないものは捨てる', (allDayIv?.all_day || []).length, 1);

    /* サーバーの時計は日本時間に固定してある。Renderの実行環境はUTCなので、
       固定しないと画面に出ている時刻と実際の日時が9時間ずれる */
    const jstCheck = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff`);
    const anyCell = (jstCheck.json.grid || [])[0]?.[0];
    check('表の見出しの時刻と、枠の実際の時刻が一致する',
      `${String(new Date(anyCell.iso).getHours()).padStart(2, '0')}:${String(new Date(anyCell.iso).getMinutes()).padStart(2, '0')}`,
      jstCheck.json.times[0]);
    check('表の見出しの日付と、枠の実際の日付が一致する',
      dayOf(anyCell.iso), jstCheck.json.days[0]);

    const otherView = await getDB(TOKENS.staff2);
    check('他支部のスタッフには見えない',
      (otherView.interviews || []).some((iv) => iv.id === IV_ID), false);

    // 状態の変更（ここはこれまでどおりスタッフだけ）
    const noDate = await api(TOKENS.staff, 'PATCH', `/api/interviews/${IV_ID}`, { status: 'fixed' });
    check('日時なしでは確定できない', noDate.status, 400);
    const badStatus = await api(TOKENS.staff, 'PATCH', `/api/interviews/${IV_ID}`, { status: 'なにか' });
    check('知らない状態は受け付けない', badStatus.status, 400);

    const fixed = await api(TOKENS.staff, 'PATCH', `/api/interviews/${IV_ID}`,
      { status: 'fixed', confirmed_datetime: firstOpen.iso });
    check('スタッフが面談を確定できる', fixed.status, 200);
    check('確定日時が入る', fixed.json.interview?.confirmed_datetime, firstOpen.iso);
    check('確定しても本名は残る', fixed.json.interview?.intern_name, '山田 太郎');

    // 確定した枠は、次の人には出さない
    check('確定済みの枠はもう選べない',
      await slotStillOpen(token1, 'u_e2e_staff', firstOpen.iso), false);
    const retry = await api(null, 'POST', `/api/apply/${token1}`,
      { name: '別の人', staff_id: 'u_e2e_staff', choices: [firstOpen.iso] });
    check('埋まった枠を指定すると断られる', retry.status, 409);

    const crossBranch = await api(TOKENS.staff2, 'PATCH', `/api/interviews/${IV_ID}`, { status: 'applied' });
    check('他支部のスタッフは変更できない', crossBranch.status, 403);

    // 合言葉の作り直し
    const byStaff = await api(TOKENS.staff, 'POST', '/api/staff/intern-invite-url/regenerate');
    check('ふつうのスタッフは作り直せない', byStaff.status, 403);
    const regen = await api(TOKENS.admin, 'POST', '/api/staff/intern-invite-url/regenerate',
      { branch_id: 'b1' });
    check('管理者は作り直せる', regen.status, 200);
    const token2 = String(regen.json.url || '').split('/i/')[1];
    check('合言葉が新しくなる', token2 !== token1, true);
    const oldGone = await api(null, 'GET', `/api/apply/${token1}`);
    check('古い合言葉はもう通らない', oldGone.status, 404);
    const newOk = await api(null, 'GET', `/api/apply/${token2}`);
    check('新しい合言葉なら通る', newOk.status, 200);

    /* 廃止した入口。会員登録もパスワードログインも撤去したので、
       ルート自体が無くなって404になる（410の案内も出さない） */
    const oldRegister = await api(null, 'POST', '/api/auth/register-intern',
      { email: 'x@example.com', password: 'password123', nickname: 'x' });
    check('インターン生の会員登録は撤去されている', oldRegister.status, 404);
    const oldLogin = await api(null, 'POST', '/api/auth/login',
      { email: 'x@example.com', password: 'password123' });
    check('パスワードログインは撤去されている', oldLogin.status, 404);
    const oldForgot = await api(null, 'POST', '/api/auth/forgot-password', { email: 'x@example.com' });
    check('パスワード再設定は撤去されている', oldForgot.status, 404);
    const oldApply = await api(TOKENS.staff, 'POST', '/api/interviews', { choices: ['2026-09-01T10:00:00.000Z'] });
    check('ログイン経由の面談申請は廃止されている', oldApply.status, 410);
    const internSession = await api(TOKENS.oldIntern, 'GET', '/api/db');
    check('残っているインターン生のセッションでは入れない', internSession.status, 401);

    // 引っ越し前からあった面談
    const admin = await getDB(TOKENS.admin);
    check('引っ越し前の面談も読める', (admin.interviews || []).some((iv) => iv.id === 'iv_old'), true);
    const raw = await readStoreRaw();
    check('store から面談が取り除かれている', 'interviews' in raw, false);
  }

  /* ---------- 空き時間を確認（日程調整URL） ----------
     面談申請と違い、URLは押すたびに1本できて、担当は押した本人に固定される。
     学生は担当を選べず、希望順も付けない。空いている時間を知るためだけの口 */
  console.log('\n─────── 空き時間を確認（日程調整URL） ───────');
  {
    const made = await api(TOKENS.staff, 'POST', '/api/freeslots', { title: '山田さんとの日程調整' });
    check('スタッフが日程調整URLを発行できる', made.status, 200);
    check('URLに /f/ が入っている', /\/f\/[0-9a-f]{32,}$/.test(String(made.json.url || '')), true);
    check('件名が返る', made.json.title, '山田さんとの日程調整');

    const noTitle = await api(TOKENS.staff, 'POST', '/api/freeslots', { title: '  ' });
    check('件名が空なら断る', noTitle.status, 400);

    const again = await api(TOKENS.staff, 'POST', '/api/freeslots', { title: '2本目' });
    check('押すたびに別のURLになる', again.json.token !== made.json.token, true);

    const mine = await api(TOKENS.staff, 'GET', '/api/freeslots');
    check('自分が発行した分が一覧に出る', (mine.json.list || []).length, 2);
    check('新しいものが先頭', (mine.json.list || [])[0]?.title, '2本目');
    check('まだ誰も答えていない', (mine.json.list || [])[0]?.count, 0);

    const others = await api(TOKENS.staff3, 'GET', '/api/freeslots');
    check('他人が発行したものは見えない', (others.json.list || []).length, 0);

    const noAuth = await api(null, 'POST', '/api/freeslots', { title: 'ログイン無し' });
    check('ログインしないと発行できない', noAuth.status, 401);

    /* ここから学生側（ログイン不要）。合言葉だけで開いて、空いている時間を送る */
    const token = made.json.token;

    const bad = await api(null, 'GET', '/api/free/deadbeef');
    check('でたらめな合言葉では開けない', bad.status, 404);

    const page = await api(null, 'GET', `/api/free/${token}`);
    check('合言葉だけで日程調整ページを開ける', page.status, 200);
    check('ページに件名が返る', page.json.title, '山田さんとの日程調整');
    check('担当スタッフの名前が返る', page.json.staff?.nickname, 'E2E-staff');
    check('支部名が返る', page.json.branch?.name, '東京');
    check('メールアドレスは渡さない', 'email' in (page.json.staff || {}), false);
    // 担当は発行した本人に固定されているので、選ばせるための一覧は渡さない
    check('スタッフの一覧は渡さない', 'staffList' in page.json, false);

    const grid = await api(null, 'GET', `/api/free/${token}/slots`);
    check('空き枠を取れる', grid.status, 200);
    check('7日ぶんの表になる', (grid.json.days || []).length, 7);
    check('先の週は上限で止まる',
      (await api(null, 'GET', `/api/free/${token}/slots?week=99`)).json.week, 2);

    /* 送れる枠を表から1つ拾う。セルは常に {state, iso} なので、
       中身を見ずに真偽で判断すると受付時間外の枠を掴む */
    const pickIso = (g) => {
      for (const col of (g.grid || [])) {
        for (const cell of col) if (cell && cell.state === 'ok') return cell.iso;
      }
      return null;
    };
    const iso1 = pickIso(grid.json);
    check('選べる枠が1つ以上ある', typeof iso1 === 'string', true);

    const noName = await api(null, 'POST', `/api/free/${token}`, { choices: [iso1] });
    check('名前が無いと送れない', noName.status, 400);
    const noSlot = await api(null, 'POST', `/api/free/${token}`, { name: '山田 太郎', choices: [] });
    check('枠を選ばないと送れない', noSlot.status, 400);
    const past = await api(null, 'POST', `/api/free/${token}`,
      { name: '山田 太郎', choices: ['2020-01-01T01:00:00.000Z'] });
    check('過ぎた枠は断る', past.status, 409);

    const sent = await api(null, 'POST', `/api/free/${token}`,
      { name: '山田 太郎', choices: [iso1], note: 'オンライン希望' });
    check('学生が空き時間を送れる', sent.status, 200);
    const countOf = async (id) => ((await api(TOKENS.staff, 'GET', '/api/freeslots')).json.list || [])
      .find((x) => x.id === id)?.count;
    check('回答人数が1になる', await countOf(made.json.id), 1);

    const resent = await api(null, 'POST', `/api/free/${token}`,
      { name: '山田 太郎', choices: [iso1], note: '対面希望' });
    check('同じ名前で送り直せる', resent.status, 200);
    check('同じ名前なら上書きで1人のまま', await countOf(made.json.id), 1);

    /* 2026-10-09 からの画面は choice_mode:'slot'（マス1つ＝30分）を付けて送る。
       付いていない回答（それより前の画面）は古い読み方で表示するので、印を混ぜない */
    const sent2 = await api(null, 'POST', `/api/free/${token}`, { name: '佐藤 花子', choices: [iso1], choice_mode: 'slot' });
    check('別の名前なら足される', sent2.status, 200);
    check('回答人数が2になる', await countOf(made.json.id), 2);

    // 発行した本人だけが中身を読める
    const detail = await api(TOKENS.staff, 'GET', `/api/freeslots/${made.json.id}`);
    check('発行した本人は中身を見られる', detail.status, 200);
    check('詳細に件名が返る', detail.json.title, '山田さんとの日程調整');
    check('2人分の回答が返る', (detail.json.responses || []).length, 2);
    check('名前が返る',
      (detail.json.responses || []).map((r) => r.name).sort().join(','), '佐藤 花子,山田 太郎');
    check('選んだ枠が配列で返る', Array.isArray((detail.json.responses || [])[0]?.choices), true);
    check('上書きした本文が残っている',
      (detail.json.responses || []).find((r) => r.name === '山田 太郎')?.note, '対面希望');
    check('メールアドレスは持たない', 'email' in ((detail.json.responses || [])[0] || {}), false);
    check('新しい画面からの回答には choice_mode が付く',
      (detail.json.responses || []).find((r) => r.name === '佐藤 花子')?.choice_mode, 'slot');
    check('印の無い回答には choice_mode が付かない',
      'choice_mode' in ((detail.json.responses || []).find((r) => r.name === '山田 太郎') || {}), false);

    const peek = await api(TOKENS.staff3, 'GET', `/api/freeslots/${made.json.id}`);
    check('発行していない人は見られない', peek.status, 404);
    const anon = await api(null, 'GET', `/api/freeslots/${made.json.id}`);
    check('ログインしないと見られない', anon.status, 401);

    /* ログイン不要の口には回数制限が要る（合言葉は配布先が広く、漏れる前提）。
       e2e では制限を切ってあるので、付いていることをソースで確かめる */
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
      check('公開の読み取りに回数制限が付いている',
        src.includes("app.get('/api/free/:token', limitPublicRead"), true);
      check('公開の書き込みに回数制限が付いている',
        src.includes("app.post('/api/free/:token', limitPublicWrite"), true);
    }

    /* 学生側の画面。面談申請の写しなので、削り忘れが起きやすい所を見る */
    {
      const freeHtml = fs.readFileSync(path.join(ROOT, 'free.html'), 'utf8');
      check('見出しは「日程調整」', freeHtml.includes('日程調整'), true);
      check('「面談を申請」とは名乗らない', freeHtml.includes('面談を申請'), false);
      // 担当は発行したスタッフに固定。学生に選ばせる欄があってはいけない
      check('担当スタッフの選択欄は無い', freeHtml.includes('担当スタッフ'), false);
      // 空いている時間を知るだけなので、希望順を並べ替える枠は出さない
      check('「選んだ希望日時」の並べ替えは無い', freeHtml.includes('選んだ希望日時'), false);
      check('カレンダーで選ぶ旨の説明がある',
        freeHtml.includes('下のカレンダーから、<b>空いている時間帯</b>を選択してください。'), true);
      check('その他（任意）の欄がある', freeHtml.includes('その他（任意）'), true);
      check('公開APIを叩いている', freeHtml.includes('/api/free/'), true);
    }

    // スタッフ側。依頼画面から発行して、届いた分を見る入口があること
    {
      const appHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      check('空き時間の一覧は「面談一覧・時間」の中に出る',
        appHtml.includes('function freeslotsPanel()')
          && appHtml.includes("showHub('free');"), true);
      check('日程調整の中に「空き時間」のタブは残っていない',
        appHtml.includes("setReqTab('free')"), false);
      check('発行のAPIを叩いている', appHtml.includes("'/api/freeslots'"), true);
      /* 明細シートは30分の枡目をやめ、続いた時間を帯にまとめて出す。
         枡目のままだと「終日OK」の日が1人の枠で埋まり、かぶりが読めなくなる */
      check('明細に「全員そろう時間」を出す', appHtml.includes('全員そろう時間'), true);
      check('全員そろわなければ最多人数を出す', appHtml.includes('いちばん重なる時間'), true);
      check('日ごとの帯を出す', appHtml.includes('日ごとの空き時間'), true);
      check('人ごとの一覧を出す', appHtml.includes('人ごと'), true);
      check('30分の枡目は並べない', appHtml.includes('fs-cell'), false);
      /* クラス名には接頭辞を付ける。短い名前は既存と衝突し、
         テストが通ったまま画面だけ崩れる */
      check('CSSのクラスに fs- を付けている',
        fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8').includes('.fs-'), true);
    }
  }

  /* ---------- リアルタイム通知（SSE） ----------
     面談申請が、再読み込みなしでスタッフの画面へ届くこと。
     配信の宛先は listNotificationsFor と同じ規則（admin は全部／他は自分の支部）*/
  console.log('\n─────── リアルタイム通知（SSE） ───────');
  {
    // ログインしていない相手にはつながせない
    const anon = await openStream(null);
    check('SSE：認証なしは401', anon.status, 401);
    anon.close();

    const s1 = await openStream(TOKENS.staff);    // b1のスタッフ（申請を受ける本人）
    const s2 = await openStream(TOKENS.staff2);   // b2のスタッフ（他支部）
    const ad = await openStream(TOKENS.admin);    // 全体管理者
    check('SSE：スタッフはつながる', s1.status, 200);

    const link = await api(TOKENS.staff, 'GET', '/api/staff/intern-invite-url');
    const tk = String(link.json.url || '').split('/i/')[1];
    const slot = await firstOpenSlot(tk, 'u_e2e_staff');
    const posted = await api(null, 'POST', `/api/apply/${tk}`,
      { name: 'SSE検証 太郎', staff_id: 'u_e2e_staff', choices: [slot.iso] });
    check('SSE：検証用の申請が通った', posted.status, 200);

    check('SSE：同じ支部のスタッフに届く', await waitFor(() => s1.events.length >= 1), true);
    check('SSE：全体管理者にも届く', await waitFor(() => ad.events.length >= 1), true);
    check('SSE：他支部のスタッフには届かない', s2.events.length, 0);

    s1.close(); s2.close(); ad.close();
  }

  console.log('\n─────── メール履歴 ───────');
  {
    const sent = await api(TOKENS.staff, 'POST', '/api/mail/send',
      { receiver_id: 'u_e2e_staff3', subject: '履歴テスト', body: '本文', kind: 'note' });
    check('メールを送れる', sent.status, 200);
    check('書き込んだ1件が返る', typeof sent.json.email?.id === 'string', true);

    const senderView = await getDB(TOKENS.staff);
    check('送った人には見える', (senderView.emails || []).some((m) => m.subject === '履歴テスト'), true);
    const receiverView = await getDB(TOKENS.staff3);
    check('受け取った人にも見える', (receiverView.emails || []).some((m) => m.subject === '履歴テスト'), true);
    const other = await getDB(TOKENS.staff2);
    check('当事者以外には見えない', (other.emails || []).some((m) => m.subject === '履歴テスト'), false);

    // 引っ越し前から store にあったメールも読めること
    check('引っ越し前のメールも読める', (senderView.emails || []).some((m) => m.id === 'ml_old'), true);
    const raw = await readStoreRaw();
    check('store からメール履歴が取り除かれている', 'emails' in raw, false);
  }

  console.log('\n─────── 古い履歴のアーカイブ ───────');
  {
    /* 6ヶ月より古いものは、消さずにアーカイブ用テーブルへ移す。
       セットアップで1年前のメールと通知を1件ずつ仕込んである */
    const rows = await countRows();
    check('古いメールが本体から消えている', rows.emails_old, 0);
    check('古いメールがアーカイブに残っている', rows.archived_emails, 1);
    check('古い通知が本体から消えている', rows.notifications_old, 0);
    check('古い通知がアーカイブに残っている', rows.archived_notifications, 1);
    check('新しいメールは残っている', rows.emails_recent > 0, true);
  }

  console.log('\n─────── 一斉アクセス（この設計変更の目的） ───────');
  {
    /* 依頼を配ったあと全員が「確認」を押す状況。
       専用APIへ移す前は、DB全体に1本しかないロックを奪い合うため
       同時100人なら大半が「保存できていません」になっていた。
       いまは1人1行の追記になるので、全員が成功するはず */
    const N = 100;
    const users = [];
    const c = createClient({ url: 'file:' + DB_PATH });
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 3600e3).toISOString();
    for (let i = 0; i < N; i++) {
      const id = 'u_load' + i;
      const token = 'loadtoken' + i;
      await c.execute({
        sql: 'INSERT OR REPLACE INTO users (id,email,password_hash,nickname,role,branch_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
        args: [id, `load${i}@example.com`, 'dummy:dummy', '負荷' + i, 'staff', 'b1', 'active', now],
      });
      await c.execute({
        sql: 'INSERT OR REPLACE INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
        args: [crypto.createHash('sha256').update(token).digest('hex'), id, now, exp],
      });
      users.push({ id, token });
    }
    c.close();

    const blastDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() + 10 * 86400000));
    const blast = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '一斉テスト', body: '全員答えてください',
      target_label: '支部全員', recipient_ids: users.map((u) => u.id),
      kind: 'attend', options: [{ date: blastDay, has_date: true, has_time: false }],
    });
    const blastId = blast.json.request?.id;
    const blastOpt = blast.json.request?.options?.[0]?.id;

    const t0 = Date.now();
    const codes = await Promise.all(users.map((u) => rawPost(u.token, `/api/requests/${blastId}/response`,
      { answers: [{ option_id: blastOpt, response: 'ok' }] }, 'PUT')));
    const ms = Date.now() - t0;
    const okCount = codes.filter((s) => s === 200).length;
    check(`${N}人が同時に回答して全員成功する`, okCount, N);

    const view = await getDB(TOKENS.staff);
    const rq = (view.requests || []).find((r) => r.id === blastId);
    check(`回答が${N}件すべて記録されている`, (rq?.responses || []).length, N);
    console.log(`       （${N}件の同時回答にかかった時間: ${ms}ms）`);

    /* 締切前にインターン生が一斉に面談を申請する状況。
       アカウントが無いので、支部リンクから名前だけで一斉に申し込む。
       希望はそれぞれ別の枠にする（同じ枠を100人が取り合う話ではないため） */
    const link = await api(TOKENS.staff, 'GET', '/api/staff/intern-invite-url');
    const applyToken = String(link.json.url || '').split('/i/')[1];
    /* 1週間ぶんでは100枠に届かないので、週をめくって集める。
       今日より前の枠は落ちるため、今週だけでは足りない日がある */
    const openSlots = [];
    for (let week = 0; week <= 4 && openSlots.length < N; week++) {
      const free = await api(null, 'GET',
        `/api/apply/${applyToken}/slots?staff_id=u_e2e_staff4&week=${week}`);
      (free.json.grid || []).forEach((col) => col.forEach((c) => {
        if (c.state === 'ok') openSlots.push(c);
      }));
    }
    check('一斉申請に使える枠が100件以上ある', openSlots.length >= N, true);

    const t1 = Date.now();
    const applyCodes = await Promise.all(users.map((u, i) => rawPost(null, `/api/apply/${applyToken}`,
      { name: '負荷' + i, staff_id: 'u_e2e_staff4', choices: [openSlots[i].iso] })));
    const applyMs = Date.now() - t1;
    check(`${N}人が同時に面談を申請して全員成功する`, applyCodes.filter((s) => s === 200).length, N);
    /* 面談一覧は担当スタッフ本人にしか出さない仕様（2026-08-10）なので、
       申請先である staff4 自身のトークンで確認する */
    const staffView = await getDB(TOKENS.staff4);
    const applied = (staffView.interviews || []).filter((iv) => String(iv.intern_name || '').startsWith('負荷'));
    check(`申請が${N}件すべて記録されている`, applied.length, N);
    console.log(`       （${N}件の同時申請にかかった時間: ${applyMs}ms）`);
  }
}

/* ---------- 実行 ---------- */
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-e2e-')), 'e2e.db');
DB_PATH = dbPath;
await setupDB(dbPath);
const { child, log } = startServer(dbPath);
let exitCode = 0;
try {
  if (!await waitForServer()) throw new Error('サーバーが起動しませんでした:\n' + log.join(''));
  if (process.argv.includes('--browser')) {
    console.log('BROWSER_URL=' + await createBrowserAttendanceFixture());
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    await testICalendarFormatting();
    await run();
    await testAttendance();
    await testCalendarSubscription();
    await testMyCalendar();
    await testSharedCalFilter();
    await testGoogleSyncFilter();
    await testLockLogic();
  }
  console.log(`\n${'─'.repeat(56)}`);
  if (!process.argv.includes('--browser') && failures.length) {
    console.log(`結果: ${pass}件成功 / ${failures.length}件失敗\n\n失敗した項目:`);
    failures.forEach((f) => console.log('  - ' + f));
    exitCode = 1;
  } else if (!process.argv.includes('--browser')) {
    console.log(`結果: ${pass}件すべて成功`);
  }
} catch (e) {
  console.error('\nテストの実行に失敗しました:', e.message);
  exitCode = 1;
} finally {
  child.kill();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* 消せなくても実害なし */ }
}
process.exit(exitCode);
