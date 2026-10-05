/* =========================================================
   予約スケジュールの通しの検査（本物のサーバー＋偽のGoogle）

   使い方:  node tools/test-booking-e2e.mjs
            node tools/test-booking-e2e.mjs --serve   画面確認用にサーバーを立てたままにする

   tools/e2e.mjs はGoogle連携を切った状態で動かすので、予約の流れを通せない。
   ここでは偽のGoogle（freeBusy・予定の作成／変更／削除・カレンダー一覧に答えるだけ）を
   立てて、Google連携を有効にした本物のサーバーを別ポートで起動する。
   google.js は GOOGLE_CAL_API / GOOGLE_TOKEN_URL で宛先を差し替えられる。
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

const PORT = 8125;
const GPORT = 8126;
const BASE = `http://localhost:${PORT}`;
const KEY = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = KEY;
const google = req('./google.js');
const SERVE = process.argv.includes('--serve');

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}

/* ---------- 偽のGoogle ---------- */
const G = {
  busy: [],          // [{start, end}] freeBusy が返す埋まり
  failFreeBusy: false,
  events: new Map(), // id -> event
  calls: [],         // { method, path, query, body }
  delay: 0,
};
const gServer = http.createServer(async (rq, rs) => {
  let body = '';
  for await (const chunk of rq) body += chunk;
  const u = new URL(rq.url, `http://localhost:${GPORT}`);
  const json = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  let parsed = {};
  try { parsed = body && rq.headers['content-type'] && rq.headers['content-type'].includes('json') ? JSON.parse(body) : {}; } catch { parsed = {}; }
  G.calls.push({ method: rq.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: parsed });
  if (G.delay) await new Promise((r) => setTimeout(r, G.delay));
  if (u.pathname === '/token') return json(200, { access_token: 'fake-access', expires_in: 3600 });
  if (u.pathname === '/cal/freeBusy') {
    if (G.failFreeBusy) return json(500, { error: 'boom' });
    const calendars = {};
    (parsed.items || []).forEach((it) => { calendars[it.id] = { busy: G.busy }; });
    return json(200, { calendars });
  }
  if (u.pathname === '/cal/users/me/calendarList') {
    return json(200, { items: [{ id: 'staff@example.com', summary: 'メイン', primary: true }, { id: 'team@group', summary: 'チーム' }] });
  }
  const m = /^\/cal\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
  if (m) {
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    if (rq.method === 'POST') {
      const ev = { ...parsed, id: 'gev_' + crypto.randomBytes(4).toString('hex') };
      if (u.searchParams.get('conferenceDataVersion') === '1' && parsed.conferenceData) ev.hangoutLink = 'https://meet.google.com/abc-defg-hij';
      G.events.set(ev.id, ev);
      return json(200, ev);
    }
    if (rq.method === 'PATCH') {
      const ev = { ...(G.events.get(id) || {}), ...parsed, id };
      G.events.set(id, ev);
      return json(200, ev);
    }
    if (rq.method === 'DELETE') { G.events.delete(id); rs.writeHead(204); return rs.end(); }
    if (rq.method === 'GET') return json(200, { items: [] });
  }
  if (u.pathname.endsWith('/watch')) return json(200, { id: 'ch', resourceId: 'res', expiration: String(Date.now() + 86400000) });
  json(404, { error: 'not found' });
});

/* ---------- DB ---------- */
const TOK = { a: 'bk_token_a', b: 'bk_token_b', c: 'bk_token_c' };
async function setupDB(dbPath) {
  const c = createClient({ url: 'file:' + dbPath });
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 3600e3 * 24).toISOString();
  await c.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    nickname TEXT, role TEXT NOT NULL, branch_id TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, approved_at TEXT, avatar_url TEXT, staff_id TEXT, google_sub TEXT)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const users = [
    ['u_bk_a', 'bk_a@dot-jp.or.jp', '予約スタッフA', 'staff', 'b1', TOK.a],
    ['u_bk_b', 'bk_b@dot-jp.or.jp', '未連携スタッフB', 'staff', 'b1', TOK.b],
    ['u_bk_c', 'bk_c@dot-jp.or.jp', '他支部スタッフC', 'staff', 'b2', TOK.c],
  ];
  for (const [id, email, nick, role, branch, token] of users) {
    await c.execute({
      sql: 'INSERT INTO users (id,email,password_hash,nickname,role,branch_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
      args: [id, email, '', nick, role, branch, 'active', now],
    });
    await c.execute({
      sql: 'INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
      args: [crypto.createHash('sha256').update(token).digest('hex'), id, now, exp],
    });
  }
  await c.execute({
    sql: 'INSERT INTO store (id,data,updated_at) VALUES (1,?,?)',
    args: [JSON.stringify({ branches: [{ id: 'b1', name: '東京' }, { id: 'b2', name: '大阪' }], availability: {} }), now],
  });
  c.close();
}
/* サーバーが google_tokens を作ったあとで、Aだけ連携済みにする */
async function connectGoogle(dbPath, staffId) {
  const c = createClient({ url: 'file:' + dbPath });
  await c.execute({
    sql: `INSERT INTO google_tokens (staff_id, access_token, refresh_token, token_expiry, calendar_id, connected_at)
          VALUES (?,?,?,?,?,?)`,
    args: [staffId, google.encrypt('fake-access'), google.encrypt('fake-refresh'),
      new Date(Date.now() + 3600e3).toISOString(), 'primary', new Date().toISOString()],
  });
  c.close();
}

function startServer(dbPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env,
      PORT: String(PORT),
      TURSO_DATABASE_URL: 'file:' + dbPath, TURSO_AUTH_TOKEN: '',
      PUBLIC_WRITE_PER_MIN: '0', PUBLIC_READ_PER_MIN: '0',
      GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret',
      TOKEN_ENCRYPTION_KEY: KEY, PUBLIC_BASE_URL: BASE,
      GOOGLE_CAL_API: `http://localhost:${GPORT}/cal`, GOOGLE_TOKEN_URL: `http://localhost:${GPORT}/token`,
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
      const r = await fetch(BASE + '/api/db', { headers: { Authorization: 'Bearer nope' } });
      if (r.status === 401 || r.status === 200) return true;
    } catch { /* まだ */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function api(token, method, p, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TOMORROW = new Date(); TOMORROW.setDate(TOMORROW.getDate() + 1); TOMORROW.setHours(0, 0, 0, 0);
const TDAY = ymd(TOMORROW);
const atT = (h, m = 0) => { const d = new Date(TOMORROW); d.setHours(h, m, 0, 0); return d; };
const ALL = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ s: '09:00', e: '12:00' }]]));

async function run(dbPath) {
  console.log('\n─────── スタッフの予約スケジュール ───────');
  const list0 = await api(TOK.a, 'GET', '/api/booking-pages');
  check('一覧が読める・連携済みと分かる', [list0.status, list0.json.googleConnected, list0.json.pages.length], [200, true, 0]);
  check('未連携の人には連携済みと出ない', (await api(TOK.b, 'GET', '/api/booking-pages')).json.googleConnected, false);
  check('ログインしていなければ読めない', (await api(null, 'GET', '/api/booking-pages')).status, 401);
  check('タイトルが無ければ作れない', (await api(TOK.a, 'POST', '/api/booking-pages', { config: {} })).status, 400);
  check('Google未連携の人は作れない', (await api(TOK.b, 'POST', '/api/booking-pages', { config: { title: 'x' } })).status, 400);

  const cfg = {
    title: '30分面談', duration: 30, weekly: ALL, minNoticeHours: 0, maxDays: 30,
    location: { type: 'meet' }, description: '気軽にどうぞ', phone: 'optional',
    questions: [{ id: 'univ', label: '大学名', required: true }],
  };
  const made = await api(TOK.a, 'POST', '/api/booking-pages', { config: cfg });
  check('作れる', made.status, 200);
  const page = made.json.page;
  const token = page.url.split('/b/')[1];
  check('公開URLは /b/<32桁>', /^[a-f0-9]{32}$/.test(token), true);
  const cals = await api(TOK.a, 'GET', '/api/booking-pages/calendars');
  check('空き確認に使えるカレンダーの一覧', cals.json.calendars.map((c) => c.name), ['メイン', 'チーム']);
  check('他人のスケジュールは書き換えられない',
    (await api(TOK.b, 'PUT', `/api/booking-pages/${page.id}`, { active: false })).status, 404);

  console.log('\n─────── 予約ページ（ログイン不要） ───────');
  const info = await api(null, 'GET', `/api/book/${token}`);
  check('ページの情報が読める', [info.status, info.json.title, info.json.duration, info.json.closed, info.json.staff.nickname],
    [200, '30分面談', 30, false, '予約スタッフA']);
  check('スタッフのメールアドレスを含まない', JSON.stringify(info.json).includes('@'), false);
  check('メール未設定なら事前確認は出さない', info.json.verifyEmail, false);
  check('知らない合言葉は404', (await api(null, 'GET', `/api/book/${'0'.repeat(32)}`)).status, 404);

  G.busy = [{ start: atT(10).toISOString(), end: atT(10, 30).toISOString() }];
  const sl = await api(null, 'GET', `/api/book/${token}/slots?from=${TDAY}&days=1`);
  check('Googleの予定と重なる枠は出ない', sl.json.days[TDAY], ['09:00', '09:30', '10:30', '11:00', '11:30']);
  const fb = G.calls.filter((c) => c.path === '/cal/freeBusy').pop();
  check('freeBusy は選んだカレンダーで聞く', fb.body.items, [{ id: 'primary' }]);

  const guest = { last_name: '山田', first_name: '太郎', email: 'Taro@Example.com', answers: { univ: '東京大学' } };
  check('必須の質問に答えていなければ弾く',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, answers: {}, start: atT(9).toISOString() })).status, 400);
  check('メールアドレスが変なら弾く',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, email: 'abc', start: atT(9).toISOString() })).status, 400);
  check('枠の途中の時刻は弾く',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, start: atT(9, 10).toISOString() })).status, 409);
  check('Googleの予定と重なる時刻は弾く',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, start: atT(10).toISOString() })).status, 409);

  G.calls.length = 0;
  const bk = await api(null, 'POST', `/api/book/${token}`, { ...guest, start: atT(9).toISOString() });
  check('予約できる', bk.status, 200);
  check('控えに日時・Meet・変更用リンク', [bk.json.booking.label.endsWith('09:00〜09:30'), bk.json.booking.meet_url,
    /\/b\/manage\/[a-f0-9]{48}$/.test(bk.json.booking.manage_url)], [true, 'https://meet.google.com/abc-defg-hij', true]);
  const ins = G.calls.find((c) => c.method === 'POST' && c.path.endsWith('/events'));
  check('Googleへ招待付きで予定を作る', [ins.query.sendUpdates, ins.query.conferenceDataVersion, ins.body.attendees[0].email],
    ['all', '1', 'taro@example.com']);
  check('予定の件名と説明欄', [ins.body.summary, ins.body.description.includes('東京大学'), ins.body.description.includes('/b/manage/')],
    ['30分面談（山田 太郎）', true, true]);

  check('同じ枠はもう取れない',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, first_name: '花子', start: atT(9).toISOString() })).status, 409);
  const sl2 = await api(null, 'GET', `/api/book/${token}/slots?from=${TDAY}&days=1`);
  check('予約した枠は一覧から消える', sl2.json.days[TDAY].includes('09:00'), false);

  // 同じ枠へ同時に5件。1件だけ通らなければならない
  G.delay = 30;
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    api(null, 'POST', `/api/book/${token}`, { ...guest, first_name: '同時' + i, start: atT(11).toISOString() })));
  G.delay = 0;
  check('同じ枠への同時予約は1件だけ通る', many.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);

  console.log('\n─────── 面談一覧への反映と見える範囲 ───────');
  const dbA = (await api(TOK.a, 'GET', '/api/db')).json;
  const mine = (dbA.interviews || []).filter((iv) => iv.source === 'booking');
  check('担当スタッフの面談一覧に確定済みで出る', [mine.length, mine.every((iv) => iv.status === 'fixed')], [2, true]);
  const ivTaro = mine.find((iv) => iv.intern_name === '山田 太郎');
  check('予約者のメールアドレスと回答は担当に見える', [ivTaro.guest_email, ivTaro.answers[0].value], ['taro@example.com', '東京大学']);
  const dbB = (await api(TOK.b, 'GET', '/api/db')).json;
  check('ほかのスタッフには見えない', (dbB.interviews || []).filter((iv) => iv.source === 'booking').length, 0);
  check('面談の状態変更（PATCH）では予約を触れない',
    (await api(TOK.a, 'PATCH', `/api/interviews/${ivTaro.id}`, { status: 'applied' })).status, 400);

  console.log('\n─────── 予約の変更・キャンセル（予約者） ───────');
  const mt = bk.json.booking.manage_url.split('/b/manage/')[1];
  const mg = await api(null, 'GET', `/api/book/manage/${mt}`);
  check('予約の内容が読める', [mg.status, mg.json.booking.name, mg.json.changeable, mg.json.reschedulable], [200, '山田 太郎', true, true]);
  check('知らない合言葉は404', (await api(null, 'GET', `/api/book/manage/${'a'.repeat(48)}`)).status, 404);
  // 自分の今の予約（9:00）は、Googleの予定にも入っているが、選び直しでは空きとして扱う
  G.busy = [{ start: atT(9).toISOString(), end: atT(9, 30).toISOString() }];
  const msl = await api(null, 'GET', `/api/book/manage/${mt}/slots?from=${TDAY}&days=1`);
  check('選び直しでは自分の今の枠も選べる', msl.json.days[TDAY].includes('09:00'), true);
  G.calls.length = 0;
  const ch = await api(null, 'PATCH', `/api/book/manage/${mt}`, { start: atT(10, 30).toISOString() });
  check('日時を変えられる', [ch.status, ch.json.booking.label.endsWith('10:30〜11:00')], [200, true]);
  const pt = G.calls.find((c) => c.method === 'PATCH');
  check('Googleの予定も動かし、変更を知らせる', [pt.query.sendUpdates, pt.body.start.dateTime], ['all', atT(10, 30).toISOString()]);
  check('埋まっている時刻へは変えられない',
    (await api(null, 'PATCH', `/api/book/manage/${mt}`, { start: atT(11).toISOString() })).status, 409);

  G.calls.length = 0;
  const del = await api(null, 'DELETE', `/api/book/manage/${mt}`);
  check('キャンセルできる', [del.status, del.json.booking.cancelled], [200, true]);
  const dl = G.calls.find((c) => c.method === 'DELETE');
  check('Googleの予定を消し、取消を知らせる', dl && dl.query.sendUpdates, 'all');
  check('二度はキャンセルできない', (await api(null, 'DELETE', `/api/book/manage/${mt}`)).status, 409);
  const after = await api(null, 'GET', `/api/book/manage/${mt}`);
  check('キャンセル後は変更できない', [after.json.changeable, after.json.reschedulable], [false, false]);

  console.log('\n─────── スタッフ側からのキャンセル ───────');
  G.busy = [];
  const bk2 = await api(null, 'POST', `/api/book/${token}`, { ...guest, first_name: '次郎', start: atT(9, 30).toISOString() });
  const iv2 = (await api(TOK.a, 'GET', '/api/db')).json.interviews.find((iv) => iv.intern_name === '山田 次郎');
  check('ほかのスタッフはキャンセルできない', (await api(TOK.b, 'POST', `/api/interviews/${iv2.id}/cancel-booking`)).status, 403);
  const sc = await api(TOK.a, 'POST', `/api/interviews/${iv2.id}/cancel-booking`);
  check('担当はキャンセルできる', [bk2.status, sc.status, sc.json.interview.status, sc.json.interview.cancelled_by], [200, 200, 'failed', 'staff']);

  console.log('\n─────── 受け付けない状態 ───────');
  G.failFreeBusy = true;
  const tomorrow2 = new Date(TOMORROW); tomorrow2.setDate(tomorrow2.getDate() + 1);
  check('Googleに聞けなければ枠を出さない',
    (await api(null, 'GET', `/api/book/${token}/slots?from=${ymd(tomorrow2)}&days=1`)).status, 503);
  check('Googleに聞けなければ予約もしない',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, first_name: '三郎', start: atT(11, 30).toISOString() })).status, 503);
  G.failFreeBusy = false;
  const off = await api(TOK.a, 'PUT', `/api/booking-pages/${page.id}`, { active: false });
  check('停止できる', [off.status, off.json.page.active], [200, false]);
  check('停止中はページに「受け付けていません」', (await api(null, 'GET', `/api/book/${token}`)).json.closed, true);
  check('停止中は枠を出さない', (await api(null, 'GET', `/api/book/${token}/slots?from=${TDAY}&days=1`)).status, 409);
  check('停止中は予約できない',
    (await api(null, 'POST', `/api/book/${token}`, { ...guest, first_name: '四郎', start: atT(11, 30).toISOString() })).status, 409);
  await api(TOK.a, 'PUT', `/api/booking-pages/${page.id}`, { active: true });

  console.log('\n─────── 配信 ───────');
  const html = await fetch(`${BASE}/b/${token}`);
  check('予約ページが配信される', [html.status, (await html.text()).includes('<title>')], [200, true]);
  check('予約ページは埋め込める', [html.headers.get('x-frame-options'), html.headers.get('content-security-policy')], [null, 'frame-ancestors *']);
  const mh = await fetch(`${BASE}/b/manage/${mt}`);
  check('変更ページは埋め込めない', [mh.status, mh.headers.get('x-frame-options')], [200, 'DENY']);
  check('book.html が配信許可にある', (await fetch(`${BASE}/book.html`)).status, 200);

  console.log('\n─────── 削除 ───────');
  check('他人は消せない', (await api(TOK.b, 'DELETE', `/api/booking-pages/${page.id}`)).status, 404);
  check('消せる', (await api(TOK.a, 'DELETE', `/api/booking-pages/${page.id}`)).status, 200);
  check('消したスケジュールのURLは404', (await api(null, 'GET', `/api/book/${token}`)).status, 404);
  const left = (await api(TOK.a, 'GET', '/api/db')).json.interviews.filter((iv) => iv.source === 'booking' && iv.status === 'fixed');
  check('入っていた予約は残る', left.length, 1);
}

/* 画面確認用：予約スケジュールを1本作り、URLを出して待つ */
async function serve() {
  const cfg = {
    title: '30分面談', duration: 30, minNoticeHours: 0, maxDays: 60,
    weekly: { 1: [{ s: '10:00', e: '12:00' }, { s: '14:00', e: '18:00' }], 2: [{ s: '10:00', e: '18:00' }], 3: [{ s: '13:00', e: '19:00' }], 4: [{ s: '10:00', e: '18:00' }], 5: [{ s: '10:00', e: '15:00' }] },
    location: { type: 'meet' }, description: 'インターンについての面談です。\n気軽にご予約ください。', phone: 'optional',
    questions: [{ id: 'univ', label: '大学名', required: true }, { id: 'memo', label: '相談したいこと', required: false }],
  };
  G.busy = [{ start: atT(10).toISOString(), end: atT(11).toISOString() }, { start: atT(14).toISOString(), end: atT(15, 30).toISOString() }];
  const made = await api(TOK.a, 'POST', '/api/booking-pages', { config: cfg });
  const guest = { last_name: '山田', first_name: '太郎', email: 'taro@example.com', answers: { univ: '東京大学' } };
  const bk = await api(null, 'POST', `/api/book/${made.json.page.url.split('/b/')[1]}`, { ...guest, start: atT(16).toISOString() });
  console.log('BOOK_URL=' + made.json.page.url);
  console.log('MANAGE_URL=' + (bk.json.booking ? bk.json.booking.manage_url : '(予約失敗 ' + JSON.stringify(bk.json) + ')'));
  console.log('STAFF_TOKEN=' + TOK.a);
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
}

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-booking-')), 'bk.db');
await setupDB(dbPath);
await new Promise((r) => gServer.listen(GPORT, r));
const { child, log } = startServer(dbPath);
let exitCode = 0;
try {
  if (!await waitForServer()) throw new Error('サーバーが起動しませんでした:\n' + log.join(''));
  await connectGoogle(dbPath, 'u_bk_a');
  if (SERVE) await serve();
  else {
    await run(dbPath);
    console.log(`\n${'─'.repeat(56)}`);
    if (failures.length) {
      console.log(`結果: ${pass}件成功 / ${failures.length}件失敗\n\n失敗した項目:`);
      failures.forEach((f) => console.log('  - ' + f));
      console.log('\nサーバーのログ（末尾）:\n' + log.join('').split('\n').slice(-30).join('\n'));
      exitCode = 1;
    } else {
      console.log(`結果: ${pass}件すべて成功`);
    }
  }
} catch (e) {
  console.error(e);
  console.log('\nサーバーのログ:\n' + log.join(''));
  exitCode = 1;
} finally {
  child.kill();
  gServer.close();
}
process.exit(exitCode);
