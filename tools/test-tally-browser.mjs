/* Playwrightのpageを受け取る実ブラウザ回帰検査。
   tools/test-tally-e2e.mjs --serve の専用localhost:8129サーバーで実行する。
   import {runTallyBrowserTests} from './test-tally-browser.mjs'; await runTallyBrowserTests(page);
   本番URLを渡しても実行しない。Playwrightは開発用の実行環境を利用する。 */
export async function runTallyBrowserTests(page){
 const base='http://localhost:8129',results=[];
 const cfg={title:'再送・競合回帰検査',description:'',template:'custom',rows:[{id:'r1',label:'午前',active:true}],columns:[{id:'c1',label:'月曜',active:true},{id:'c2',label:'火曜',active:true}]};
 const create=async()=>{const r=await page.request.post(base+'/api/tally-boards',{headers:{Authorization:'Bearer tly_token_a'},data:{config:cfg}});if(r.status()!==200)throw Error('検証用の表作成に失敗');return (await r.json()).board;};
 const check=(ok,message)=>{if(!ok)throw Error(message);};
 async function test(label,fn){const ctx=await page.context().browser().newContext();try{await fn(await ctx.newPage());results.push({label,ok:true});}catch(e){results.push({label,ok:false,error:e.message});}finally{await ctx.close();}}
 for(const status of [429,500])await test('応答喪失→再試行'+status+'→再々試行でも同じ回答',async p=>{
  const b=await create();await p.goto(b.url);await p.getByRole('button',{name:'あなたの予定を登録',exact:true}).click();await p.locator('#name').fill('再送検査');await p.locator('#editor button').first().click();let attempt=0;const keys=[];
  await p.route('**/api/tally/*/responses',async route=>{attempt++;keys.push(route.request().postDataJSON().submissionKey);if(attempt===1){await route.fetch();await route.abort('failed');}else if(attempt===2)await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:'一時的なエラー'})});else await route.continue();});
  await p.locator('#submit').click();await p.waitForFunction(()=>document.querySelector('#submit').textContent==='前回の送信結果を確認する');await p.locator('#submit').click();await p.waitForFunction(()=>!document.querySelector('#submit').disabled);await p.locator('#submit').click();await p.locator('#receipt a').waitFor();
  const data=await (await p.request.get(base+'/api/tally/'+b.token)).json();check(data.responses.length===1,'二重登録: '+data.responses.length+'件');check(keys.length===3&&new Set(keys).size===1,'送信キーを変更している');
 });
 await test('表と本人回答が両方変更されても古い入力で上書きしない',async p=>{
  const b=await create();await p.goto(b.url);await p.getByRole('button',{name:'あなたの予定を登録',exact:true}).click();await p.locator('#name').fill('古い名前');await p.locator('#editor button').first().click();await p.locator('#submit').click();await p.locator('#receipt a').waitFor();const path=await p.locator('#receipt a').getAttribute('href'),apiPath=path.replace('/t/','/api/tally/');await p.goto(base+path);await p.locator('#editor button').first().waitFor();
  const own=await (await p.request.get(base+apiPath)).json();await p.request.put(base+apiPath,{data:{name:'新しい名前',note:'別画面の最新回答',selected:['r1:c2'],boardRevision:1,responseRevision:own.response.revision}});await p.request.put(base+'/api/tally-boards/'+b.id,{headers:{Authorization:'Bearer tly_token_a'},data:{config:{...cfg,description:'表も更新'},active:true,revision:1}});
  await p.locator('#submit').click();await p.getByRole('button',{name:'入力を保持して最新の表を読み込む'}).click();await p.waitForFunction(()=>document.querySelector('#form-status').textContent.includes('最新の表を読み込みました')||document.querySelector('#form-status').textContent.includes('回答が変更'));
  await p.locator('#submit').click();const current=await (await p.request.get(base+apiPath)).json();check(current.response.name==='新しい名前'&&current.response.note==='別画面の最新回答'&&JSON.stringify(current.response.selected)==='["r1:c2"]','最新の本人回答を古い内容で上書きした');
  await p.getByRole('button',{name:'現在の入力を破棄して最新の回答を確認する'}).click();await p.waitForFunction(()=>document.querySelector('#note').value==='別画面の最新回答');check(await p.locator('#name').inputValue()==='新しい名前','最新回答の明示再読込失敗');
 });
 return results;
}
