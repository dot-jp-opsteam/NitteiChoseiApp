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

/* 打ち込まれた開始時刻を、希望に含まれる30分枠に突き合わせる部分。
   ここが緩むと、学生が出していない時刻で面談が確定してしまう */
console.log('\n[ スタッフ画面 index.html の開始時刻チェック ]');
{
  const I = load('index.html', ['pad', 'hm', 'runEnd', 'fmtGroupRange', 'ivTimeVal', 'ivSlotFor', 'ivTimeErr'],
    'var SLOT_MS=30*60*1000; var IV_TIME={}; function fmtDate(){return "8/7(金)";}');
  const g = { slots: [iso(17, 0), iso(17, 30), iso(18, 0)] };   // 17:00〜18:00 の希望
  check('範囲の先頭は通る', I.ivSlotFor(g, '17:00'), g.slots[0]);
  check('範囲の途中も通る', I.ivSlotFor(g, '17:30'), g.slots[1]);
  check('範囲の最後も通る', I.ivSlotFor(g, '18:00'), g.slots[2]);
  check('範囲より前は弾く', I.ivSlotFor(g, '16:30'), null);
  check('範囲より後は弾く', I.ivSlotFor(g, '18:30'), null);
  check('30分刻みでなければ弾く', I.ivSlotFor(g, '17:15'), null);
  check('空欄は弾く', I.ivSlotFor(g, ''), null);
  check('希望が無ければ弾く', I.ivSlotFor(null, '17:00'), null);
  check('初期値は先頭の枠', I.ivTimeVal(g, 1), '17:00');
  check('空欄のときの注意書き', I.ivTimeErr(g, ''), '開始時刻を入力してください');
  check('範囲外のときの注意書き', I.ivTimeErr(g, '19:00'),
    '8/7(金) 17:00〜18:00 の範囲内で入力してください（17:00・17:30・18:00）');
}

/* 出欠確認の候補日時。日付と時刻の計算だけを見る（画面の組み立ては目視で確かめる） */
console.log('\n[ スタッフ画面 index.html の候補日時の計算 ]');
{
  const I = load('index.html',
    ['pad', 'ymd', 'reqMins', 'reqHHMM', 'reqShiftDate', 'reqDateRange',
     'copyReqOption', 'reqApplyTimeChange', 'reqCalendarCells']);

  check('時刻を分に直す', I.reqMins('19:30'), 19 * 60 + 30);
  check('分を時刻に戻す', I.reqHHMM(19 * 60 + 30), '19:30');
  check('0時ちょうども戻せる', I.reqHHMM(0), '00:00');
  check('日付を1日進める', I.reqShiftDate('2026-08-17', 1), '2026-08-18');
  check('月をまたいで進める', I.reqShiftDate('2026-08-31', 1), '2026-09-01');

  check('なぞった範囲を昇順で返す',
    I.reqDateRange('2026-08-17', '2026-08-19'),
    ['2026-08-17', '2026-08-18', '2026-08-19']);
  check('逆向きになぞっても昇順',
    I.reqDateRange('2026-08-19', '2026-08-17'),
    ['2026-08-17', '2026-08-18', '2026-08-19']);
  check('同じ日なら1件', I.reqDateRange('2026-08-17', '2026-08-17'), ['2026-08-17']);

  check('コピーは前の終わりから始まり長さを保つ',
    I.copyReqOption({ date: '2026-08-17', t1: '19:00', t2: '21:00' }),
    { date: '2026-08-17', t1: '21:00', t2: '23:00' });
  check('その日に収まらないぶんは翌日の先頭へ',
    I.copyReqOption({ date: '2026-08-17', t1: '21:00', t2: '23:00' }),
    { date: '2026-08-18', t1: '00:00', t2: '02:00' });
  check('終わりが24:00になる場合も翌日へ送る',
    I.copyReqOption({ date: '2026-08-17', t1: '22:00', t2: '23:00' }),
    { date: '2026-08-18', t1: '00:00', t2: '01:00' });
  check('月末をコピーすると翌月へ',
    I.copyReqOption({ date: '2026-08-31', t1: '22:00', t2: '23:00' }),
    { date: '2026-09-01', t1: '00:00', t2: '01:00' });

  const base = { t1: '19:00', t2: '21:00' };
  check('終わりを後ろへ動かすと開始はそのまま',
    I.reqApplyTimeChange(base, 't2', '22:00'), { t1: '19:00', t2: '22:00' });
  check('終わりを開始より前に回すと開始も一緒に下がる',
    I.reqApplyTimeChange(base, 't2', '18:00'), { t1: '16:00', t2: '18:00' });
  check('開始を終わりより後ろに回すと終わりも一緒に上がる',
    I.reqApplyTimeChange(base, 't1', '22:00'), { t1: '22:00', t2: '23:59' });
  check('開始を前へ動かすと終わりはそのまま',
    I.reqApplyTimeChange(base, 't1', '17:00'), { t1: '17:00', t2: '21:00' });
  check('終わりを0時へ回しても開始が負にならない',
    I.reqApplyTimeChange(base, 't2', '00:30'), { t1: '00:00', t2: '00:30' });

  /* 2026年8月は土曜はじまりで31日まで。1日の前に6つの空きが要る */
  const cells = I.reqCalendarCells(2026, 7, ['2026-08-17'], '2026-08-10');
  check('先頭は曜日のぶんだけ空く', cells.slice(0, 6), [null, null, null, null, null, null]);
  check('1日は7つめ', cells[6], { date: '2026-08-01', day: 1, on: false, past: true });
  check('選んだ日は on', cells[6 + 16], { date: '2026-08-17', day: 17, on: true, past: false });
  check('今日は past ではない', cells[6 + 9], { date: '2026-08-10', day: 10, on: false, past: false });
  check('末尾は7の倍数まで埋める', cells.length % 7, 0);
  check('マスの数は 6 + 31 を7で丸めた数', cells.length, 42);
}

/* 締切日の通知計算。時刻を見ず、日付だけで境界を判定する */
console.log('\n[ スタッフ画面 index.html の締切通知の計算 ]');
{
  const I = load('index.html', ['dueDaysRemaining', 'dueShouldNotify', 'dueNoticeText']);

  check('月をまたいでも残り日数を数えられる',
    I.dueDaysRemaining('2026-09-02', '2026-08-31'), 2);
  check('締切が4日後ならまだ出さない', I.dueShouldNotify('2026-09-04', '2026-08-31'), false);
  check('締切の3日前になったら出す', I.dueShouldNotify('2026-09-03', '2026-08-31'), true);
  check('締切が2日後なら出す', I.dueShouldNotify('2026-09-02', '2026-08-31'), true);
  check('締切が今日なら出す', I.dueShouldNotify('2026-08-31', '2026-08-31'), true);
  check('締切が昨日なら出さない', I.dueShouldNotify('2026-08-30', '2026-08-31'), false);
  check('締切が未設定なら出さない', I.dueShouldNotify('', '2026-08-31'), false);
  check('2日前の文言に件名と残り日数が入る',
    I.dueNoticeText('チーム懇親会', 2), 'チーム懇親会の回答期限まであと2日です');
  check('当日の文言は「今日まで」になる',
    I.dueNoticeText('資料確認', 0), '資料確認の回答期限は今日までです');
}

console.log(`\n合格 ${pass}件 / 不合格 ${failures.length}件`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
