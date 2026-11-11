/* e2e --browser専用。通常起動と本番には読み込まれない、架空スタッフの入口。 */
const path=require('node:path');
const os=require('node:os');
const {createRequire}=require('node:module');
const url=process.env.TURSO_DATABASE_URL||'';
const tmp=path.resolve(os.tmpdir());
if(process.env.PORT!=='8123'||process.env.PUBLIC_BASE_URL!=='http://localhost:8123'||!url.startsWith('file:')||!path.resolve(url.slice(5)).startsWith(tmp+path.sep)||!path.basename(path.dirname(path.resolve(url.slice(5)))).startsWith('ops-e2e-')||process.env.GOOGLE_CLIENT_ID||process.env.SMTP_USER)throw Error('ローカルの一時テストDBでのみ起動できます');
const express=createRequire(path.join(__dirname,'../server/package.json'))('express');
const init=express.application.init;
express.application.init=function(...args){init.apply(this,args);
 this.get('/__local-review',(req,res)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.sendStatus(403);
  res.set('Cache-Control','no-store').type('html').send('<!doctype html><meta charset="utf-8"><title>ローカル検証用</title><p>架空のスタッフでテストアプリを開きます。</p><script>sessionStorage.setItem("ops_token_v1","e2etoken_staff");location.replace("/");</script>');
 });
};
