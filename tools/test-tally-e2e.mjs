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
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ops-tally-')),dbPath=path.join(dir,'test.db');let server;
try{await setupDB(dbPath);server=startServer(dbPath);await ready(server);const board=await staffTests();
 // PUBLIC_TESTS
 if(process.argv.includes('--serve')){console.log('STAFF_TOKEN='+TOK.a+'\nSHARE_URL='+BASE+'/t/'+board.token+'\nDB='+dbPath);await new Promise(()=>{});}
 console.log('表で日程調整 E2E: '+count+'件成功');
}catch(e){console.error(e);process.exitCode=1;}finally{if(server)await stop(server);}
