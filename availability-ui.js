let AVGOOGLE={key:'',events:[],loading:false,error:'',connected:false};
let AVGOOGLE_EDIT=null;
const AVGOOGLE_SAVES=new Map();
let AVGOOGLE_DRAG=false;
let AVGOOGLE_VERSION=0,AVGOOGLE_REFRESH_TIMER=null;
let AVGOOGLE_FULL_REFRESH=false;
const AVGOOGLE_UPDATES=new Map();
const avGoogleSaveKey=(key,event)=>JSON.stringify([key.split('|')[0],event.calendar_id,event.id]);

function avGoogleRefresh(){
  if(currentTab!=='avset')return;
  if(AVGOOGLE_DRAG||(typeof AVDRAG!=='undefined'&&AVDRAG)||(typeof AVHOLD!=='undefined'&&AVHOLD)){
    clearTimeout(AVGOOGLE_REFRESH_TIMER);AVGOOGLE_REFRESH_TIMER=setTimeout(avGoogleRefresh,50);return;
  }
  if(AVGOOGLE_FULL_REFRESH){AVGOOGLE_FULL_REFRESH=false;renderQuiet();return;}
  if(typeof genEditGrid==='function'){
    const {grid}=genEditGrid(ME.id,AVSET.weekOffset||0);
    const states=new Map(grid.flat().map(cell=>[cell.iso,cell]));
    document.querySelectorAll('.avg-stage td[data-iso]').forEach(cell=>{
      const state=states.get(cell.dataset.iso);if(!state)return;
      cell.className='bt-c '+({free:'ok',block:'block',locked:'locked',off:'off'}[state.state]);
      cell.textContent={free:'○',block:'×',locked:'－',off:'×'}[state.state];
      cell.title=state.state==='locked'?state.label+'あり':state.state==='block'?'タップまたはドラッグで解除':state.state==='free'?'タップ、または同じ日の中で上下になぞって不可にする':'';
      cell.onpointerdown=['free','block'].includes(state.state)?event=>avPointerDown(event,state.iso):null;
    });
    const count=document.getElementById('avBlockedCnt');
    if(count)count.textContent=grid.flat().filter(cell=>cell.state==='block').length;
  }
  avGooglePaint();
}

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
  return `<p class="fine" aria-live="polite">${AVGOOGLE.loading?'Googleの予定を読み込んでいます…':AVGOOGLE.connected?'Googleの予定をタップすると、日調アプリの面談不可時間だけ調整できます。上下のつまみは30分単位です。確定した面談の帯も、上下のつまみで長さを変えられます（押すと時間を数字で指定できます）。':'Google未連携の場合は、マスをタップして不可時間を指定できます。'}</p><div id="avg-event-list" class="avg-event-list"></div>`;
}

async function avGoogleLoad(range){
  const pending=AVGOOGLE;
  const version=AVGOOGLE_VERSION;
  try{
    const response=await api('/api/availability/google-events?from='+encodeURIComponent(range.from)+'&to='+encodeURIComponent(range.to));
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'Googleの予定を取得できませんでした');
    if(AVGOOGLE!==pending)return;
    const events=(data.events||[]).map(event=>{
      const id=avGoogleSaveKey(range.key,event),changed=AVGOOGLE_UPDATES.get(id);
      return AVGOOGLE_SAVES.get(id)?.latest||(changed&&changed.version>version?changed.event:event);
    });
    for(const [id,changed] of AVGOOGLE_UPDATES){
      if(JSON.parse(id)[0]!==range.key.split('|')[0]||(!AVGOOGLE_SAVES.has(id)&&changed.version<=version))continue;
      const event=changed.event,from=Date.parse(range.from),to=Date.parse(range.to);
      const overlaps=(start,end)=>Date.parse(start)<to&&Date.parse(end)>from;
      if(!events.some(item=>item.id===event.id&&item.calendar_id===event.calendar_id)&&(overlaps(event.start,event.end)||(!event.ignored&&overlaps(event.blocking_start,event.blocking_end))))events.push(event);
    }
    AVGOOGLE={...range,events,connected:!!data.connected,loading:false,error:''};
  }catch(error){
    if(AVGOOGLE!==pending)return;
    AVGOOGLE.loading=false;AVGOOGLE.error=error.message;
  }
  if(currentTab==='avset'){AVGOOGLE_FULL_REFRESH=true;avGoogleRefresh();}
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
  if(!firstRow)return;
  const cells=Array.from(firstRow.querySelectorAll('td'));
  const base=stage.getBoundingClientRect(),rowHeight=firstRow.getBoundingClientRect().height;
  const overlay=document.createElement('div');overlay.className='avg-overlay';
  if(AVGOOGLE.events.length)cells.forEach(cell=>{
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
  avInterviewBands(overlay,cells,base,rowHeight);
  stage.append(overlay);
  const list=document.getElementById('avg-event-list');
  if(list)list.innerHTML=AVGOOGLE.events.map((event,index)=>`<button class="btn sm" onclick="avGoogleOpen(${index})">${esc(event.title||'（無題の予定）')} ${event.ignored?'・面談OK':event.adjusted?'・調整済み':''}</button>`).join('');
}

function avGoogleDate(value){return new Date(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T00:00:00+09:00':value);}
function avGoogleTime(value){return avGoogleDate(value).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',hour12:false});}
function avGoogleInput(value){const date=avGoogleDate(value);return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());}

function avGoogleOpen(index){
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
  const editing=AVGOOGLE_EDIT;if(!editing)return;
  const event=editing.event;
  const id=avGoogleSaveKey(editing.key,event);
  let state=AVGOOGLE_SAVES.get(id);
  if(!state){state={confirmed:{...event},pending:null,key:editing.key};AVGOOGLE_SAVES.set(id,state);}
  const defaults={start:event.blocking_start||avGoogleDate(event.start).toISOString(),end:event.blocking_end||avGoogleDate(event.end).toISOString()};
  const body={calendar_id:event.calendar_id,...defaults,ignored:!!event.ignored,...changes};
  const optimistic=changes.reset?{...event,blocking_start:avGoogleDate(event.start).toISOString(),blocking_end:avGoogleDate(event.end).toISOString(),ignored:event.transparency==='transparent'||!!event.declined,adjusted:false}:{...event,blocking_start:body.start,blocking_end:body.end,ignored:body.ignored,adjusted:true};
  const update=value=>{
    state.latest=value;
    AVGOOGLE_UPDATES.set(id,{event:value,version:++AVGOOGLE_VERSION});
    if(AVGOOGLE_UPDATES.size>1000)AVGOOGLE_UPDATES.delete(AVGOOGLE_UPDATES.keys().next().value);
    if(AVGOOGLE.key.split('|')[0]===state.key.split('|')[0]){AVGOOGLE.events=AVGOOGLE.events.map(item=>item.id===event.id&&item.calendar_id===event.calendar_id?value:item);avGoogleRefresh();}
  };
  state.pending=body;update(optimistic);
  if(editing.sheet)closeSheet();
  AVGOOGLE_EDIT=null;
  if(state.running)return state.running;
  state.running=(async()=>{
    try{
      while(state.pending){
        const next=state.pending;state.pending=null;
        try{
          const response=await api('/api/availability/google-events/'+encodeURIComponent(event.id),{method:'PATCH',body:JSON.stringify(next)});
          const data=await response.json();if(!response.ok)throw Error(data.error||'保存できませんでした');
          state.confirmed=data.event||data;
          if(!state.pending)update(state.confirmed);
        }catch(error){
          if(!state.pending){update(state.confirmed);toast(error.message+'。最後に保存できた時間に戻しました');}
        }
      }
    }finally{AVGOOGLE_SAVES.delete(id);}
  })();
  return state.running;
}

function avGoogleResize(pointer,index,edge,rowHeight,band){
  if(pointer.button!==0)return;
  pointer.preventDefault();pointer.stopPropagation();
  AVGOOGLE_DRAG=true;
  const event=AVGOOGLE.events[index],origin=pointer.clientY,key=AVGOOGLE.key;
  const original=+new Date(edge==='start'?event.blocking_start:event.blocking_end);
  let moved=0;
  const originalTop=parseFloat(band.style.top),originalHeight=parseFloat(band.style.height);
  const move=next=>{moved=Math.round((next.clientY-origin)/rowHeight)*1800000;const pixels=moved/1800000*rowHeight;band.style.opacity='.55';band.style.top=(originalTop+(edge==='start'?pixels:0))+'px';band.style.height=Math.max(18,originalHeight+(edge==='start'?-pixels:pixels))+'px';};
  const cleanup=()=>{AVGOOGLE_DRAG=false;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);band.style.opacity='';};
  const cancel=()=>{cleanup();avGoogleRefresh();};
  const finish=()=>{
    cleanup();if(!moved||key!==AVGOOGLE.key){avGoogleRefresh();return;}
    pointer.target.dataset.dragged='1';
    const start=edge==='start'?original+moved:+new Date(event.blocking_start),end=edge==='end'?original+moved:+new Date(event.blocking_end);
    if(end<=start){avGooglePaint();toast('終了は開始より後にしてください');return;}
    AVGOOGLE_EDIT={event:{...event},key};
    avGoogleSave({start:new Date(start).toISOString(),end:new Date(end).toISOString(),ignored:false});
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);
}

/* ---- 確定した面談の帯 ----
   確定した面談は表では「－」で押せないが、Googleの予定と同じように帯としても重ねて出す。
   上下のつまみをドラッグすれば面談の長さ（30分単位）を変えられ、指を離したらその場で確定する
   （面談とGoogleの予定が同じ内容に変わる）。帯を押すと、開始と終了を数字で指定する画面が開く。
   帯そのものをドラッグして動かす操作は付けない（使いにくいとの指摘、2026-10-26）。
   予約スケジュールの予約は長さが予約ページで決まっているので、帯を押すと面談の詳細が開く */
const AV_IV_MIN=30*60000,AV_IV_MAX=240*60000,AV_WINDOW=15*3600000;
function avInterviewGeometry(cells,base,rowHeight,start,duration){
  for(const cell of cells){
    const begin=+new Date(cell.dataset.iso);
    if(start>=begin&&start+duration<=begin+AV_WINDOW){
      const rect=cell.getBoundingClientRect();
      return{top:rect.top-base.top+(start-begin)/1800000*rowHeight,height:duration/1800000*rowHeight,left:rect.left-base.left+1,width:rect.width-3};
    }
  }
  return null;
}
function avInterviewBands(overlay,cells,base,rowHeight){
  const now=Date.now();
  (DB.interviews||[]).filter(iv=>iv.staff_id===ME.id&&iv.status==='fixed'&&iv.confirmed_datetime&&+new Date(iv.confirmed_datetime)>now).forEach(iv=>{
    const start=+new Date(iv.confirmed_datetime),duration=(Number(iv.duration_min)||30)*60000;
    let geometry=avInterviewGeometry(cells,base,rowHeight,start,duration);
    if(!geometry){ // 表の範囲（9:00〜24:00）からはみ出す面談は、範囲内の部分だけ見せる
      for(const cell of cells){const begin=+new Date(cell.dataset.iso),s=Math.max(begin,start),e=Math.min(begin+AV_WINDOW,start+duration);if(e>s){geometry=avInterviewGeometry(cells,base,rowHeight,s,e-s);break;}}
    }
    if(!geometry)return;
    const label=ivInternName(iv)+'さん',booking=ivIsBooking(iv);
    const band=document.createElement('div');band.className='avg-band avg-iv'+(duration<=30*60000?' avg-iv-short':'');band.dataset.id=iv.id;
    band.style.cssText=`top:${geometry.top}px;height:${geometry.height}px;left:${geometry.left}px;width:${geometry.width}px`;
    band.innerHTML=(booking?'':`<button type="button" class="avg-resize avg-resize-start" aria-label="${esc(label)}の面談の開始をドラッグ"></button>`)+
      `<button type="button" class="avg-event-open" aria-label="${esc(label)}の面談の時間を変更"><strong>面談 ${esc(label)}</strong><span>${hm(iv.confirmed_datetime)}〜${hm(new Date(start+duration).toISOString())}</span></button>`+
      (booking?'':`<button type="button" class="avg-resize avg-resize-end" aria-label="${esc(label)}の面談の終了をドラッグ"></button>`);
    const body=band.querySelector('.avg-event-open');
    body.onclick=()=>{if(band.dataset.dragged){delete band.dataset.dragged;return;}if(booking)openInterview(iv.id);else avInterviewOpen(iv.id);};
    band.querySelectorAll('.avg-resize').forEach((handle,position)=>{
      handle.onpointerdown=pointer=>avInterviewDrag(pointer,iv,position===0?'start':'end',{cells,base,rowHeight,band});
    });
    overlay.append(band);
  });
}
function avInterviewDrag(pointer,iv,mode,{cells,base,rowHeight,band}){
  if(pointer.button!==0)return;
  pointer.preventDefault();
  pointer.stopPropagation();
  AVGOOGLE_DRAG=true;
  const originStart=+new Date(iv.confirmed_datetime),originDuration=(Number(iv.duration_min)||30)*60000;
  const startX=pointer.clientX,startY=pointer.clientY;
  let next={start:originStart,duration:originDuration},dragging=false;
  const compute=event=>{
    const steps=Math.round((event.clientY-startY)/rowHeight)*1800000;
    if(mode==='start')return{start:originStart+steps,duration:originDuration-steps};
    return{start:originStart,duration:originDuration+steps};
  };
  const valid=value=>value.start>Date.now()&&value.duration>=AV_IV_MIN&&value.duration<=AV_IV_MAX&&!!avInterviewGeometry(cells,base,rowHeight,value.start,value.duration);
  const move=event=>{
    if(!dragging&&Math.hypot(event.clientX-startX,event.clientY-startY)<5)return;
    dragging=true;band.dataset.dragged='1';band.style.opacity='.6';
    const candidate=compute(event);
    if(!valid(candidate))return;
    next=candidate;
    const g=avInterviewGeometry(cells,base,rowHeight,next.start,next.duration);
    band.style.top=g.top+'px';band.style.height=g.height+'px';band.style.left=g.left+'px';band.style.width=g.width+'px';
  };
  const cleanup=()=>{AVGOOGLE_DRAG=false;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);band.style.opacity='';};
  const cancel=()=>{cleanup();delete band.dataset.dragged;avGoogleRefresh();};
  const finish=()=>{
    cleanup();
    if(!dragging)return;
    if(next.start===originStart&&next.duration===originDuration){avGoogleRefresh();return;}
    avInterviewSave(iv,next.start,next.duration);
  };
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);
}
function avInterviewOpen(id){
  const iv=(DB.interviews||[]).find(item=>item.id===id);if(!iv)return;
  const start=new Date(iv.confirmed_datetime),end=new Date(+start+(Number(iv.duration_min)||30)*60000);
  openSheet(`<h2>面談 ${esc(ivInternName(iv))}さん</h2><p class="fine">確定済みの面談の時間です。変更すると面談とGoogleの予定が同じ内容に変わります。相手への連絡は別にお願いします。</p><label class="fl" for="avi-start">開始</label><input type="datetime-local" step="1800" id="avi-start" value="${avGoogleInput(start)}"><label class="fl" for="avi-end">終了</label><input type="datetime-local" step="1800" id="avi-end" value="${avGoogleInput(end)}"><p id="avi-error" class="field-err" role="alert"></p><div class="avg-actions"><button class="btn pri" onclick="avInterviewSaveInputs('${esc(id)}')">この時間に変更</button><button class="btn" onclick="openInterview('${esc(id)}')">面談の詳細を開く</button></div>`);
}
function avInterviewSaveInputs(id){
  const iv=(DB.interviews||[]).find(item=>item.id===id);if(!iv)return;
  const start=new Date(document.getElementById('avi-start').value),end=new Date(document.getElementById('avi-end').value);
  const error=message=>{const label=document.getElementById('avi-error');label.textContent=message;label.classList.add('show');};
  if(!Number.isFinite(+start)||!Number.isFinite(+end))return error('開始と終了を入力してください');
  if(start.getMinutes()%30||end.getMinutes()%30)return error('時刻は30分単位で指定してください');
  const duration=+end-+start;
  if(duration<AV_IV_MIN||duration>AV_IV_MAX)return error('面談の長さは30分から4時間までにしてください');
  if(+start<=Date.now())return error('未来の時間を指定してください');
  if(+start===+new Date(iv.confirmed_datetime)&&duration===(Number(iv.duration_min)||30)*60000)return error('時間が変わっていません');
  closeSheet();
  avInterviewSave(iv,+start,duration);
}
async function avInterviewSave(iv,start,duration){
  const booking=ivIsBooking(iv),startIso=new Date(start).toISOString();
  try{
    const result=await fsJSON('/api/interviews/'+encodeURIComponent(iv.id)+(booking?'/reschedule-booking':''),{method:booking?'POST':'PATCH',
      body:JSON.stringify(booking?{start:startIso}:{status:'fixed',confirmed_datetime:startIso,duration_min:duration/60000})});
    applyInterview(result.interview);
    toast(`${ivInternName(iv)}さんの面談を ${fmtDT(startIso)}〜${hm(new Date(start+duration).toISOString())} に変更しました。相手へも連絡してください`);
  }catch(failure){toast(failure.message);}
  avGoogleRefresh();
}

if(typeof window!=='undefined')window.addEventListener('resize',()=>avGooglePaint());
