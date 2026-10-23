function reqCandidateState(){
  if(!REQFORM.candidates){
    const first=new Date(),last=new Date(first);last.setDate(last.getDate()+6);
    REQFORM.candidates={from:ymd(first),to:ymd(last),duration:30,open:false,slots:null,loading:false,error:''};
  }
  return REQFORM.candidates;
}
function reqToggleCandidates(){
  const state=reqCandidateState();state.open=!state.open;renderRequestForm(true);
}
function reqCandidateField(field,value){
  const state=reqCandidateState();state[field]=field==='duration'?Number(value):value;
  state.slots=null;state.error='';
  renderRequestForm(true);
}
function reqCandidateHTML(){
  const state=reqCandidateState();
  const header=`<button type="button" class="btn block" aria-expanded="${state.open}" onclick="reqToggleCandidates()">${ic('clock')}自分の空き時間から候補を選ぶ</button>`;
  if(!state.open)return `<div class="req-free">${header}</div>`;
  const days={};
  (state.slots||[]).forEach((slot,index)=>{(days[slot.date]||(days[slot.date]=[])).push({slot,index});});
  const results=Object.entries(days).map(([date,entries])=>`<div class="req-free-day"><b>${esc(reqDateLabel(date))}</b><div class="req-free-times">${entries.map(({slot,index})=>{
    const selected=REQFORM.opts.some(option=>option.date===slot.date&&option.t1===slot.time);
    return `<button type="button" class="req-free-slot${selected?' selected':''}" aria-pressed="${selected}" aria-label="${esc(reqDateLabel(date)+' '+slot.time)}" onclick="reqToggleCandidate(${index})">${esc(slot.time)}</button>`;
  }).join('')}</div></div>`).join('');
  return `<div class="req-free">${header}<div class="req-free-panel">
    <p class="fine">受けられない時間・Googleの予定・確定した面談を除きます。選んだ候補は、送信前に変更できます。</p>
    <div class="req-free-fields"><label>開始日<input type="date" aria-label="空き候補の開始日" min="${ymd(new Date())}" value="${esc(state.from)}" onchange="reqCandidateField('from',this.value)"></label>
    <label>終了日<input type="date" aria-label="空き候補の終了日" min="${esc(state.from)}" value="${esc(state.to)}" onchange="reqCandidateField('to',this.value)"></label>
    <label>必要な空き時間<select aria-label="候補の所要時間" onchange="reqCandidateField('duration',this.value)">${[15,30,45,60,90,120].map(duration=>`<option value="${duration}"${state.duration===duration?' selected':''}>${duration}分</option>`).join('')}</select></label></div>
    <button type="button" class="btn" onclick="reqLoadCandidates()"${state.loading?' disabled':''}>${state.loading?'確認しています…':'空きを表示'}</button>
    <p class="fine" role="status">${esc(state.error||(state.slots?`${state.duration}分続けて空いている開始時刻です。候補は仮押さえされません。`: '期間は21日以内で指定してください。'))}</p>
    <div class="req-free-results">${results||((state.slots&&!state.loading)?'<p class="fine">この条件で選べる空き時間はありません。</p>':'')}</div>
    </div></div>`;
}
async function reqLoadCandidates(){
  const form=REQFORM,state=reqCandidateState();
  if(state.loading)return;
  state.loading=true;state.error='';state.slots=null;
  const query=new URLSearchParams({from:state.from,to:state.to,duration:String(state.duration)}).toString();
  renderRequestForm(true);
  try{
    const data=await fsJSON('/api/availability/candidates?'+query);
    if(REQFORM!==form||new URLSearchParams({from:state.from,to:state.to,duration:String(state.duration)}).toString()!==query)return;
    state.slots=data.slots;
  }catch(error){
    if(REQFORM===form)state.error=error.message;
  }finally{
    state.loading=false;
    if(REQFORM===form&&document.getElementById('reqSubj'))renderRequestForm(true);
  }
}
function reqToggleCandidate(index){
  const slot=(reqCandidateState().slots||[])[index];
  if(!slot)return;
  const existing=REQFORM.opts.findIndex(option=>option.date===slot.date&&option.t1===slot.time);
  if(existing>=0)REQFORM.opts.splice(existing,1);
  else{
    if(REQFORM.opts.length>=100){toast('候補は100件以内で選んでください');return;}
    REQFORM.opts.push({date:slot.date,t1:slot.time});
    REQFORM.addTime=slot.time;
  }
  reqSortOptions();renderRequestForm(true);
}
