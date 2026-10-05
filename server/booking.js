/* 予約スケジュール（Googleカレンダーの「予約スケジュール」と同じ動き）の枠の計算。

   面談申請（slots.js）は「30分刻みの表を出して、希望をいくつでも選んでもらう」ものだが、
   こちらは「空いている開始時刻だけを並べて、1つ選んだらその場で確定する」もの。
   考え方が違うので、slots.js とは別に置いてある。

   純粋な計算だけを行い、DBにもGoogleにも触らない（呼ぶ側が材料を渡す）。
   時計はサーバー全体で日本時間に固定してある（server.js の先頭）ので、
   ここで使う Date の「その日の0時」「曜日」はすべて日本時間になる。 */
'use strict';

/* 予約時間の選択肢。Googleの予約スケジュールと同じ並び */
const DURATIONS = [15, 30, 45, 60, 90, 120];
const LOCATION_TYPES = ['meet', 'place', 'phone', 'none'];
const PHONE_MODES = ['off', 'optional', 'required'];
/* リマインダーを送れるタイミング（予約の何分前か） */
const REMINDER_CHOICES = [10, 30, 60, 180, 1440, 2880, 10080];
const COLORS = ['#039be5', '#7986cb', '#33b679', '#8e24aa', '#e67c73', '#f6bf26', '#f4511e', '#616161', '#3f51b5', '#0b8043', '#d50000'];

const MAX_RANGES_PER_DAY = 8;
const MAX_OVERRIDES = 200;
const MAX_QUESTIONS = 10;
const MAX_DAYS_LIMIT = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/* '09:30' → 570。'24:00' は1日の終わりとして認める。読めなければ null */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return null;
  if (h === 24 && mi === 0) return 1440;
  if (h > 23) return null;
  return h * 60 + mi;
}
function fromMinutes(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function ymdOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseYmd(s).getTime());
}
/* 'YYYY-MM-DD' をその日の0時（日本時間）にする */
function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/* 区間の並びを整える。壊れたもの・長さ0のものは捨て、開始順に並べ、
   重なっている区間は1本にまとめる（同じ枠が二重に出ないように） */
function cleanRanges(list) {
  const out = (Array.isArray(list) ? list : [])
    .map((r) => ({ s: toMinutes(r && r.s), e: toMinutes(r && r.e) }))
    .filter((r) => r.s !== null && r.e !== null && r.s < r.e)
    .sort((a, b) => a.s - b.s);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }
  return merged.slice(0, MAX_RANGES_PER_DAY).map((r) => ({ s: fromMinutes(r.s), e: fromMinutes(r.e) }));
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/* 新しく作るときの初期値。Googleの初期値（平日9〜17時・60日先まで・4時間前まで）に合わせている */
function defaultConfig() {
  const weekday = [{ s: '09:00', e: '17:00' }];
  return {
    title: '',
    color: COLORS[0],
    duration: 30,
    repeat: 'weekly',
    weekly: { 0: [], 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: [] },
    overrides: {},
    maxDays: 60,
    startDate: null,
    endDate: null,
    minNoticeHours: 4,
    bufferMin: 0,
    maxPerDay: 0,
    calendars: ['primary'],
    location: { type: 'meet', text: '' },
    description: '',
    phone: 'off',
    questions: [],
    verifyEmail: false,
    reminders: [1440, 60],
  };
}

/**
 * 画面から来た設定を、使える形に整える。
 * 足りないものは初期値で埋め、範囲の外は丸める。
 * 致命的なもの（名前が無い）だけ error で返す。
 * @returns {{config?: object, error?: string}}
 */
function normalizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const def = defaultConfig();
  const title = str(src.title, 80);
  if (!title) return { error: 'タイトルを入力してください' };

  const weekly = {};
  for (let d = 0; d <= 6; d++) {
    const w = src.weekly && typeof src.weekly === 'object' ? src.weekly[d] : undefined;
    weekly[d] = w === undefined ? def.weekly[d] : cleanRanges(w);
  }

  const overrides = {};
  if (src.overrides && typeof src.overrides === 'object') {
    Object.keys(src.overrides).filter(isYmd).sort().slice(0, MAX_OVERRIDES).forEach((k) => {
      overrides[k] = cleanRanges(src.overrides[k]);
    });
  }

  let startDate = isYmd(src.startDate) ? src.startDate : null;
  let endDate = isYmd(src.endDate) ? src.endDate : null;
  if (startDate && endDate && startDate > endDate) [startDate, endDate] = [endDate, startDate];

  const loc = src.location && typeof src.location === 'object' ? src.location : {};
  const questions = (Array.isArray(src.questions) ? src.questions : [])
    .map((q, i) => ({
      id: /^[a-z0-9_]{1,20}$/i.test(String(q && q.id || '')) ? String(q.id) : 'q' + (i + 1),
      label: str(q && q.label, 200),
      required: !!(q && q.required),
    }))
    .filter((q) => q.label)
    .slice(0, MAX_QUESTIONS);
  // 同じIDが2つあると回答が混ざるので、後ろのほうを振り直す
  const seen = new Set();
  questions.forEach((q, i) => {
    while (seen.has(q.id)) q.id = 'q' + (i + 1) + '_' + seen.size;
    seen.add(q.id);
  });

  const calendars = [...new Set((Array.isArray(src.calendars) ? src.calendars : [])
    .map((c) => str(c, 300)).filter(Boolean))].slice(0, 20);

  const reminders = [...new Set((Array.isArray(src.reminders) ? src.reminders : def.reminders)
    .map(Number).filter((m) => REMINDER_CHOICES.includes(m)))].sort((a, b) => b - a);

  return {
    config: {
      title,
      color: COLORS.includes(src.color) ? src.color : def.color,
      duration: DURATIONS.includes(Number(src.duration)) ? Number(src.duration) : def.duration,
      repeat: src.repeat === 'none' ? 'none' : 'weekly',
      weekly,
      overrides,
      maxDays: clampInt(src.maxDays, 1, MAX_DAYS_LIMIT, def.maxDays),
      startDate,
      endDate,
      minNoticeHours: clampInt(src.minNoticeHours, 0, 24 * 30, def.minNoticeHours),
      bufferMin: clampInt(src.bufferMin, 0, 120, def.bufferMin),
      maxPerDay: clampInt(src.maxPerDay, 0, 50, def.maxPerDay),
      calendars: calendars.length ? calendars : def.calendars,
      location: {
        type: LOCATION_TYPES.includes(loc.type) ? loc.type : def.location.type,
        text: str(loc.text, 300),
      },
      description: str(src.description, 2000),
      phone: PHONE_MODES.includes(src.phone) ? src.phone : def.phone,
      questions,
      verifyEmail: !!src.verifyEmail,
      reminders,
    },
  };
}

/* その日の受付区間（分）。特定日の上書きがあればそちらを使う。
   「繰り返さない」のときは、特定日として入れた日だけが受付日になる */
function rangesForDay(cfg, day) {
  const key = ymdOf(day);
  if (cfg.overrides && Object.prototype.hasOwnProperty.call(cfg.overrides, key)) {
    return cleanRanges(cfg.overrides[key]).map((r) => ({ s: toMinutes(r.s), e: toMinutes(r.e) }));
  }
  if (cfg.repeat === 'none') return [];
  return cleanRanges((cfg.weekly || {})[day.getDay()]).map((r) => ({ s: toMinutes(r.s), e: toMinutes(r.e) }));
}

/**
 * 予約を受け付ける期間（ミリ秒）。
 * 始まり：今＋締め切り時間、開始日があればその日の0時の遅いほう
 * 終わり：今日の0時＋何日先まで、終了日があればその翌日0時の早いほう
 */
function bookingWindow(cfg, nowMs) {
  let from = nowMs + (cfg.minNoticeHours || 0) * 60 * 60 * 1000;
  const today = startOfDay(nowMs);
  const last = new Date(today);
  last.setDate(today.getDate() + (cfg.maxDays || 60));
  let to = last.getTime();
  if (cfg.startDate) from = Math.max(from, parseYmd(cfg.startDate).getTime());
  if (cfg.endDate) {
    const end = parseYmd(cfg.endDate);
    end.setDate(end.getDate() + 1);
    to = Math.min(to, end.getTime());
  }
  return { from, to };
}

function overlaps(s, e, list) {
  return list.some(([bs, be]) => s < be && e > bs);
}

/**
 * 空いている枠の開始時刻を並べる。
 *
 * @param {object} cfg   normalizeConfig 済みの設定
 * @param {object} opts
 *   now          現在時刻（ミリ秒）
 *   fromMs/toMs  見たい範囲。予約期間の外は自動で削る
 *   busy         [[開始,終了], ...] Googleの予定＋スタッフの確定済み面談（余白は付けない）
 *   pageBookings [[開始,終了], ...] このスケジュールで入った予約（余白と1日の上限に使う）
 * @returns {number[]} 開始時刻（ミリ秒）の昇順
 */
function computeSlots(cfg, opts) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const win = bookingWindow(cfg, nowMs);
  const from = Math.max(win.from, Number.isFinite(opts.fromMs) ? opts.fromMs : win.from);
  const to = Math.min(win.to, Number.isFinite(opts.toMs) ? opts.toMs : win.to);
  if (!(from < to)) return [];

  const durMs = cfg.duration * 60 * 1000;
  const bufMs = (cfg.bufferMin || 0) * 60 * 1000;
  const busy = (opts.busy || []).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const mine = (opts.pageBookings || []).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const padded = mine.map(([s, e]) => [s - bufMs, e + bufMs]);

  /* 1日の上限は「その日に始まる予約の数」で数える */
  const perDay = new Map();
  mine.forEach(([s]) => {
    const k = ymdOf(new Date(s));
    perDay.set(k, (perDay.get(k) || 0) + 1);
  });

  const out = [];
  /* 範囲の始まりの日から、1日ずつ進める。
     日付は setDate で進めるので、夏時間が無い日本時間なら1日はいつも24時間 */
  for (let day = startOfDay(from); day.getTime() < to; day.setDate(day.getDate() + 1)) {
    if (cfg.maxPerDay && (perDay.get(ymdOf(day)) || 0) >= cfg.maxPerDay) continue;
    for (const r of rangesForDay(cfg, day)) {
      for (let t = r.s; t + cfg.duration <= r.e; t += cfg.duration) {
        const st = day.getTime() + t * 60 * 1000;
        const en = st + durMs;
        if (st < from || st >= to) continue;
        if (overlaps(st, en, busy)) continue;
        if (overlaps(st, en, padded)) continue;
        out.push(st);
      }
    }
  }
  return out;
}

/* 枠の並びを、画面に渡す形 {'YYYY-MM-DD': ['09:00', ...]} にまとめる */
function groupByDay(starts) {
  const out = {};
  starts.forEach((ms) => {
    const d = new Date(ms);
    const k = ymdOf(d);
    (out[k] = out[k] || []).push(fromMinutes(d.getHours() * 60 + d.getMinutes()));
  });
  return out;
}

/* その時刻が、今まさに予約できる枠か（送信時の最終確認用） */
function isBookable(cfg, opts, startMs) {
  if (!Number.isFinite(startMs)) return false;
  const day = startOfDay(startMs).getTime();
  return computeSlots(cfg, { ...opts, fromMs: day, toMs: day + DAY_MS }).includes(startMs);
}

module.exports = {
  DURATIONS, LOCATION_TYPES, PHONE_MODES, REMINDER_CHOICES, COLORS, MAX_DAYS_LIMIT,
  defaultConfig, normalizeConfig, rangesForDay, bookingWindow, computeSlots, groupByDay, isBookable,
  toMinutes, ymdOf, parseYmd, isYmd,
};
