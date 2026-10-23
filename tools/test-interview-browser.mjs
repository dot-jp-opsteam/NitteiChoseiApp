export async function runInterviewBrowserTests(page){
  const results=[];
  const day=new Date();day.setDate(day.getDate()+1);day.setHours(13,0,0,0);
  const original=day.toISOString(),changed=new Date(+day+3600000).toISOString();
  let interview={id:'ui_interview',intern_name:'面談テストさん',status:'fixed',confirmed_datetime:original,choices:[original],created_at:new Date().toISOString(),note:'申請メモ'};
  let fail=false;
  await page.route('**/api/interviews/ui_interview',async route=>{
    if(fail)return route.fulfill({status:409,json:{error:'この時間は面談できません。別の時間を選んでください'}});
    interview={...interview,...route.request().postDataJSON()};
    if(interview.status==='failed')interview={...interview,cancelled:true,previous_confirmed_datetime:changed,confirmed_datetime:null};
    return route.fulfill({json:{ok:true,interview}});
  });
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  try{
    await page.evaluate(fixture=>{fixture.staff_id=ME.id;fixture.branch_id=ME.branch_id;DB.interviews=[...DB.interviews.filter(item=>item.id!==fixture.id),fixture];openInterview(fixture.id);},interview);
    await page.getByRole('button',{name:'日時を変更',exact:true}).click();
    const local=await page.locator('#iv-change-datetime').inputValue();
    await page.getByLabel('変更後の日時',{exact:true}).fill(local.slice(0,11)+'14:00');
    await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();
    await page.getByRole('button',{name:'変更する',exact:true}).click();
    await page.getByRole('heading',{name:'面談日時を変更しました',exact:true}).waitFor();
    const message=await page.locator('#iv-change-message').inputValue();
    check(message.includes('変更前')&&message.includes('変更後')&&message.includes('13:00')&&message.includes('14:00'),'変更前後の連絡文がない');
    check(await page.evaluate(()=>DB.interviews.find(item=>item.id==='ui_interview').note==='申請メモ'),'申請メモが失われる');
    results.push({label:'確定面談の日時変更とLINE連絡文・申請情報保持',ok:true});
    fail=true;
    await page.evaluate(()=>openInterview('ui_interview'));
    await page.getByRole('button',{name:'日時を変更',exact:true}).click();
    await page.getByLabel('変更後の日時',{exact:true}).fill(local.slice(0,11)+'15:00');
    await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();
    await page.getByRole('button',{name:'変更する',exact:true}).click();
    await page.locator('#toast').filter({hasText:'この時間は面談できません'}).waitFor();
    check(await page.evaluate(expected=>DB.interviews.find(item=>item.id==='ui_interview').confirmed_datetime===expected,changed),'変更失敗で日時が変わる');
    results.push({label:'重複エラーでは確定日時を保持',ok:true});
    fail=false;
    await page.evaluate(()=>openInterview('ui_interview'));
    await page.getByRole('button',{name:'面談をキャンセル',exact:true}).click();
    await page.getByRole('button',{name:'キャンセルする',exact:true}).click();
    await page.getByRole('heading',{name:'面談をキャンセルしました',exact:true}).waitFor();
    check((await page.locator('#iv-change-message').inputValue()).includes('キャンセル'),'取消の連絡文がない');
    results.push({label:'面談キャンセルと連絡文の表示',ok:true});
  }finally{await page.unroute('**/api/interviews/ui_interview');}
  return results;
}
