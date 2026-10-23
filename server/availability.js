'use strict';

function eventInterval(event) {
  const parse = value => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value + 'T00:00:00+09:00' : value);
  return [parse(event.start), parse(event.end)];
}

function applicableOverride(event, override) {
  return override && (!override.original_start || (Date.parse(override.original_start) === eventInterval(event)[0] && Date.parse(override.original_end) === eventInterval(event)[1]));
}

function effectiveIntervals(events, overrides, excludeGoogleEventId) {
  const byId = new Map(overrides.map(override => [override.event_id, override]));
  return events.flatMap(event => {
    if (event.id === excludeGoogleEventId || event.status === 'cancelled') return [];
    const override = byId.get(event.id);
    if (applicableOverride(event, override)) {
      if (Number(override.ignored)) return [];
      const interval = eventInterval(override);
      if (interval.every(Number.isFinite) && interval[1] > interval[0]) return [interval];
    }
    if (event.transparency === 'transparent' || event.declined) return [];
    const interval = eventInterval(event);
    return interval.every(Number.isFinite) && interval[1] > interval[0] ? [interval] : [];
  });
}

function manualBusy(availability) {
  return (availability?.blocks || []).filter(block => block.kind !== 'external-google').map(eventInterval).filter(interval => interval.every(Number.isFinite) && interval[1] > interval[0]);
}

module.exports = { eventInterval, applicableOverride, effectiveIntervals, manualBusy };
