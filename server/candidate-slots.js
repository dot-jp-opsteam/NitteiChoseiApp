const DAY_MS = 86400000;
const DURATIONS = [15, 30, 45, 60, 90, 120];

function dateKey(timestamp) {
  return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10);
}

function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new RangeError('日付を指定してください');
  const timestamp = Date.parse(value + 'T00:00:00+09:00');
  if (!Number.isFinite(timestamp) || dateKey(timestamp) !== value) throw new RangeError('日付が正しくありません');
  return timestamp;
}

function candidateWindow(query, now = Date.now()) {
  const from = parseDay(query.from);
  const to = parseDay(query.to);
  const duration = query.duration === undefined ? 30 : Number(query.duration);
  if (!DURATIONS.includes(duration)) throw new RangeError('所要時間を選んでください');
  if (from < parseDay(dateKey(now))) throw new RangeError('過去の日付は指定できません');
  if (to < from || to - from > 20 * DAY_MS) throw new RangeError('期間は開始日から21日以内で指定してください');
  if (from - now > 365 * DAY_MS) throw new RangeError('日付は1年以内で指定してください');
  return { from, to, duration };
}

function generateCandidates({ from, to, duration, blocks = [], interviews = [], now = Date.now() }) {
  const busy = blocks.map(block => [Date.parse(block.start), Date.parse(block.end)]);
  for (const interview of interviews) {
    if (interview.status !== 'fixed') continue;
    const start = Date.parse(interview.confirmed_datetime);
    busy.push([start, start + (Number(interview.duration_min) || 30) * 60000]);
  }
  const candidates = [];
  for (let day = from; day <= to; day += DAY_MS) {
    for (let minute = 9 * 60; minute + duration <= 24 * 60; minute += 30) {
      const start = day + minute * 60000;
      const end = start + duration * 60000;
      if (start <= now || busy.some(([busyStart, busyEnd]) => start < busyEnd && end > busyStart)) continue;
      candidates.push({
        date: dateKey(day),
        time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        duration,
      });
    }
  }
  return candidates;
}

module.exports = { candidateWindow, generateCandidates };
