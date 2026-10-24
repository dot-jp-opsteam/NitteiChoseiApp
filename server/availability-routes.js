'use strict';
const { eventInterval, applicableOverride, effectiveIntervals, manualBusy } = require('./availability');

module.exports = function registerAvailabilityRoutes({app, client, requireAuth, google, GOOGLE_ENABLED, getTokenRow, accessTokenFor, ownGoogleEventIdsFor, readDB}) {
  let revision = 0;
  const eventLookups = new Map();
  async function lookupEvent(staff,row,id) {
    const key=JSON.stringify([staff,id]);
    if(eventLookups.has(key))return eventLookups.get(key);
    const pending=(async()=>google.getEvent(await accessTokenFor(row),'primary',id))();
    eventLookups.set(key,pending);
    try{return await pending;}finally{eventLookups.delete(key);}
  }
  async function init() {
    await client.execute(`CREATE TABLE IF NOT EXISTS availability_google_overrides (
      staff_id TEXT NOT NULL, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
      start TEXT, end TEXT, ignored INTEGER NOT NULL DEFAULT 0,
      original_start TEXT NOT NULL, original_end TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(staff_id, calendar_id, event_id)
    )`);
  }
  async function overridesFor(staffId, calendarId) {
    return (await client.execute({sql:'SELECT * FROM availability_google_overrides WHERE staff_id = ? AND calendar_id = ?',args:[staffId,calendarId]})).rows;
  }
  async function busyFor(staffId, calendarIds, fromMs, toMs, {excludeGoogleEventId} = {}) {
    const row = await getTokenRow(staffId);
    if (!row) throw new Error('Google未連携');
    const accessToken = await accessTokenFor(row);
    const result = [];
    let primaryId;
    const allOverrides = (await client.execute({sql:'SELECT * FROM availability_google_overrides WHERE staff_id = ?',args:[staffId]})).rows;
    if (allOverrides.length || excludeGoogleEventId) primaryId = (await google.listCalendars(accessToken)).find(calendar => calendar.primary)?.id;
    for (const calendarId of [...new Set(calendarIds)]) {
      const canonical = calendarId === primaryId ? 'primary' : calendarId;
      const storedCalendar = row.calendar_id === primaryId ? 'primary' : (row.calendar_id || 'primary');
      const excludeId = canonical === storedCalendar ? excludeGoogleEventId : undefined;
      const overrides = allOverrides.filter(override => override.calendar_id === canonical);
      const timeMin = new Date(fromMs).toISOString();
      const timeMax = new Date(toMs).toISOString();
      if (!overrides.length && !excludeId) {
        result.push(...await google.freeBusy(accessToken,[calendarId],timeMin,timeMax));
      } else {
        const events = await google.listEventsInRange(accessToken,calendarId,timeMin,timeMax);
        const own = await ownGoogleEventIdsFor(staffId);
        result.push(...effectiveIntervals(events,overrides.filter(override => !own.has(override.event_id)),excludeId));
        for (const override of overrides) {
          if (events.some(event => event.id === override.event_id) || own.has(override.event_id)) continue;
          const interval = eventInterval(override);
          if (Number(override.ignored) || !interval.every(Number.isFinite) || interval[1] <= fromMs || interval[0] >= toMs) continue;
          const event = await google.getEvent(accessToken,calendarId,override.event_id);
          if (event && applicableOverride(event,override)) result.push(...effectiveIntervals([event],[override],excludeId));
        }
      }
    }
    return result;
  }
  async function effectiveAvailability(staffId, rawAvailability, fromMs, toMs, options = {}) {
    const row = GOOGLE_ENABLED && await getTokenRow(staffId);
    if (!row) return {...rawAvailability, blocks:[...(rawAvailability?.blocks || [])]};
    const busy = await busyFor(staffId,['primary'],fromMs,toMs,options);
    return {...rawAvailability,blocks:[...(rawAvailability?.blocks || []).filter(block => block.kind !== 'external-google'),...busy.map(([start,end]) => ({kind:'external-google',start:new Date(start).toISOString(),end:new Date(end).toISOString()}))]};
  }
  async function getEffectiveAvailability(staffId,{from,to,...options}) {
    const db = await readDB();
    return effectiveAvailability(staffId,db?.availability?.[staffId] || {},Number(new Date(from)),Number(new Date(to)),options);
  }
  function present(event, override) {
    const adjusted = !!applicableOverride(event,override);
    const [start,end] = eventInterval(event);
    const blocking = event.transparency !== 'transparent' && !event.declined;
    return {...event,calendar_id:'primary',adjusted,ignored:adjusted ? !!Number(override.ignored) : !blocking,
      blocking_start:adjusted ? override.start : new Date(start).toISOString(),blocking_end:adjusted ? override.end : new Date(end).toISOString()};
  }
  app.get('/api/availability/google-events',requireAuth,async(req,res) => {
    const fromMs = Date.parse(req.query.from), toMs = Date.parse(req.query.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs-fromMs > 93*86400000) return res.status(400).json({error:'期間は93日以内で指定してください'});
    try {
      const row = GOOGLE_ENABLED && await getTokenRow(req.authUser.id);
      if (!row) return res.json({connected:false,events:[]});
      const accessToken = await accessTokenFor(row);
      const events = await google.listEventsInRange(accessToken,'primary',new Date(fromMs).toISOString(),new Date(toMs).toISOString());
      const own = await ownGoogleEventIdsFor(req.authUser.id);
      const overrides = new Map((await overridesFor(req.authUser.id,'primary')).map(override => [override.event_id,override]));
      const included = new Set(events.map(event => event.id));
      for (const override of overrides.values()) {
        if (included.has(override.event_id) || own.has(override.event_id) || Number(override.ignored)) continue;
        const interval = eventInterval(override);
        if (!interval.every(Number.isFinite) || interval[1] <= fromMs || interval[0] >= toMs) continue;
        const event = await google.getEvent(accessToken,'primary',override.event_id);
        if (!event || event.status === 'cancelled' || !applicableOverride(event,override)) continue;
        events.push(event);
        included.add(event.id);
      }
      res.json({connected:true,events:events.filter(event => !own.has(event.id)).map(event => present(event,overrides.get(event.id)))});
    } catch { res.status(503).json({error:'Google予定を取得できませんでした。再度お試しください'}); }
  });
  app.patch('/api/availability/google-events/:id',requireAuth,async(req,res) => {
    const body = req.body || {};
    try {
      const row = GOOGLE_ENABLED && await getTokenRow(req.authUser.id);
      if (!row) return res.status(409).json({error:'Google連携が必要です'});
      if (body.calendar_id !== 'primary') return res.status(400).json({error:'自分のカレンダーを指定してください'});
      if ((await ownGoogleEventIdsFor(req.authUser.id)).has(req.params.id)) return res.status(409).json({error:'確定済みの面談は面談一覧から変更してください'});
      const event = await lookupEvent(req.authUser.id,row,req.params.id);
      if (!event || event.status === 'cancelled') return res.status(404).json({error:'予定が見つかりません'});
      const original = eventInterval(event);
      if (!original.every(Number.isFinite)) return res.status(400).json({error:'予定の日時を読み取れません'});
      let override;
      if (body.reset === true) {
        await client.execute({sql:'DELETE FROM availability_google_overrides WHERE staff_id = ? AND calendar_id = ? AND event_id = ?',args:[req.authUser.id,'primary',req.params.id]});
      } else {
        const start = Date.parse(body.start), end = Date.parse(body.end);
        if (typeof body.ignored !== 'boolean' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end-start > 93*86400000 || Math.abs(start-original[0]) > 93*86400000) return res.status(400).json({error:'面談不可の開始・終了を正しく指定してください'});
        override = {event_id:req.params.id,ignored:body.ignored ? 1:0,start:new Date(start).toISOString(),end:new Date(end).toISOString(),original_start:new Date(original[0]).toISOString(),original_end:new Date(original[1]).toISOString()};
        await client.execute({sql:`INSERT INTO availability_google_overrides (staff_id,calendar_id,event_id,start,end,ignored,original_start,original_end,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(staff_id,calendar_id,event_id) DO UPDATE SET start=excluded.start,end=excluded.end,ignored=excluded.ignored,original_start=excluded.original_start,original_end=excluded.original_end,updated_at=excluded.updated_at`,args:[req.authUser.id,'primary',override.event_id,override.start,override.end,override.ignored,override.original_start,override.original_end,new Date().toISOString()]});
      }
      revision++;
      const updated = present(event,override);
      res.json({...updated,event:updated});
    } catch { res.status(503).json({error:'変更を保存できませんでした。再度お試しください'}); }
  });
  return {init,busyFor,effectiveAvailability,getEffectiveAvailability,manualBusy,get revision(){return revision;}};
};
