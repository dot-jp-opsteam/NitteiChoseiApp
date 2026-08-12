/* =========================================================
   server/ratelimit.js（ログイン不要の入口の回数制限）を取り出して検証する

   使い方:  node tools/test-ratelimit.mjs

   e2e.mjs 側ではこの制限を切ってある（1つのIPから100件を同時に送る
   検査があり、制限が効くと必ず落ちるため）。そのぶんの検査をここで受け持つ。
   時刻は now を渡して固定できるので、実際に1分待たずに窓の移り変わりを確かめられる。
   ========================================================= */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server', 'package.json'));

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}
function section(name) {
  console.log(`\n─────── ${name} ───────`);
}

const rl = require(path.join(ROOT, 'server', 'ratelimit.js'));
const { WINDOW_MS } = rl;

/* ---------------------------------------------------------- */
section('回数の数え方');
{
  rl._resetForTest();
  const now = 1000000;
  const out = [];
  for (let i = 0; i < 5; i++) out.push(rl.hit('t', '1.1.1.1', 3, { now }).limited);
  check('上限3なら4回目から断る', out, [false, false, false, true, true]);

  rl._resetForTest();
  check('残り回数を返す', rl.hit('t', '1.1.1.1', 3, { now }).remaining, 2);
  check('数えるごとに減る', rl.hit('t', '1.1.1.1', 3, { now }).remaining, 1);
}

section('相手ごとに別々に数える');
{
  rl._resetForTest();
  const now = 1000000;
  for (let i = 0; i < 3; i++) rl.hit('t', 'A', 3, { now });
  check('Aは上限に達している', rl.hit('t', 'A', 3, { now }).limited, true);
  check('Bはまだ通る', rl.hit('t', 'B', 3, { now }).limited, false);
}

section('口ごとに別々に数える');
{
  rl._resetForTest();
  const now = 1000000;
  for (let i = 0; i < 3; i++) rl.hit('write', 'A', 3, { now });
  check('書き込みは上限に達している', rl.hit('write', 'A', 3, { now }).limited, true);
  check('読み取りは別枠なので通る', rl.hit('read', 'A', 3, { now }).limited, false);
}

section('窓が変わると数え直す');
{
  rl._resetForTest();
  const now = 1000000;
  for (let i = 0; i < 4; i++) rl.hit('t', 'A', 3, { now });
  check('窓の中では断られる', rl.hit('t', 'A', 3, { now }).limited, true);
  /* 窓のすぐ手前を先に見る。窓が過ぎたことを先に確かめると、
     そこで数え直しが起きて手前の判定が変わってしまう */
  check('窓のすぐ手前ではまだ断る',
    rl.hit('t', 'A', 3, { now: now + WINDOW_MS - 1 }).limited, true);
  check('窓が過ぎれば通る', rl.hit('t', 'A', 3, { now: now + WINDOW_MS }).limited, false);
}

section('次に受け付けるまでの秒数');
{
  rl._resetForTest();
  const now = 1000000;
  for (let i = 0; i < 4; i++) rl.hit('t', 'A', 3, { now });
  const r = rl.hit('t', 'A', 3, { now: now + 20000 });
  check('残り40秒として返す', r.retryAfter, 40);
  check('0秒にはならない', rl.hit('t', 'A', 3, { now: now + WINDOW_MS - 1 }).retryAfter >= 1, true);
}

section('相手が分からないとき');
{
  rl._resetForTest();
  const now = 1000000;
  for (let i = 0; i < 3; i++) rl.hit('t', undefined, 3, { now });
  check('まとめて1つの枠として数える', rl.hit('t', undefined, 3, { now }).limited, true);
  check('空文字も同じ枠', rl.hit('t', '', 3, { now }).limited, true);
}

section('記録が際限なく増えない');
{
  rl._resetForTest();
  const now = 1000000;
  // 上限を超える数の相手から叩かせて、抱える数が青天井にならないことを見る
  for (let i = 0; i < rl.MAX_BUCKETS + 500; i++) rl.hit('t', 'ip' + i, 10, { now });
  const r = rl.hit('t', 'ip0', 10, { now });
  check('新しい相手は受け付け続ける', r.limited, false);
}

section('Expressに挟む形');
{
  rl._resetForTest();
  const mw = rl.limiter('mw', 2);
  const runs = [];
  const call = () => {
    const res = {
      code: 0, headers: {}, body: null,
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
    };
    let nexted = false;
    mw({ ip: '9.9.9.9' }, res, () => { nexted = true; });
    runs.push(nexted ? 'next' : res.code);
    return res;
  };
  call(); call();
  const blocked = call();
  check('上限までは次へ通す', runs.slice(0, 2), ['next', 'next']);
  check('超えたら429', runs[2], 429);
  check('断る理由を code で伝える', blocked.body.code, 'rate_limited');
  check('Retry-After を付ける', typeof blocked.headers['Retry-After'], 'string');

  rl._resetForTest();
  const off = rl.limiter('off', 0);
  let passed = false;
  off({ ip: '9.9.9.9' }, {}, () => { passed = true; });
  check('上限0なら制限しない（試験用）', passed, true);
}

/* 2026-08-12に本番で踏んだ失敗の再発防止。
   相手の見分けを req.ip 任せにしていたところ、Renderの前段プロキシが
   要求ごとに替わるせいで毎回ちがう相手として数えられ、
   いくら叩いても上限に達しなかった。ローカルにはプロキシが無いので気づけなかった。
   ここではプロキシ越しの形（X-Forwarded-For 付き・req.ip は毎回別）を作って、
   ちゃんと同じ相手として数えられることを確かめる */
section('プロキシ越しでも同じ相手として数える（2026-08-12）');
{
  /* server.js の clientKey と同じ規則。
     向こうを直したらこちらも直すこと（写しであることを承知で置いている）*/
  const clientKey = (req) => {
    const xff = String((req.headers && req.headers['x-forwarded-for']) || '');
    const first = xff.split(',')[0].trim();
    return first || req.ip || '';
  };

  rl._resetForTest();
  const mw = rl.limiter('proxied', 3, clientKey);
  const codes = [];
  const send = (clientIp, proxyIp) => {
    const res = {
      code: 0, set() { return this; }, status(c) { this.code = c; return this; }, json() { return this; },
    };
    mw({ headers: { 'x-forwarded-for': `${clientIp}, 10.0.0.9` }, ip: proxyIp },
      res, () => { res.code = 200; });
    codes.push(res.code);
  };
  // 同じ利用者だが、前段プロキシのアドレスは毎回ちがう
  send('203.0.113.5', '10.1.1.1');
  send('203.0.113.5', '10.1.1.2');
  send('203.0.113.5', '10.1.1.3');
  send('203.0.113.5', '10.1.1.4');
  check('プロキシが替わっても同じ相手として数える', codes, [200, 200, 200, 429]);

  // 別の利用者は巻き添えにしない
  const before = codes.length;
  send('198.51.100.7', '10.1.1.5');
  check('別の利用者は通る', codes[before], 200);

  rl._resetForTest();
  const mw2 = rl.limiter('noxff', 1, clientKey);
  const res2 = { code: 0, set() { return this; }, status(c) { this.code = c; return this; }, json() { return this; } };
  mw2({ headers: {}, ip: '1.2.3.4' }, res2, () => { res2.code = 200; });
  check('X-Forwarded-For が無ければ req.ip を使う', res2.code, 200);
}

/* ---------------------------------------------------------- */
console.log('\n────────────────────────────────────────────────────────');
if (failures.length) {
  console.log(`結果: ${pass}件成功 / ${failures.length}件失敗`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`結果: ${pass}件すべて成功`);
