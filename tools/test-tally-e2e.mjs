/* 本物のサーバーと専用DB。外部Google・メールを無効化して確認する。 */
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {createClient}=createRequire(path.join(ROOT,'server/package.json'))('@libsql/client');
const BASE='http://localhost:8128',TOK={a:'tly_token_a',b:'tly_token_b',admin:'tly_token_admin',branch:'tly_token_branch',intern:'tly_token_intern'};
const cfg={title:'相談会',description:'一般の方もどうぞ',template:'custom',rows:[{id:'r1',label:'午前',active:true}],columns:[{id:'c1',label:'月曜',active:true},{id:'c2',label:'火曜',active:true}]};
let count=0;
function eq(actual,want,label){assert.deepEqual(actual,want,label);count++;}
async function api(token,method,p,payload){const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;const r=await fetch(BASE+p,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)});return {status:r.status,json:await r.json().catch(()=>({})),headers:r.headers};}
async function setupDB(dbPath){
 const c=createClient({url:'file:'+dbPath}),now=new Date().toISOString(),exp=new Date(Date.now()+86400000).toISOString();
 await c.execute(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,nickname TEXT,role TEXT NOT NULL,branch_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,approved_at TEXT,avatar_url TEXT,staff_id TEXT,google_sub TEXT)`);
 await c.execute(`CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL)`);
 await c.execute(`CREATE TABLE store(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,updated_at TEXT NOT NULL)`);
 for(const [key,token] of Object.entries(TOK)){const role={a:'staff',b:'staff',admin:'admin',branch:'branch_admin',intern:'intern'}[key];await c.execute({sql:'INSERT INTO users(id,email,password_hash,nickname,role,branch_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',args:['u_'+key,key+'@example.test','','検査スタッフ '+key,role,'b1','active',now]});await c.execute({sql:'INSERT INTO sessions VALUES(?,?,?,?)',args:[crypto.createHash('sha256').update(token).digest('hex'),'u_'+key,now,exp]});}
 await c.execute({sql:'INSERT INTO store VALUES(1,?,?)',args:[JSON.stringify({branches:[{id:'b1',name:'東京'}],availability:{}}),now]});c.close();
}
function startServer(dbPath,writeLimit=0){const child=spawn(process.execPath,['server.js'],{cwd:path.join(ROOT,'server'),env:{...process.env,PORT:'8128',TURSO_DATABASE_URL:'file:'+dbPath,TURSO_AUTH_TOKEN:'',PUBLIC_BASE_URL:BASE,PUBLIC_WRITE_PER_MIN:String(writeLimit),PUBLIC_READ_PER_MIN:'0',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',TOKEN_ENCRYPTION_KEY:'',SMTP_USER:'',SMTP_PASS:'',SEED_ADMIN_EMAIL:''},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);return {child,log:()=>log};}
async function ready(server){for(let i=0;i<80;i++){if(server.child.exitCode!==null)throw Error(server.log());try{if((await api(null,'GET','/api/db')).status===401)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error(server.log());}
async function stop(server){await new Promise(resolve=>{if(server.child.exitCode!==null)return resolve();server.child.once('exit',resolve);server.child.kill();});}
async function staffTests(){
 eq((await api(null,'GET','/api/tally-boards')).status,401,'未ログイン');eq((await api(TOK.intern,'GET','/api/tally-boards')).status,401,'intern');
 eq((await api(TOK.a,'POST','/api/tally-boards',{config:{}})).status,400,'不正表');
 const made=await api(TOK.a,'POST','/api/tally-boards',{config:cfg});eq(made.status,200,'作成');const board=made.json.board;
 eq(/^[a-f0-9]{32}$/.test(board.token),true,'共有鍵');eq(board.url,BASE+'/t/'+board.token,'URL');
 eq((await api(TOK.a,'GET','/api/tally-boards')).json.boards.length,1,'自分一覧');eq((await api(TOK.b,'GET','/api/tally-boards')).json.boards.length,0,'他人一覧');
 eq((await api(TOK.b,'GET','/api/tally-boards/'+board.id)).status,404,'他人読込');eq((await api(TOK.admin,'PUT','/api/tally-boards/'+board.id,{config:cfg,active:false,revision:1})).status,404,'adminも所有者限定');
 let edited={...cfg,description:'変更済み',columns:[cfg.columns[1],{...cfg.columns[0],label:'新しい月曜'}]};
 const saved=await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:edited,active:false,revision:1});eq(saved.status,200,'編集');eq(saved.json.board.revision,2,'表revision');eq(saved.json.board.config.description,'変更済み','説明');eq(saved.json.board.active,false,'停止');
 eq((await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:cfg,active:true,revision:1})).json.code,'stale_board','古い更新');
 eq((await api(TOK.a,'GET','/api/tally-boards/'+board.id)).json.board.config.columns[0].id,'c2','並べ替え保持');
 const reopened=await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:edited,active:true,revision:2});eq(reopened.json.board.active,true,'再開');
 for(const key of ['admin','branch'])eq((await api(TOK[key],'POST','/api/tally-boards',{config:cfg})).status,200,key+'作成');
 for(let i=0;i<29;i++)eq((await api(TOK.b,'POST','/api/tally-boards',{config:cfg})).status,200,'上限前');
 const two=await Promise.all([1,2].map(()=>api(TOK.b,'POST','/api/tally-boards',{config:cfg})));eq(two.map(r=>r.status).sort(),[200,409],'30表同時上限');
 return reopened.json.board;
}

const fresh=board=>({name:'山田',note:'',selected:['r1:c1'],boardRevision:board.revision,submissionKey:crypto.randomBytes(24).toString('hex'),editToken:crypto.randomBytes(24).toString('hex')});
async function publicTests(board){
 const url='/api/tally/'+board.token,body=fresh(board),first=await api(null,'POST',url+'/responses',body);eq(first.status,200,'公開初回');
 const retry=await api(null,'POST',url+'/responses',body);eq(retry.json.responseId,first.json.responseId,'再送同じ回答');
 let data=await api(null,'GET',url);eq(data.json.responses.length,1,'二重登録なし');eq(data.headers.get('cache-control'),'no-store','キャッシュなし');
 const secretKeys=new Set(['editToken','edit_token_hash','submissionKey','submission_key','staff_id','email']);function clean(x){if(!x||typeof x!=='object')return;for(const [k,v] of Object.entries(x)){eq(secretKeys.has(k),false,'非公開キーなし '+k);clean(v);}}clean(data.json);
 eq(JSON.stringify(data.json).includes(body.editToken),false,'生鍵なし');
 eq((await api(null,'POST',url+'/responses',{...body,editToken:crypto.randomBytes(24).toString('hex')})).status,409,'同じ送信鍵の他鍵拒否');
 const same=await api(null,'POST',url+'/responses',{...fresh(board),selected:[]});eq(same.status,200,'同名全不可別人');eq(same.json.responseId===first.json.responseId,false,'同名別ID');
 const link='/api/tally/manage/'+body.editToken,own=await api(null,'GET',link);eq(own.json.response.id,first.json.responseId,'本人読込');eq(own.json.response.answered,['r1:c2','r1:c1'],'現行全マスanswered');
 eq((await api(null,'GET','/api/tally/manage/'+'0'.repeat(48))).status,404,'未知編集鍵');eq((await api(null,'GET','/api/tally/bad')).status,404,'不正共有鍵');
 const edited={name:'更新山田',note:'本人だけ更新',selected:['r1:c2'],boardRevision:board.revision,responseRevision:1};
 const edits=await Promise.all([1,2].map(()=>api(null,'PUT',link,edited)));eq(edits.map(r=>r.status).sort(),[200,409],'同時編集1件成功');eq((await api(null,'GET',link)).json.response.name,'更新山田','読戻し');
 eq((await api(null,'GET',url)).json.responses.find(r=>r.id===same.json.responseId).selected,[],'他人不変');
 eq((await api(null,'POST',url+'/responses',{...fresh(board),selected:['unknown']})).status,400,'未知マス');eq((await api(null,'POST',url+'/responses',{...fresh(board),selected:Array(1489).fill('r1:c1')})).status,400,'過大配列');
 const parallelBody=fresh(board),twice=await Promise.all([1,2].map(()=>api(null,'POST',url+'/responses',parallelBody)));eq(twice.map(r=>r.status),[200,200],'並列初回');eq(twice[0].json.responseId,twice[1].json.responseId,'並列同じID');
 const newer={...board.config,columns:[...board.config.columns,{id:'c3',label:'水曜',active:true}]};
 let save=await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:newer,active:true,revision:board.revision});eq(save.status,200,'列追加');
 eq((await api(null,'POST',url+'/responses',fresh(board))).json.code,'stale_board','古い表拒否');eq((await api(null,'PUT',link,{...edited,responseRevision:2})).json.code,'stale_board','古い本人表拒否');
 data=await api(null,'GET',url);eq(data.json.responses.length,3,'古い入力保存されない');eq(data.json.responses[0].answered.includes('r1:c3'),false,'追加マス未回答');
 board=save.json.board;save=await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:board.config,active:false,revision:board.revision});board=save.json.board;
 eq((await api(null,'POST',url+'/responses',fresh(board))).json.code,'closed','停止新規');eq((await api(null,'PUT',link,{...edited,boardRevision:board.revision,responseRevision:2})).json.code,'closed','停止編集');
 eq((await api(null,'GET',url)).status,200,'停止閲覧');eq((await api(null,'POST',url+'/responses',body)).json.responseId,first.json.responseId,'停止・改版後も既存送信控え');
 save=await api(TOK.a,'PUT','/api/tally-boards/'+board.id,{config:board.config,active:true,revision:board.revision});board=save.json.board;
 eq((await api(null,'PUT',link,{...edited,boardRevision:board.revision,responseRevision:2})).status,200,'再開編集');
 for(let i=3;i<99;i++){const r=await api(null,'POST',url+'/responses',fresh(board));assert.equal(r.status,200,'上限前 '+i);}
 const last=await Promise.all([1,2].map(()=>api(null,'POST',url+'/responses',fresh(board))));eq(last.map(r=>r.status).sort(),[200,409],'同時100人上限');eq((await api(null,'GET',url)).json.responses.length,100,'100人超えない');
 eq((await api(null,'PUT',link,{...edited,boardRevision:board.revision,responseRevision:3})).status,200,'上限でも本人編集');
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ops-tally-')),dbPath=path.join(dir,'test.db');let server;
try{await setupDB(dbPath);server=startServer(dbPath);await ready(server);const board=await staffTests();
 await publicTests(board);
 if(process.argv.includes('--serve')){console.log('STAFF_TOKEN='+TOK.a+'\nSHARE_URL='+BASE+'/t/'+board.token+'\nDB='+dbPath);await new Promise(()=>{});}
 console.log('表で日程調整 E2E: '+count+'件成功');
}catch(e){console.error(e);process.exitCode=1;}finally{if(server)await stop(server);}
