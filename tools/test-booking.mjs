/* 予約スケジュールの枠の計算（server/booking.js）の検査。
   使い方:  node tools/test-booking.mjs

   DBにもGoogleにも触らない純粋な関数なので、材料を作って直接呼ぶ。
   サーバーと同じく日本時間で動かす（読み込みより先に決める必要がある） */
process.env.TZ = 'Asia/Tokyo';

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = createRequire(path.join(ROOT, 'server', 'package.json'))('./booking.js');

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { failures.push(label); console.log(`  NG   ${label}\n         期待: ${JSON.stringify(expected)}\n         実際: ${JSON.stringify(actual)}`); }
}
const at = (s) => new Date(s).getTime();   // '2026-10-05T10:00' は日本時間として読まれる
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function cfg(over) {
  const r = b.normalizeConfig({ title: 'テスト', ...over });
  if (r.error) throw new Error(r.error);
  return r.config;
}
/* 2026-10-05 は月曜日。朝7時を「今」にしておく */
const NOW = at('2026-10-05T07:00:00');
const MON = { from: at('2026-10-05T00:00:00'), to: at('2026-10-06T00:00:00') };
const dayHm = (c, extra = {}) => b.computeSlots(c, { now: NOW, fromMs: MON.from, toMs: MON.to, ...extra }).map(hm);

console.log('\n─────── 設定の正規化 ───────');
check('タイトルが無ければ弾く', b.normalizeConfig({}).error, 'タイトルを入力してください');
{
  const c = cfg({});
  check('初期値：30分・60日先まで・4時間前まで', [c.duration, c.maxDays, c.minNoticeHours], [30, 60, 4]);
  check('初期値：平日9〜17時、土日は休み', [c.weekly[1], c.weekly[0], c.weekly[6]], [[{ s: '09:00', e: '17:00' }], [], []]);
  check('初期値：場所はMeet・リマインダーは前日と1時間前', [c.location.type, c.reminders], ['meet', [1440, 60]]);
}
check('知らない長さは30分に戻す', cfg({ duration: 37 }).duration, 30);
check('重なる区間は1本にまとめる',
  cfg({ weekly: { 1: [{ s: '10:00', e: '12:00' }, { s: '11:00', e: '13:00' }, { s: '15:00', e: '14:00' }] } }).weekly[1],
  [{ s: '10:00', e: '13:00' }]);
check('開始日と終了日が逆なら入れ替える',
  [cfg({ startDate: '2026-12-01', endDate: '2026-11-01' }).startDate, cfg({ startDate: '2026-12-01', endDate: '2026-11-01' }).endDate],
  ['2026-11-01', '2026-12-01']);
check('何日先までは1〜365に丸める', [cfg({ maxDays: 0 }).maxDays, cfg({ maxDays: 9999 }).maxDays], [1, 365]);
check('空の質問は捨て、10問までにする',
  cfg({ questions: [{ label: '' }, ...Array.from({ length: 12 }, (_, i) => ({ label: 'Q' + i }))] }).questions.length, 10);
check('同じIDの質問は振り直す',
  new Set(cfg({ questions: [{ id: 'a', label: '1' }, { id: 'a', label: '2' }] }).questions.map((q) => q.id)).size, 2);
check('選択肢に無いリマインダーは捨てる', cfg({ reminders: [60, 61, 1440] }).reminders, [1440, 60]);
check('壊れた日付の上書きは捨てる', Object.keys(cfg({ overrides: { 'abc': [], '2026-10-10': [] } }).overrides), ['2026-10-10']);

console.log('\n─────── 区間の切り方 ───────');
{
  const c = cfg({ minNoticeHours: 0, weekly: { 1: [{ s: '10:00', e: '11:45' }] } });
  check('30分枠：区間をはみ出す枠は作らない', dayHm(c), ['10:00', '10:30', '11:00']);
}
{
  const c = cfg({ minNoticeHours: 0, duration: 60, weekly: { 1: [{ s: '10:00', e: '12:00' }, { s: '14:00', e: '15:30' }] } });
  check('60分枠：区間ごとに頭から切る', dayHm(c), ['10:00', '11:00', '14:00']);
}
{
  const c = cfg({ minNoticeHours: 0, duration: 15, weekly: { 1: [{ s: '23:15', e: '24:00' }] } });
  check('24:00 まで使える', dayHm(c), ['23:15', '23:30', '23:45']);
}

console.log('\n─────── 予約期間 ───────');
{
  const c = cfg({ weekly: { 1: [{ s: '09:00', e: '13:00' }] } }); // 4時間前まで → 11:00以降
  check('締め切り（4時間前）より近い枠は出ない', dayHm(c), ['11:00', '11:30', '12:00', '12:30']);
}
{
  const c = cfg({ minNoticeHours: 0, maxDays: 2, weekly: { 1: [{ s: '09:00', e: '10:00' }], 2: [{ s: '09:00', e: '10:00' }], 3: [{ s: '09:00', e: '10:00' }] } });
  const all = b.computeSlots(c, { now: NOW }).map((ms) => b.ymdOf(new Date(ms)));
  check('何日先まで：今日を含めて2日分', [...new Set(all)], ['2026-10-05', '2026-10-06']);
}
{
  const c = cfg({ minNoticeHours: 0, startDate: '2026-10-07', endDate: '2026-10-08',
    weekly: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ s: '09:00', e: '09:30' }]])) });
  const days = b.computeSlots(c, { now: NOW }).map((ms) => b.ymdOf(new Date(ms)));
  check('開始日・終了日の外は出ない', days, ['2026-10-07', '2026-10-08']);
}

console.log('\n─────── 特定日の調整と「繰り返さない」 ───────');
{
  const c = cfg({ minNoticeHours: 0, weekly: { 1: [{ s: '09:00', e: '10:00' }] }, overrides: { '2026-10-05': [{ s: '15:00', e: '16:00' }] } });
  check('特定日の区間に差し替わる', dayHm(c), ['15:00', '15:30']);
}
{
  const c = cfg({ minNoticeHours: 0, weekly: { 1: [{ s: '09:00', e: '10:00' }] }, overrides: { '2026-10-05': [] } });
  check('空の上書きはその日を休みにする', dayHm(c), []);
}
{
  const c = cfg({ minNoticeHours: 0, repeat: 'none', weekly: { 1: [{ s: '09:00', e: '10:00' }], 2: [{ s: '09:00', e: '10:00' }] },
    overrides: { '2026-10-06': [{ s: '13:00', e: '13:30' }] } });
  const all = b.computeSlots(c, { now: NOW }).map((ms) => `${b.ymdOf(new Date(ms))} ${hm(ms)}`);
  check('繰り返さない：特定日として入れた日だけ', all, ['2026-10-06 13:00']);
}

console.log('\n─────── 予定・余白・上限 ───────');
const WIDE = { minNoticeHours: 0, weekly: { 1: [{ s: '09:00', e: '12:00' }] } };
{
  const c = cfg(WIDE);
  check('Googleの予定と少しでも重なる枠は消える',
    dayHm(c, { busy: [[at('2026-10-05T09:45:00'), at('2026-10-05T10:15:00')]] }),
    ['09:00', '10:30', '11:00', '11:30']);
  check('ちょうど隣り合う予定では消えない',
    dayHm(c, { busy: [[at('2026-10-05T08:00:00'), at('2026-10-05T09:00:00')]] }).length, 6);
}
{
  const c = cfg({ ...WIDE, bufferMin: 15 });
  check('余白はこのスケジュールの予約の前後だけに効く',
    dayHm(c, { pageBookings: [[at('2026-10-05T10:00:00'), at('2026-10-05T10:30:00')]] }),
    ['09:00', '11:00', '11:30']);
  check('ほかの予定には余白を付けない',
    dayHm(c, { busy: [[at('2026-10-05T10:00:00'), at('2026-10-05T10:30:00')]] }),
    ['09:00', '09:30', '10:30', '11:00', '11:30']);
}
{
  const c = cfg({ ...WIDE, maxPerDay: 2 });
  const two = [[at('2026-10-05T09:00:00'), at('2026-10-05T09:30:00')], [at('2026-10-05T11:30:00'), at('2026-10-05T12:00:00')]];
  check('1日の上限に達したらその日は全部消える', dayHm(c, { pageBookings: two }), []);
  check('上限に達していなければ残る', dayHm(c, { pageBookings: two.slice(0, 1) }).length, 5);
}

console.log('\n─────── 送信時の確認・まとめ方 ───────');
{
  const c = cfg(WIDE);
  check('空いている枠は予約できる', b.isBookable(c, { now: NOW }, at('2026-10-05T10:00:00')), true);
  check('枠の途中の時刻は予約できない', b.isBookable(c, { now: NOW }, at('2026-10-05T10:10:00')), false);
  check('埋まった枠は予約できない',
    b.isBookable(c, { now: NOW, busy: [[at('2026-10-05T10:00:00'), at('2026-10-05T10:30:00')]] }, at('2026-10-05T10:00:00')), false);
  check('日ごとにまとめる',
    b.groupByDay([at('2026-10-05T09:00:00'), at('2026-10-05T09:30:00'), at('2026-10-06T23:30:00')]),
    { '2026-10-05': ['09:00', '09:30'], '2026-10-06': ['23:30'] });
}

console.log('\n───────');
console.log(`${pass}件OK / ${failures.length}件NG`);
if (failures.length) process.exit(1);
