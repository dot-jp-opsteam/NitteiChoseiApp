/* 面談の空き枠を作る処理。
   画面側（index.html の genSlots）と同じ規則で、30分刻みの枠を並べる。
   ここに置いたのは、ログインしていないインターン生の申請ページにも
   同じ枠を見せる必要があるため。枠の判断はサーバーだけが持つようにして、
   画面ごとに規則がずれるのを防ぐ。

   純粋な計算だけを行い、DBには触らない（呼ぶ側が材料を渡す）。 */

const SLOT_MINUTES = 30;

/* 申請ページの表に出す時間の幅。スタッフの設定に関わらず、いつもこの高さで出す。
   週によって表の高さが変わると、同じ時刻の行が上下にずれて選びにくいため。
   受け付けていない時間は「×」として並ぶ */
const GRID_START = '09:00';
const GRID_END = '23:00';

/* 曜日ごとの受付時間の既定値。スタッフが何も設定していないときに使う。
   0=日曜。設定していない人でも実際に選んでもらえるよう、
   曜日を問わず9〜23時を受け付ける（2026-08-05にユーザーの指示で広げた） */
const DEFAULT_WEEKLY = {
  0: { on: true, s: GRID_START, e: GRID_END },
  1: { on: true, s: GRID_START, e: GRID_END },
  2: { on: true, s: GRID_START, e: GRID_END },
  3: { on: true, s: GRID_START, e: GRID_END },
  4: { on: true, s: GRID_START, e: GRID_END },
  5: { on: true, s: GRID_START, e: GRID_END },
  6: { on: true, s: GRID_START, e: GRID_END },
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
/* 受け付けられない時間帯。開始と終了のミリ秒に直しておく。
   日付として読めないものは、判定を狂わせるので捨てる */
function prepBlocks(availability) {
  return ((availability && availability.blocks) || [])
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
}

function generateSlots(availability, takenMs, opts = {}) {
  const days = opts.days || 14;
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const weekly = (availability && availability.weekly) || DEFAULT_WEEKLY;
  const blocks = prepBlocks(availability);
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

/* 申請ページで「次の1週間」を押せる回数。
   ログイン不要のページなので、青天井にすると延々と先の週を作らせる負荷をかけられる */
const MAX_WEEK_OFFSET = 2;

/* 申請の受け付け時に、希望枠が妥当かを確かめる範囲（日数）。
   週表示で辿り着ける最も遠い日（今日から最大20日先）を必ず含む長さにしてある。
   ここが短いと、画面には出ているのに申請だけ弾かれることになる */
const VALIDATION_DAYS = 30;

/**
 * 月曜始まりの1週間ぶんの表を作る。申請ページのカレンダー表示用。
 *
 * generateSlots が「空いている枠だけを日ごとに並べる」のに対して、
 * こちらは埋まっている枠も `off` として残す。表の形を崩さないため。
 *
 * @param {number} weekOffset 0＝今週。MAX_WEEK_OFFSET を超える指定は丸める
 * @returns {{week:number, hasNext:boolean, days:string[], times:string[],
 *            grid:Array<Array<{state:'ok'|'off', iso:string}>>}}
 *          grid は [日][時刻] の順。days と times がそれぞれの見出しになる。
 */
function generateWeekGrid(availability, takenMs, weekOffset, opts = {}) {
  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const weekly = (availability && availability.weekly) || DEFAULT_WEEKLY;
  const blocks = prepBlocks(availability);
  const taken = (takenMs || []).filter((t) => Number.isFinite(t));

  const n = Number(weekOffset);
  const week = Math.min(Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0), MAX_WEEK_OFFSET);

  // その週の月曜から7日ぶん。日曜は前の週の扱いになるので6日戻す
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow) + week * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }

  /* 表の縦幅はいつも同じ（9:00〜23:00）。
     スタッフの受付時間に合わせて伸び縮みさせると、週を移るたびに行がずれて
     同じ時刻を探しにくくなる。受け付けていない時間は「×」として並ぶ */
  const minM = toMinutes(GRID_START);
  const maxM = toMinutes(GRID_END);

  const times = [];
  for (let t = minM; t + SLOT_MINUTES <= maxM; t += SLOT_MINUTES) times.push(t);

  const grid = days.map((day) => {
    const conf = weekly[day.getDay()];
    const s = conf && conf.on ? toMinutes(conf.s) : null;
    const e = conf && conf.on ? toMinutes(conf.e) : null;
    return times.map((t) => {
      const dt = new Date(day);
      dt.setHours(Math.floor(t / 60), t % 60, 0, 0);
      const st = dt.getTime();
      const en = st + SLOT_MINUTES * 60 * 1000;
      const iso = dt.toISOString();
      const off = { state: 'off', iso };
      if (s === null || e === null) return off;             // 受け付けていない曜日
      if (t < s || t + SLOT_MINUTES > e) return off;        // 受付時間の外
      if (st < nowMs) return off;                           // 過ぎた時刻
      if (taken.some((x) => Math.abs(x - st) < SLOT_MINUTES * 60 * 1000 - 1)) return off;
      if (blocks.some(([bs, be]) => st < be && en > bs)) return off;
      return { state: 'ok', iso };
    });
  });

  return {
    week,
    hasNext: week < MAX_WEEK_OFFSET,
    days: days.map((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
    times: times.map((t) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`),
    grid,
  };
}

/* 選べる枠の開始時刻（ミリ秒）を集めた Set。
   希望を何件でも出せるため、1件ごとに枠を作り直すと同じ計算を何度も繰り返す。
   受け付け側は、これを一度だけ作って照合する */
function selectableTimes(availability, takenMs, opts = {}) {
  const days = opts.days || VALIDATION_DAYS;
  const out = new Set();
  generateSlots(availability, takenMs, { ...opts, days }).forEach((d) => {
    d.slots.forEach((s) => { if (s.ok) out.add(new Date(s.iso).getTime()); });
  });
  return out;
}

/* 送られてきた希望枠が、本当に選べる枠なのかを確かめる。
   画面を細工されても、埋まっている枠や受付時間外を掴まされないようにする */
function isSelectableSlot(iso, availability, takenMs, opts = {}) {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return false;
  const days = opts.days || VALIDATION_DAYS;
  return generateSlots(availability, takenMs, { ...opts, days })
    .some((d) => d.slots.some((s) => s.ok && new Date(s.iso).getTime() === target));
}

module.exports = {
  generateSlots, generateWeekGrid, isSelectableSlot, selectableTimes,
  DEFAULT_WEEKLY, SLOT_MINUTES, MAX_WEEK_OFFSET, VALIDATION_DAYS,
  GRID_START, GRID_END,
};
