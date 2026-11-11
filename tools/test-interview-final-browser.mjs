import assert from 'node:assert/strict';
import fs from 'node:fs';
const BASE='http://localhost:8123',TOKEN='e2etoken_staff';
const headers={Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'};
async function json(path,method='GET',body){const r=await fetch(BASE+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});assert.equal(r.ok,true,await r.clone().text());return r.json();}
export async function runInterviewFinalBrowserTests(browser){
 let checks=0;const ok=(value,message)=>{assert.ok(value,message);checks++;};
 fs.mkdirSync('.superpowers/sol-review',{recursive:true});
 const db=await json('/api/db'),sample=db.interviews.find(i=>i.intern_name==='画面確認 希望時間帯');assert.ok(sample);
 const invite=await json('/api/staff/intern-invite-url');
 for(const width of [1280,320,390,430]){
  const context=await browser.newContext({viewport:{width,height:1100},isMobile:width<500,hasTouch:width<500,timezoneId:'Asia/Tokyo'});
 await context.addCookies([{name:'ops_design_v1',value:'latest',url:BASE}]);
  try{const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(BASE+'/__local-review');await page.getByRole('button',{name:'画面確認 希望時間帯さんの面談申請を開く',exact:true}).click();
   await page.locator('.ivc-page').waitFor();await page.locator('#ivc-confirm:not([disabled])').waitFor();
   ok(await page.locator('.ivc-date').count()===2,'日付カード2件');
   ok(await page.locator('.ivc-date').first().locator('.ivc-date-time').count()===2,'同日の希望を2行表示');
   ok(await page.locator('.ivc-date[aria-pressed=true]').count()===1,'単一日選択');
   await page.locator('.ivc-band[data-index="1"]').press('Enter');
   ok((await page.locator('.ivc-confirm-panel').innerText()).includes('第2希望'),'時間帯の順位を表示');
   const values=await page.locator('#ivc-start option').evaluateAll(list=>list.map(o=>o.value));
   ok(values.length===4&&values.every((slot,index)=>slot===sample.preference_groups[1].slots[index]),'2時間の希望を4つの30分枠から選べる');
   ok((await page.locator('.ivc-duration').innerText()).includes('30分'),'面談の所要時間は30分');
   await page.locator('#ivc-start').selectOption(values.at(-1));
   ok((await page.locator('#ivc-end').innerText())==='18:00','終了は自動計算');
   await page.locator('.ivc-date').nth(1).click();await page.locator('#ivc-confirm:not([disabled])').waitFor();
   ok((await page.locator('.ivc-confirm-panel').innerText()).includes('第3希望'),'別日へ切替');
   await page.locator('.ivc-date').first().click();await page.locator('#ivc-confirm:not([disabled])').waitFor();
   ok(await page.evaluate(()=>document.querySelector('#scrim').scrollWidth<=document.querySelector('#scrim').clientWidth),'横スクロールなし '+width);
   ok(await page.locator('.ivc-time-table').evaluate(e=>getComputedStyle(e).overflowY==='visible'),'表の内部スクロールなし');
   ok(await page.locator('#sheet').evaluate(e=>getComputedStyle(e).overflowY==='visible'),'シートの内部スクロールなし');
   await page.route('**/api/my-calendar/events?**',route=>route.fulfill({json:{events:[],connected:true,error:'failed'}}));
   await page.evaluate(()=>ivcRetry());await page.getByText('予定を取得できませんでした。予定がないことは確認できていません。',{exact:false}).waitFor();
   ok(await page.locator('#ivc-confirm').isDisabled(),'Google取得失敗を空き扱いしない');
   await page.unroute('**/api/my-calendar/events?**');await page.getByRole('button',{name:'再取得',exact:true}).click();await page.locator('#ivc-confirm:not([disabled])').waitFor();
   await page.locator('.ivc-other summary').focus();await page.keyboard.press('Tab');
   ok(await page.locator('.ivc-heading button').evaluate(e=>e===document.activeElement),'閉じた詳細欄の末尾から先頭へフォーカスを戻す');
   await page.keyboard.press('Shift+Tab');
   ok(await page.locator('.ivc-other summary').evaluate(e=>e===document.activeElement),'先頭から末尾へ逆移動できる');
   await page.locator('#scrim').evaluate(e=>e.scrollTop=0);
   await page.screenshot({path:'.superpowers/sol-review/confirm-'+width+'.png',fullPage:true});
   if(width===390){await page.locator('.ivc-confirm-panel').scrollIntoViewIfNeeded();await page.screenshot({path:'.superpowers/sol-review/confirm-390-time.png'});}
   ok(errors.length===0,'JSエラーなし '+width);
  }finally{await context.close();}
 }
 // 新規の架空申請で確定時の応答喪失・同時確定を検証。見せるサンプルは残す。
 const title='確定の再試行 '+Date.now();
 const future=await json('/api/apply/'+new URL(invite.url).pathname.split('/').pop()+'/slots?week=2');
 let run;
 for(const col of future.grid){const open=col.filter(c=>c.state==='ok').map(c=>c.iso);for(let i=0;i<=open.length-8;i++){const part=open.slice(i,i+8);if(part.every((s,j)=>!j||+new Date(s)-new Date(part[j-1])===1800000)){run=part;break;}}if(run)break;}
 assert.ok(run,'確定テストの空き時間');
 const freshGroups=[{slots:run.slice(0,4)},{slots:run.slice(4)}];
 await json('/api/apply/'+new URL(invite.url).pathname.split('/').pop(),'POST',{name:title,choices:freshGroups.flatMap(g=>g.slots),preference_groups:freshGroups,choice_mode:'slot',duration_min:60});
 const iv=(await json('/api/db')).interviews.find(i=>i.intern_name===title);
 const context=await browser.newContext({viewport:{width:1280,height:1000},timezoneId:'Asia/Tokyo'});
 await context.addCookies([{name:'ops_design_v1',value:'latest',url:BASE}]);
 try{const page=await context.newPage();await page.goto(BASE+'/__local-review');await page.getByRole('button',{name:title+'さんの面談申請を開く',exact:true}).click();await page.locator('#ivc-confirm:not([disabled])').waitFor();await page.locator('.ivc-date').first().click();await page.locator('#ivc-confirm:not([disabled])').waitFor();await page.locator('.ivc-band[data-index="1"]').press('Enter');
  let writes=0,lost=true;await page.route('**/api/interviews/'+iv.id,async route=>{writes++;if(lost){lost=false;await route.fetch();await route.abort();}else await route.continue();});
  await page.locator('#ivc-confirm').click();await page.locator('#ivc-save-error').filter({hasText:'通信に失敗'}).waitFor();
  ok((await page.locator('.ivc-confirm-panel').innerText()).includes('第2希望'),'確定失敗でも選択を保持');await page.locator('#ivc-confirm').click();await page.getByText('面談日程を確定しました',{exact:true}).waitFor();
  const saved=(await json('/api/db')).interviews.find(i=>i.id===iv.id);ok(saved.confirmed_preference===2&&saved.duration_min===30,'確定後にも順位と30分を保持');ok(writes===2,'失敗と再試行の2リクエストだけ');
  const race=await fetch(BASE+'/api/interviews/'+iv.id,{method:'PATCH',headers,body:JSON.stringify({status:'fixed',confirmed_datetime:sample.choices[0],preference_index:0,expected_status:'applied'})});ok(race.status===409,'処理済みの申請を別日時で上書きしない');
 }finally{await context.close();}
 // 公開申請：現行のカレンダー・順位の持ち手を維持。失敗時も選択を失わない。
 const publicContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Tokyo'});
 await publicContext.addCookies([{name:'ops_design_v1',value:'latest',url:BASE}]);
 try{const page=await publicContext.newPage();const name='申請の再試行 '+Date.now();await page.goto(invite.url+'?d=60');await page.locator('td.bt-c.ok').first().waitFor();await page.locator('#applyname').fill(name);
  const cells=page.locator('td.bt-c.ok');await cells.nth(0).click();await cells.nth(3).click();
  ok(await page.locator('input[type=time]').count()===0,'却下された時刻編集欄なし');
  const before=await page.evaluate(()=>APPLY.sel.slice());await page.locator('.ap-rank-handle').nth(1).press('ArrowUp');
  ok(await page.evaluate(s=>APPLY.sel[0]===s,before[1]),'キーボードで順位変更');
  const handle=page.locator('.ap-rank-handle').first();await handle.scrollIntoViewIfNeeded();const first=await handle.boundingBox(),last=await page.locator('.ap-rank-handle').last().boundingBox();
  await page.mouse.move(first.x+first.width/2,first.y+first.height/2);await page.mouse.down();await page.mouse.move(last.x+last.width/2,last.y+last.height+6,{steps:8});await page.mouse.up();
  ok(await page.evaluate(s=>APPLY.sel[0]===s,before[0]),'持ち手で順位を戻す');
  ok(await page.evaluate(()=>new Set(APPLY.sel).size===APPLY.sel.length),'時間帯の二重選択なし');
  await page.locator('#applybtn').click();const selected=await page.evaluate(()=>APPLY.sel.slice());
  let phase=0,sentKey;await page.route('**/api/apply/*',async route=>{if(route.request().method()!=='POST')return route.continue();const body=route.request().postDataJSON();if(!sentKey)sentKey=body.submission_key;ok(body.submission_key===sentKey,'失敗後も同じ再送キー');phase++;if(phase===1)return route.fulfill({status:500,json:{error:'検証用の通信障害'}});if(phase===2){await route.fetch();return route.abort();}return route.continue();});
  await page.locator('#applybtn').click();await page.locator('.ap-send-error').waitFor();
  ok(JSON.stringify(await page.evaluate(()=>APPLY.sel))===JSON.stringify(selected),'500でも日時保持');ok(await page.evaluate(n=>APPLY.name===n,name),'500でも名前保持');
  await page.locator('#applybtn').click();await page.locator('.ap-send-error').waitFor();await page.locator('#applybtn:not([disabled])').waitFor();await page.locator('#applybtn').click();await page.getByText('申請した内容（控え）',{exact:true}).waitFor();
  ok(await page.getByRole('button',{name:/回答を修正|書き直す/}).count()===0,'送信後本人編集なし');
  const stored=(await json('/api/db')).interviews.filter(i=>i.intern_name===name);ok(stored.length===1,'応答喪失後も二重登録なし');ok(JSON.stringify(stored[0].choices)===JSON.stringify(selected),'送信した順位を保存');
  await page.screenshot({path:'.superpowers/sol-review/apply-done.png',fullPage:true});
 }finally{await publicContext.close();}
 return {checks,status:'全成功'};
}

export async function runInterviewTouchTests(browser){
 const invite=await json('/api/staff/intern-invite-url');
 const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Tokyo'});
 await ctx.addCookies([{name:'ops_design_v1',value:'latest',url:BASE}]);
 let checks=0;const ok=(value,message)=>{assert.ok(value,message);checks++;};
 try{
  const page=await ctx.newPage();await page.goto(invite.url);await page.locator('td.bt-c.ok').first().waitFor();await page.locator('#applyname').fill('長押しの検査');
  const slots=await page.evaluate(()=>{const list=Array.from(document.querySelectorAll('td.bt-c.ok')).map(e=>e.dataset.iso).sort((a,b)=>new Date(a)-new Date(b));for(let i=0;i<list.length-2;i++)if(+new Date(list[i+1])-new Date(list[i])===1800000&&+new Date(list[i+2])-new Date(list[i+1])===1800000&&dayKey(list[i])===dayKey(list[i+2]))return list.slice(i,i+3);return [];});assert.equal(slots.length,3);
  const cell=iso=>page.locator('td[data-iso="'+iso+'"]');await cell(slots[0]).scrollIntoViewIfNeeded();
  let start=await cell(slots[0]).boundingBox();const center=b=>({x:b.x+b.width/2,y:b.y+b.height/2});
  await page.touchscreen.tap(center(start).x,center(start).y);ok(await page.evaluate(()=>APPLY.sel.length===1),'短いタップで1枠');await page.touchscreen.tap(center(start).x,center(start).y);ok(await page.evaluate(()=>APPLY.sel.length===0),'再タップで解除・重複なし');
  const client=await ctx.newCDPSession(page);const end=await cell(slots[2]).boundingBox();
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center(start)]});await new Promise(r=>setTimeout(r,90));
  await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[center(end)]});await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  ok(await page.evaluate(()=>APPLY.sel.length===3&&new Set(APPLY.sel).size===3),'長押しなぞりで連続3枠');
  const text=page.locator('.selsummary .sr .st').first();await text.scrollIntoViewIfNeeded();start=await text.boundingBox();const before=await page.evaluate(()=>({slots:APPLY.sel.slice(),y:scrollY}));const point=center(start);
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  for(let i=1;i<=5;i++)await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y+16*i}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  ok(await page.evaluate(old=>JSON.stringify(APPLY.sel)===JSON.stringify(old.slots)&&SELDRAG===null,before),'希望本文のスクロールで順位ドラッグしない');
  await page.locator('#applybtn').click();await page.route('**/api/apply/*',async route=>route.request().method()==='POST'?route.fulfill({status:409,json:{error:'枠が埋まりました。入力は保持しています',unavailable_choices:[slots[0]]}}):route.continue());
  await page.locator('#applybtn').click();await page.locator('.ap-unavailable').waitFor();ok(await page.evaluate(()=>APPLY.sel.length===3&&APPLY.name==='長押しの検査'),'枠が埋まった場合も入力を保持');
  await page.locator('#applybtn').click();ok(await page.evaluate(()=>APPLY.step==='form'),'未解消の不可枠があれば確認へ進めない');
  await page.screenshot({path:'.superpowers/sol-review/apply-unavailable.png',fullPage:true});
  return {touchChecks:checks,status:'全成功'};
 }finally{await ctx.close();}
}
