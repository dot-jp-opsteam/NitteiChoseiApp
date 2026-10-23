export async function runCandidateBrowserTests(page){
  const results=[];
  const day=new Date();day.setDate(day.getDate()+1);
  const date=[day.getFullYear(),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0')].join('-');
  let fail=false,requests=0;
  await page.route('**/api/availability/candidates?**',route=>{
    requests++;
    return route.fulfill(fail?{status:503,json:{error:'空き時間テストエラー'}}:{json:{slots:[{date,time:'10:00',duration:30},{date,time:'11:00',duration:30}]}});
  });
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  try{
    await page.evaluate(()=>openRequestForm());
    await page.locator('#reqSubj').fill('入力保持テスト');
    await page.locator('#reqBody').fill('連絡文を残す');
    await page.getByRole('button',{name:'自分の空き時間から候補を選ぶ'}).click();
    await page.getByRole('button',{name:'空きを表示',exact:true}).click();
    await page.locator('.req-free-slot').first().waitFor();
    await page.locator('.req-free-slot').first().click();
    check(await page.locator('#reqSubj').inputValue()==='入力保持テスト','候補を選ぶと件名が消える');
    check(await page.locator('#reqBody').inputValue()==='連絡文を残す','候補を選ぶと本文が消える');
    check(await page.evaluate(()=>REQFORM.opts.length===1&&REQFORM.opts[0].t1==='10:00'),'候補の時刻が保存されない');
    results.push({label:'空き候補を追加し、入力中の件名・本文を保持',ok:true});
    await page.locator('.req-free-slot').first().click();
    check(await page.evaluate(()=>REQFORM.opts.length===0),'候補の選択を取り消せない');
    await page.locator('.req-free-slot').nth(1).click();
    await page.getByRole('button',{name:'自分の空き時間から候補を選ぶ'}).click();
    check(await page.evaluate(()=>REQFORM.opts[0].t1==='11:00'),'閉じると候補が消える');
    results.push({label:'選択の取消・パネルを閉じても候補を保持',ok:true});
    await page.getByRole('button',{name:'自分の空き時間から候補を選ぶ'}).click();
    fail=true;
    await page.getByRole('button',{name:'空きを表示',exact:true}).click();
    await page.getByText('空き時間テストエラー',{exact:true}).waitFor();
    check(await page.evaluate(()=>REQFORM.opts[0].t1==='11:00'),'取得失敗で選択済み候補が消える');
    check(requests===2,'表示以外の要求が発生する');
    results.push({label:'空き時間の取得失敗でも候補を保持',ok:true});
  }finally{await page.unroute('**/api/availability/candidates?**');}
  return results;
}
