/* 受けられる時間の表に出る、確定した面談の帯（移動・伸縮）の画面検査。
   tools/test-tally-e2e.mjs --serve の専用localhost:8129で、ダミーのスタッフ tly_token_a として動かす。
   PATCH は偽の応答にして、送った内容と画面の変わり方を見る */
export async function runInterviewBandBrowserTests(page){
  const results=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const start=new Date();start.setDate(start.getDate()+1);start.setHours(13,0,0,0);
  const original=start.toISOString();
  let interview={id:'ui_band',intern_name:'帯テストさん',status:'fixed',confirmed_datetime:original,duration_min:30,choices:[original],created_at:new Date().toISOString()};
  Object.assign(interview,await page.evaluate(()=>({staff_id:ME.id,branch_id:ME.branch_id})));
  let fail=false;const bodies=[];
  await page.route('**/api/interviews/ui_band',async route=>{
    if(route.request().method()!=='PATCH')return route.fallback();
    const body=route.request().postDataJSON();bodies.push(body);
    if(fail)return route.fulfill({status:409,json:{error:'この時間は面談できません。別の時間を選んでください'}});
    interview={...interview,...body};
    return route.fulfill({json:{ok:true,interview}});
  });
  const band=()=>page.locator('.avg-band.avg-iv[data-id="ui_band"]');
  const row=()=>page.evaluate(()=>document.querySelector('.avg-stage tbody tr').getBoundingClientRect().height);
  const drag=async(locator,dx,dy)=>{
    await locator.scrollIntoViewIfNeeded();
    const box=await locator.boundingBox();
    const x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx/2,y+dy/2,{steps:4});await page.mouse.move(x+dx,y+dy,{steps:4});await page.mouse.up();
  };
  try{
    await page.evaluate(fixture=>{DB.interviews=[...DB.interviews.filter(item=>item.id!==fixture.id),fixture];go('avset');},interview);
    await band().waitFor();
    const unit=await row();
    check((await band().textContent()).includes('13:00〜13:30'),'帯に面談の時間が出ない');
    results.push({label:'確定した面談が帯で出る',ok:true});

    await drag(band().locator('.avg-resize-end'),0,unit*2);
    await page.waitForFunction(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min===90);
    check(bodies.at(-1).duration_min===90&&bodies.at(-1).confirmed_datetime===original&&bodies.at(-1).status==='fixed','下のつまみを2マス下げても、開始そのままで90分にならない');
    await page.waitForFunction(()=>document.querySelector('.avg-band.avg-iv span')?.textContent.includes('13:00〜14:30'));
    results.push({label:'下のつまみで面談を伸ばす（30分単位）',ok:true});

    await drag(band().locator('.avg-resize-start'),0,unit*2);
    await page.waitForFunction(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min===30);
    check(bodies.at(-1).duration_min===30&&new Date(bodies.at(-1).confirmed_datetime).getTime()===+new Date(original)+3600000,'上のつまみを2マス下げても、開始が1時間後・30分にならない');
    results.push({label:'上のつまみで面談を縮める',ok:true});

    await drag(band().locator('.avg-event-open'),0,-unit*2);
    await page.waitForFunction(o=>DB.interviews.find(item=>item.id==='ui_band').confirmed_datetime===o,original);
    check(bodies.at(-1).duration_min===30&&bodies.at(-1).confirmed_datetime===original,'帯を2マス上へ動かしても元の時刻に戻らない');
    results.push({label:'帯をドラッグして時刻を動かす',ok:true});

    const column=await page.evaluate(()=>document.querySelector('.avg-stage tbody tr td').getBoundingClientRect().width);
    await drag(band().locator('.avg-event-open'),column,0);
    await page.waitForFunction(o=>new Date(DB.interviews.find(item=>item.id==='ui_band').confirmed_datetime).getTime()===new Date(o).getTime()+86400000,original);
    results.push({label:'帯を隣の日へ動かす',ok:true});

    fail=true;const before=interview.confirmed_datetime;
    await drag(band().locator('.avg-event-open'),0,unit);
    await page.locator('#toast').filter({hasText:'この時間は面談できません'}).waitFor();
    check(await page.evaluate(expected=>DB.interviews.find(item=>item.id==='ui_band').confirmed_datetime===expected,before),'変更に失敗したのに日時が変わる');
    const d=new Date(before),hhmm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    await page.waitForFunction(t=>document.querySelector('.avg-band.avg-iv span')?.textContent.startsWith(t),hhmm);
    results.push({label:'変更に失敗したら帯を元の位置に戻す',ok:true});
    fail=false;

    const count=bodies.length;
    await band().locator('.avg-event-open').click();
    check(bodies.length===count,'押しただけで面談が変更される');
    await page.getByRole('button',{name:'日時を変更',exact:true}).waitFor();
    results.push({label:'帯を押すと面談の詳細が開く（動かさない）',ok:true});
  }finally{await page.unroute('**/api/interviews/ui_band');}
  return results;
}
