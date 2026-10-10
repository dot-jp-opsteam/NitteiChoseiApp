import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
process.env.TZ = 'Asia/Tokyo';
const require = createRequire(import.meta.url);
const booking = require('../server/booking.js');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('function bkList('), html.indexOf('function bkCalendarsHTML('));
const cfg = () => ({...booking.defaultConfig(), title:'日時編集テスト'});
const ctx = vm.createContext({ BKE: { c: cfg() }, toast() {}, bkRedraw() {}, esc: String, ic: () => '', BK_DOW_ORDER: [1,2,3,4,5,6,0], BK_DOWJ: ['日','月','火','水','木','金','土'], BKCOPY: null });
vm.runInContext(code, ctx);
const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0;
function test(name, fn) { try { ctx.BKE.c = cfg(); fn(); passed++; console.log('OK ' + name); } catch (e) { failed++; console.log('NG ' + name + ': ' + e.message); } }
test('繰り返さないへの切替で日付を直接編集できる初期行ができる', () => {
  assert.equal(typeof ctx.bkChangeRepeat, 'function');
  ctx.bkChangeRepeat('none');
  assert.equal(ctx.BKE.c.repeat, 'none');
  const entries = Object.entries(ctx.BKE.c.overrides);
  assert.equal(entries.length, 1);
  assert.deepEqual(plain(entries[0][1]), [{s:'09:00',e:'17:00'}]);
});
test('日付追加で既存の日の時間帯を上書きしない', () => {
  ctx.BKE.c.repeat = 'none';
  ctx.BKE.c.overrides = {'2026-10-11': [{s:'10:00',e:'11:00'}]};
  assert.equal(typeof ctx.bkAddDate, 'function');
  ctx.bkAddDate('2026-10-11');
  assert.deepEqual(plain(ctx.BKE.c.overrides), {'2026-10-11':[{s:'10:00',e:'11:00'}]});
  ctx.bkAddDate('2026-10-12');
  assert.deepEqual(plain(ctx.BKE.c.overrides['2026-10-12']), [{s:'09:00',e:'17:00'}]);
});
test('日付を変更しても複数時間帯を保持し、重複日付では元の設定を保持する', () => {
  ctx.BKE.c.overrides = {'2026-10-11': [{s:'09:00',e:'17:00'},{s:'18:00',e:'19:00'}], '2026-10-12': [{s:'10:00',e:'11:00'}]};
  assert.equal(typeof ctx.bkChangeDate, 'function');
  ctx.bkChangeDate('2026-10-11', '2026-10-12');
  assert.equal(Object.keys(ctx.BKE.c.overrides).length, 2);
  ctx.bkChangeDate('2026-10-11', '2026-10-13');
  assert.equal(ctx.BKE.c.overrides['2026-10-11'], undefined);
  assert.deepEqual(plain(ctx.BKE.c.overrides['2026-10-13']), [{s:'09:00',e:'17:00'},{s:'18:00',e:'19:00'}]);
});
test('最後の時間帯削除は単発なら日付も消し、毎週の特定日なら休みを保持する', () => {
  ctx.BKE.c.repeat = 'none'; ctx.BKE.c.overrides = {'2026-10-11':[{s:'09:00',e:'17:00'}]};
  ctx.bkDelRange('o', '2026-10-11', 0);
  assert.equal(ctx.BKE.c.overrides['2026-10-11'], undefined);
  ctx.BKE.c.repeat = 'weekly'; ctx.BKE.c.overrides = {'2026-10-11':[{s:'09:00',e:'17:00'}]};
  ctx.bkDelRange('o', '2026-10-11', 0);
  assert.deepEqual(plain(ctx.BKE.c.overrides['2026-10-11']), []);
});
test('午前・午後・24時間形式を正しく保存し、不正時刻は保存値を変えない', () => {
  ctx.BKE.c.overrides = {'2026-10-11':[{s:'09:00',e:'17:00'}]};
  assert.equal(typeof ctx.bkSetTime, 'function');
  const input = {value:'午後6:00'};
  ctx.bkSetTime('o','2026-10-11',0,'s',input);
  assert.equal(ctx.BKE.c.overrides['2026-10-11'][0].s, '18:00');
  for (const [value, want] of [['午前12:00','00:00'],['午後12:00','12:00'],['13:45','13:45']]) {
    input.value = value; ctx.bkSetTime('o','2026-10-11',0,'s',input);
    assert.equal(ctx.BKE.c.overrides['2026-10-11'][0].s, want);
  }
  input.value = '午後13:00'; ctx.bkSetTime('o','2026-10-11',0,'s',input);
  assert.equal(ctx.BKE.c.overrides['2026-10-11'][0].s, '13:45');
  input.value = '24:00'; ctx.bkSetTime('o','2026-10-11',0,'e',input);
  assert.equal(ctx.BKE.c.overrides['2026-10-11'][0].e, '24:00');
});
test('編集した単発の2時間帯が保存・再読込後に正しい公開枠になる', () => {
  ctx.BKE.c.repeat = 'none'; ctx.BKE.c.duration = 60; ctx.BKE.c.minNoticeHours = 0;
  ctx.BKE.c.overrides = {'2026-10-11':[{s:'09:00',e:'10:00'}]};
  assert.equal(typeof ctx.bkChangeDate, 'function');
  ctx.bkChangeDate('2026-10-11','2026-10-12');
  ctx.bkAddRange('o','2026-10-12');
  ctx.bkSetTime('o','2026-10-12',1,'s',{value:'午後6:00'});
  ctx.bkSetTime('o','2026-10-12',1,'e',{value:'午後7:00'});
  const {config} = booking.normalizeConfig(plain(ctx.BKE.c));
  const slots = booking.computeSlots(config, {now: new Date('2026-10-10T00:00:00+09:00').getTime(), fromMs: new Date('2026-10-11T00:00:00+09:00').getTime(), toMs: new Date('2026-10-13T00:00:00+09:00').getTime()});
  assert.deepEqual(booking.groupByDay(slots), {'2026-10-12':['09:00','18:00']});
});
console.log(`結果: ${passed}件成功 / ${failed}件失敗`);
process.exitCode = failed ? 1 : 0;
