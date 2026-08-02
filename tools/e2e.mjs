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
    interviews: [], events: [], event_responses: [], emails: [], availability: {}, notifications: [],
    // b2（他支部）のデータ。b1のユーザーからは見えても触れてもいけない
    profiles: { u_e2e_staff2: { departments: ['大阪の部署'] } },
    internships: [{ id: 'ip_osaka', branch_id: 'b2', name: '大阪の企業', created_by: 'u_e2e_staff2', created_at: now }],
    requests: [{
      id: 'rq_osaka', branch_id: 'b2', sender_id: 'u_e2e_staff2',
      subject: '【大阪支部の内部連絡】', body: '他支部に見えてはいけない内容',
      target_label: '大阪支部全員', recipient_ids: ['u_e2e_staff2'], read_by: [], created_at: now,
    }],
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
async function getDB(token) {
  const r = await fetch(BASE + '/api/db', { headers: H(token) });
  if (!r.ok) throw new Error('GET /api/db が ' + r.status);
  return r.json();
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
   テスト本体
   ========================================================= */
async function run() {
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
      db.requests = [...(db.requests || []), {
        id: 'rq_tokyo', branch_id: 'b1', sender_id: 'u_e2e_staff',
        subject: '東京の依頼', body: 'テスト本文', target_label: '支部全員',
        recipient_ids: ['u_e2e_intern', 'u_e2e_intern2'], read_by: [], created_at: new Date().toISOString(),
      }];
      db.profiles = { ...(db.profiles || {}), u_e2e_staff: { departments: ['企画局'] } };
      db.internships = [...(db.internships || []), {
        id: 'ip_tokyo', branch_id: 'b1', name: '東京の企業',
        created_by: 'u_e2e_staff', created_at: new Date().toISOString(),
      }];
    });
    check('スタッフの保存が成功する', res.status, 200);

    const after = await getDB(TOKENS.staff);
    check('依頼が保存されている', (after.requests || []).some((r) => r.id === 'rq_tokyo'), true);
    check('所属部署が保存されている', (after.profiles || {}).u_e2e_staff?.departments, ['企画局']);
    check('インターン先マスタが保存されている', (after.internships || []).some((p) => p.id === 'ip_tokyo'), true);

    // 見えていないデータを巻き添えで消していないか（保存のたびに他支部が消えると致命的）
    const admin = await getDB(TOKENS.admin);
    check('他支部の依頼を巻き添えで消していない', (admin.requests || []).some((r) => r.id === 'rq_osaka'), true);
    check('他支部のインターン先を巻き添えで消していない', (admin.internships || []).some((p) => p.id === 'ip_osaka'), true);
    check('他支部のプロフィールを巻き添えで消していない', !!(admin.profiles || {}).u_e2e_staff2, true);
  }

  console.log('\n─────── 依頼の確認（read_by への追記） ───────');
  {
    const res = await putDB(TOKENS.intern, (db) => {
      const r = (db.requests || []).find((x) => x.id === 'rq_tokyo');
      if (r) { r.read_by = [...(r.read_by || []), { user_id: 'u_e2e_intern', at: new Date().toISOString() }]; }
    });
    check('インターン生が確認を保存できる', res.status, 200);
    const after = await getDB(TOKENS.intern);
    const r = (after.requests || []).find((x) => x.id === 'rq_tokyo');
    check('自分の確認が記録されている', (r?.read_by || []).some((x) => x.user_id === 'u_e2e_intern'), true);
    check('宛先のインターン生には依頼が見えている', !!r, true);
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

    res = await putDB(TOKENS.intern, (db) => {
      db.requests = [...(db.requests || []), {
        id: 'rq_hack', branch_id: 'b1', sender_id: 'u_e2e_staff', subject: 'なりすまし',
        recipient_ids: ['u_e2e_intern2'], read_by: [], created_at: new Date().toISOString(),
      }];
    });
    check('インターン生が依頼を送れない', res.status, 403);

    res = await putDB(TOKENS.intern, (db) => {
      const r = (db.requests || []).find((x) => x.id === 'rq_tokyo');
      if (r) r.subject = '改ざんされた件名';
    });
    check('宛先の人が依頼の中身を書き換えられない', res.status, 403);

    res = await putDB(TOKENS.intern, (db) => {
      db.requests = (db.requests || []).filter((x) => x.id !== 'rq_tokyo');
    });
    check('依頼を削除できない', res.status, 403);

    /* 他支部のものは絞り込みで既に見えないので「書き換え」は送りようがない。
       意味のある攻撃は「他支部あてに新しく作る」ほうなので、そちらを試す */
    res = await putDB(TOKENS.staff, (db) => {
      db.internships = [...(db.internships || []), { id: 'ip_cross', branch_id: 'b2', name: '他支部に勝手に追加' }];
    });
    check('他支部あてにインターン先を追加できない', res.status, 403);

    res = await putDB(TOKENS.staff, (db) => {
      db.requests = [...(db.requests || []), {
        id: 'rq_cross', branch_id: 'b2', sender_id: 'u_e2e_staff', subject: '他支部あて',
        recipient_ids: ['u_e2e_staff2'], read_by: [], created_at: new Date().toISOString(),
      }];
    });
    check('他支部あてに依頼を送れない', res.status, 403);
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
}

/* ---------- 実行 ---------- */
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-e2e-')), 'e2e.db');
await setupDB(dbPath);
const { child, log } = startServer(dbPath);
let exitCode = 0;
try {
  if (!await waitForServer()) throw new Error('サーバーが起動しませんでした:\n' + log.join(''));
  await run();
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
