import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const google = require('../server/google');
const originalFetch = globalThis.fetch;
const calls=[];
globalThis.fetch=async(url,options)=>{
  calls.push({url:String(url),options});
  const parsed=new URL(url);
  if (parsed.pathname.endsWith('/missing')) return {ok:false,status:404};
  if (parsed.pathname.endsWith('/single')) return {ok:true,json:async()=>({id:'single',start:{date:'2030-01-01'},end:{date:'2030-01-02'},transparency:'transparent'})};
  const second=parsed.searchParams.get('pageToken')==='second';
  return {ok:true,json:async()=>second?{items:[{id:'declined',start:{dateTime:'2030-01-01T11:00:00Z'},end:{dateTime:'2030-01-01T12:00:00Z'},attendees:[{self:true,responseStatus:'declined'}]},{id:'deleted',status:'cancelled'}]}:{items:[{id:'recurring_instance_1',summary:'Private title',start:{dateTime:'2030-01-01T10:00:00Z'},end:{dateTime:'2030-01-01T11:00:00Z'}}],nextPageToken:'second'}};
};
try {
  const events=await google.listEventsInRange('access','primary','2030-01-01T00:00:00Z','2030-01-03T00:00:00Z');
  assert.equal(events.length,2);
  assert.equal(calls.length,2);
  assert.equal(new URL(calls[0].url).searchParams.get('singleEvents'),'true');
  assert.equal(events[1].declined,true);
  assert.equal(events[0].title,'Private title');
  assert.equal((await google.getEvent('access','primary','single')).transparency,'transparent');
  assert.equal(await google.getEvent('access','primary','missing'),null);
  assert.equal(calls.every(call=>!call.options.method || call.options.method==='GET'),true);
  console.log('availability Google pagination/lookup: 8 checks passed');
} finally { globalThis.fetch=originalFetch; }
