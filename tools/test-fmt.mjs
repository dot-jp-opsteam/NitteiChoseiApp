/* =========================================================
   表示だけを受け持つ関数の検証

   使い方:  node tools/test-fmt.mjs

   apply.html と index.html は <script> 直書きなので import できない。
   そこで関数の本体をファイルから切り出し、new Function で組み立てて動かしている。
   ソースを写して持つと二重管理になり、片方だけ直したときに気づけないため、
   必ず実ファイルから読むこと。

   ※対象にできるのは「文字列や正規表現の中に波括弧を含まない単純な関数」だけ。
     切り出しは波括弧の数を数えているので、それ以外だと壊れる。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}

/* `function 名(` から、対応する閉じ波括弧までを切り出す */
function cut(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つかりません（名前を変えたならこのファイルも直すこと）`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} の終わりが見つかりません`);
}
/* 指定した関数だけを取り出して、動かせる形にして返す */
function load(file, names, prelude = '') {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const body = names.map((n) => cut(src, n)).join('\n');
  return new Function(`${prelude}\n${body}\nreturn {${names.join(',')}};`)();
}

/* 30分刻みの ISO 文字列を作る。時間帯はこの端末のもので揃えれば足りる
   （hm() も同じ端末の時計で読むため、ずれは打ち消し合う） */
function iso(h, m, day = 7) {
  return new Date(2026, 7, day, h, m, 0, 0).toISOString();
}

console.log('\n[ 申請画面 apply.html の fmtRanges ]');
{
  const A = load('apply.html', ['pad', 'hm', 'runEnd', 'fmtRanges'],
    'var SLOT_MS=30*60*1000;');
  check('枠1つ → 開始＋30分',
    A.fmtRanges([iso(17, 0)]), '17:00〜17:30');
  check('枠2つ → 最後の枠の開始時刻',
    A.fmtRanges([iso(17, 0), iso(17, 30)]), '17:00〜17:30');
  check('枠3つ（17:00/17:30/18:00）→ 17:00〜18:00',
    A.fmtRanges([iso(17, 0), iso(17, 30), iso(18, 0)]), '17:00〜18:00');
  check('枠4つ（20:00〜21:30）→ 20:00〜21:30',
    A.fmtRanges([iso(20, 0), iso(20, 30), iso(21, 0), iso(21, 30)]), '20:00〜21:30');
  check('離れた区間は ＆ でつなぐ',
    A.fmtRanges([iso(10, 0), iso(10, 30), iso(13, 0)]), '10:00〜10:30＆13:00〜13:30');
  check('順番がばらばらでも時刻順に直す',
    A.fmtRanges([iso(18, 0), iso(17, 0), iso(17, 30)]), '17:00〜18:00');
}

console.log('\n[ スタッフ画面 index.html の fmtGroupRange ]');
{
  const I = load('index.html', ['pad', 'hm', 'runEnd', 'fmtGroupRange'],
    'var SLOT_MS=30*60*1000; function fmtDate(){return "8/7(金)";}');
  check('枠1つ → 開始＋30分',
    I.fmtGroupRange({ slots: [iso(17, 0)] }), '8/7(金) 17:00〜17:30');
  check('枠3つ（17:00/17:30/18:00）→ 17:00〜18:00',
    I.fmtGroupRange({ slots: [iso(17, 0), iso(17, 30), iso(18, 0)] }), '8/7(金) 17:00〜18:00');
  check('枠4つ（20:00〜21:30）→ 20:00〜21:30',
    I.fmtGroupRange({ slots: [iso(20, 0), iso(20, 30), iso(21, 0), iso(21, 30)] }),
    '8/7(金) 20:00〜21:30');
  check('離れた区間は ＆ でつなぐ（終日OKの日）',
    I.fmtGroupRange({ allDay: true, slots: [iso(10, 0), iso(10, 30), iso(13, 0)] }),
    '8/7(金) 10:00〜10:30＆13:00〜13:30');
  check('枠なし → —', I.fmtGroupRange({ slots: [] }), '—');
}

console.log(`\n合格 ${pass}件 / 不合格 ${failures.length}件`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
