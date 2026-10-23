let AVGOOGLE={key:'',events:[],loading:false,error:'',connected:false};
let AVGOOGLE_EDIT=null;

function avGoogleLanes(segments){
  const sorted=segments.slice().sort((left,right)=>left.start-right.start||left.end-right.end);
  let cluster=[],ends=[];
  const finish=()=>{cluster.forEach(segment=>segment.lanes=ends.length);cluster=[];ends=[];};
  for(const segment of sorted){
    if(cluster.length&&segment.start>=Math.max(...ends))finish();
    let lane=ends.findIndex(end=>end<=segment.start);
    if(lane<0)lane=ends.length;
    segment.lane=lane;ends[lane]=segment.end;cluster.push(segment);
  }
  finish();return sorted;
}

function avGoogleWeek(days){
  const from=new Date(days[0]),to=new Date(from);to.setDate(to.getDate()+7);
  return {from:from.toISOString(),to:to.toISOString(),key:ME.id+'|'+from.toISOString()};
}

function avGoogleQueue(days){
  const range=avGoogleWeek(days);
  if(AVGOOGLE.key!==range.key){
    AVGOOGLE={...range,events:[],loading:true,error:'',connected:false};
    setTimeout(()=>avGoogleLoad(range),0);
  }
  setTimeout(avGooglePaint,0);
  if(AVGOOGLE.error)return `<p class="field-err show" role="alert">${esc(AVGOOGLE.error)} <button class="btn sm" onclick="avGoogleRetry()">再読み込み</button></p>`;
  return `<p class="fine" aria-live="polite">${AVGOOGLE.loading?'Googleの予定を読み込んでいます…':AVGOOGLE.connected?'Googleの予定をタップすると、日調アプリの面談不可時間だけ調整できます。上下のつまみは30分単位です。':'Google未連携の場合は、マスをタップして不可時間を指定できます。'}</p><div id="avg-event-list" class="avg-event-list"></div>`;
}

async function avGoogleLoad(range){
  const pending=AVGOOGLE;
  try{
    const response=await api('/api/availability/google-events?from='+encodeURIComponent(range.from)+'&to='+encodeURIComponent(range.to));
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'Googleの予定を取得できませんでした');
    if(AVGOOGLE!==pending)return;
    AVGOOGLE={...range,events:data.events||[],connected:!!data.connected,loading:false,error:''};
  }catch(error){
    if(AVGOOGLE!==pending)return;
    AVGOOGLE.loading=false;AVGOOGLE.error=error.message;
  }
  if(currentTab==='avset')renderQuiet();
}

function avGoogleRetry(){AVGOOGLE.loading=true;AVGOOGLE.error='';avGoogleLoad({...AVGOOGLE});renderQuiet();}

function avGoogleGridBlocks(staffId,days,fallback){
  if(staffId!==ME.id||AVGOOGLE.key!==avGoogleWeek(days).key||AVGOOGLE.loading||AVGOOGLE.error||!AVGOOGLE.connected)return fallback;
  return AVGOOGLE.events.filter(event=>!event.ignored).map(event=>({start:event.blocking_start,end:event.blocking_end}));
}

function avGooglePaint(){
  const stage=document.querySelector('.avg-stage');
  if(!stage||currentTab!=='avset')return;
  stage.querySelector('.avg-overlay')?.remove();
  const firstRow=stage.querySelector('tbody tr');
  if(!firstRow||!AVGOOGLE.events.length)return;
  const cells=Array.from(firstRow.querySelectorAll('td'));
  const base=stage.getBoundingClientRect(),rowHeight=firstRow.getBoundingClientRect().height;
  const overlay=document.createElement('div');overlay.className='avg-overlay';
  cells.forEach(cell=>{
    const morning=new Date(cell.dataset.iso),begin=+morning,finish=begin+15*3600000;
    const rect=cell.getBoundingClientRect();
    const segments=AVGOOGLE.events.map((event,index)=>({event,index,start:Math.max(begin,+avGoogleDate(event.ignored?event.start:event.blocking_start)),end:Math.min(finish,+avGoogleDate(event.ignored?event.end:event.blocking_end))})).filter(segment=>segment.end>segment.start);
    avGoogleLanes(segments).forEach(segment=>{
      const {event,index,lane,lanes,start,end}=segment;
      const band=document.createElement('div');band.className='avg-band'+(event.ignored?' avg-ignored':'');
      band.title='Googleの元予定：'+avGoogleDate(event.start).toLocaleString('ja-JP')+'〜'+avGoogleDate(event.end).toLocaleString('ja-JP');
      band.style.cssText=`top:${rect.top-base.top+(start-begin)/1800000*rowHeight}px;height:${(end-start)/1800000*rowHeight}px;left:${rect.left-base.left+lane*rect.width/lanes+1}px;width:${rect.width/lanes-3}px`;
      const label=event.title||'（無題の予定）';
      band.innerHTML=`<button type="button" class="avg-resize avg-resize-start" aria-label="${esc(label)} の不可開始をドラッグ"></button><button type="button" class="avg-event-open" aria-label="${esc(label)} の面談不可時間を調整"><strong>${esc(label)}</strong><span>${event.ignored?'面談OK':avGoogleTime(event.blocking_start)+'〜'+avGoogleTime(event.blocking_end)}</span></button><button type="button" class="avg-resize avg-resize-end" aria-label="${esc(label)} の不可終了をドラッグ"></button>`;
      band.querySelector('.avg-event-open').onclick=()=>avGoogleOpen(index);
      band.querySelectorAll('.avg-resize').forEach((handle,position)=>{
        handle.onpointerdown=pointer=>avGoogleResize(pointer,index,position===0?'start':'end',rowHeight,band);
        handle.onclick=()=>{if(handle.dataset.dragged){delete handle.dataset.dragged;return;}avGoogleOpen(index);};
      });
      overlay.append(band);
    });
  });
  stage.append(overlay);
  const list=document.getElementById('avg-event-list');
  if(list)list.innerHTML=AVGOOGLE.events.map((event,index)=>`<button class="btn sm" onclick="avGoogleOpen(${index})">${esc(event.title||'（無題の予定）')} ${event.ignored?'・面談OK':event.adjusted?'・調整済み':''}</button>`).join('');
}

function avGoogleDate(value){return new Date(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T00:00:00+09:00':value);}
function avGoogleTime(value){return avGoogleDate(value).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',hour12:false});}
function avGoogleInput(value){const date=avGoogleDate(value);return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());}

function avGoogleOpen(index){
  if(AVGOOGLE_EDIT?.saving){toast('保存中です。少しお待ちください');return;}
  const source=AVGOOGLE.events[index];if(!source)return;
  const event={...source,start:avGoogleDate(source.start).toISOString(),end:avGoogleDate(source.end).toISOString()};
  AVGOOGLE_EDIT={event:{...event},key:AVGOOGLE.key,sheet:true};
  openSheet(`<h2>${esc(event.title||'（無題の予定）')}</h2><p class="fine">Googleの元予定：${esc(new Date(event.start).toLocaleString('ja-JP'))} 〜 ${esc(new Date(event.end).toLocaleString('ja-JP'))}${event.allDay?'（終日）':''}</p><p>ここで調整するのは日調アプリの面談不可時間です。Googleの予定は変わりません。</p><label class="fl" for="avg-start">面談不可の開始</label><input type="datetime-local" step="1800" id="avg-start" value="${avGoogleInput(event.blocking_start||event.start)}"><label class="fl" for="avg-end">面談不可の終了</label><input type="datetime-local" step="1800" id="avg-end" value="${avGoogleInput(event.blocking_end||event.end)}"><p id="avg-error" class="field-err" role="alert"></p><div class="avg-actions"><button class="btn pri" onclick="avGoogleSaveInputs()">面談不可時間を保存</button><button class="btn" onclick="avGoogleSave({ignored:true})">この予定中も面談OK</button><button class="btn" onclick="avGoogleSave({reset:true})">元の予定どおりに戻す</button></div>`);
}

function avGoogleSaveInputs(){
  const start=new Date(document.getElementById('avg-start').value),end=new Date(document.getElementById('avg-end').value);
  if(!Number.isFinite(+start)||!Number.isFinite(+end)||+end<=+start){const label=document.getElementById('avg-error');label.textContent='終了は開始より後にしてください';label.classList.add('show');return;}
  avGoogleSave({start:start.toISOString(),end:end.toISOString(),ignored:false});
}

async function avGoogleSave(changes){
  const editing=AVGOOGLE_EDIT;if(!editing||editing.saving)return;
  editing.saving=true;
  const buttons=editing.sheet?Array.from(document.querySelectorAll('.avg-actions button')):[];buttons.forEach(button=>button.disabled=true);
  try{
    const defaults={start:editing.event.blocking_start||avGoogleDate(editing.event.start).toISOString(),end:editing.event.blocking_end||avGoogleDate(editing.event.end).toISOString()};
    const response=await api('/api/availability/google-events/'+encodeURIComponent(editing.event.id),{method:'PATCH',body:JSON.stringify({calendar_id:editing.event.calendar_id,...defaults,...changes})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'保存できませんでした');
    if(AVGOOGLE.key===editing.key){
      const updated=data.event||data;
      AVGOOGLE.events=AVGOOGLE.events.map(event=>event.id===updated.id&&event.calendar_id===updated.calendar_id?updated:event);
    }
    if(AVGOOGLE_EDIT===editing){if(editing.sheet)closeSheet();AVGOOGLE_EDIT=null;}
    if(currentTab==='avset')renderQuiet();
    toast('面談不可時間を更新しました');
  }catch(error){
    if(AVGOOGLE_EDIT===editing){const label=editing.sheet&&document.getElementById('avg-error');if(label){label.textContent=error.message;label.classList.add('show');}else toast(error.message);}
    else toast(error.message);
  }finally{editing.saving=false;buttons.forEach(button=>button.disabled=false);}
}

function avGoogleResize(pointer,index,edge,rowHeight,band){
  if(pointer.button!==0)return;
  if(AVGOOGLE_EDIT?.saving){toast('保存中です。少しお待ちください');return;}
  pointer.preventDefault();pointer.stopPropagation();
  const event=AVGOOGLE.events[index],origin=pointer.clientY,key=AVGOOGLE.key;
  const original=+new Date(edge==='start'?event.blocking_start:event.blocking_end);
  let moved=0;
  const originalTop=parseFloat(band.style.top),originalHeight=parseFloat(band.style.height);
  const move=next=>{moved=Math.round((next.clientY-origin)/rowHeight)*1800000;const pixels=moved/1800000*rowHeight;band.style.opacity='.55';band.style.top=(originalTop+(edge==='start'?pixels:0))+'px';band.style.height=Math.max(18,originalHeight+(edge==='start'?-pixels:pixels))+'px';};
  const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);band.style.opacity='';};
  const cancel=()=>{cleanup();avGooglePaint();};
  const finish=()=>{
    cleanup();avGooglePaint();if(!moved||key!==AVGOOGLE.key)return;
    pointer.target.dataset.dragged='1';
    const start=edge==='start'?original+moved:+new Date(event.blocking_start),end=edge==='end'?original+moved:+new Date(event.blocking_end);
    if(end<=start){toast('終了は開始より後にしてください');return;}
    AVGOOGLE_EDIT={event:{...event},key};
    avGoogleSave({start:new Date(start).toISOString(),end:new Date(end).toISOString(),ignored:false});
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);
}

if(typeof window!=='undefined')window.addEventListener('resize',()=>avGooglePaint());
