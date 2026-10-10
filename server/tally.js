/* 表で日程調整: Nodeとブラウザで共有する純粋なモデル。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TallyModel=api;})(globalThis,function(){
  'use strict';
  const bad=error=>({ok:false,code:'invalid',error});
  const cellId=(r,c)=>r+':'+c;
  const activeCells=c=>c.rows.filter(r=>r.active).flatMap(r=>c.columns.filter(col=>col.active).map(col=>cellId(r.id,col.id)));
  const str=(s,max,required=false)=>typeof s==='string'&&s.length<=max&&(!required||s.trim().length>0);
  function normalizeBoard(input,previous=null){
    if(!input||!str(input.title,100,true)||!str(input.description,2000)||!['calendar','timetable','custom'].includes(input.template))return bad('件名・説明・テンプレートを確認してください。');
    if(previous&&input.template!==previous.template)return bad('保存後はテンプレートを変更できません。行・列を編集してください。');
    function axes(items,old,max){
      if(!Array.isArray(items)||items.length>max)return null;
      const ids=new Set(),out=[];
      for(const a of items){if(!a||typeof a.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(a.id)||ids.has(a.id)||!str(a.label,40,true)||typeof a.active!=='boolean')return null;ids.add(a.id);out.push({id:a.id,label:a.label.trim(),active:a.active});}
      for(const a of old||[])if(!ids.has(a.id))out.push({id:a.id,label:a.label,active:false});
      return out.length<=max&&out.some(a=>a.active)?out:null;
    }
    const rows=axes(input.rows,previous&&previous.rows,48),columns=axes(input.columns,previous&&previous.columns,31);
    if(!rows||!columns)return bad('行・列の名前、ID、上限を確認してください。有効な行・列が1つ以上必要です。');
    return {ok:true,config:{title:input.title.trim(),description:input.description.trim(),template:input.template,rows,columns}};
  }
  const time=s=>{if(typeof s!=='string'||!/^\d{2}:\d{2}$/.test(s))return null;const [h,m]=s.split(':').map(Number);return m<60&&h<=24&&(h<24||m===0)?h*60+m:null;};
  const fmt=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  function makeTemplate(input,idFactory){
    const config={title:'',description:'',template:input.kind,rows:[],columns:[]},tappy=input.style==='tappy';
    const add=(axis,label)=>config[axis].push({id:idFactory(axis==='rows'?'r_':'c_'),label,active:true});
    if(input.kind==='calendar'){
      const s=time(input.start),e=time(input.end),d=new Date(input.startDate+'T00:00:00Z');
      if(typeof input.startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==input.startDate||!Number.isInteger(input.days)||input.days<1||input.days>31||s===null||e===null||s>=e||![30,60].includes(input.step)||(e-s)%input.step!==0)return bad('日付・日数・時間を確認してください。終了まで間隔で割り切れる設定にしてください。');
      for(let i=0;i<input.days;i++){const at=new Date(d.getTime()+i*86400000);add('columns',tappy?(at.getUTCMonth()+1)+'/'+at.getUTCDate():at.getUTCFullYear()+'/'+(at.getUTCMonth()+1)+'/'+at.getUTCDate()+'（'+'日月火水木金土'[at.getUTCDay()]+'）');}
      if(tappy&&(e-s)/input.step+1>48)return bad('縦の項目は48件までです。');
      for(let t=s;t<(tappy?e+1:e);t+=input.step)add('rows',tappy?fmt(t):fmt(t)+'–'+fmt(t+input.step));
    }else if(input.kind==='timetable'){
      if(!Number.isInteger(input.periods)||input.periods<1||input.periods>10)return bad('コマ数は1〜10にしてください。');
      const weekdays=tappy?['Mon','Tue','Wed','Thu','Fri','Sat','Sun']:['月','火','水','木','金','土','日'];
      for(const label of weekdays.slice(0,input.weekend?7:5))add('columns',tappy?label:label+'曜');
      for(let i=1;i<=input.periods;i++){add('rows',tappy?String(i):i+'限');if(!tappy&&input.lunch&&i===2)add('rows','昼休み');}
      if(tappy&&input.lunch)add('rows','昼休み');
    }else if(input.kind==='custom'){
      for(const label of ['午前','午後'])add('rows',label);for(const label of ['候補1','候補2'])add('columns',label);
    }else return bad('テンプレートを選んでください。');
    return {ok:true,config};
  }
  function normalizeResponse(input,config){
    if(!input||!str(input.name,80,true)||!str(input.note===undefined?'':input.note,500)||!Array.isArray(input.selected)||input.selected.length>1488)return bad('名前・コメント・選択したマスを確認してください。');
    const answered=activeCells(config),valid=new Set(answered);
    if(input.selected.some(id=>typeof id!=='string'||!valid.has(id)))return bad('表が変更されたか、存在しないマスが選択されています。');
    return {ok:true,data:{name:input.name.trim(),note:(input.note||'').trim(),selected:[...new Set(input.selected)],answered}};
  }
  function tally(config,responses,selectedIds=null){
    const filter=selectedIds===null?null:new Set(selectedIds),people=responses.filter(p=>filter===null||filter.has(p.id));
    const cells=Object.create(null);for(const id of activeCells(config))cells[id]={count:0,yes:[],no:[],unknown:[]};
    for(const p of people){const chosen=new Set(p.selected),answered=new Set(p.answered);for(const [id,c] of Object.entries(cells)){if(chosen.has(id)&&answered.has(id)){c.count++;c.yes.push(p.id);}else if(answered.has(id))c.no.push(p.id);else c.unknown.push(p.id);}}
    const max=Math.max(0,...Object.values(cells).map(c=>c.count));
    return {total:people.length,cells,best:max>0?Object.keys(cells).filter(id=>cells[id].count===max):[]};
  }
  function visitStroke(state,cell){
    if(state.visited.includes(cell))return {selected:[...state.selected],target:state.target,visited:[...state.visited]};
    const selected=state.selected.filter(id=>id!==cell);if(state.target)selected.push(cell);
    return {selected,target:state.target,visited:[...state.visited,cell]};
  }
  const beginStroke=(selected,cell)=>visitStroke({selected:[...selected],target:!selected.includes(cell),visited:[]},cell);
  return {cellId,activeCells,makeTemplate,normalizeBoard,normalizeResponse,tally,beginStroke,visitStroke};
});
