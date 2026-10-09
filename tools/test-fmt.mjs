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
  /* 2026-10-09 から、表は時刻をマスの境目の線の横に出し、マス1つ＝その時刻から30分。
     終わりはいつも最後のマスの終わり（以前の「マス＝時刻」の読み方ではない） */
  check('マス1つ → 開始＋30分',
    A.fmtRanges([iso(17, 0)]), '17:00〜17:30');
  check('マス2つ（17:00/17:30）→ 17:00〜18:00',
    A.fmtRanges([iso(17, 0), iso(17, 30)]), '17:00〜18:00');
  check('マス3つ（17:00/17:30/18:00）→ 17:00〜18:30',
    A.fmtRanges([iso(17, 0), iso(17, 30), iso(18, 0)]), '17:00〜18:30');
  check('離れた区間は ＆ でつなぐ',
    A.fmtRanges([iso(10, 0), iso(10, 30), iso(13, 0)]), '10:00〜11:00＆13:00〜13:30');
  check('順番がばらばらでも時刻順に直す',
    A.fmtRanges([iso(18, 0), iso(17, 0), iso(17, 30)]), '17:00〜18:30');
  // いちばん下のマスは 23:30〜24:00。24:00 のマスは無いので 24:00〜0:30 にはならない
  check('最後のマス（23:30）→ 23:30〜24:00',
    A.fmtRanges([iso(23, 30)]), '23:30〜24:00');
  check('23:00・23:30 → 23:00〜24:00',
    A.fmtRanges([iso(23, 0), iso(23, 30)]), '23:00〜24:00');
}

console.log('\n[ スタッフ画面 index.html の fmtGroupRange ]');
{
  const I = load('index.html', ['pad', 'hm', 'hm24', 'slotDayStart', 'runEnd', 'fmtGroupRange'],
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
  // 表のいちばん下の 24:00 の行（中身は翌日 0:00）は「24:00」と読む
  check('23:00・23:30・24:00 → 23:00〜24:00',
    I.fmtGroupRange({ slots: [iso(23, 0), iso(23, 30), iso(0, 0, 8)] }), '8/7(金) 23:00〜24:00');
  /* 2026-10-09 からの申請（choice_mode:'slot'）はマス1つ＝30分。上は印の無い古い申請の読み方 */
  check('新しい申請：17:00/17:30 → 17:00〜18:00',
    I.fmtGroupRange({ mode: 'slot', slots: [iso(17, 0), iso(17, 30)] }), '8/7(金) 17:00〜18:00');
  check('新しい申請：最後のマス 23:30 → 23:30〜24:00',
    I.fmtGroupRange({ mode: 'slot', slots: [iso(23, 30)] }), '8/7(金) 23:30〜24:00');
}

/* 打ち込まれた開始時刻を、希望に含まれる30分枠に突き合わせる部分。
   ここが緩むと、学生が出していない時刻で面談が確定してしまう */
console.log('\n[ スタッフ画面 index.html の開始時刻チェック ]');
{
  const I = load('index.html', ['pad', 'hm', 'hm24', 'slotDayStart', 'runEnd', 'fmtGroupRange', 'ivTimeVal', 'ivSlotFor', 'ivTimeErr'],
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
     'copyReqOption', 'reqCalendarCells']);

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

  /* コピーは前の開始から1時間後。終了時刻の概念は廃止したので、
     開始時刻(t1)だけを見て次の候補をつくる */
  check('コピーは前の開始から1時間後',
    I.copyReqOption({ date: '2026-08-17', t1: '19:00' }),
    { date: '2026-08-17', t1: '20:00' });
  check('日をまたがなければ同じ日のまま',
    I.copyReqOption({ date: '2026-08-17', t1: '22:30' }),
    { date: '2026-08-17', t1: '23:30' });
  check('日をまたぐ分は翌日の0時へ',
    I.copyReqOption({ date: '2026-08-17', t1: '23:30' }),
    { date: '2026-08-18', t1: '00:00' });
  check('ちょうど24:00になる場合も翌日へ送る',
    I.copyReqOption({ date: '2026-08-17', t1: '23:00' }),
    { date: '2026-08-18', t1: '00:00' });
  check('月末をコピーすると翌月へ',
    I.copyReqOption({ date: '2026-08-31', t1: '23:30' }),
    { date: '2026-09-01', t1: '00:00' });

  /* 2026年8月は土曜はじまりで31日まで。1日の前に6つの空きが要る */
  const cells = I.reqCalendarCells(2026, 7, ['2026-08-17'], '2026-08-10');
  check('先頭は曜日のぶんだけ空く', cells.slice(0, 6), [null, null, null, null, null, null]);
  check('1日は7つめ', cells[6], { date: '2026-08-01', day: 1, on: false, past: true });
  check('選んだ日は on', cells[6 + 16], { date: '2026-08-17', day: 17, on: true, past: false });
  check('今日は past ではない', cells[6 + 9], { date: '2026-08-10', day: 10, on: false, past: false });
  check('末尾は7の倍数まで埋める', cells.length % 7, 0);
  check('マスの数は 6 + 31 を7で丸めた数', cells.length, 42);
}

/* 候補1件の表示。終了時刻の入力欄は廃止したので、
   終了時刻があるとき（過去のデータ）だけ範囲表示になる */
console.log('\n[ スタッフ画面 index.html の候補1件の表示 fmtSlot ]');
{
  const I = load('index.html', ['pad', 'hm', 'fmtDate', 'fmtSlot'],
    "const WD_JP=['日','月','火','水','木','金','土'];");
  const start = iso(19, 0, 12), end = iso(21, 0, 12);
  check('終了時刻があれば範囲で出す',
    I.fmtSlot({ has_date: true, has_time: true, start, end, end_time: '21:00' }),
    '8/12(水) 19:00〜21:00');
  check('終了時刻が無ければ開始だけ',
    I.fmtSlot({ has_date: true, has_time: true, start, end }),
    '8/12(水) 19:00');
  check('時間を設定していない候補は日付だけ',
    I.fmtSlot({ has_date: true, has_time: false, start }),
    '8/12(水)');
}

console.log('\n[ 出欠公開ページ attendance.html の候補1件の表示 fmtSlot ]');
{
  const A = load('attendance.html', ['jstParts', 'fmtSlot'],
    "const hm=(iso)=>{const p=jstParts(iso);return `${p.hour}:${p.minute}`;};");
  const start = '2026-08-12T19:00:00+09:00', end = '2026-08-12T21:00:00+09:00';
  check('終了時刻があれば範囲で出す',
    A.fmtSlot({ has_date: true, has_time: true, start, end, end_time: '21:00' }),
    '8/12(水) 19:00〜21:00');
  check('終了時刻が無ければ開始だけ',
    A.fmtSlot({ has_date: true, has_time: true, start, end }),
    '8/12(水) 19:00');
  check('時間を設定していない候補は日付だけ',
    A.fmtSlot({ has_date: true, has_time: false, start }),
    '8/12(水)');
}

console.log('\n[ server/server.js の候補正規化 normalizeAttendOption ]');
{
  const S = load('server/server.js', ['validAttendDate', 'validAttendTime', 'normalizeAttendOption']);
  const withEnd = S.normalizeAttendOption(
    { has_date: true, has_time: true, date: '2026-08-12', start_time: '19:00', end_time: '21:00' }, 'op0');
  check('終了時刻を指定すれば保存される', withEnd && withEnd.end_time, '21:00');
  check('終了時刻ありのendは指定どおり21時',
    withEnd && withEnd.end, new Date('2026-08-12T21:00:00+09:00').toISOString());

  const noEnd = S.normalizeAttendOption(
    { has_date: true, has_time: true, date: '2026-08-12', start_time: '19:00' }, 'op1');
  check('終了時刻を省略しても作れる', noEnd, {
    id: 'op1', has_date: true, has_time: true, date: '2026-08-12',
    start_time: '19:00',
    start: new Date('2026-08-12T19:00:00+09:00').toISOString(),
    end: new Date('2026-08-12T20:00:00+09:00').toISOString(),
  });
  check('終了時刻を省略したらend_timeは保存しない（表示に出さないため）', noEnd && ('end_time' in noEnd), false);

  const badEnd = S.normalizeAttendOption(
    { has_date: true, has_time: true, date: '2026-08-12', start_time: '19:00', end_time: '18:00' }, 'op2');
  check('終了時刻が開始より前なら弾く', badEnd, null);

  const badStart = S.normalizeAttendOption(
    { has_date: true, has_time: true, date: '2026-08-12', start_time: '25:99' }, 'op3');
  check('開始時刻の形がおかしければ弾く', badStart, null);
}

console.log('\n[ server/server.js の候補1件の表示 fmtSlotJP ]');
{
  const S = load('server/server.js', ['fmtSlotJP']);
  const start = '2026-08-12T19:00:00+09:00', end = '2026-08-12T21:00:00+09:00';
  check('終了時刻があれば範囲で出す',
    S.fmtSlotJP({ has_date: true, has_time: true, start, end, end_time: '21:00' }),
    '8/12(水) 19:00〜21:00');
  check('終了時刻が無ければ開始だけ',
    S.fmtSlotJP({ has_date: true, has_time: true, start, end }),
    '8/12(水) 19:00');
  check('時間を設定していない候補は日付だけ',
    S.fmtSlotJP({ has_date: true, has_time: false, start }),
    '8/12(水)');
  check('日付未定の候補はこれまでどおり',
    S.fmtSlotJP({ has_date: false, start_time: '20:00', end_time: '22:00' }),
    '20:00〜22:00（日程未定）');
}

/* 締切の計算。通知は日で数え、締切を過ぎたかどうかだけ時刻まで見る */
console.log('\n[ スタッフ画面 index.html の締切通知の計算 ]');
{
  const I = load('index.html', ['pad', 'dueDaysRemaining', 'dueShouldNotify', 'dueNoticeText',
    'dueIsExpired', 'dueResolveDate', 'dueMonthDays']);

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

  /* 締切の時刻。既定は 23:59 なので、ふだんは「その日いっぱい」になる */
  check('締切時刻の前はまだ過ぎていない',
    I.dueIsExpired('2026-08-31', '23:59', '2026-08-31', '23:58'), false);
  check('締切時刻を回ったら過ぎている',
    I.dueIsExpired('2026-08-31', '18:00', '2026-08-31', '18:01'), true);
  check('締切時刻ちょうどはまだ過ぎていない',
    I.dueIsExpired('2026-08-31', '18:00', '2026-08-31', '18:00'), false);
  check('翌日になれば時刻を問わず過ぎている',
    I.dueIsExpired('2026-08-31', '23:59', '2026-09-01', '00:00'), true);
  /* 時刻の無い依頼＝この欄ができる前に送ったもの。今までどおり日で見る */
  check('時刻の無い依頼は当日いっぱい過ぎていない',
    I.dueIsExpired('2026-08-31', '', '2026-08-31', '23:59'), false);
  check('時刻の無い依頼も翌日には過ぎている',
    I.dueIsExpired('2026-08-31', '', '2026-09-01', '00:00'), true);
  check('締切を過ぎた依頼は通知しない',
    I.dueShouldNotify('2026-08-31', '2026-08-31', '18:00', '19:00'), false);
  check('締切時刻の前なら当日でも通知する',
    I.dueShouldNotify('2026-08-31', '2026-08-31', '18:00', '17:00'), true);

  /* 年は入力させず、月日から今日以降でいちばん近い年を当てる */
  check('先の月日は今年になる', I.dueResolveDate(9, 2, '2026-08-31'), '2026-09-02');
  check('今日と同じ日はその年のまま', I.dueResolveDate(8, 31, '2026-08-31'), '2026-08-31');
  check('過ぎた月日は翌年になる', I.dueResolveDate(1, 5, '2026-08-31'), '2027-01-05');
  check('月日が揃わないうちは空', I.dueResolveDate(8, '', '2026-08-31'), '');
  check('30日までの月を数えられる', I.dueMonthDays(9, '2026-08-31'), 30);
  check('うるう年の2月は29日まで', I.dueMonthDays(2, '2027-06-01'), 29);
  check('ふつうの年の2月は28日まで', I.dueMonthDays(2, '2026-06-01'), 28);
}

/* ブラウザの「戻る／進む」で、アプリ内の直前画面を復元するための履歴状態。 */
console.log('\n[ スタッフ画面 index.html の画面履歴 ]');
{
  const I = load('index.html', ['historyTab']);
  check('履歴に保存したタブを復元する', I.historyTab({ tab: 'requests' }), 'requests');
  check('タブを持たない履歴は復元しない', I.historyTab({}), null);
  check('アプリ以外の履歴は復元しない', I.historyTab(null), null);
}

/* 日程調整の候補行。時刻を残したまま、上の設定がオフなら入力欄だけ隠す。 */
console.log('\n[ スタッフ画面 index.html の日程候補の時刻欄 ]');
{
  const I = load('index.html', ['pad', 'reqHHMM', 'reqTimeOptionsHTML', 'reqDateLabel', 'reqOptionsHTML'],
    "var REQFORM={kind:'attend',addTime:'',opts:[{date:'2026-08-20',t1:'09:30'}]}; function reqCalendarHTML(){return '<calendar>';}; function ic(){return ''};");
  const html = I.reqOptionsHTML();
  check('時間を設定しない間は候補行の時刻欄を隠す', html.includes('class=\"opttime\"'), false);
}

/* 日程調整画面（free.html）。apply.html の写しなので、
   時刻のまとめ方が同じままであることを確かめる */
console.log('\n[ 日程調整画面 free.html の fmtRanges ]');
{
  const F = load('free.html', ['pad', 'hm', 'runEnd', 'fmtRanges'],
    'var SLOT_MS=30*60*1000;');
  check('マス1つ → 開始＋30分', F.fmtRanges([iso(17, 0)]), '17:00〜17:30');
  check('続いた2マス（17:00/17:30）→ 17:00〜18:00',
    F.fmtRanges([iso(17, 0), iso(17, 30)]), '17:00〜18:00');
  check('最後のマス（23:30）→ 23:30〜24:00', F.fmtRanges([iso(23, 30)]), '23:30〜24:00');
  check('離れた枠は ＆ でつなぐ',
    F.fmtRanges([iso(17, 0), iso(19, 0)]), '17:00〜17:30＆19:00〜19:30');
}

/* 空き時間のかぶり。複数の学生が同じ枠を選ぶほど人数が積み上がる */
console.log('\n[ 空き時間のかぶり集計 index.html ]');
{
  const T = load('index.html', ['fsSegments', 'fsTally'], 'var FS_SLOT_MS=30*60*1000;');
  const a = '2026-08-25T05:00:00.000Z';
  const b = '2026-08-25T05:30:00.000Z';
  const c = '2026-08-26T05:00:00.000Z';
  const responses = [
    { name: '山田', choices: [a, b] },
    { name: '佐藤', choices: [a, c] },
    { name: '鈴木', choices: [a] },
  ];
  const tally = T.fsTally(responses);
  check('同じ枠に3人が集まる', tally[a], ['山田', '佐藤', '鈴木']);
  /* 選んだのは「時刻」。山田の a・b（続いた2つ）は a〜b の意味なので、b は終わりの時刻で数えない */
  check('続いた並びの最後は終わりの時刻なので数えない', b in tally, false);
  check('1つだけ選んだ枠も数える', tally[c], ['佐藤']);
  check('誰も選んでいない枠は持たない', 'x' in tally, false);

}

/* 30分の枡目のままだと「終日OK」の日が1人の枠で埋まって読めないので、
   続いた枠を1本の帯にまとめて見せる。顔ぶれが変わる所で切る */
console.log('\n[ 空き時間の帯まとめ index.html ]');
{
  const T = load('index.html',
    ['fsSegments', 'fsTally', 'fsRanges', 'fsBest', 'fsOwnRanges'], 'var FS_SLOT_MS=30*60*1000;');
  const at = (h, m, day = 7) => iso(h, m, day);

  // 山田は 9:00〜11:00 通し、佐藤は 10:00〜11:00 だけ（選ぶのは時刻。終わりの 11:00 も選ぶ）
  const tally = T.fsTally([
    { name: '山田', choices: [at(9, 0), at(9, 30), at(10, 0), at(10, 30), at(11, 0)] },
    { name: '佐藤', choices: [at(10, 0), at(10, 30), at(11, 0)] },
  ]);
  const r = T.fsRanges(tally);
  check('顔ぶれが変わる所で割れる', r.length, 2);
  check('前半は山田だけ', [r[0].start, r[0].end, r[0].names], [at(9, 0), at(10, 0), ['山田']]);
  check('後半は2人', [r[1].start, r[1].end, r[1].names], [at(10, 0), at(11, 0), ['佐藤', '山田']]);

  // 途中で人が増えて、また減る → 3本（山田 9:00〜10:30、佐藤は 9:30 だけ＝9:30〜10:00）
  const r3 = T.fsRanges(T.fsTally([
    { name: '山田', choices: [at(9, 0), at(9, 30), at(10, 0), at(10, 30)] },
    { name: '佐藤', choices: [at(9, 30)] },
  ]));
  check('増えて減ると3本になる', r3.map((x) => x.names.length), [1, 2, 1]);

  // 離れた枠・日をまたぐ枠はつながらない
  check('離れた枠はつながらない',
    T.fsRanges(T.fsTally([{ name: '山田', choices: [at(9, 0), at(12, 0)] }])).length, 2);
  check('日をまたぐとつながらない',
    T.fsRanges(T.fsTally([{ name: '山田', choices: [at(9, 0, 7), at(9, 0, 8)] }])).length, 2);

  check('いちばん多い帯だけを返す', T.fsBest(r).map((x) => x.names.length), [2]);
  check('同数なら早い順', T.fsBest(r3.filter((x) => x.names.length === 1))
    .map((x) => x.start), [at(9, 0), at(10, 0)]);
  check('誰も答えていなければ空', T.fsBest([]), []);

  // 1人分。「終日OK」の日も、ほかと同じく時間の帯で出す
  check('1人分もまとめる（9:00・9:30 は 9:00〜9:30、10:30 だけは 10:30〜11:00）',
    T.fsOwnRanges([at(10, 30), at(9, 0), at(9, 30)]),
    [{ start: at(9, 0), end: at(9, 30) }, { start: at(10, 30), end: at(11, 0) }]);
  check('21:00・21:30・22:00 → 21:00〜22:00（21:00〜22:30 ではない）',
    T.fsOwnRanges([at(21, 0), at(21, 30), at(22, 0)]), [{ start: at(21, 0), end: at(22, 0) }]);
  /* 2026-10-09 からの回答（choice_mode:'slot'）はマスがそのまま30分の区切り */
  check('新しい回答：21:00・21:30 → 21:00〜22:00',
    T.fsOwnRanges([at(21, 0), at(21, 30)], 'slot'), [{ start: at(21, 0), end: at(22, 0) }]);
  check('新しい回答と古い回答が混ざっても、かぶりは正しく出る',
    T.fsRanges(T.fsTally([
      { name: '山田', choices: [at(21, 0), at(21, 30)], choice_mode: 'slot' },          // 21:00〜22:00
      { name: '佐藤', choices: [at(21, 0), at(21, 30), at(22, 0)] },                     // 21:00〜22:00（古い読み方）
    ])).map((x) => [x.start, x.end, x.names.length]),
    [[at(21, 0), at(22, 0), 2]]);
  check('人によって終わりが違っても、かぶりは正しく出る',
    T.fsRanges(T.fsTally([
      { name: '山田', choices: [at(21, 0), at(21, 30), at(22, 0)] },
      { name: '佐藤', choices: [at(21, 0), at(21, 30)] },
    ])).map((x) => [x.start, x.end, x.names.length]),
    [[at(21, 0), at(21, 30), 2], [at(21, 30), at(22, 0), 1]]);
  check('選んでいなければ空', T.fsOwnRanges([]), []);
}

console.log('\n[ 受けられない時間の表 index.html の blkIntervals / blkHit / blkColumnPlan ]');
{
  /* 表のマスは「時刻」。学生の申請画面と同じく、21:00・21:30・22:00 に×なら
     21:00〜22:00 が受けられない（21:00〜22:30 ではない） */
  const B = load('index.html', ['blkIntervals', 'blkHit', 'blkColumnPlan']);
  const t = (h, m, day = 7) => new Date(2026, 7, day, h, m, 0, 0).getTime();
  const at = (h, m, day) => new Date(t(h, m, day)).toISOString();
  const hitsOf = (blocks) => {
    const v = B.blkIntervals(blocks);
    const out = [];
    for (let m = 9 * 60; m <= 24 * 60; m += 30) if (B.blkHit(v, t(0, m))) out.push(m / 60);
    return out;
  };
  // 1日ぶんの列。xs に入っている時刻だけ×、ほかは○
  const column = (xs, extra = {}) => {
    const cells = [];
    for (let m = 9 * 60; m <= 24 * 60; m += 30) {
      const st = extra[m / 60] || (xs.includes(m / 60) ? 'x' : 'ok');
      cells.push({ t: t(0, m), st });
    }
    return cells;
  };
  let n = 0;
  const newId = () => 'n' + (++n);
  const plan = (xs, blocks = [], extra) => B.blkColumnPlan(column(xs, extra), blocks, newId);
  const span = (b) => [b.kind, b.start, b.end];

  /* 2026-10-09 から、マス1つ＝その時刻から30分。保存は「本当に受けられない時間」の start〜end */
  // 作る側
  check('21:00・21:30 に× → 21:00〜22:00 で保存',
    plan([21, 21.5]).added.map(span), [['slot', at(21, 0), at(22, 0)]]);
  check('×1つ → その時刻から30分',
    plan([21]).added.map(span), [['slot', at(21, 0), at(21, 30)]]);
  check('離れた×は別々',
    plan([10, 21, 21.5]).added.map(span),
    [['slot', at(10, 0), at(10, 30)], ['slot', at(21, 0), at(22, 0)]]);
  check('最後のマス 23:30 に× → 23:30〜24:00',
    plan([23.5]).added.map(span), [['slot', at(23, 30), at(24, 0)]]);
  check('予定ありのマスをはさんでもひと続き',
    plan([21, 22], [], { 21.5: 'lock' }).added.map(span), [['slot', at(21, 0), at(22, 30)]]);
  check('過ぎた時間は保存し直さない',
    plan([12], [], { 9: 'past', 9.5: 'past' }).added.map(span), [['slot', at(12, 0), at(12, 30)]]);

  // 読む側：start〜end と重なるマスが×
  check('21:00〜22:00 は 21:00 と 21:30 のマス',
    hitsOf([{ kind: 'slot', start: at(21, 0), end: at(22, 0) }]), [21, 21.5]);
  check('30分ぶんは1マス',
    hitsOf([{ kind: 'slot', start: at(21, 0), end: at(21, 30) }]), [21]);
  check('「マス＝時刻」の頃の range（21:00〜22:00）も同じ2マス',
    hitsOf([{ kind: 'range', start: at(21, 0), end: at(22, 0) }]), [21, 21.5]);
  check('日時でまとめて追加（kind なし）も同じ',
    hitsOf([{ start: at(13, 0), end: at(14, 0) }]), [13, 13.5]);
  check('Googleの予定は×に数えない',
    hitsOf([{ kind: 'external-google', start: at(13, 0), end: at(14, 0) }]), []);

  // 作り直し：列に見えている自分の分は外し、Googleの予定と別の日は触らない
  const old = [
    { id: 'a', kind: 'slot', start: at(21, 0), end: at(21, 30) },
    { id: 'b', kind: 'slot', start: at(21, 30), end: at(22, 0) },
    { id: 'g', kind: 'external-google', start: at(13, 0), end: at(14, 0) },
    { id: 'o', kind: 'slot', start: at(21, 0, 8), end: at(21, 30, 8) },
  ];
  check('保存済みが無ければ外すものも無い', plan([21, 21.5]).removedIds, []);
  check('作り直すときは同じ列の古い分を外す', plan([21, 21.5], old).removedIds, ['a', 'b']);
  // 9時より前にはみ出していた分は、はみ出した部分だけ残す
  const early = [{ id: 'e', start: at(8, 0), end: at(10, 0) }];
  check('9時より前の部分は残す',
    plan([9, 9.5], early).added.map(span),
    [['slot', at(9, 0), at(10, 0)], ['slot', at(8, 0), at(9, 0)]]);
  check('9:00 の×を外しても、9時より前の部分は残る',
    plan([], early).added.map(span), [['slot', at(8, 0), at(9, 0)]]);
}

console.log(`\n合格 ${pass}件 / 不合格 ${failures.length}件`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
