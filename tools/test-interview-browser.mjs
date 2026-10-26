export async function runInterviewBrowserTests(page){
  const results=[];
  const day=new Date();day.setDate(day.getDate()+1);day.setHours(13,0,0,0);
  const original=day.toISOString(),changed=new Date(+day+3600000).toISOString();
  const third=new Date(+day+7200000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
  let interview={id:'ui_interview',intern_name:'面談テストさん',status:'fixed',confirmed_datetime:original,choices:[original,third,past],created_at:new Date().toISOString(),note:'申請メモ'};
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
    /* 確定するときと同じ「第N希望」の一覧。変更前の日時は札を付けて残し、過ぎた希望は出さない */
    check(await page.locator('#rsg1 .tag').innerText()==='変更前','変更前の希望に「変更前」の札がない');
    check(await page.locator('#rst1').count()===0,'変更前の時刻だけの希望に入力欄がある');
    check(await page.locator('#rsg2 .cn').innerText()==='第2希望'&&await page.locator('#rst2').inputValue()==='15:00','第2希望に開始時刻の入力欄がない');
    check(await page.locator('#rsg3').count()===0,'過ぎた希望が一覧に出る');
    check((await page.locator('#rsg2').getAttribute('class')).includes('open')&&!(await page.locator('#rsg1').getAttribute('class')).includes('open'),'選べる最初の希望だけが開いていない');
    await page.locator('#rsg1 .chead').click();
    check((await page.locator('#rsg1').getAttribute('class')).includes('open'),'希望の見出しを押しても開かない');
    await page.locator('#rst2').fill('15:30');
    check(await page.locator('#rsok2').isDisabled(),'候補にない時刻でも変更ボタンが押せる');
    await page.locator('#rst2').fill('15:00');
    check(await page.locator('#rsok2').isEnabled(),'候補の時刻で変更ボタンが押せない');
    results.push({label:'日時変更は確定画面と同じ希望一覧で、変更前の日時も表示',ok:true});
    await page.getByRole('button',{name:'候補以外の日時に変更する',exact:true}).click();
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
    await page.getByRole('button',{name:'候補以外の日時に変更する',exact:true}).click();
    await page.getByLabel('変更後の日時',{exact:true}).fill(local.slice(0,11)+'15:00');
    await page.getByRole('button',{name:'変更内容を確認',exact:true}).click();
    await page.getByRole('button',{name:'変更する',exact:true}).click();
    await page.locator('#toast').filter({hasText:'この時間は面談できません'}).waitFor();
    check(await page.evaluate(expected=>DB.interviews.find(item=>item.id==='ui_interview').confirmed_datetime===expected,changed),'変更失敗で日時が変わる');
    results.push({label:'重複エラーでは確定日時を保持',ok:true});
    /* 希望の一覧から変更する道も、失敗したら一覧へ戻り、成功すれば連絡文が出る */
    await page.evaluate(()=>openInterview('ui_interview'));
    await page.getByRole('button',{name:'日時を変更',exact:true}).click();
    check(await page.locator('#rst1').inputValue()==='13:00','変更後は元の希望の時刻を選べない');
    await page.locator('#rsg2 .chead').click();
    await page.locator('#rsok2').click();
    await page.getByRole('button',{name:'変更する',exact:true}).click();
    await page.locator('#rsg2').waitFor();
    check(await page.evaluate(expected=>DB.interviews.find(item=>item.id==='ui_interview').confirmed_datetime===expected,changed),'希望からの変更が失敗しても日時が変わる');
    fail=false;
    await page.locator('#rsok2').click();
    await page.getByRole('button',{name:'変更する',exact:true}).click();
    await page.getByRole('heading',{name:'面談日時を変更しました',exact:true}).waitFor();
    const second=await page.locator('#iv-change-message').inputValue();
    check(second.includes('14:00')&&second.includes('15:00'),'希望から変更した連絡文がない');
    results.push({label:'希望の一覧から日時変更（失敗時は一覧へ戻り、成功で連絡文）',ok:true});
    await page.evaluate(()=>openInterview('ui_interview'));
    await page.getByRole('button',{name:'面談をキャンセル',exact:true}).click();
    await page.getByRole('button',{name:'キャンセルする',exact:true}).click();
    await page.getByRole('heading',{name:'面談をキャンセルしました',exact:true}).waitFor();
    check((await page.locator('#iv-change-message').inputValue()).includes('キャンセル'),'取消の連絡文がない');
    results.push({label:'面談キャンセルと連絡文の表示',ok:true});
  }finally{await page.unroute('**/api/interviews/ui_interview');}
  return results;
}
