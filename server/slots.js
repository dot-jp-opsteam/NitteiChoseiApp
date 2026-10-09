/* 面談の空き枠を作る処理。
   画面側（index.html の genSlots）と同じ規則で、30分刻みの枠を並べる。
   ここに置いたのは、ログインしていないインターン生の申請ページにも
   同じ枠を見せる必要があるため。枠の判断はサーバーだけが持つようにして、
   画面ごとに規則がずれるのを防ぐ。

   純粋な計算だけを行い、DBには触らない（呼ぶ側が材料を渡す）。 */

const SLOT_MINUTES = 30;

/* 申請ページの表に出す時間の幅。全員・全曜日 09:00〜24:00（2026-10-06 の指示）。
   曜日ごとの「面談を受けられる時間」（weekly）はもう使わない。選べないのは
   「受けられない時間」・Googleの予定・確定した面談・過ぎた時刻だけ。
   スタッフの「受けられない時間」の表（index.html の genEditGrid）と同じ幅にしてある。
   表のマス1つは「その時刻から30分」。時刻はマスの境目の線の横に出す（Googleカレンダーと同じ。
   2026-10-09 から）。21:00〜22:00 なら 21:00 と 21:30 の2マス、最後のマスは 23:30〜24:00。
   2026-10-06〜10-09 は「マス＝時刻」の読み方で、24:00 のマスがあった。その頃の回答は
   choice_mode が無いので、画面側（index.html）は古い読み方のまま表示する */
const GRID_START = '09:00';
const GRID_END = '24:00';
const GRID_START_M = 9 * 60;
const GRID_END_M = 24 * 60;

/* 曜日ごとの受付時間の既定値。スタッフが何も設定していないときに使う。
   0=日曜。設定していない人でも実際に選んでもらえるよう、
   曜日を問わず9〜23時を受け付ける（2026-08-05にユーザーの指示で広げた）。
   ※2026-10-06 からは枠の計算に weekly を使っていない（上の GRID_* を参照） */
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
  const blocks = prepBlocks(availability);
  const taken = (takenMs || []).filter((t) => Number.isFinite(t));

  const out = [];
  for (let off = 0; off < days; off++) {
    const day = new Date(nowMs);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + off);

    const slots = [];
    for (let t = GRID_START_M; t + SLOT_MINUTES <= GRID_END_M; t += SLOT_MINUTES) {
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
 * 今日から1週間ぶんの表を作る。申請ページのカレンダー表示用。
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
  const blocks = prepBlocks(availability);
  const taken = (takenMs || []).filter((t) => Number.isFinite(t));

  const n = Number(weekOffset);
  const week = Math.min(Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0), MAX_WEEK_OFFSET);

  /* 今日から7日ぶん。週を送るごとに7日ずつ先へずらす。
     以前は月曜始まりにしていたが、それだと週の後半に開くほど左側が
     すでに過ぎた日で埋まり、選べる枠が右端に寄ってしまっていた */
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setDate(today.getDate() + week * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    days.push(d);
  }

  /* 表の縦幅はいつも同じ（9:00〜24:00）。マスは 9:00〜23:30 から始まる30分の30個 */
  const times = [];
  for (let t = GRID_START_M; t + SLOT_MINUTES <= GRID_END_M; t += SLOT_MINUTES) times.push(t);

  const grid = days.map((day) => {
    return times.map((t) => {
      const dt = new Date(day);
      dt.setHours(Math.floor(t / 60), t % 60, 0, 0);
      const st = dt.getTime();
      const en = st + SLOT_MINUTES * 60 * 1000;
      const iso = dt.toISOString();
      const off = { state: 'off', iso };
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
