'use strict';

/* iCalendar の値にだけ適用するエスケープ。
   プロパティ名や VALUE=DATE などの構文には使わない。 */
function escapeICalText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function formatICalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('日時をiCalendar形式に変換できません');
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function formatICalDate(value) {
  const direct = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (direct) return direct.slice(1).join('');
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('日付をiCalendar形式に変換できません');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return get('year') + get('month') + get('day');
}

/* RFC 5545の75オクテット制限。続きの先頭空白も1オクテットとして数える。 */
function foldICalLine(line) {
  const chunks = [];
  let chunk = '';
  let limit = 75;
  for (const character of String(line)) {
    const size = Buffer.byteLength(character, 'utf8');
    if (chunk && Buffer.byteLength(chunk, 'utf8') + size > limit) {
      chunks.push(chunk);
      chunk = character;
      limit = 74;
    } else {
      chunk += character;
    }
  }
  chunks.push(chunk);
  return chunks.map((part, index) => index ? ' ' + part : part).join('\r\n');
}

function buildICalendar(events, options = {}) {
  const calendarName = options.calendarName || 'OPS日程調整';
  const prodId = options.prodId || '-//dot-jp//OPS日程調整//JA';
  const now = options.now || new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeICalText(calendarName)}`,
  ];

  for (const event of events || []) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeICalText(event.uid || `${event.id}@ops-nittyou`)}`);
    lines.push(`DTSTAMP:${formatICalDateTime(event.updatedAt || now)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatICalDate(event.start)}`);
      lines.push(`DTEND;VALUE=DATE:${formatICalDate(event.end)}`);
    } else {
      lines.push(`DTSTART:${formatICalDateTime(event.start)}`);
      lines.push(`DTEND:${formatICalDateTime(event.end)}`);
    }
    lines.push(`SUMMARY:${escapeICalText(event.summary)}`);
    lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeICalText(event.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldICalLine).join('\r\n') + '\r\n';
}

exports.escapeICalText = escapeICalText;
exports.formatICalDateTime = formatICalDateTime;
exports.formatICalDate = formatICalDate;
exports.foldICalLine = foldICalLine;
exports.buildICalendar = buildICalendar;
