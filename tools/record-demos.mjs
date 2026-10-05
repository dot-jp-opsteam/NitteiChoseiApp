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
const S = 2; // 画質：画面の点を縦横 S 倍に細かくして撮る（見た目の大きさは変わらない）
const W = 640, H = 400; // 録画の大きさ。横長（16:10）。表示側（style.css の .demotip video）の比と合わせる

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
// 録画にはマウスの矢印が写らないので、ふつうのカーソルと同じ白い矢印（黒ふち）を描く。
// 先端がマウスの位置。小さく縮めて見るので、実物より少し大きめにしてある
const CURSOR_JS = () => {
  // 出欠画面の共有URLは画面側で location から作るので、localhost が写らないよう本番の名前に見せ替える。
  // 欄が画面に足された瞬間に書き換える（描かれてからだと、最初の一瞬だけ localhost が写る）
  const fixUrl = () => {
    document.querySelectorAll('input[id="attUrl"]').forEach((e) => {
      if (e.value && e.value.indexOf(location.origin) === 0) {
        e.value = e.value.replace(location.origin, 'https://ops-nittyou-app.onrender.com');
      }
    });
  };
  new MutationObserver(fixUrl).observe(document, { childList: true, subtree: true });
  setInterval(fixUrl, 50);
  const ARROW = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="37" viewBox="0 0 12 19">'
    + '<path d="M1 1V15.2L4.5 12.1L7 17.8L9.2 16.8L6.8 11.2H11.2Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></svg>';
  const mk = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;z-index:2147483647;width:24px;height:37px;pointer-events:none;'
      + 'left:-60px;top:-60px;background:url("data:image/svg+xml,' + encodeURIComponent(ARROW) + '") no-repeat;'
      + 'filter:drop-shadow(0 1px 1px rgba(0,0,0,.35))';
    document.documentElement.appendChild(d);
    // mousemove ではなく pointermove で追う。画面側のドラッグ処理は pointerdown を止めるため、
    // ドラッグ中は mousemove が出ず、カーソルが動かないまま選択だけが伸びてしまう
    document.addEventListener('pointermove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
};
// 見せ場が間延びしないよう、待ち時間は少し詰める
const PACE = 0.7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const wait = (ms) => new Promise((r) => setTimeout(r, ms)); // 詰めない待ち時間

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
/* 空いている枠（○）を選ぶ。まず縦になぞって、続いた時間をまとめて選ぶところを
   ゆっくり見せる。そのあと別の日をひとつ押す。
   マウスを動かすたびに少し待つのは、録画のコマ（1秒20枚）に、なぞった軌跡と
   色が付いていく様子が写るようにするため */
async function dragSlots(page, from, to) {
  await glide(page, from);
  await page.mouse.down(); await wait(500);          // 押したまま、少し間を置く
  const N = 36;
  for (let i = 1; i <= N; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / N, from.y + (to.y - from.y) * i / N);
    await wait(45);
  }
  await wait(600);                                    // 離す前に、選ばれた範囲を見せる
  await page.mouse.up(); await wait(1400);            // 離したあとも、結果を見せる
}
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
  const colA = xs.find((x) => cols[x].length >= 4) ?? xs.find((x) => cols[x].length >= 3);
  const colB = xs.find((x) => x !== colA && cols[x].length >= 1);
  const cellsA = cols[colA];
  const last = Math.min(cellsA.length - 1, 5);          // 最大6マス（3時間ぶん）なぞる
  // なぞる範囲の真ん中を画面の中央に持ってくる（横長で縦が短いので、上下の端が切れないように）
  await scrollTo(page, cells.nth(cellsA[Math.floor(last / 2)].i));
  const from = await centerOf(cells.nth(cellsA[0].i));
  const to = await centerOf(cells.nth(cellsA[last].i));
  await dragSlots(page, from, to);
  // ほかの日をひとつ押す
  if (colB !== undefined) await click(page, cells.nth(cols[colB][0].i));
  await sleep(500);
}

/* 送信が終わって完了の表示が出るまで待ち、それを少し見せて終わる。
   固定の待ち時間だと、サーバーが遅いときに「送信中…」のまま動画が終わってしまう */
async function finish(page, text) {
  await page.getByText(text).first().waitFor({ timeout: 15000 });
  // 録画ファイルは終わりの2秒ほどが欠けることがあるので、完了の表示を長めに見せておく
  await wait(4000);
}

/* 動画の頭出し。ページを開いて名前などを入れ終えたところから撮り始める。

   Playwright 標準の録画（recordVideo）は使わない。録画ファイルの時間が実際の時間と
   ±2秒ほどずれ、頭出しも終わりも当てにならなかった（完了の表示が映る前に動画が
   終わることがあった）。代わりに、ブラウザが画面の変化ごとに送ってくるコマ
   （CDP の screencast）を、コマに付いた時刻どおりの長さで並べる。
   screenshot を繰り返す方法は、重い画面で1秒9コマまで落ちてカクついたのでやめた */
const CAPTURE = new WeakMap();
async function start(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (ev) => {
    frames.push({ t: ev.metadata.timestamp * 1000, buf: Buffer.from(ev.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W * S, maxHeight: H * S, everyNthFrame: 1 });
  CAPTURE.set(page, {
    frames,
    async stop() {
      const endT = Date.now();
      await cdp.send('Page.stopScreencast').catch(() => {});
      this.endT = endT;
    },
  });
}

/* ---------- 3つの場面 ---------- */
const SCENES = {
  // 面談申請リンク：学生が名前・担当・希望日時を送る
  async apply(page, url) {
    await page.goto(url); await sleep(1500);
    await page.locator('#applyname').fill('山田 太郎');           // 名前と担当スタッフの選択は
    await page.locator('select').first().selectOption({ index: 1 }); // 見せない（最初から入れておく）
    await page.locator('td.bt-c.ok').first().waitFor({ timeout: 10000 }); // 空き枠が出るまで待つ
    await start(page);
    await pickSlots(page);
    await click(page, page.locator('#applybtn'));   // 内容を確認する
    await sleep(1500);
    await click(page, page.locator('#applybtn'));   // この内容で申請する
    await finish(page, '申請しました');
  },
  // 空き時間を聞く：相手が空いている時間をカレンダーで選ぶ
  async free(page, url) {
    await page.goto(url); await sleep(1500);
    await page.locator('#applyname').fill('鈴木 花子'); // 入力の様子は見せない
    await start(page);
    await pickSlots(page);
    await click(page, page.locator('#applybtn'));
    await sleep(1500);
    await click(page, page.locator('#applybtn'));
    await finish(page, '送信しました');
  },
  // 候補日を送る：候補ごとに ○ △ × で答える
  async attend(page, url) {
    await page.goto(url); await sleep(1500);
    await page.locator('#respondentName').fill('佐藤 次郎'); // 入力の様子は見せない
    await start(page);
    for (const [i, v] of [['0', 'ok'], ['1', 'may'], ['2', 'no']]) {
      await click(page, page.locator(`#attans .attb[data-v="${v}"]`).nth(Number(i)));
    }
    await sleep(500);
    await click(page, page.locator('#attBtn'));
    await finish(page, '回答を送りました');
  },
};

function encode(frames, endT, destBase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-demo-frames-'));
  const list = [];
  frames.forEach((f, i) => {
    const name = `${String(i).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), f.buf);
    // 次のコマが届くまでの時間だけ、そのコマを見せる（最後のコマは撮り終えるまで）
    const sec = Math.max(0.001, ((i + 1 < frames.length ? frames[i + 1].t : endT) - f.t) / 1000);
    list.push(`file '${name}'\nduration ${sec.toFixed(3)}`);
  });
  list.push(`file '${String(frames.length - 1).padStart(5, '0')}.jpg'`); // concat の決まり：最後は重ねて書く
  fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n') + '\n');
  const head = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-an', '-vf', `fps=20,scale=${W * S}:-2`];
  execFileSync('ffmpeg', [...head, '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', destBase + '.mp4']);
  execFileSync('ffmpeg', [...head, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30',
    '-row-mt', '1', destBase + '.webm']);
  fs.rmSync(dir, { recursive: true, force: true });
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
let browser;
try {
  await waitForServer();
  const urls = await makeUrls();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try { browser = await chromium.launch(); }
  catch { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }); }
  for (const [name, scene] of Object.entries(SCENES)) {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: S, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    });
    await ctx.addInitScript(CURSOR_JS);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.warn(`  ${name}: ページのエラー ${e.message}`));
    await scene(page, urls[name]);
    const cap = CAPTURE.get(page);
    await cap.stop();
    await ctx.close();
    const base = path.join(OUT_DIR, name);
    encode(cap.frames, cap.endT, base);
    console.log(`  ${name}: ${cap.frames.length}コマ（約${(cap.frames.length / ((cap.endT - cap.frames[0].t) / 1000)).toFixed(0)}コマ/秒）`);
    const kb = (ext) => (fs.statSync(`${base}.${ext}`).size / 1024).toFixed(0);
    console.log(`作成しました: demo/${name}.mp4（${kb('mp4')}KB）・demo/${name}.webm（${kb('webm')}KB）`);
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
