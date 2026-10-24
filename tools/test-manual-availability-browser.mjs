export async function runManualAvailabilityBrowserTests(page){
  const results=[];
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const patches=[];
  let release,hold=new Promise(resolve=>{release=resolve;}),fail=false,loseReply=false,puts=0;
  const watch=request=>{if(request.method()==='PUT'&&new URL(request.url()).pathname==='/api/db')puts++;};
  page.on('request',watch);
  await page.route('**/api/availability/google-events**',route=>route.fulfill({json:{connected:true,events:[]}}));
  await page.route('**/api/availability/blocks',async route=>{
    patches.push(route.request().postDataJSON());
    if(hold)await hold;
    if(fail)return route.fulfill({status:503,json:{error:'一時的な通信障害'}});
    const response=await route.fetch();
    if(loseReply){loseReply=false;return route.abort('failed');}
    return route.fulfill({response});
  });
  try{
    await page.evaluate(()=>go('avset'));
    await page.waitForFunction(()=>!AVGOOGLE.loading&&document.querySelector('.avg-stage'));
    await page.evaluate(()=>{window.manualTestStage=document.querySelector('.avg-stage');});
    const stroke=async(day,start,end)=>{
      const cells=page.locator('.avg-stage tbody tr');
      const first=cells.nth(start).locator('td[data-iso]').nth(day),last=cells.nth(end).locator('td[data-iso]').nth(day);
      await first.scrollIntoViewIfNeeded();
      const a=await first.boundingBox(),b=await last.boundingBox();
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
      await page.mouse.down();
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:1});
      await page.mouse.up();
    };
    await stroke(1,2,8);
    check(await page.locator('.avg-stage tbody .bt-c.block').count()===7,'高速な1回の移動で途中の7マスも反映');
    await page.waitForFunction(()=>AVBLOCK_SAVES.get(ME.id)?.inflight.length>0);
    for(let i=0;i<20;i++)await stroke(1+i%2,2+i%3,5+i%3);
    check(patches.length===1,'応答待ちでも追加操作でき、並列保存しない');
    await page.evaluate(async()=>{await onServerRefresh();});
    const expected=await page.locator('.avg-stage tbody .bt-c.block').evaluateAll(cells=>cells.map(cell=>cell.dataset.iso));
    check(expected.length>0,'通信中も直前の編集を表示');
    hold=null;release();
    await page.waitForFunction(()=>!AVBLOCK_SAVES.get(ME.id)?.running);
    check(await page.evaluate(()=>window.manualTestStage===document.querySelector('.avg-stage')),'保存・更新通知で表を作り直さない');
    const persisted=await page.evaluate(async()=>{
      const response=await api('/api/db');const data=await response.json();
      const blocks=data.availability[ME.id].blocks;
      return Array.from(document.querySelectorAll('.avg-stage td[data-iso]')).filter(cell=>{
        const start=Date.parse(cell.dataset.iso),end=start+1800000;
        return blocks.some(block=>block.kind!=='external-google'&&start<Date.parse(block.end)&&end>Date.parse(block.start));
      }).map(cell=>cell.dataset.iso);
    });
    check(JSON.stringify(expected.sort())===JSON.stringify(persisted.sort()),'20回の連続操作の最終状態が実DBと一致');
    check(patches.length<21,'操作回数より保存回数を削減');
    results.push({label:'高速なぞり・20連続操作・遅延応答・DB一致・表DOM維持',ok:true,requests:patches.length});
    loseReply=true;
    await stroke(2,10,11);
    await page.waitForFunction(()=>!AVBLOCK_SAVES.get(ME.id)?.running);
    check(await page.evaluate(()=>!AVBLOCK_SAVES.get(ME.id).failed),'保存成功の応答を失っても再送で回復');
    results.push({label:'保存応答喪失後の自動再送',ok:true});
    fail=true;
    await stroke(2,12,13);
    await page.getByText('未保存（再試行できます）',{exact:true}).waitFor();
    check(await page.locator('.avg-stage tbody tr').nth(12).locator('td[data-iso]').nth(2).evaluate(cell=>cell.classList.contains('block')),'失敗時も入力を保持');
    fail=false;
    await page.evaluate(()=>retrySave());
    await page.getByText('保存済み',{exact:true}).waitFor();
    check(puts===0,'再試行もDB全体PUTを使わない');
    results.push({label:'通信障害時の入力保持・明示再試行',ok:true});
  }finally{
    if(hold){hold=null;release();}
    page.off('request',watch);
    await page.unroute('**/api/availability/blocks');
    await page.unroute('**/api/availability/google-events**');
  }
  return results;
}
