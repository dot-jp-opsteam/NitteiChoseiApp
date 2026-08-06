/* =========================================================
   server/stream.js（SSEの接続管理）だけを取り出して検証する

   使い方:  node tools/test-stream.mjs

   stream.js は DB にも HTTP にも触らない独立したモジュールなので、
   require して直接動かせる。HTTPサーバーを起動する e2e.mjs 側では、
   「実際に画面へ届くか」は検証できても、
   「切断がちゃんと一覧から外れるか」「宛先の絞り込みが規則どおりか」を
   機械的に確かめる手段が無かった（レビュー指摘）。
   ここでは本物の res の代わりに write() だけを持つ偽物を渡して、
   接続の出入りをそのまま確かめる。
   ========================================================= */
import fs from 'node:fs';
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

/* 呼ばれた回数と本文を控えるだけの偽の res。
   throwOnWrite を渡すと、書き込み不能になった接続を模倣できる */
function fakeRes({ throwOnWrite = false } = {}) {
  const writes = [];
  return {
    writes,
    write(chunk) {
      if (throwOnWrite) throw new Error('切れている接続への書き込み（テスト用）');
      writes.push(chunk);
    },
  };
}

console.log('\n[ 接続の出入り（addClient / removeClient / clientCount） ]');
{
  // stream.js はモジュール単位で状態（clients）を持つので、毎回 fresh に読み直す
  delete require.cache[require.resolve('../server/stream.js')];
  const stream = require('../server/stream.js');

  check('最初は誰もつながっていない', stream.clientCount(), 0);

  const staff = { id: 'u1', role: 'staff', branch_id: 'b1' };
  const c1 = stream.addClient(fakeRes(), staff);
  check('addClientでclientCountが増える', stream.clientCount(), 1);

  const c2 = stream.addClient(fakeRes(), staff);
  check('複数つないでも数える', stream.clientCount(), 2);

  stream.removeClient(c1);
  check('removeClientでclientCountが減る', stream.clientCount(), 1);

  stream.removeClient(c2);
  check('全員切ると0に戻る', stream.clientCount(), 0);

  // 存在しない相手を消しても壊れない（req.on('close') が二重に呼ばれても平気なように）
  stream.removeClient(c1);
  check('二重にremoveClientしても落ちない', stream.clientCount(), 0);
}

console.log('\n[ 書けない接続はbroadcastの中で自動的に外れる ]');
{
  delete require.cache[require.resolve('../server/stream.js')];
  const stream = require('../server/stream.js');

  const staff = { id: 'u1', role: 'staff', branch_id: 'b1' };
  const dead = stream.addClient(fakeRes({ throwOnWrite: true }), staff);
  const alive = stream.addClient(fakeRes(), staff);
  check('つないだ直後は2件', stream.clientCount(), 2);

  stream.broadcast('b1', { type: 'テスト' });
  check('書けなかった1件だけ一覧から消える', stream.clientCount(), 1);

  // 生きている方は普通に受け取れている（巻き添えで消えていないことの確認）
  stream.removeClient(alive);
  check('生き残った接続を明示的に消せば0になる', stream.clientCount(), 0);
}

console.log('\n[ 宛先の規則（listNotificationsFor と同じにする） ]');
{
  delete require.cache[require.resolve('../server/stream.js')];
  const stream = require('../server/stream.js');

  const resB1 = fakeRes();
  const resB2 = fakeRes();
  const resAdmin = fakeRes();
  stream.addClient(resB1, { id: 'u1', role: 'staff', branch_id: 'b1' });
  stream.addClient(resB2, { id: 'u2', role: 'staff', branch_id: 'b2' });
  stream.addClient(resAdmin, { id: 'u3', role: 'admin', branch_id: null });

  stream.broadcast('b1', { type: '支部b1向け' });
  check('支部が同じスタッフには届く', resB1.writes.length, 1);
  check('支部が違うスタッフには届かない', resB2.writes.length, 0);
  check('adminにはどの支部の通知も届く', resAdmin.writes.length, 1);

  stream.broadcast('b2', { type: '支部b2向け' });
  check('支部が違えば今度はb2に届く', resB2.writes.length, 1);
  check('b1には増えない', resB1.writes.length, 1);
  check('adminには引き続き届く', resAdmin.writes.length, 2);

  stream.broadcast(null, { type: '全員向け' });
  check('branch_idがnullの通知はb1にも届く', resB1.writes.length, 2);
  check('branch_idがnullの通知はb2にも届く', resB2.writes.length, 2);
  check('branch_idがnullの通知はadminにも届く', resAdmin.writes.length, 3);
}

console.log('\n[ 押し出す本文の形式（中身を漏らさない） ]');
{
  delete require.cache[require.resolve('../server/stream.js')];
  const stream = require('../server/stream.js');

  const res = fakeRes();
  stream.addClient(res, { id: 'u1', role: 'staff', branch_id: 'b1' });
  stream.broadcast('b1', { type: '面談申請' });

  const body = res.writes[0] || '';
  check('event: refresh で始まる', body.startsWith('event: refresh\n'), true);
  check('dataにJSONが1行で入る', body, 'event: refresh\ndata: {"type":"面談申請"}\n\n');

  /* stream.js は渡された payload をそのまま JSON化するだけなので、
     「中身を漏らさない」の担保は呼び出し側（server.js の insertNotification）にある。
     呼び出し箇所が type 以外（msg・氏名など）を含めていないことをソースで確かめる */
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const idx = serverSrc.indexOf('stream.broadcast(row.branch_id');
  const callText = serverSrc.slice(idx, serverSrc.indexOf(');', idx) + 2);
  check('insertNotificationの呼び出しが見つかる', idx >= 0, true);
  check('通知本文（msg）は載せていない', callText.includes('row.msg'), false);
  check('氏名（intern_name等）も載せていない',
    /intern_name|nickname/.test(callText), false);
}

console.log('\n[ ハートビートの開始と停止 ]');
{
  delete require.cache[require.resolve('../server/stream.js')];
  const stream = require('../server/stream.js');

  // setInterval/clearIntervalを一時的に横取りして、呼ばれ方だけを確かめる。
  // 本物のタイマーを25秒待つわけにはいかないため
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  let started = 0;
  const cleared = [];
  global.setInterval = (fn, ms) => { started++; return realSetInterval(fn, ms); };
  global.clearInterval = (id) => { cleared.push(id); return realClearInterval(id); };

  try {
    stream.startHeartbeat();
    check('startHeartbeatでタイマーが1つ作られる', started, 1);

    stream.startHeartbeat();
    check('二重に呼んでも増えない（すでに動いているので）', started, 1);

    stream.stopHeartbeat();
    check('stopHeartbeatでタイマーが止められる', cleared.length, 1);

    stream.stopHeartbeat();
    check('止まっている状態でもう一度呼んでも壊れない', cleared.length, 1);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
}

console.log(`\n合格 ${pass}件 / 不合格 ${failures.length}件`);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
