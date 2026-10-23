import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json',import.meta.url));
const {createClient} = require('@libsql/client');
const register = require('./availability-routes');
const client = createClient({url:'file::memory:'});
const routes = new Map();
const event = (id,start,end,extra={}) => ({id,title:'private '+id,start:`2030-01-01T${start}:00+09:00`,end:`2030-01-01T${end}:00+09:00`,...extra});
const events = [event('first','10:00','12:00'),event('second','11:00','13:00'),event('own','15:00','16:00')];
let fail = false;
let mutationCalls = 0;
let storedCalendarId = 'primary';
const google = {
  listCalendars:async()=>[{id:'me@example.com',primary:true}],
  listEventsInRange:async(_token,_calendar,from,to)=>{if(fail) throw Error('offline'); return events.filter(event=>Date.parse(event.start)<Date.parse(to) && Date.parse(event.end)>Date.parse(from));},
  getEvent:async(_token,_calendar,id)=>events.find(event=>event.id===id),
  freeBusy:async()=>events.map(event=>[Date.parse(event.start),Date.parse(event.end)]),
  updateEvent:async()=>{mutationCalls++;},
};
const api = register({app:{get:(path,...handlers)=>routes.set('GET '+path,handlers.at(-1)),patch:(path,...handlers)=>routes.set('PATCH '+path,handlers.at(-1))},client,requireAuth:()=>{},google,GOOGLE_ENABLED:true,getTokenRow:async staff=>staff==='unlinked'?null:{calendar_id:storedCalendarId},accessTokenFor:async()=> 'token',ownGoogleEventIdsFor:async()=>new Set(['own']),readDB:async()=>({})});
await api.init();
async function request(method,staff='staff',body={},id='first') {
  let status=200, response;
  const res={status:code=>{status=code;return res;},json:value=>{response=value;return res;}};
  const req={authUser:{id:staff},query:{from:'2030-01-01T00:00:00Z',to:'2030-01-03T00:00:00Z'},params:{id},body};
  await routes.get(method+' /api/availability/google-events'+(method==='PATCH'? '/:id':''))(req,res);
  return {status,body:response};
}
const body={calendar_id:'primary',start:events[0].start,end:events[0].end,ignored:true};
assert.equal((await request('GET')).body.events.length,2);
assert.equal((await request('PATCH','staff',body)).status,200);
assert.equal(mutationCalls,0);
assert.equal((await request('GET')).body.events[0].ignored,true);
assert.equal((await request('GET','other')).body.events[0].ignored,false);
assert.equal((await request('PATCH','staff',body,'own')).status,409);
assert.equal((await request('PATCH','staff',body,'missing')).status,404);
assert.equal((await request('PATCH','staff',{...body,calendar_id:'other'})).status,400);
assert.equal((await request('PATCH','staff',{...body,end:body.start})).status,400);
const from=Date.parse('2030-01-01T00:00:00Z'),to=Date.parse('2030-01-03T00:00:00Z');
const busy=await api.busyFor('staff',['me@example.com'],from,to);
assert.deepEqual(busy,events.slice(1).map(event=>[Date.parse(event.start),Date.parse(event.end)]));
const effective=await api.effectiveAvailability('staff',{blocks:[{kind:'external-google',start:events[0].start,end:events[0].end,note:'private'},{start:events[0].start,end:events[0].end}]},from,to);
assert.equal(effective.blocks.length,3);
assert.equal(effective.blocks.filter(block=>block.note).length,0);
assert.deepEqual(await api.busyFor('staff',['primary'],from,to,{excludeGoogleEventId:'own'}),[[Date.parse(events[1].start),Date.parse(events[1].end)]]);
storedCalendarId='me@example.com';
assert.deepEqual(await api.busyFor('staff',['primary'],from,to,{excludeGoogleEventId:'own'}),[[Date.parse(events[1].start),Date.parse(events[1].end)]]);
storedCalendarId='primary';
events[0]={...events[0],start:'2030-01-02T10:00:00+09:00',end:'2030-01-02T12:00:00+09:00'};
assert.equal((await request('GET')).body.events[0].adjusted,false);
assert.equal((await api.busyFor('staff',['primary'],from,to)).length,3);
await Promise.all([request('PATCH','staff',{...body,start:events[0].start,end:events[0].end}),request('PATCH','other',{...body,ignored:false})]);
assert.equal((await request('GET')).body.events[0].ignored,true);
assert.equal((await request('GET','other')).body.events[0].ignored,false);
fail=true;
assert.equal((await request('GET')).status,503);
await assert.rejects(()=>api.busyFor('staff',['primary'],from,to));
fail=false;
assert.equal((await request('PATCH','staff',{calendar_id:'primary',reset:true})).body.event.adjusted,false);
assert.equal((await request('GET','unlinked')).body.connected,false);
events.push({id:'outside',title:'outside week',start:'2029-12-31T10:00:00+09:00',end:'2029-12-31T11:00:00+09:00'});
await request('PATCH','staff',{calendar_id:'primary',start:'2030-01-01T17:00:00+09:00',end:'2030-01-01T18:00:00+09:00',ignored:false},'outside');
assert.equal((await request('GET')).body.events.filter(event=>event.id==='outside').length,1);
events.at(-1).start='2029-12-31T09:00:00+09:00';
assert.equal((await request('GET')).body.events.filter(event=>event.id==='outside').length,0);
client.close();
console.log('availability API/service: 24 checks passed');
