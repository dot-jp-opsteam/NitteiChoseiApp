/* =========================================================
   「回答する人の画面」のデモ動画を撮り直すスクリプト
   ---------------------------------------------------------
   使い方（このリポジトリの直下で）：
       node tools/record-demos.mjs

   左メニュー・ホームの「候補日を送る」「空き時間を聞く」「面談申請リンク」に
   カーソルを乗せると、下に回答の様子が流れる（index.html の demoTip）。
   その動画 demo/ の中身を作り直す。回答ページ（apply.html / free.html /
   attendance.html）の見た目や流れを変えたら、これを走らせて動画も更新すること。

   やっていること：
     1. 使い捨てのDBでサーバーを別ポートに起動する（本番にも開発用DBにも触らない）
     2. ダミーのスタッフ・面談申請リンク・空き時間URL・公開の出欠確認を作る
     3. ブラウザで3つの回答ページを実際に操作し、その画面を録画する
     4. ffmpeg で縮めて demo/ に書き出す。mp4（H.264）と webm（VP9）の2種類。
        ブラウザによって H.264 を再生できないことがあるため、両方を並べて使う

   必要なもの：Playwright（Chromium入り）と ffmpeg。どちらも無料。
   ダミーの名前（山田 太郎 など）だけを使う。実在の人の情報は入れないこと。
   ========================================================= */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// サーバーも録画も日本時間に合わせる（Renderと同じ。画面の時刻がずれないように）
process.env.TZ = 'Asia/Tokyo';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'demo');
const { createClient } = createRequire(path.join(ROOT, 'server', 'package.json'))('@libsql/client');
const PORT = 8124;
const BASE = `http://localhost:${PORT}`;
const W = 420, H = 560; // 録画の大きさ（スマホの幅ぐらい）

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return req(p); } catch { /* 次の候補へ */ }
  }
  console.error('Playwright が見つかりません。npm i -g playwright などで入れてください。');
  process.exit(1);
}
const { chromium } = loadPlaywright();

/* ---------- 使い捨てのサーバーとダミーデータ ---------- */
const DB_PATH = path.join(os.tmpdir(), 'ops-demo-record.db');
async function seedDB() {
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(DB_PATH + s); } catch { /* 無ければよい */ } }
  const c = createClient({ url: 'file:' + DB_PATH });
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 24 * 3600e3).toISOString();
  await c.execute(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    nickname TEXT, role TEXT NOT NULL, branch_id TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, approved_at TEXT, avatar_url TEXT, staff_id TEXT, google_sub TEXT)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  await c.execute(`CREATE TABLE IF NOT EXISTS store (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await c.execute({
    sql: 'INSERT INTO users (id,email,password_hash,nickname,role,branch_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
    args: ['u_demo', 'demo@dot-jp.or.jp', '', '東 玲奈', 'staff', 'b1', 'active', now],
  });
  await c.execute({
    sql: 'INSERT INTO sessions VALUES (?,?,?,?)',
    args: [crypto.createHash('sha256').update('demotoken').digest('hex'), 'u_demo', now, exp],
  });
  await c.execute({
    sql: 'INSERT INTO store (id,data,updated_at) VALUES (1,?,?)',
    args: [JSON.stringify({
      branches: [{ id: 'b1', name: '東京' }], availability: {}, interviews: [], emails: [],
      events: [], profiles: {}, internships: [], requests: [], event_responses: [], notifications: [],
    }), now],
  });
  c.close();
}
function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), TURSO_DATABASE_URL: 'file:' + DB_PATH, TURSO_AUTH_TOKEN: '',
      PUBLIC_WRITE_PER_MIN: '0', PUBLIC_READ_PER_MIN: '0' },
    stdio: 'ignore',
  });
}
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/db', { headers: { Authorization: 'Bearer nope' } });
      if (r.status === 401 || r.status === 200) return;
    } catch { /* まだ起動していない */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('サーバーが起動しませんでした');
}
async function makeUrls() {
  const hdr = { Authorization: 'Bearer demotoken', 'Content-Type': 'application/json' };
  const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: hdr, body: JSON.stringify(body) })).json();
  const at = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const invite = await (await fetch(BASE + '/api/staff/intern-invite-url', { headers: hdr })).json();
  const free = await post('/api/freeslots', { title: '面談の日程調整' });
  const attend = await post('/api/requests', {
    subject: '支部ミーティング', body: '参加できる日を教えてください', target_label: '誰でも回答OK',
    recipient_ids: [], kind: 'attend', public_access: true,
    options: [{ start: at(5, 19), end: at(5, 20) }, { start: at(6, 19), end: at(6, 20) }, { start: at(7, 19), end: at(7, 20) }],
  });
  const urls = { apply: invite.url, free: free.url, attend: attend.request?.public_url };
  for (const [k, v] of Object.entries(urls)) if (!v) throw new Error(`${k} のURLを作れませんでした`);
  return urls;
}

/* ---------- 録画の道具 ---------- */
// 録画にはマウスの矢印が写らないので、赤い丸でカーソルを描く
const CURSOR_JS = () => {
  // 出欠画面の共有URLは画面側で location から作るので、localhost が写らないよう本番の名前に見せ替える
  setInterval(() => {
    const e = document.getElementById('attUrl');
    if (e && e.value && e.value.indexOf(location.origin) === 0) {
      e.value = e.value.replace(location.origin, 'https://ops-nittyou-app.onrender.com');
    }
  }, 50);
  const mk = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;z-index:2147483647;width:24px;height:24px;border-radius:50%;'
      + 'background:rgba(255,70,50,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);'
      + 'pointer-events:none;left:-60px;top:-60px;transform:translate(-50%,-50%);transition:transform .12s';
    document.documentElement.appendChild(d);
    document.addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { d.style.transform = 'translate(-50%,-50%) scale(.6)'; }, true);
    document.addEventListener('mouseup', () => { d.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
};
// 見せ場が間延びしないよう、待ち時間は少し詰める
const PACE = 0.7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));

async function scrollTo(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await sleep(900);
}
async function centerOf(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function glide(page, p) { await page.mouse.move(p.x, p.y, { steps: 16 }); await sleep(250); }
async function click(page, locator) {
  await scrollTo(page, locator);
  await glide(page, await centerOf(locator));
  await page.mouse.down(); await sleep(80); await page.mouse.up();
  await sleep(500);
}
async function type(page, locator, text) {
  await click(page, locator);
  await page.keyboard.type(text, { delay: 100 });
  await sleep(500);
}

/* 空いている枠（○）を、同じ日の縦に3つ以上並んだ列から探す。
   なぞって選ぶ操作と、別の日を1つ押す操作を見せるため */
async function pickSlots(page) {
  const cells = page.locator('td.bt-c.ok');
  await cells.first().waitFor({ timeout: 10000 });
  const boxes = [];
  const n = await cells.count();
  for (let i = 0; i < n; i++) {
    const b = await cells.nth(i).boundingBox();
    if (b) boxes.push({ i, x: Math.round(b.x), y: Math.round(b.y) });
  }
  const cols = {};
  boxes.forEach((b) => { (cols[b.x] = cols[b.x] || []).push(b); });
  const xs = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const colA = xs.find((x) => cols[x].length >= 3);
  const colB = xs.find((x) => x !== colA && cols[x].length >= 1);
  await scrollTo(page, cells.nth(cols[colA][0].i));
  // 縦になぞって、続いた時間をまとめて選ぶ
  const a = await centerOf(cells.nth(cols[colA][0].i));
  const z = await centerOf(cells.nth(cols[colA][2].i));
  await glide(page, a);
  await page.mouse.down(); await sleep(150);
  await page.mouse.move(z.x, z.y, { steps: 18 }); await sleep(200);
  await page.mouse.up(); await sleep(900);
  // ほかの日をひとつ押す
  if (colB !== undefined) await click(page, cells.nth(cols[colB][0].i));
  await sleep(500);
}

/* ---------- 3つの場面 ---------- */
const SCENES = {
  // 面談申請リンク：学生が名前・担当・希望日時を送る
  async apply(page, url) {
    await page.goto(url); await sleep(1500);
    await type(page, page.locator('#applyname'), '山田 太郎');
    const staffSelect = page.locator('select').first();
    await scrollTo(page, staffSelect);
    await glide(page, await centerOf(staffSelect));
    await staffSelect.selectOption({ index: 1 }); await sleep(900);
    await pickSlots(page);
    await click(page, page.locator('#applybtn'));   // 内容を確認する
    await sleep(1500);
    await click(page, page.locator('#applybtn'));   // この内容で送る
    await sleep(2500);
  },
  // 空き時間を聞く：相手が空いている時間をカレンダーで選ぶ
  async free(page, url) {
    await page.goto(url); await sleep(1500);
    await type(page, page.locator('#applyname'), '鈴木 花子');
    await pickSlots(page);
    await click(page, page.locator('#applybtn'));
    await sleep(1500);
    await click(page, page.locator('#applybtn'));
    await sleep(2500);
  },
  // 候補日を送る：候補ごとに ○ △ × で答える
  async attend(page, url) {
    await page.goto(url); await sleep(1500);
    await type(page, page.locator('#respondentName'), '佐藤 次郎');
    for (const [i, v] of [['0', 'ok'], ['1', 'may'], ['2', 'no']]) {
      await click(page, page.locator(`#attans .attb[data-v="${v}"]`).nth(Number(i)));
    }
    await sleep(500);
    await click(page, page.locator('#attBtn'));
    await sleep(2500);
  },
};

function encode(src, destBase) {
  // 最初の0.6秒は読み込み中の白い画面なので切る。音は無い
  const head = ['-y', '-loglevel', 'error', '-ss', '0.6', '-i', src, '-an', '-vf', `fps=20,scale=${W}:-2`];
  execFileSync('ffmpeg', [...head, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', destBase + '.mp4']);
  execFileSync('ffmpeg', [...head, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38',
    '-row-mt', '1', destBase + '.webm']);
}

/* ---------- 実行 ---------- */
// 前に起動したサーバーが残っていると、それに繋がって違うデータを録画してしまう
try {
  await fetch(BASE + '/api/db', { headers: { Authorization: 'Bearer nope' } });
  console.error(`${PORT}番ポートがすでに使われています。残っているサーバーを止めてからやり直してください。`);
  process.exit(1);
} catch { /* 誰も使っていない。ここから先へ進む */ }
await seedDB();
const server = startServer();
const tmpVideos = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-demo-video-'));
let browser;
try {
  await waitForServer();
  const urls = await makeUrls();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try { browser = await chromium.launch(); }
  catch { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }); }
  for (const [name, scene] of Object.entries(SCENES)) {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
      recordVideo: { dir: tmpVideos, size: { width: W, height: H } },
    });
    await ctx.addInitScript(CURSOR_JS);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.warn(`  ${name}: ページのエラー ${e.message}`));
    await scene(page, urls[name]);
    const video = page.video();
    await ctx.close();
    const base = path.join(OUT_DIR, name);
    encode(await video.path(), base);
    const kb = (ext) => (fs.statSync(`${base}.${ext}`).size / 1024).toFixed(0);
    console.log(`作成しました: demo/${name}.mp4（${kb('mp4')}KB）・demo/${name}.webm（${kb('webm')}KB）`);
  }
} finally {
  if (browser) await browser.close();
  server.kill();
  fs.rmSync(tmpVideos, { recursive: true, force: true });
}
