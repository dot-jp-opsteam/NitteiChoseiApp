/* 公開ページ・スタッフ画面共通の表。表示する文字はDOMのtextContentを使う。 */
(function(root){
 'use strict';const M=root.TallyModel;
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const button=(text,action,cls='btn ghost')=>{const n=el('button',cls,text);n.type='button';n.addEventListener('click',action);return n;};
 function cellLabel(config,id){const [r,c]=id.split(':');return (config.columns.find(x=>x.id===c)?.label||'')+' / '+(config.rows.find(x=>x.id===r)?.label||'');}
 function grid(container,config,makeCell){
  const wrap=el('div','tly-scroll'),table=el('table','tly-table');table.setAttribute('aria-label',config.title||'日程調整の表');const head=el('thead'),tr=el('tr');tr.append(el('th','tly-corner','時間 / 候補'));
  const cols=config.columns.filter(x=>x.active);for(const c of cols){const th=el('th','',c.label);th.scope='col';tr.append(th);}head.append(tr);table.append(head);
  const body=el('tbody');for(const r of config.rows.filter(x=>x.active)){const row=el('tr'),th=el('th','',r.label);th.scope='row';row.append(th);for(const c of cols){const td=el('td');td.append(makeCell(M.cellId(r.id,c.id)));row.append(td);}body.append(row);}table.append(body);wrap.append(table);container.append(wrap);return wrap;
 }
 function renderSummary(container,config,responses,options={}){
  container.replaceChildren();let ids=options.selectedIds===undefined?responses.map(p=>p.id):[...options.selectedIds];const tools=el('div','tly-summary-tools'),count=el('p','tly-muted'),members=el('fieldset','tly-members'),legend=el('legend','','集計する人');members.append(legend);
  const person=el('div','tly-person-detail');person.hidden=true;
  tools.append(count,button('全員を選ぶ',()=>{ids=responses.map(p=>p.id);refresh();options.onFilter?.([...ids]);}));container.append(tools,members,person);
  const boxes=new Map(),names=new Map();for(const p of responses)names.set(p.name,(names.get(p.name)||0)+1);
  responses.forEach((p,index)=>{
   const row=el('div','tly-member'),label=el('label'),cb=el('input');cb.type='checkbox';cb.checked=ids.includes(p.id);cb.setAttribute('aria-label','集計対象 '+p.name+' #'+(index+1));boxes.set(p.id,cb);
   const display=p.name+(names.get(p.name)>1?' #'+(index+1):'');label.append(cb,document.createTextNode('集計'));cb.addEventListener('change',()=>{ids=responses.filter(x=>boxes.get(x.id).checked).map(x=>x.id);refresh();options.onFilter?.([...ids]);});
   const name=button(display,()=>{person.replaceChildren(el('h3','',display+'さんの回答'),el('p','tly-pre',p.note||'コメントなし'));const selected=new Set(p.selected),answered=new Set(p.answered),list=el('ul','tly-person-slots');for(const id of M.activeCells(config))list.append(el('li','',(selected.has(id)?'○ ':answered.has(id)?'× ':'未回答 ')+cellLabel(config,id)));person.append(list,button('閉じる',()=>person.hidden=true));person.hidden=false;});name.className='tly-name';row.append(label,name);members.append(row);
  });
  const cellButtons=new Map();grid(container,config,id=>{const b=button('',()=>options.onInspect?.(id),'tly-cell');b.setAttribute('aria-label',cellLabel(config,id));cellButtons.set(id,b);return b;});
  const key=el('p','tly-muted','数字は参加できる人数です。★は最多の候補。マスを押すと回答者を確認できます。');container.append(key);
  function refresh(){const result=M.tally(config,responses,ids),best=new Set(result.best);count.textContent=result.total?result.total+'人を集計 / 回答 '+responses.length+'人':'集計対象を選んでください';for(const [id,b] of cellButtons){const n=result.cells[id].count,shade=n===0?0:Math.max(1,Math.ceil(4*n/result.total));b.className='tly-cell tly-n'+shade+(best.has(id)?' tly-best':'');b.textContent=(best.has(id)?'★ ':'')+n+' / '+result.total;b.setAttribute('aria-label',cellLabel(config,id)+'、'+n+'人参加可能、対象'+result.total+'人'+(best.has(id)?'、最多候補':''));}for(const [id,cb] of boxes)cb.checked=ids.includes(id);}
  refresh();return ()=>container.replaceChildren();
 }
 function renderEditor(container,config,options={}){
  container.replaceChildren();const valid=new Set(M.activeCells(config));let selected=(options.selected||[]).filter(x=>valid.has(x)),stroke=null,pointer=null,timer=null,drag=false,moved=false,origin=null,startCell=null;const buttons=new Map();
  const wrap=grid(container,config,id=>{const b=el('button','tly-cell tly-choice','');b.type='button';b.dataset.cell=id;b.setAttribute('aria-label',cellLabel(config,id));b.addEventListener('click',e=>{if(e.detail===0){selected=M.beginStroke(selected,id).selected;paint();options.onChange?.([...selected]);}});buttons.set(id,b);return b;});
  function paint(){const set=new Set(selected);for(const [id,b] of buttons){b.setAttribute('aria-pressed',String(set.has(id)));b.textContent=set.has(id)?'○':'—';b.classList.toggle('tly-selected',set.has(id));}}
  function begin(id){stroke=M.beginStroke(selected,id);selected=stroke.selected;drag=true;paint();options.onChange?.([...selected]);}
  function finish(e){if(pointer===null||e.pointerId!==pointer)return;clearTimeout(timer);if(e.type==='pointerup'&&!drag&&!moved&&startCell)begin(startCell);pointer=null;stroke=null;drag=false;wrap.classList.remove('tly-dragging');}
  function down(e){if(pointer!==null||e.button!==0)return;const b=e.target.closest('button[data-cell]');if(!b||!wrap.contains(b))return;pointer=e.pointerId;origin={x:e.clientX,y:e.clientY};startCell=b.dataset.cell;moved=false;drag=false;if(e.pointerType==='touch'){timer=setTimeout(()=>{if(pointer!==null&&!moved){begin(startCell);wrap.classList.add('tly-dragging');}},220);}else{e.preventDefault();b.focus();begin(startCell);}}
  function move(e){if(e.pointerId!==pointer)return;if(!drag){if(Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>8){moved=true;clearTimeout(timer);}return;}if(e.cancelable)e.preventDefault();const b=document.elementFromPoint(e.clientX,e.clientY)?.closest('button[data-cell]');if(b&&wrap.contains(b)){stroke=M.visitStroke(stroke,b.dataset.cell);selected=stroke.selected;paint();options.onChange?.([...selected]);}}
  function touchMove(e){if(drag&&e.cancelable)e.preventDefault();}
  wrap.addEventListener('pointerdown',down);document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',finish);document.addEventListener('pointercancel',finish);wrap.addEventListener('touchmove',touchMove,{passive:false});paint();
  return {setSelected(value){selected=value.filter(x=>valid.has(x));paint();},getSelected:()=>[...selected],destroy(){clearTimeout(timer);pointer=null;document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',finish);document.removeEventListener('pointercancel',finish);wrap.removeEventListener('pointerdown',down);wrap.removeEventListener('touchmove',touchMove);container.replaceChildren();}};
 }
 root.TallyUI={renderSummary,renderEditor,cellLabel};
})(globalThis);
