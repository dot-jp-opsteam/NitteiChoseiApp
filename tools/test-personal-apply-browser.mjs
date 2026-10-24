import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function runPersonalApplyBrowserTests(browser,base='http://localhost:8123'){
  const results=[];
  const output=mkdtempSync(path.join(os.tmpdir(),'ops-personal-apply-'));
  for(const mobile of [false,true]){
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:'Asia/Tokyo',locale:'ja-JP'});
    try{
      const response=await context.request.get(base+'/api/staff/intern-invite-url',{headers:{Authorization:'Bearer e2etoken_staff'}});
      assert.equal(response.status(),200);
      const link=await response.json();
      const page=await context.newPage();
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(link.url);
      await page.locator('.apply-staff-name').waitFor();
      assert.match(await page.locator('.apply-staff-name').innerText(),/E2E-staff/);
      assert.equal(await page.locator('select').count(),0);
      await page.locator('td.bt-c.ok').first().waitFor();
      const screenshot=path.join(output,mobile?'mobile.png':'desktop.png');
      await page.screenshot({path:screenshot,fullPage:true});
      const name='個人リンク画面検査 '+(mobile?'mobile':'desktop');
      await page.locator('#applyname').fill(name);
      await page.locator('td.bt-c.ok').first().click();
      await page.locator('#applybtn').click();
      const sent=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/apply/'));
      await page.locator('#applybtn').click();
      assert.equal('staff_id' in (await sent).postDataJSON(),false);
      await page.getByText('申請した内容（控え）',{exact:true}).waitFor();
      const db=await (await context.request.get(base+'/api/db',{headers:{Authorization:'Bearer e2etoken_staff'}})).json();
      assert.equal(db.interviews.find(item=>item.intern_name===name)?.staff_id,link.staff_id);
      assert.deepEqual(errors,[]);
      results.push({screen:mobile?'mobile':'desktop',fixedStaff:true,autoLoadedSlots:true,submittedToOwner:true,screenshot});
      if(!mobile){
        await page.goto(base+'/i/legacy_e2e_branch_link');
        await page.locator('select').waitFor();
        await page.locator('select').selectOption('u_e2e_staff3');
        await page.locator('td.bt-c.ok').first().waitFor();
        await page.locator('#applyname').fill('旧共通リンク画面検査');
        await page.locator('td.bt-c.ok').first().click();
        await page.locator('#applybtn').click();
        await page.locator('#applybtn').click();
        await page.getByText('申請した内容（控え）',{exact:true}).waitFor();
        const oldDb=await (await context.request.get(base+'/api/db',{headers:{Authorization:'Bearer e2etoken_staff3'}})).json();
        assert.equal(oldDb.interviews.find(item=>item.intern_name==='旧共通リンク画面検査')?.staff_id,'u_e2e_staff3');
        results.push({legacyStaffSelectionAndSubmission:true});
      }
    }finally{await context.close();}
  }
  return results;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {chromium}=createRequire(import.meta.url)('playwright');
  const browser=await chromium.launch();
  try{console.log(JSON.stringify(await runPersonalApplyBrowserTests(browser),null,2));}
  finally{await browser.close();}
}
