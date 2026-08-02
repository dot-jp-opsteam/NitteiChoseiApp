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
const TOKENS = {
  staff: 'e2etoken_staff',       // b1のスタッフ
  intern: 'e2etoken_intern',     // b1のインターン生
  admin: 'e2etoken_admin',       // 全体管理者
  staff2: 'e2etoken_staff2',     // b2のスタッフ（他支部の代表）
};
const USERS = [
  ['u_e2e_staff', 'e2e_staff@dot-jp.or.jp', 'staff', 'b1'],
  ['u_e2e_intern', 'e2e_intern@example.com', 'intern', 'b1'],
  ['u_e2e_intern2', 'e2e_intern2@example.com', 'intern', 'b1'],
  ['u_e2e_admin', 'e2e_admin@dot-jp.or.jp', 'admin', null],
  ['u_e2e_staff2', 'e2e_staff2@dot-jp.or.jp', 'staff', 'b2'],
];

async function setupDB(dbPath) {
  // 前回の残骸を消してから作り直す（毎回まっさらな状態で始める）
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* 無ければよい */ }
  }
  const c = createClient({ url: 'file:' + dbPath });
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 3600e3).toISOString();

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
    const userId = { staff: 'u_e2e_staff', intern: 'u_e2e_intern', admin: 'u_e2e_admin', staff2: 'u_e2e_staff2' }[key];
    await c.execute({
      sql: 'INSERT OR REPLACE INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
      args: [crypto.createHash('sha256').update(token).digest('hex'), userId, now, exp],
    });
  }

  const store = {
    branches: [{ id: 'b1', name: '東京' }, { id: 'b2', name: '大阪' }],
    interviews: [], emails: [], availability: {},
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
    notifications: [{ id: 'nt_old', type: 'info', msg: '引っ越し前の通知', branch_id: 'b2', at: now }],
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
const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

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
/* store の生の中身を直接のぞく（APIを通さない）。引っ越しの確認に使う */
let DB_PATH = null;
async function readStoreRaw() {
  const c = createClient({ url: 'file:' + DB_PATH });
  const rs = await c.execute('SELECT data FROM store WHERE id = 1');
  c.close();
  return JSON.parse(rs.rows[0].data);
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
  }

  console.log('\n─────── 情報漏えい（他支部のデータが見えないこと） ───────');
  {
    const intern = await getDB(TOKENS.intern);
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
      db.internships = [...(db.internships || []), {
        id: 'ip_tokyo', branch_id: 'b1', name: '東京の企業',
        created_by: 'u_e2e_staff', created_at: new Date().toISOString(),
      }];
    });
    check('スタッフの保存が成功する', res.status, 200);

    const after = await getDB(TOKENS.staff);
    check('所属部署が保存されている', (after.profiles || {}).u_e2e_staff?.departments, ['企画局']);
    check('インターン先マスタが保存されている', (after.internships || []).some((p) => p.id === 'ip_tokyo'), true);

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
      recipient_ids: ['u_e2e_intern', 'u_e2e_intern2'],
    });
    check('スタッフが依頼を送れる', sent.status, 200);
    REQ_ID = sent.json.request?.id;
    check('依頼IDが返る', typeof REQ_ID === 'string', true);

    const internView = await getDB(TOKENS.intern);
    const mine = (internView.requests || []).find((r) => r.id === REQ_ID);
    check('あて先のインターン生に依頼が見えている', !!mine, true);
    check('通知が積まれている', (internView.notifications || []).some((n) => n.msg?.includes('東京の依頼')), true);

    const other = await getDB(TOKENS.staff2);
    check('他支部のスタッフには見えない', (other.requests || []).some((r) => r.id === REQ_ID), false);

    const read = await api(TOKENS.intern, 'POST', `/api/requests/${REQ_ID}/read`);
    check('あて先の人が確認できる', read.status, 200);
    const afterRead = await getDB(TOKENS.intern);
    const r = (afterRead.requests || []).find((x) => x.id === REQ_ID);
    check('自分の確認が記録されている', (r?.read_by || []).some((x) => x.user_id === 'u_e2e_intern'), true);

    // 二度押しても増えない（回線の再送や連打で二重に記録されないこと）
    await api(TOKENS.intern, 'POST', `/api/requests/${REQ_ID}/read`);
    const twice = await getDB(TOKENS.intern);
    const r2 = (twice.requests || []).find((x) => x.id === REQ_ID);
    check('二度確認しても記録は1件のまま', (r2?.read_by || []).filter((x) => x.user_id === 'u_e2e_intern').length, 1);

    const notMine = await api(TOKENS.staff2, 'POST', `/api/requests/${REQ_ID}/read`);
    check('あて先でない人は確認できない', notMine.status, 403);
    const byIntern = await api(TOKENS.intern, 'POST', '/api/requests', {
      subject: 'なりすまし', recipient_ids: ['u_e2e_intern2'],
    });
    check('インターン生は依頼を送れない', byIntern.status, 403);
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

    const v1 = await api(TOKENS.intern, 'PUT', '/api/events/ev_e2e/response', { response: 'yes' });
    check('出欠に回答できる', v1.status, 200);
    let view = await getDB(TOKENS.intern);
    check('回答が記録されている',
      (view.event_responses || []).some((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_intern' && r.response === 'yes'), true);

    await api(TOKENS.intern, 'PUT', '/api/events/ev_e2e/response', { response: 'no' });
    view = await getDB(TOKENS.intern);
    check('回答を変えると上書きされる（重複しない）',
      (view.event_responses || []).filter((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_intern').map((r) => r.response), ['no']);

    await api(TOKENS.intern, 'PUT', '/api/events/ev_e2e/response', { response: 'no' });
    view = await getDB(TOKENS.intern);
    check('同じ回答をもう一度押すと取り消される',
      (view.event_responses || []).some((r) => r.event_id === 'ev_e2e' && r.user_id === 'u_e2e_intern'), false);

    const outsider = await api(TOKENS.staff2, 'PUT', '/api/events/ev_e2e/response', { response: 'yes' });
    check('見えないイベントには回答できない', outsider.status, 403);
  }

  console.log('\n─────── 権限（許されない変更が拒否されること） ───────');
  {
    let res = await putDB(TOKENS.intern, (db) => {
      db.profiles = { ...(db.profiles || {}), u_e2e_intern2: { departments: ['乗っ取り'] } };
    });
    check('インターン生が他人のプロフィールを書き換えられない', res.status, 403);

    res = await putDB(TOKENS.intern, (db) => {
      db.internships = [...(db.internships || []), { id: 'ip_hack', branch_id: 'b1', name: '勝手に追加' }];
    });
    check('インターン生がインターン先マスタを追加できない', res.status, 403);

    /* 他支部のものは絞り込みで既に見えないので「書き換え」は送りようがない。
       意味のある攻撃は「他支部あてに新しく作る」ほうなので、そちらを試す */
    res = await putDB(TOKENS.staff, (db) => {
      db.internships = [...(db.internships || []), { id: 'ip_cross', branch_id: 'b2', name: '他支部に勝手に追加' }];
    });
    check('他支部あてにインターン先を追加できない', res.status, 403);

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

  console.log('\n─────── スタッフによる代理設定（許される変更） ───────');
  {
    const res = await putDB(TOKENS.staff, (db) => {
      db.profiles = { ...(db.profiles || {}), u_e2e_intern: { ...(db.profiles?.u_e2e_intern || {}), internship_id: 'ip_tokyo' } };
    });
    check('スタッフが同支部インターン生のインターン先を設定できる', res.status, 200);
    const after = await getDB(TOKENS.intern);
    check('設定した内容が残っている', (after.profiles || {}).u_e2e_intern?.internship_id, 'ip_tokyo');
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
      rawPost(TOKENS.staff, '/api/mail/send', { receiver_id: 'u_e2e_intern', subject: '同時送信テスト' + i, body: 'x', kind: 'note' })));
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
      b.internships = [...(base.internships || []), { id: 'ip_race' + n, branch_id: 'b1', name: '競合テスト' + n }];
      return fetch(BASE + '/api/db', { method: 'PUT', headers: H(TOKENS.staff), body: JSON.stringify(b) });
    };
    const races = await Promise.all([mk(1), mk(2), mk(3)]);
    const codes = races.map((r) => r.status).sort();
    check('同じ版を土台にした3件の同時保存は1件だけ成功する', codes, [200, 409, 409]);
    const afterRace = await getDB(TOKENS.staff);
    const saved = (afterRace.internships || []).filter((p) => String(p.id).startsWith('ip_race')).length;
    check('成功した1件だけが保存されている', saved, 1);
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
        args: [id, `load${i}@example.com`, 'dummy:dummy', '負荷' + i, 'intern', 'b1', 'active', now],
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
