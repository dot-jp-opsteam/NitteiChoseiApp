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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// server/ 側にインストールされている @libsql/client を借りる（tools用の依存は増やさない）
const { createClient } = createRequire(path.join(ROOT, 'server', 'package.json'))('@libsql/client');
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

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
  const exp = new Date(Date.now() + 3600e3).toISOString();
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
      args: [id, email, 'dummy:dummy', 'E2E-' + role, role, branch, 'active', now],
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
      target_label: '大阪支部全員', recipient_ids: ['u_e2e_staff2'],
      read_by: [{ user_id: 'u_e2e_staff2', at: now }], created_at: now,
    }],
    event_responses: [{ id: 'er_old', event_id: 'ev_old', user_id: 'u_e2e_staff2', response: 'yes' }],
    notifications: [
      { id: 'nt_old', type: 'info', msg: '引っ越し前の通知', branch_id: 'b2', at: now },
      { id: 'nt_ancient', type: 'info', msg: '1年前の通知', branch_id: 'b2', at: oneYearAgo },
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
    env: { ...process.env, PORT: String(PORT), TURSO_DATABASE_URL: 'file:' + dbPath, TURSO_AUTH_TOKEN: '' },
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
function rawPost(token, pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: 'localhost', port: PORT, path: pathname, method: 'POST', agent,
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
  const mk = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x.toISOString(); };

  const made = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: 'チーム懇親会', body: '場所は未定です',
    target_label: '支部の全インターン生', recipient_ids: ['u_e2e_staff3', 'u_e2e_staff4'],
    kind: 'attend',
    options: [{ start: mk(t1, 19), end: mk(t1, 21) }, { start: mk(t2, 19), end: mk(t2, 21) }],
  });
  check('出欠確認を作れる', made.status, 200);
  check('出欠確認として記録される', made.json.request?.kind, 'attend');
  check('候補が2件ある', made.json.request?.options?.length, 2);
  check('候補にidが振られる', made.json.request?.options?.[0]?.id, 'op0');
  const attId = made.json.request?.id;

  /* 依頼の一覧を見ていない人がメール画面からでも気づけるよう、
     出欠確認はあて先ひとりずつのメール履歴にも残す */
  const mailView = await getDB(TOKENS.staff3);
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

  // ---- 回答 ----
  const ans = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'ok' }, { option_id: 'op1', response: 'no' }] });
  check('あて先の人は答えられる', ans.status, 200);
  check('答えた数だけ保存される', ans.json.saved?.length, 2);

  const ans2 = await api(TOKENS.staff4, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'may' }, { option_id: 'op1', response: 'ok' }] });
  check('もう1人も答えられる', ans2.status, 200);

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
  check('送った本人に回答が見える', row?.responses?.length, 4);
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

  const after = await getDB(TOKENS.staff);
  const row2 = (after.requests || []).find((r) => r.id === attId);
  check('確定した候補が記録される', row2?.confirmed, 'op1');
  check('できた予定が支部のカレンダーに入っている',
    (after.events || []).some((e) => e.id === done.json.event?.id), true);

  const late = await api(TOKENS.staff3, 'PUT', `/api/requests/${attId}/response`,
    { answers: [{ option_id: 'op0', response: 'no' }] });
  check('確定後はもう答えられない', late.status, 409);

  // ---- ふつうの依頼が壊れていないこと ----
  const normal = await api(TOKENS.staff, 'POST', '/api/requests', {
    subject: 'ふつうの依頼', body: '本文', target_label: 'x', recipient_ids: ['u_e2e_staff3'],
  });
  check('ふつうの依頼は今までどおり作れる', normal.status, 200);
  check('ふつうの依頼には出欠の印が付かない', normal.json.request?.kind, 'normal');
  const normalMail = await getDB(TOKENS.staff3);
  check('ふつうの依頼はメール履歴に残さない',
    (normalMail.emails || []).some((m) => String(m.subject || '').includes(normal.json.request?.subject)), false);
  const notAttend = await api(TOKENS.staff3, 'PUT', `/api/requests/${normal.json.request?.id}/response`,
    { answers: [{ option_id: 'op0', response: 'ok' }] });
  check('ふつうの依頼には出欠で答えられない', notAttend.status, 400);
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
    check('依頼の確認状況も引き継がれている',
      (admin.requests || []).find((r) => r.id === 'rq_osaka')?.read_by?.some((x) => x.user_id === 'u_e2e_staff2'), true);

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

  console.log('\n─────── 依頼（専用API） ───────');
  {
    const sent = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '東京の依頼', body: 'テスト本文', target_label: '支部全員',
      recipient_ids: ['u_e2e_staff3', 'u_e2e_staff4'],
    });
    check('スタッフが依頼を送れる', sent.status, 200);
    REQ_ID = sent.json.request?.id;
    check('依頼IDが返る', typeof REQ_ID === 'string', true);

    const internView = await getDB(TOKENS.staff3);
    const mine = (internView.requests || []).find((r) => r.id === REQ_ID);
    check('あて先のインターン生に依頼が見えている', !!mine, true);
    check('通知が積まれている', (internView.notifications || []).some((n) => n.msg?.includes('東京の依頼')), true);

    const other = await getDB(TOKENS.staff2);
    check('他支部のスタッフには見えない', (other.requests || []).some((r) => r.id === REQ_ID), false);

    const read = await api(TOKENS.staff3, 'POST', `/api/requests/${REQ_ID}/read`);
    check('あて先の人が確認できる', read.status, 200);
    const afterRead = await getDB(TOKENS.staff3);
    const r = (afterRead.requests || []).find((x) => x.id === REQ_ID);
    check('自分の確認が記録されている', (r?.read_by || []).some((x) => x.user_id === 'u_e2e_staff3'), true);

    // 二度押しても増えない（回線の再送や連打で二重に記録されないこと）
    await api(TOKENS.staff3, 'POST', `/api/requests/${REQ_ID}/read`);
    const twice = await getDB(TOKENS.staff3);
    const r2 = (twice.requests || []).find((x) => x.id === REQ_ID);
    check('二度確認しても記録は1件のまま', (r2?.read_by || []).filter((x) => x.user_id === 'u_e2e_staff3').length, 1);

    const notMine = await api(TOKENS.staff2, 'POST', `/api/requests/${REQ_ID}/read`);
    check('あて先でない人は確認できない', notMine.status, 403);
    /* インターン生のアカウントを廃止したので、
       「送れない相手」の検証は他支部のスタッフで行う */
    const crossSend = await api(TOKENS.staff2, 'POST', '/api/requests', {
      subject: 'なりすまし', recipient_ids: ['u_e2e_staff4'],
    });
    check('他支部の相手には依頼を送れない', crossSend.status, 403);
    const crossBranch = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '他支部あて', recipient_ids: ['u_e2e_staff2'],
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

    // 空き枠。月曜始まりの1週間ぶんの表で返る。受付時間を決めていなくても既定値で出る
    const slotRes = await api(null, 'GET', `/api/apply/${token1}/slots?staff_id=u_e2e_staff`);
    check('空き枠を取れる', slotRes.status, 200);
    check('今週から始まる', slotRes.json.week, 0);
    check('7日ぶんの表になる', (slotRes.json.days || []).length, 7);
    /* 表の高さはスタッフの受付時間に関わらず9:00〜23:00で固定。
       週ごとに伸び縮みすると、同じ時刻の行が上下にずれて選びにくくなるため */
    check('表はいつも9:00から始まる', (slotRes.json.times || [])[0], '09:00');
    check('表は22:30の枠で終わる', (slotRes.json.times || []).slice(-1)[0], '22:30');
    check('30分刻みで28行ある', (slotRes.json.times || []).length, 28);
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
       「○のマスが空き時間」だと分かる一文が要る（設計書 2節） */
    {
      const applyHtml = fs.readFileSync(path.join(ROOT, 'apply.html'), 'utf8');
      check('申請画面に空き時間の説明がある',
        applyHtml.includes('○が付いているマスが、担当スタッフの面談できる空き時間です。'), true);
      check('説明は担当スタッフ欄とカレンダーの間にある',
        applyHtml.indexOf('のスタッフから選べます') < applyHtml.indexOf('○が付いているマスが')
        && applyHtml.indexOf('○が付いているマスが') < applyHtml.indexOf('weekBlock(groups)'), true);
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

    // 廃止した入口
    const oldRegister = await api(null, 'POST', '/api/auth/register-intern',
      { email: 'x@example.com', password: 'password123', nickname: 'x' });
    check('インターン生の会員登録は廃止されている', oldRegister.status, 410);
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

    const blast = await api(TOKENS.staff, 'POST', '/api/requests', {
      subject: '一斉テスト', body: '全員確認してください',
      target_label: '支部全員', recipient_ids: users.map((u) => u.id),
    });
    const blastId = blast.json.request?.id;

    const t0 = Date.now();
    const codes = await Promise.all(users.map((u) => rawPost(u.token, `/api/requests/${blastId}/read`, {})));
    const ms = Date.now() - t0;
    const okCount = codes.filter((s) => s === 200).length;
    check(`${N}人が同時に確認して全員成功する`, okCount, N);

    const view = await getDB(TOKENS.staff);
    const rq = (view.requests || []).find((r) => r.id === blastId);
    check(`確認が${N}件すべて記録されている`, (rq?.read_by || []).length, N);
    console.log(`       （${N}件の同時確認にかかった時間: ${ms}ms）`);

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
    const staffView = await getDB(TOKENS.staff);
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
  await run();
  await testAttendance();
  await testMyCalendar();
  await testSharedCalFilter();
  await testLockLogic();
  console.log(`\n${'─'.repeat(56)}`);
  if (failures.length) {
    console.log(`結果: ${pass}件成功 / ${failures.length}件失敗\n\n失敗した項目:`);
    failures.forEach((f) => console.log('  - ' + f));
    exitCode = 1;
  } else {
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
