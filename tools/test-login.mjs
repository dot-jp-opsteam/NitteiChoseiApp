/* =========================================================
   Googleでログインの通しの検査（本物のサーバー＋偽のGoogle）

   使い方:  node tools/test-login.mjs

   2026-10-09 に「ドットの友達がログインしても、同じ画面に戻ってしまう」と報告があった。
   スタッフ登録を済ませずに、ふつうの「Googleでログイン」から入った人には
   インターン生の行ができ、ログイン直後に requireAuth で黙って弾かれていた。
   ここでは偽のGoogle（トークン交換で id_token を返すだけ）を立て、
   ログインから戻ってきたあとの行き先を確かめる。
     ・登録済みのスタッフ … そのままログインできる
     ・未登録の @dot-jp.or.jp … スタッフ登録の画面へ送られ、登録すると使える
     ・前にインターン生の行ができた @dot-jp.or.jp … 同じく登録の画面へ。登録でスタッフに切り替わる
     ・ドット以外のアカウント … 行はできる（塞がない）が、ログインはさせず理由を出す
   ポートは 8127（サーバー）と 8128（偽のGoogle）。ほかの検査と同時に走らせてもぶつからない
   ========================================================= */
process.env.TZ = 'Asia/Tokyo';

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'server', 'package.json'));
const { createClient } = req('@libsql/client');

const PORT = 8127;
const GPORT = 8128;
const BASE = `http://localhost:${PORT}`;
const KEY = crypto.randomBytes(32).toString('hex');

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}

/* ---------- 偽のGoogle ----------
   認可コードに「誰としてログインしたか」を埋めておき、トークン交換でその人の id_token を返す */
const PEOPLE = {
  staff: { sub: 'g_staff', email: 'staff1@dot-jp.or.jp', name: '登録済み スタッフ' },
  newdot: { sub: 'g_newdot', email: 'friend@dot-jp.or.jp', name: 'ドット 友達' },
  olddot: { sub: 'g_olddot', email: 'old@dot-jp.or.jp', name: '前に入った 人' },
  gmail: { sub: 'g_gmail', email: 'someone@gmail.com', name: '個人 アカウント' },
  stopped: { sub: 'g_stopped', email: 'stopped@dot-jp.or.jp', name: '止めた 人' },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const gServer = http.createServer(async (rq, rs) => {
  let body = '';
  for await (const chunk of rq) body += chunk;
  const u = new URL(rq.url, `http://localhost:${GPORT}`);
  if (u.pathname === '/token') {
    const who = PEOPLE[new URLSearchParams(body).get('code')];
    if (!who) { rs.writeHead(400); return rs.end('{}'); }
    const idToken = [b64({ alg: 'none' }), b64({
      iss: 'https://accounts.google.com', aud: 'fake-client', sub: who.sub,
      email: who.email, email_verified: true, name: who.name,
    }), 'sig'].join('.');
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    return rs.end(JSON.stringify({ access_token: 'a', id_token: idToken, expires_in: 3600 }));
  }
  rs.writeHead(404); rs.end('{}');
});

/* ---------- DB ---------- */
async function setupDB(dbPath) {
  const c = createClient({ url: 'file:' + dbPath });
  const now = new Date().toISOString();
  await c.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    nickname TEXT, role TEXT NOT NULL, branch_id TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, approved_at TEXT, avatar_url TEXT, staff_id TEXT, google_sub TEXT)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const users = [
    ['u_staff', PEOPLE.staff.email, '登録済み', 'staff', 'b1', 'active', PEOPLE.staff.sub],
    // 修正前の作りで、ふつうのログインから入ってインターン生の行ができてしまった人
    ['u_olddot', PEOPLE.olddot.email, '前に入った', 'intern', null, 'active', PEOPLE.olddot.sub],
    // 管理者が止めたアカウント。登録し直しで生き返ってはいけない
    ['u_stopped', PEOPLE.stopped.email, '止めた', 'intern', null, 'disabled', PEOPLE.stopped.sub],
  ];
  for (const [id, email, nick, role, branch, status, sub] of users) {
    await c.execute({
      sql: 'INSERT INTO users (id,email,password_hash,nickname,role,branch_id,status,created_at,google_sub) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [id, email, '', nick, role, branch, status, now, sub],
    });
  }
  await c.execute({
    sql: 'INSERT INTO store (id,data,updated_at) VALUES (1,?,?)',
    args: [JSON.stringify({ branches: [{ id: 'b1', name: '東京' }], availability: {} }), now],
  });
  c.close();
}
async function roleOf(dbPath, email) {
  const c = createClient({ url: 'file:' + dbPath });
  const rs = await c.execute({ sql: 'SELECT role, status, branch_id, nickname FROM users WHERE email = ?', args: [email] });
  c.close();
  return rs.rows[0] ? { ...rs.rows[0] } : null;
}

function startServer(dbPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env,
      PORT: String(PORT),
      TURSO_DATABASE_URL: 'file:' + dbPath, TURSO_AUTH_TOKEN: '',
      PUBLIC_WRITE_PER_MIN: '0', PUBLIC_READ_PER_MIN: '0',
      GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GOOGLE_LOGIN_ENABLED: 'true',
      TOKEN_ENCRYPTION_KEY: KEY, PUBLIC_BASE_URL: BASE,
      GOOGLE_TOKEN_URL: `http://localhost:${GPORT}/token`, GOOGLE_CAL_API: `http://localhost:${GPORT}/cal`,
      SMTP_USER: '', SMTP_PASS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/bootstrap');
      if (r.status === 200) return true;
    } catch { /* まだ */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ログインボタン（または /staff の登録ボタン）を押してGoogleから戻ってきたところまでを再現し、
   戻り先のURLを返す。state はサーバーが署名して作るので、行き先のURLから取り出して使う */
async function googleRoundTrip(who, start = '/api/auth/google/login') {
  const go = await fetch(BASE + start, { redirect: 'manual' });
  const state = new URL(go.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${BASE}/api/auth/google/login/callback?code=${who}&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' });
  return back.headers.get('location') || '';
}
const tokenIn = (loc) => (/#token=([^&]+)/.exec(loc) || [])[1];
const verifiedIn = (loc) => new URL(loc, BASE).searchParams.get('verified');
async function bootUser(token) {
  const r = await fetch(BASE + '/api/bootstrap', { headers: { Authorization: 'Bearer ' + decodeURIComponent(token) } });
  return (await r.json()).user;
}
async function signup(verified, name) {
  const r = await fetch(BASE + '/api/auth/staff-signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verified, full_name: name, branch_id: 'b1' }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function run(dbPath) {
  console.log('\n─────── 登録済みのスタッフ ───────');
  {
    const loc = await googleRoundTrip('staff');
    check('そのままログインできる（トークンが渡る）', !!tokenIn(loc), true);
    check('アプリに入れる', (await bootUser(tokenIn(loc)))?.role, 'staff');
  }

  console.log('\n─────── 未登録の @dot-jp.or.jp（報告のあった友達） ───────');
  {
    const loc = await googleRoundTrip('newdot');
    check('ログインはさせず、スタッフ登録の画面へ送る', loc.startsWith('/staff?verified='), true);
    check('ふつうのログインから来たと分かる印が付く', loc.includes('&from=login'), true);
    check('インターン生の行は作らない', await roleOf(dbPath, PEOPLE.newdot.email), null);
    const done = await signup(verifiedIn(loc), 'ドット 友達');
    check('氏名と支部を入れると登録できる', done.status, 200);
    check('登録した人はそのまま入れる', (await bootUser(done.json.token))?.role, 'staff');
    const again = await googleRoundTrip('newdot');
    check('次からはふつうにログインできる', !!tokenIn(again), true);
  }

  console.log('\n─────── 前にインターン生の行ができた @dot-jp.or.jp ───────');
  {
    const loc = await googleRoundTrip('olddot');
    check('スタッフ登録の画面へ送る', loc.startsWith('/staff?verified='), true);
    const done = await signup(verifiedIn(loc), '前に入った 人');
    check('登録できる（既に登録済みとは言わない）', done.status, 200);
    const row = await roleOf(dbPath, PEOPLE.olddot.email);
    check('同じ行がスタッフに切り替わる', [row?.role, row?.branch_id, row?.nickname], ['staff', 'b1', '前に入った 人']);
    check('ログインできるようになる', !!tokenIn(await googleRoundTrip('olddot')), true);
    // /staff の「Googleアカウントで続ける」から入った場合も同じ扱い
    const fromStaff = await googleRoundTrip('olddot', '/api/auth/staff-signup/google');
    check('登録が済んだあとに /staff から入ると「登録済み」', fromStaff, '/staff?staff_error=already');
  }

  console.log('\n─────── 管理者が止めたアカウント ───────');
  {
    check('ログインでは登録の画面へ送らず「ログインできません」', await googleRoundTrip('stopped'), '/?login_error=inactive');
    // /staff から入って登録の画面まで進んでも、登録のところで止める
    const loc = await googleRoundTrip('stopped', '/api/auth/staff-signup/google');
    const done = await signup(verifiedIn(loc), '止めた 人');
    check('登録し直しても生き返らない', done.status, 403);
    check('止めたまま', (await roleOf(dbPath, PEOPLE.stopped.email))?.status, 'disabled');
  }

  console.log('\n─────── ドット以外のアカウント（個人のGmailなど） ───────');
  {
    const loc = await googleRoundTrip('gmail');
    check('ログインはさせず、理由を出す', loc, '/?login_error=not_staff');
    check('行はできる（管理者がスタッフに変えれば入れるよう、塞がない）',
      (await roleOf(dbPath, PEOPLE.gmail.email))?.role, 'intern');
    check('2回目も同じ案内', await googleRoundTrip('gmail'), '/?login_error=not_staff');
    const viaStaff = await googleRoundTrip('gmail', '/api/auth/staff-signup/google');
    check('/staff から入ってもドット以外は登録できない', viaStaff, '/staff?staff_error=domain');
  }

  console.log('\n─────── 残っていたインターン生のセッション ───────');
  {
    // 起動時の情報取りで通してしまうと、いったん入ってから黙って戻されるので、未ログインとして返す
    const c = createClient({ url: 'file:' + dbPath });
    const now = new Date().toISOString();
    await c.execute({
      sql: 'INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
      args: [crypto.createHash('sha256').update('old_intern_token').digest('hex'),
        (await c.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [PEOPLE.gmail.email] })).rows[0].id,
        now, new Date(Date.now() + 864e5).toISOString()],
    });
    c.close();
    check('インターン生は未ログインとして返す', await bootUser('old_intern_token'), null);
  }
}

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-login-')), 'login.db');
await setupDB(dbPath);
await new Promise((r) => gServer.listen(GPORT, r));
const { child, log } = startServer(dbPath);
let exitCode = 0;
try {
  if (!await waitForServer()) throw new Error('サーバーが起動しませんでした:\n' + log.join(''));
  await run(dbPath);
  console.log(`\n${'─'.repeat(56)}`);
  if (failures.length) {
    console.log(`結果: ${pass}件成功 / ${failures.length}件失敗\n\n失敗した項目:`);
    failures.forEach((f) => console.log('  - ' + f));
    exitCode = 1;
  } else {
    console.log(`結果: ${pass}件すべて成功`);
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  child.kill();
  gServer.close();
}
process.exit(exitCode);
