export async function runManualAvailabilityTests({api,getDB,putDB,tokens,check}){
  console.log('\n─────── 不可時間の連続・同時保存 ───────');
  const path='/api/availability/blocks';
  const block=id=>({id,start:'2031-02-01T10:00:00Z',end:'2031-02-01T10:30:00Z',kind:'slot',note:'連続操作検査'});
  check('未ログインの不可時間変更を拒否',(await api(null,'PATCH',path,{added:[block('denied')]})).status,401);
  check('本人以外を指定する要求を拒否',(await api(tokens.staff,'PATCH',path,{user_id:'u_e2e_staff3',added:[block('denied')]})).status,400);
  const before=await getDB(tokens.staff);
  const saves=await Promise.all(Array.from({length:60},(_,i)=>api(tokens.staff,'PATCH',path,{added:[block('fast_'+i)],removedIds:[]})));
  check('同じ人の60件同時保存が全て成功',saves.filter(result=>result.status===200).length,60);
  const after=await getDB(tokens.staff);
  check('60件の不可時間が消えずに残る',(after.availability?.u_e2e_staff?.blocks||[]).filter(item=>item.id.startsWith('fast_')).length,60);
  check('他のプロフィールを変えない',after.profiles,before.profiles);
  const idem=await api(tokens.staff,'PATCH',path,{added:[block('fast_0')],removedIds:[]});
  check('再送で同じ不可時間を重複追加しない',idem.json.blocks?.filter(item=>item.id==='fast_0').length,1);
  const many=await Promise.all([api(tokens.staff,'PATCH',path,{added:[block('mine')]}),api(tokens.staff3,'PATCH',path,{added:[block('theirs')]})]);
  check('別の人の同時保存も成功',many.map(result=>result.status),[200,200]);
  const other=await getDB(tokens.staff3);
  check('他人の不可時間を本人の領域に混ぜない',(other.availability?.u_e2e_staff3?.blocks||[]).some(item=>item.id==='mine'),false);
  const bad=await api(tokens.staff,'PATCH',path,{added:[{...block('invalid'),end:'bad'}]});
  check('不正な日時を拒否',bad.status,400);
  check('Google予定を手動追加させない',(await api(tokens.staff,'PATCH',path,{added:[{...block('fake-google'),kind:'external-google'}]})).status,400);
  await putDB(tokens.admin,db=>{const av=db.availability.u_e2e_staff;av.blocks.push({...block('protected-google'),kind:'external-google',googleEventId:'real-google'});});
  check('Google予定を通常マスAPIで削除させない',(await api(tokens.staff,'PATCH',path,{removedIds:['protected-google']})).status,400);
  check('Google予定と同じIDで置き換えさせない',(await api(tokens.staff,'PATCH',path,{added:[block('protected-google')]})).status,400);
  await api(tokens.staff,'PATCH',path,{removedIds:[...Array.from({length:60},(_,i)=>'fast_'+i),'mine']});
  await api(tokens.staff3,'PATCH',path,{removedIds:['theirs']});
  check('追加した手動不可時間をまとめて解除できる',((await getDB(tokens.staff)).availability.u_e2e_staff.blocks||[]).filter(item=>item.id.startsWith('fast_')).length,0);
  await putDB(tokens.admin,db=>{db.availability.u_e2e_staff.blocks=db.availability.u_e2e_staff.blocks.filter(item=>item.id!=='protected-google');});
}
