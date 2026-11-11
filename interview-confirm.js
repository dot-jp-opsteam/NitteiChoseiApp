/* スタッフの面談確定。入力済みの希望順と古い枠の読み方は本体から受け取る。 */
let IVC=null;
const IV_CONFIRMING=new Set();
function ivcSetBusy(busy){const b=document.getElementById('ivc-confirm');if(b){b.disabled=busy;b.textContent=busy?'確定しています…':'この日時で確定';}}
function ivcSaveError(message){const el=document.getElementById('ivc-save-error');if(el)el.textContent=message||'';}
function ivcGroups(iv){return ivGroups(iv).map((g,index)=>({...g,index,segments:InterviewPreferences.segments(g)}));}
function ivcKey(g){return g.key||slotYmd(g.slots[0]);}
function ivcLabel(key){return fmtDate(new Date(key+'T12:00:00'));}
function ivcTimes(g){return g.segments.map(r=>`${hm24(new Date(r.start))}〜${hm24(new Date(r.end))}`).join(' ＆ ');}
function ivcOptions(iv,g){return g.slots.filter(s=>new Date(s)>Date.now()&&InterviewPreferences.fits(g,s,ivRequestDuration(iv)));}
function openInterviewConfirm(id){
  const iv=(DB.interviews||[]).find(i=>i.id===id);if(!iv)return;
  if(iv.status!=='applied')return openInterview(id);
  const groups=ivcGroups(iv);
  if(!IVC||IVC.id!==id)IVC={id,day:groups[0]?ivcKey(groups[0]):'',index:groups[0]?.index??0,start:'',agenda:{},busy:false};
  const days=[...new Set(groups.map(ivcKey))];
  if(!days.includes(IVC.day))IVC.day=groups[0]?ivcKey(groups[0]):'';
  const dayGroups=groups.filter(g=>ivcKey(g)===IVC.day);
  let group=dayGroups.find(g=>g.index===IVC.index)||dayGroups[0];
  if(group){IVC.index=group.index;const options=ivcOptions(iv,group);if(!options.includes(IVC.start))IVC.start=options[0]||'';}
  const cards=days.sort().map(day=>`<button type="button" data-day="${day}" class="ivc-date${day===IVC.day?' on':''}" aria-pressed="${day===IVC.day}" onclick="ivcSelectDay('${day}')">
    <span class="ivc-radio" aria-hidden="true"></span><span><b>${ivcLabel(day)}</b>${groups.filter(g=>ivcKey(g)===day).map(g=>`<span class="ivc-date-time"><span>${ivcTimes(g)}</span><strong>第${g.index+1}希望</strong></span>`).join('')}</span></button>`).join('');
  const agenda=IVC.agenda[IVC.day];
  const agendaNote=!IVC.day?'':!agenda||agenda.loading?'<p class="ivc-state" role="status">自分の予定を読み込んでいます…</p>':agenda.error?`<p class="ivc-state ivc-error" role="alert">予定を取得できませんでした。予定がないことは確認できていません。<button type="button" class="btn sm" onclick="ivcRetry()">再取得</button></p>`:!agenda.connected?'<p class="ivc-state">Googleカレンダー未連携：アプリ内の面談予定を表示しています。</p>':'';
  const ready=agenda&&!agenda.loading&&!agenda.error;
  const options=group?ivcOptions(iv,group):[];
  const overlap=IVC.start?ivcAgendaItems(iv).filter(e=>+new Date(IVC.start)<e.end&&+new Date(IVC.start)+ivRequestDuration(iv)*60000>e.start):[];
  const confirmation=group?`<aside class="ivc-confirm-panel" aria-label="確定する日時の確認"><strong>第${group.index+1}希望</strong><h3>${ivcLabel(IVC.day)}</h3><p class="ivc-person">${esc(ivInternName(iv))} さん</p>
    <div class="ivc-fields"><label for="ivc-start">開始時刻<select id="ivc-start" onchange="ivcChangeStart(this.value)"${options.length?'':' disabled'}>${options.length?options.map(s=>`<option value="${esc(s)}"${IVC.start===s?' selected':''}>${hm24(s)}</option>`).join(''):'<option>選べる開始時刻なし</option>'}</select></label>
    <div><span class="ivc-field-label">終了時刻</span><output id="ivc-end">${IVC.start?hm24(new Date(+new Date(IVC.start)+ivRequestDuration(iv)*60000)):'—'}</output><span>（${ivRequestDuration(iv)}分後）</span></div></div>
    <p class="ivc-duration">所要時間 <b>${ivRequestDuration(iv)}分</b></p>
    ${options.length?'':'<p class="ivc-error">この希望時間帯には所要時間が収まる開始時刻がありません。</p>'}
    ${overlap.length?`<div class="ivc-warning">別の予定と重なっています。${overlap.map(e=>`<div>${esc(e.label)}</div>`).join('')}<p>確定前にもう一度確認します。</p></div>`:''}
    <p id="ivc-save-error" class="ivc-error" role="alert"></p>
    <button type="button" class="btn pri block" id="ivc-confirm"${ready&&IVC.start&&!IV_CONFIRMING.has(id)?'':' disabled'} onclick="ivcConfirm()">${IV_CONFIRMING.has(id)?'確定しています…':'この日時で確定'}</button></aside>`:'';
  const active=document.querySelector('.ivc-page');const focused=document.activeElement;const focusId=focused?.id;const focusedDay=focused?.closest('.ivc-date')?.dataset.day;const focusedIndex=focused?.closest('.ivc-band')?.dataset.index;const scroller=document.getElementById('scrim');const scroll=active?scroller.scrollTop:0;
  openSheet(`<section class="ivc-page" data-id="${esc(id)}" role="dialog" aria-modal="true" aria-labelledby="ivc-title" onkeydown="ivcKeyDown(event)"><header class="ivc-heading"><button type="button" class="btn sm" onclick="closeSheet()" aria-label="面談確定画面を閉じる">${ic('chevron-l')}戻る</button><h2 id="ivc-title" tabindex="-1">面談日時を確定</h2></header>
    <p class="ivc-subtitle">${esc(ivInternName(iv))} さん・${ivRequestDuration(iv)}分</p>
    ${iv.note?`<p class="ivc-note">${esc(iv.note)}</p>`:''}
    ${groups.length?`<div class="ivc-dates" aria-label="希望日を1日選択">${cards}</div><div class="ivc-instruction"><p>空き時間をタップ／クリックして選択。</p><div class="ivc-legend"><span>相手の空き時間</span><span>自分の予定</span></div></div>${agendaNote}<div class="ivc-layout">${ivcTimeline(iv,dayGroups)}${confirmation}</div>`:'<p class="ivc-state">希望日時がありません。担当者が相手に確認してください。</p>'}
    <details class="ivc-other"><summary>その他の対応</summary><button type="button" class="btn block" onclick="openCustomConfirm('${id}')">候補以外の日時で確定する</button><p class="fine">相手に別の日時を確認した場合に使います。</p><button type="button" class="btn bad block" onclick="failInterview('${id}')">この申請を不成立にする</button></details></section>`);
  scroller.scrollTop=scroll;
  const app=document.getElementById('app');if(app)app.inert=true;
  const focusTarget=focusId?document.getElementById(focusId):focusedDay?document.querySelector('.ivc-date[data-day="'+focusedDay+'"]'):focusedIndex!==undefined?document.querySelector('.ivc-band[data-index="'+focusedIndex+'"]'):!active?document.getElementById('ivc-title'):null;
  focusTarget?.focus({preventScroll:true});
  if(IVC.day&&!agenda)ivcLoadAgenda(id,IVC.day);
}
function ivcAgendaItems(iv){
  if(!IVC||!IVC.day)return [];
  const day=IVC.day,base=+new Date(day+'T00:00:00'),end=base+86400000,items=[],googleIds=new Set();
  (DB.interviews||[]).forEach(i=>{if(i.id===iv.id||i.staff_id!==ME.id||i.status!=='fixed'||!i.confirmed_datetime)return;const s=+new Date(i.confirmed_datetime),e=s+(Number(i.duration_min)||30)*60000;if(s>=end||e<=base)return;if(i.googleEventId)googleIds.add(i.googleEventId);items.push({start:s,end:e,title:ivInternName(i)+'さんの面談',label:hm24(new Date(s))+'〜'+hm24(new Date(e))+' '+ivInternName(i)+'さんの面談'});});
  const seen=new Set();(IVC.agenda[day]?.events||[]).forEach(e=>{
    if(!e||googleIds.has(e.id)||seen.has(e.id))return;seen.add(e.id);
    const all=!!e.allDay,s=all?+new Date(String(e.start).slice(0,10)+'T00:00:00'):+new Date(e.start),finish=e.end?(all?+new Date(String(e.end).slice(0,10)+'T00:00:00'):+new Date(e.end)):s+(all?86400000:3600000);
    if(!Number.isFinite(s)||!Number.isFinite(finish)||s>=end||finish<=base)return;
    const title=e.title||'タイトルなし';items.push({start:s,end:finish,title,allDay:all,label:(all?'終日':hm24(new Date(s))+'〜'+hm24(new Date(finish)))+' '+title});
  });return items.sort((a,b)=>a.start-b.start);
}
function ivcTimeline(iv,groups){
  const base=+new Date(IVC.day+'T00:00:00'),items=ivcAgendaItems(iv),ranges=groups.flatMap(g=>g.segments);
  if(!ranges.length)return '';
  const minutes=t=>(t-base)/60000;
  const timed=items.filter(e=>!e.allDay),all=items.filter(e=>e.allDay);
  const lo=Math.max(0,Math.floor(Math.min(...ranges.map(r=>minutes(r.start)),...timed.map(r=>minutes(r.start)))/60)*60);
  const hi=Math.min(1440,Math.ceil(Math.max(...ranges.map(r=>minutes(r.end)),...timed.map(r=>minutes(r.end)))/60)*60);
  const px=1,height=Math.max(60,hi-lo)*px;
  const pos=(s,e)=>`top:${Math.max(0,minutes(s)-lo)*px}px;height:${Math.max(18,(Math.min(hi,minutes(e))-Math.max(lo,minutes(s)))*px)}px`;
  const labels=[];for(let m=lo;m<=hi;m+=60)labels.push(`<span style="top:${(m-lo)*px}px">${String(Math.floor(m/60)).padStart(2,'0')}:00</span>`);
  const bands=groups.flatMap(g=>g.segments.map(r=>`<button type="button" class="ivc-band" style="${pos(r.start,r.end)}" data-index="${g.index}" data-start="${r.start}" data-end="${r.end}" aria-label="第${g.index+1}希望 ${hm24(new Date(r.start))}から${hm24(new Date(r.end))}" onclick="ivcPick(event,${g.index})"><span class="ivc-band-copy" style="top:${IVC.index===g.index&&IVC.start&&+new Date(IVC.start)<r.start+2400000?Math.max(4,Math.min((+new Date(IVC.start)+ivRequestDuration(iv)*60000-r.start)/60000+4,(r.end-r.start)/60000-38)):6}px"><strong>第${g.index+1}希望</strong><span>${hm24(new Date(r.start))}〜${hm24(new Date(r.end))}</span></span></button>`)).join('');
  const chosen=IVC.start?`<div class="ivc-selected" style="${pos(+new Date(IVC.start),+new Date(IVC.start)+ivRequestDuration(iv)*60000)}">${hm24(IVC.start)}–${hm24(new Date(+new Date(IVC.start)+ivRequestDuration(iv)*60000))}</div>`:'';
  return `<div class="ivc-time-table" role="group" aria-label="${ivcLabel(IVC.day)}の共通時間軸"><div class="ivc-table-head"><span></span><b>相手の空き時間</b><b>自分の予定</b></div>${all.length?`<div class="ivc-all-day"><span>終日</span><span></span><div>${all.map(e=>`<p>${esc(e.title)}</p>`).join('')}</div></div>`:''}<div class="ivc-grid" style="height:${height+14}px"><div class="ivc-axis">${labels.join('')}</div><div class="ivc-track" style="height:${height}px">${bands}${chosen}</div><div class="ivc-track ivc-own" style="height:${height}px">${timed.map(e=>`<div class="ivc-event" style="${pos(e.start,e.end)}"><b>${esc(e.title)}</b><span>${hm24(new Date(e.start))}〜${hm24(new Date(e.end))}</span></div>`).join('')}${!items.length&&IVC.agenda[IVC.day]&&!IVC.agenda[IVC.day].loading&&!IVC.agenda[IVC.day].error?'<p class="ivc-no-events">予定はありません</p>':''}</div></div></div>`;
}
async function ivcLoadAgenda(id,day){
  const state=IVC;if(!state||state.id!==id)return;
  const entry={loading:true,events:[],connected:false,error:false};state.agenda[day]=entry;
  try{
    const start=new Date(day+'T00:00:00'),end=new Date(+start+86400000);
    const r=await api('/api/my-calendar/events?timeMin='+encodeURIComponent(start.toISOString())+'&timeMax='+encodeURIComponent(end.toISOString()));
    if(!r.ok)throw Error('予定を取得できませんでした');
    const data=await r.json();entry.events=data.events||[];entry.connected=!!data.connected;entry.error=!!data.error;
  }catch(e){entry.error=true;}finally{
    entry.loading=false;
    if(IVC===state&&IVC.day===day&&document.querySelector('.ivc-page')?.dataset.id===id)openInterviewConfirm(id);
  }
}
function ivcRetry(){if(!IVC)return;delete IVC.agenda[IVC.day];openInterviewConfirm(IVC.id);}
function ivcSelectDay(day){if(!IVC||IV_CONFIRMING.has(IVC.id))return;IVC.day=day;IVC.start='';openInterviewConfirm(IVC.id);}
function ivcChangeStart(value){if(!IVC||IV_CONFIRMING.has(IVC.id))return;IVC.start=value;openInterviewConfirm(IVC.id);document.getElementById('ivc-start')?.focus();}
function ivcPick(event,index){
  if(!IVC||IV_CONFIRMING.has(IVC.id))return;
  const iv=DB.interviews.find(i=>i.id===IVC.id),g=ivcGroups(iv).find(g=>g.index===index);if(!g)return;
  const options=ivcOptions(iv,g);IVC.index=index;
  if(event.detail===0)IVC.start=options[0]||'';
  else{const button=event.currentTarget,rect=button.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height)),s=Number(button.dataset.start),e=Number(button.dataset.end),target=s+Math.floor((e-s)*fraction/1800000)*1800000;
    IVC.start=options.filter(t=>+new Date(t)>=s&&+new Date(t)<e).sort((a,b)=>Math.abs(+new Date(a)-target)-Math.abs(+new Date(b)-target))[0]||'';
  }openInterviewConfirm(IVC.id);
}
function ivcConfirm(){
  if(!IVC||IV_CONFIRMING.has(IVC.id))return;
  const iv=DB.interviews.find(i=>i.id===IVC.id),g=ivcGroups(iv).find(g=>g.index===IVC.index),agenda=IVC.agenda[IVC.day];
  if(!iv||!g||!IVC.start||!agenda||agenda.loading||agenda.error||!ivcOptions(iv,g).includes(IVC.start)){toast('候補と予定の読み込み状態を確認してください');return;}
  confirmInterview(iv.id,IVC.start,false,false,IVC.index);
}
async function ivcRefreshState(id){
  try{const r=await api('/api/db');if(!r.ok)return;const data=await r.json();const fresh=(data.interviews||[]).find(i=>i.id===id);if(fresh){applyInterview(fresh);openInterview(id);}}catch(e){}
}

function ivcKeyDown(e){
 if(e.key==='Escape'){e.preventDefault();closeSheet();return;}
 if(e.key!=='Tab')return;
 const focusable=Array.from(e.currentTarget.querySelectorAll('button:not([disabled]),select:not([disabled]),summary')).filter(el=>el.offsetParent!==null&&(!el.closest('details:not([open])')||el.tagName==='SUMMARY'));
 if(!focusable.length)return;
 if(e.shiftKey&&(document.activeElement===focusable[0]||document.activeElement.id==='ivc-title')){e.preventDefault();focusable.at(-1).focus();}
 else if(!e.shiftKey&&document.activeElement===focusable.at(-1)){e.preventDefault();focusable[0].focus();}
}
function ivcOverlapLabels(iv,dt,min){
 if(!IVC||IVC.id!==iv.id||IVC.day!==ymd(new Date(dt)))return ivOverlaps(dt,min,iv.id);
 const start=+new Date(dt),end=start+min*60000;return ivcAgendaItems(iv).filter(e=>start<e.end&&end>e.start).map(e=>e.label);
}
