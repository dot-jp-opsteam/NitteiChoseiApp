/* 面談の空き枠を作る処理。
   画面側（index.html の genSlots）と同じ規則で、30分刻みの枠を並べる。
   ここに置いたのは、ログインしていないインターン生の申請ページにも
   同じ枠を見せる必要があるため。枠の判断はサーバーだけが持つようにして、
   画面ごとに規則がずれるのを防ぐ。

   純粋な計算だけを行い、DBには触らない（呼ぶ側が材料を渡す）。 */

const SLOT_MINUTES = 30;

/* 曜日ごとの受付時間の既定値。スタッフが何も設定していないときに使う。
   0=日曜。平日は9〜19時、土曜は10〜16時、日曜は受け付けない */
const DEFAULT_WEEKLY = {
  0: { on: false, s: '09:00', e: '19:00' },
  1: { on: true, s: '09:00', e: '19:00' },
  2: { on: true, s: '09:00', e: '19:00' },
  3: { on: true, s: '09:00', e: '19:00' },
  4: { on: true, s: '09:00', e: '19:00' },
  5: { on: true, s: '09:00', e: '19:00' },
  6: { on: false, s: '10:00', e: '16:00' },
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/* '09:30' を、その日の0時からの経過分に直す。
   壊れた値が入っていても落ちないように、数値にできなければ null を返す */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * スタッフの空き枠を、今日から days 日分作る。
 *
 * @param {object}   availability そのスタッフの設定 { weekly, blocks }
 * @param {number[]} takenMs      すでに確定している面談の開始時刻（ミリ秒）
 * @param {object}   opts         days（何日分か）と now（現在時刻。試験で固定するため）
 * @returns {Array<{date: string, slots: Array<{iso: string, time: string, ok: boolean}>}>}
 *          ok が false の枠は、埋まっているので選べない。
 *          画面に「埋まっている」と見せるために、消さずに残している。
 */
function generateSlots(availability, takenMs, opts = {}) {
  const days = opts.days || 14;
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const weekly = (availability && availability.weekly) || DEFAULT_WEEKLY;

  /* 受け付けられない時間帯。開始と終了のミリ秒に直しておく。
     日付として読めないものは、判定を狂わせるので捨てる */
  const blocks = ((availability && availability.blocks) || [])
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));

  const taken = (takenMs || []).filter((t) => Number.isFinite(t));

  const out = [];
  for (let off = 0; off < days; off++) {
    const day = new Date(nowMs);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + off);

    const conf = weekly[day.getDay()];
    if (!conf || !conf.on) continue;

    const startM = toMinutes(conf.s);
    const endM = toMinutes(conf.e);
    if (startM === null || endM === null) continue;

    const slots = [];
    for (let t = startM; t + SLOT_MINUTES <= endM; t += SLOT_MINUTES) {
      const dt = new Date(day);
      dt.setHours(Math.floor(t / 60), t % 60, 0, 0);
      const st = dt.getTime();
      const en = st + SLOT_MINUTES * 60 * 1000;

      // 過ぎた時刻は候補にしない
      if (st < nowMs) continue;

      const overlapsBlock = blocks.some(([bs, be]) => st < be && en > bs);
      // 確定済みの面談と同じ枠か。ちょうど隣り合う枠は別扱いにする
      const alreadyTaken = taken.some((x) => Math.abs(x - st) < SLOT_MINUTES * 60 * 1000 - 1);

      slots.push({
        iso: dt.toISOString(),
        time: `${pad(Math.floor(t / 60))}:${pad(t % 60)}`,
        ok: !overlapsBlock && !alreadyTaken,
      });
    }
    if (slots.length) {
      out.push({
        date: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
        slots,
      });
    }
  }
  return out;
}

/* 送られてきた希望枠が、本当に選べる枠なのかを確かめる。
   画面を細工されても、埋まっている枠や受付時間外を掴まされないようにする */
function isSelectableSlot(iso, availability, takenMs, opts = {}) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return false;
  return generateSlots(availability, takenMs, opts)
    .some((d) => d.slots.some((s) => s.ok && new Date(s.iso).getTime() === target));
}

module.exports = { generateSlots, isSelectableSlot, DEFAULT_WEEKLY, SLOT_MINUTES };
