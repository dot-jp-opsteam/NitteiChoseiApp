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
  let fail=false,delay=0;const bodies=[];
  await page.route('**/api/interviews/ui_band',async route=>{
    if(route.request().method()!=='PATCH')return route.fallback();
    const body=route.request().postDataJSON();bodies.push(body);
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(fail)return route.fulfill({status:409,json:{error:'この時間は面談できません。別の時間を選んでください'}});
    interview={...interview,...body};
    return route.fulfill({json:{ok:true,interview}});
  });
  const band=()=>page.locator('.avg-band.avg-iv[data-id="ui_band"]');
  const row=()=>page.evaluate(()=>document.querySelector('.avg-stage tbody tr').getBoundingClientRect().height);
  const drag=async(locator,dx,dy,inFlight=false)=>{
    if(!inFlight){await page.waitForFunction(()=>AV_IV_SAVING.size===0);await page.waitForTimeout(100);} // 保存の返事で帯が描き直されるのを待つ
    await locator.scrollIntoViewIfNeeded();
    const box=await locator.boundingBox();
    const x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx/2,y+dy/2,{steps:4});await page.mouse.move(x+dx,y+dy,{steps:4});await page.mouse.up();
  };
  try{
    await page.evaluate(fixture=>{DB.interviews=[...DB.interviews.filter(item=>item.id!==fixture.id),fixture];go('avset');},interview);
    await page.waitForFunction(()=>!AVGOOGLE.loading); // Googleの予定の読み込みが終わると帯が描き直されるので、先に待つ
    await band().waitFor();
    await page.waitForTimeout(300);
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

    /* 帯そのものはドラッグしても動かない（動かすのは上下のつまみだけ） */
    const countBefore=bodies.length;
    await drag(band().locator('.avg-event-open'),0,unit*2);
    await page.waitForTimeout(300);
    check(bodies.length===countBefore,'帯の本体をドラッグすると面談が動いてしまう');
    results.push({label:'帯の本体はドラッグしても動かない',ok:true});

    /* 帯を押すと、開始と終了を数字で指定する画面が開く */
    await band().locator('.avg-event-open').click();
    await page.locator('#avi-end').waitFor();
    const startValue=await page.locator('#avi-start').inputValue();
    const day=startValue.slice(0,11);
    await page.locator('#avi-end').fill(day+'16:00');
    await page.getByRole('button',{name:'この時間に変更',exact:true}).click();
    await page.waitForFunction(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min===120);
    check(bodies.at(-1).duration_min===120&&bodies.at(-1).confirmed_datetime===interview.confirmed_datetime,'終了を16:00にしても、開始そのままで120分にならない');
    results.push({label:'帯を押して終了時刻を数字で指定し、面談を伸ばす',ok:true});

    await band().locator('.avg-event-open').click();
    await page.locator('#avi-end').waitFor();
    await page.locator('#avi-end').fill((await page.locator('#avi-start').inputValue()).slice(0,11)+'05:00');
    await page.getByRole('button',{name:'この時間に変更',exact:true}).click();
    check((await page.locator('#avi-error').innerText()).includes('4時間'),'長すぎる指定が拒否されない');
    await page.locator('#avi-end').fill((await page.locator('#avi-start').inputValue()));
    await page.getByRole('button',{name:'この時間に変更',exact:true}).click();
    check((await page.locator('#avi-error').innerText()).includes('30分から4時間')||(await page.locator('#avi-error').innerText()).includes('30分'),'終了が開始と同じ指定が拒否されない');
    check(bodies.at(-1).duration_min===120,'不正な指定で送信されている');
    results.push({label:'不正な長さの指定は送らず理由を表示',ok:true});
    await page.getByRole('button',{name:'面談の詳細を開く',exact:true}).click();
    await page.getByRole('button',{name:'日時を変更',exact:true}).waitFor();
    results.push({label:'指定画面から面談の詳細へ進める',ok:true});

    await page.evaluate(()=>closeSheet());

    /* つまみを動かしている最中に画面の大きさが変わっても、帯が元の位置へ飛ばない */
    const handle=band().locator('.avg-resize-end');
    await handle.scrollIntoViewIfNeeded();
    const box=await handle.boundingBox(),hx=box.x+box.width/2,hy=box.y+box.height/2;
    await page.mouse.move(hx,hy);await page.mouse.down();await page.mouse.move(hx,hy+unit/2,{steps:3});await page.mouse.move(hx,hy+unit,{steps:3});
    const during=await band().evaluate(element=>element.style.height);
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForTimeout(200);
    check(await band().evaluate(element=>element.style.height)===during,'つまみを動かしている途中で画面の大きさが変わると、帯が別の位置へ飛ぶ');
    await page.mouse.up();
    await page.waitForFunction(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min===150);
    results.push({label:'ドラッグ中に画面の大きさが変わっても帯が飛ばない',ok:true});

    /* 保存の返事を待つ間は動かした位置のまま見せ、その間の次の操作は受け付けない（古い内容から動いて飛ぶのを防ぐ） */
    delay=700;const savesBefore=bodies.length;
    await drag(band().locator('.avg-resize-end'),0,unit);
    await page.waitForFunction(()=>document.querySelector('.avg-band.avg-iv span')?.textContent.includes('〜17:00'));
    await drag(band().locator('.avg-resize-end'),0,unit,true);
    await page.waitForFunction(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min===180);
    await page.waitForTimeout(900);
    check(bodies.length===savesBefore+1,'保存中に次のドラッグが受け付けられ、二重に保存される');
    check(await page.evaluate(()=>DB.interviews.find(item=>item.id==='ui_band').duration_min)===180,'保存中の操作で長さが変わってしまう');
    delay=0;
    results.push({label:'保存中は帯が動かした位置のままで、次の操作は受け付けない',ok:true});

    fail=true;const before=interview.confirmed_datetime;
    await drag(band().locator('.avg-resize-end'),0,unit);
    await page.locator('#toast').filter({hasText:'この時間は面談できません'}).waitFor();
    check(await page.evaluate(expected=>DB.interviews.find(item=>item.id==='ui_band').confirmed_datetime===expected,before),'変更に失敗したのに日時が変わる');
    const d=new Date(before),hhmm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    await page.waitForFunction(t=>document.querySelector('.avg-band.avg-iv span')?.textContent.startsWith(t),hhmm);
    results.push({label:'変更に失敗したら帯を元の位置に戻す',ok:true});
    fail=false;

  }finally{await page.unroute('**/api/interviews/ui_band');}
  return results;
}
