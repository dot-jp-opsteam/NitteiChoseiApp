/* 表の保存API。公開DTOと本人用の鍵を分離する。 */
'use strict';
const crypto=require('node:crypto');
const model=require('./tally');
const hex=(s,n)=>typeof s==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(s);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const random=n=>crypto.randomBytes(n).toString('hex');
class HttpError extends Error{constructor(status,code,error){super(error);this.status=status;this.code=code;}}
const fail=(status,code,error)=>{throw new HttpError(status,code,error);};
module.exports=function({app,client,requireAuth,limitPublicRead,limitPublicWrite}){
 const base=()=>String(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
 const boardDTO=r=>({token:r.token,active:Number(r.active)===1,revision:Number(r.revision),config:JSON.parse(r.data)});
 const staffDTO=r=>({...boardDTO(r),id:r.id,url:base()+'/t/'+r.token,created_at:r.created_at,updated_at:r.updated_at});
 const responseDTO=r=>{const data=JSON.parse(r.data);return {id:r.id,name:r.name,note:r.note,selected:data.selected,answered:data.answered,revision:Number(r.revision),created_at:r.created_at,updated_at:r.updated_at};};
 async function query(db,sql,args=[]){return (await db.execute({sql,args})).rows;}
 const one=async(db,sql,args)=> (await query(db,sql,args))[0];
 const responses=async(db,id)=>(await query(db,'SELECT * FROM tally_responses WHERE board_id=? ORDER BY created_at,id',[id])).map(responseDTO);
 // ローカルSQLiteも同一接続のBEGINが重ならないよう順に開始。DBのwrite transactionで他プロセスとの競合も防ぐ。
 let writes=Promise.resolve();
 function write(fn){const operation=writes.then(async()=>{const tx=await client.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}});writes=operation.catch(()=>{});return operation;}
 const noStore=(req,res,next)=>{res.set('Cache-Control','no-store');next();};
 const staff=(req,res,next)=>{if(!['staff','branch_admin','admin'].includes(req.authUser.role))return res.status(403).json({error:'権限がありません'});next();};
 const handler=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){if(e instanceof HttpError)return res.status(e.status).json({code:e.code,error:e.message});console.error('表で日程調整APIの処理に失敗しました');res.status(500).json({error:'保存または読み込みに失敗しました。再試行してください。'});}};
 const owned=async(db,req)=>{const b=await one(db,'SELECT * FROM tally_boards WHERE id=? AND staff_id=?',[req.params.id,req.authUser.id]);if(!b)fail(404,'not_found','表が見つかりません。');return b;};
 async function init(){
  await client.execute(`CREATE TABLE IF NOT EXISTS tally_boards(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,token TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  await client.execute('CREATE INDEX IF NOT EXISTS idx_tally_boards_staff ON tally_boards(staff_id)');
  await client.execute(`CREATE TABLE IF NOT EXISTS tally_responses(id TEXT PRIMARY KEY,board_id TEXT NOT NULL,name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,edit_token_hash TEXT UNIQUE NOT NULL,submission_key TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(board_id,submission_key))`);
  await client.execute('CREATE INDEX IF NOT EXISTS idx_tally_responses_board ON tally_responses(board_id)');
 }
 app.get('/api/tally-boards',requireAuth,staff,noStore,handler(async req=>({boards:(await query(client,`SELECT b.*,(SELECT COUNT(*) FROM tally_responses r WHERE r.board_id=b.id) AS response_count FROM tally_boards b WHERE b.staff_id=? ORDER BY b.created_at DESC,b.id`,[req.authUser.id])).map(r=>({...staffDTO(r),count:Number(r.response_count)}))})));
 app.post('/api/tally-boards',requireAuth,staff,noStore,handler(req=>write(async tx=>{
  const norm=model.normalizeBoard(req.body.config);if(!norm.ok)fail(400,norm.code,norm.error);
  const n=await one(tx,'SELECT COUNT(*) AS n FROM tally_boards WHERE staff_id=?',[req.authUser.id]);if(Number(n.n)>=30)fail(409,'limit','作成できる表は30件までです。');
  const now=new Date().toISOString(),id='tly_'+random(16),token=random(16);
  await tx.execute({sql:'INSERT INTO tally_boards(id,staff_id,token,data,created_at,updated_at) VALUES(?,?,?,?,?,?)',args:[id,req.authUser.id,token,JSON.stringify(norm.config),now,now]});
  return {board:staffDTO(await one(tx,'SELECT * FROM tally_boards WHERE id=?',[id]))};
 })));
 app.get('/api/tally-boards/:id',requireAuth,staff,noStore,handler(async req=>{const b=await owned(client,req);return {board:staffDTO(b),responses:await responses(client,b.id)};}));
 app.put('/api/tally-boards/:id',requireAuth,staff,noStore,handler(req=>write(async tx=>{
  const b=await owned(tx,req),norm=model.normalizeBoard(req.body.config,JSON.parse(b.data));if(!norm.ok)fail(400,norm.code,norm.error);
  if(typeof req.body.active!=='boolean'||!Number.isInteger(req.body.revision))fail(400,'invalid','受付状態と版を確認してください。');
  const result=await tx.execute({sql:'UPDATE tally_boards SET data=?,active=?,revision=revision+1,updated_at=? WHERE id=? AND staff_id=? AND revision=?',args:[JSON.stringify(norm.config),req.body.active?1:0,new Date().toISOString(),b.id,req.authUser.id,req.body.revision]});
  if(!result.rowsAffected)fail(409,'stale_board','別の画面で表が変更されました。最新の表を確認してください。');
  return {board:staffDTO(await one(tx,'SELECT * FROM tally_boards WHERE id=?',[b.id]))};
 })));

 const publicBoard=async(db,token)=>{if(!hex(token,32))fail(404,'not_found','表が見つかりません。');const b=await one(db,'SELECT * FROM tally_boards WHERE token=?',[token]);if(!b)fail(404,'not_found','表が見つかりません。');return b;};
 const managed=async(db,token)=>{if(!hex(token,48))fail(404,'not_found','編集リンクが見つかりません。');const r=await one(db,'SELECT * FROM tally_responses WHERE edit_token_hash=?',[sha(token)]);if(!r)fail(404,'not_found','編集リンクが見つかりません。');return {r,b:await one(db,'SELECT * FROM tally_boards WHERE id=?',[r.board_id])};};
 const checkBoard=(b,revision)=>{if(!Number(b.active))fail(409,'closed','回答の受付は停止しています。');if(!Number.isInteger(revision))fail(400,'invalid','表の版を確認してください。');if(Number(b.revision)!==revision)fail(409,'stale_board','表が変更されました。最新の表を読み込んでください。');};
 const ack=(b,r,token)=>({responseId:r.id,responseRevision:Number(r.revision),boardRevision:Number(b.revision),editUrl:base()+'/t/manage/'+token});
 app.get('/api/tally/manage/:editToken',noStore,limitPublicRead,handler(async req=>{const {b,r}=await managed(client,req.params.editToken);return {board:boardDTO(b),response:responseDTO(r)};}));
 app.put('/api/tally/manage/:editToken',noStore,limitPublicWrite,handler(req=>write(async tx=>{
  const {b,r}=await managed(tx,req.params.editToken);checkBoard(b,req.body.boardRevision);
  if(!Number.isInteger(req.body.responseRevision))fail(400,'invalid','回答の版を確認してください。');
  if(Number(r.revision)!==req.body.responseRevision)fail(409,'stale_response','別の画面で回答が変更されました。最新の回答を確認してください。');
  const norm=model.normalizeResponse(req.body,JSON.parse(b.data));if(!norm.ok)fail(400,norm.code,norm.error);
  const {name,note,selected,answered}=norm.data;
  const result=await tx.execute({sql:'UPDATE tally_responses SET name=?,note=?,data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',args:[name,note,JSON.stringify({selected,answered}),new Date().toISOString(),r.id,req.body.responseRevision]});
  if(!result.rowsAffected)fail(409,'stale_response','回答が変更されました。');
  return ack(b,await one(tx,'SELECT * FROM tally_responses WHERE id=?',[r.id]),req.params.editToken);
 })));
 app.get('/api/tally/:token',noStore,limitPublicRead,handler(async req=>{const b=await publicBoard(client,req.params.token);return {board:boardDTO(b),responses:await responses(client,b.id)};}));
 app.post('/api/tally/:token/responses',noStore,limitPublicWrite,handler(req=>write(async tx=>{
  const b=await publicBoard(tx,req.params.token),input=req.body;
  if(!hex(input.submissionKey,48)||!hex(input.editToken,48))fail(400,'invalid','送信キーを確認してください。');
  const existing=await one(tx,'SELECT * FROM tally_responses WHERE board_id=? AND submission_key=?',[b.id,input.submissionKey]);
  if(existing){if(existing.edit_token_hash!==sha(input.editToken))fail(409,'invalid','送信キーが別の回答に使われています。');return ack(b,existing,input.editToken);}
  checkBoard(b,input.boardRevision);
  const total=await one(tx,'SELECT COUNT(*) AS n FROM tally_responses WHERE board_id=?',[b.id]);if(Number(total.n)>=100)fail(409,'limit','回答できる人数は100人までです。');
  const norm=model.normalizeResponse(input,JSON.parse(b.data));if(!norm.ok)fail(400,norm.code,norm.error);
  if(await one(tx,'SELECT id FROM tally_responses WHERE edit_token_hash=?',[sha(input.editToken)]))fail(409,'invalid','編集キーが使われています。');
  const {name,note,selected,answered}=norm.data,now=new Date().toISOString(),id='tlr_'+random(16);
  await tx.execute({sql:'INSERT INTO tally_responses(id,board_id,name,note,data,edit_token_hash,submission_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',args:[id,b.id,name,note,JSON.stringify({selected,answered}),sha(input.editToken),input.submissionKey,now,now]});
  return ack(b,await one(tx,'SELECT * FROM tally_responses WHERE id=?',[id]),input.editToken);
 })));

 return {init};
};
