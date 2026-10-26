/* 起動・再読み込みのときに、ホームが「現れる動き付き」で何度も描き直されない（ちらつかない）ことの画面検査。
   tools/test-tally-e2e.mjs --serve の専用localhost:8129で、ダミーのスタッフ tly_token_a として動かす。
   Googleの予定は偽の応答で返し、予定が届くたびに描き直しが起きる状況を作る */
export async function runBootBrowserTests(browser){
  const out=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});
  try{
    await ctx.addInitScript(()=>{
      localStorage.setItem('ops_token_v1','tly_token_a');
      window.__renders=[];
      document.addEventListener('DOMContentLoaded',()=>{
        for(const name of ['render','renderQuiet']){
          const original=window[name];
          window[name]=function(){window.__renders.push(name);return original.apply(this,arguments);};
        }
      });
    });
    const page=await ctx.newPage();
    const now=Date.now();
    await page.route('**/api/my-calendar/events*',route=>route.fulfill({json:{connected:true,events:[{id:'g1',title:'自分の予定',start:new Date(now).toISOString(),end:new Date(now+3600000).toISOString(),allDay:false}]}}));
    await page.route('**/api/shared-calendar/events*',route=>route.fulfill({json:{configured:true,name:'共有',calendarId:'x',events:[{id:'s1',title:'共有予定',start:new Date(now).toISOString(),allDay:false}]}}));
    await page.goto('http://localhost:8129/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__renders.length>=3&&document.querySelector('#main .view'));
    await page.waitForTimeout(800);
    const renders=await page.evaluate(()=>window.__renders);
    check(renders.filter(name=>name==='render').length===1,'起動のあと、現れる動き付きの描き直しが何度も起きる（ちらつく）：'+renders.join(','));
    check(renders.filter(name=>name==='renderQuiet').length>=2,'予定が届いたとき静かに描き直されない：'+renders.join(','));
    out.push({label:'起動時の描き直しは1回だけ動き付き、予定が届いたときは静かに描く',ok:true});
  }finally{await ctx.close();}
  return out;
}
