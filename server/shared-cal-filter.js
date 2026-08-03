/* 全体予定表から外す予定の判定。
   スタッフ全員に配るカレンダーには、部内向けの定例など
   見せなくてよい予定も混ざる。タイトルに決められた語句が入っていれば配らない。

   語句は環境変数 SHARED_CALENDAR_EXCLUDE でカンマ区切りに指定する（既定は OPS）。
   空にすればすべての予定が出る。

   大文字・小文字と、全角・半角の違いは吸収する。予定を作る人によって
   「OPS」「ops」「ＯＰＳ」と揺れるため、そのたびに漏らさないようにしている。
   NFKC は全角の英数字を半角へ寄せる正規化で、これを通してから小文字にして比べる */

function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

function parseExcludeWords(raw) {
  return String(raw ?? 'OPS')
    .split(',')
    .map((s) => normalize(s).trim())
    .filter(Boolean);
}

/* タイトルに語句のどれかが含まれていれば true（＝配らない）。
   語句が1つもなければ、何も外さない */
function isExcluded(title, words) {
  if (!words || !words.length) return false;
  const t = normalize(title);
  return words.some((w) => t.includes(w));
}

function filterSharedEvents(events, words) {
  if (!words || !words.length) return events || [];
  return (events || []).filter((e) => !isExcluded(e && e.title, words));
}

module.exports = { normalize, parseExcludeWords, isExcluded, filterSharedEvents };
