const {chromium}=require('C:/Users/MAKRO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const admin=await browser.newContext({viewport:{width:390,height:844}}),page=await admin.newPage();const base=process.env.TEST_URL||'http://localhost:3082';
 await page.goto(base);await page.locator('#loginForm [name=email]').fill('demo@signage.local');await page.locator('#loginForm [name=password]').fill('Signage-demo-local-2026');await page.locator('#loginForm .primary').click();await page.locator('#shell').waitFor({state:'visible'});
 const context=await browser.newContext({viewport:{width:1280,height:720}}),player=await context.newPage();await player.goto(base+'/player.html');await player.locator('#qr').waitFor({state:'visible'});const code=await player.locator('#code').textContent();
 const device=await page.evaluate(async code=>{await api('/api/pair/claim',{code,name:'Rotación · '+code});const s=await api('/api/state'),d=s.devices.find(d=>d.name==='Rotación · '+code);await api('/api/devices/'+d.id+'/assign',{playlist:s.playlists[0].id});await load();return d.id;},code);
 await page.locator('[data-all-screens]').click();const options=page.locator('.device-card').filter({has:page.locator(`[data-device-display="${device}"]`)});await options.locator('summary').click();await options.locator('[data-device-display]').click();
 await page.locator('#displayForm [name=orientation]').selectOption('portrait');await page.locator('#displayForm [name=rotation]').selectOption('180');await page.locator('#displayForm .primary').click();await page.locator('#displayDialog').waitFor({state:'hidden'});
 await player.evaluate(()=>sync());await player.waitForFunction(()=>document.querySelector('#stage>img'));
 for(const rotation of [0,90,180,270]){
  await page.evaluate(async({device,rotation})=>api('/api/devices/'+device+'/display',{orientation:'auto',rotation,fit:'cover'}),{device,rotation});await player.evaluate(()=>sync());
  const result=await player.locator('#stage>img').evaluate(el=>{const rect=el.getBoundingClientRect();return {w:rect.width,h:rect.height,fit:getComputedStyle(el).objectFit,position:getComputedStyle(el).objectPosition};});assert(Math.abs(result.w-1280)<1);assert(Math.abs(result.h-720)<1);assert.equal(result.fit,'cover');assert.equal(result.position,'50% 50%');
 }
 await page.evaluate(async device=>api('/api/devices/'+device+'/display',{orientation:'portrait',rotation:0,fit:'contain'}),device);await player.evaluate(()=>sync());
 await context.setOffline(true);await player.reload();await player.waitForFunction(()=>document.querySelector('#stage>img'));
 assert.equal(await player.locator('#stage>img').evaluate(el=>getComputedStyle(el).objectFit),'contain');assert.deepEqual(await player.evaluate(()=>manifest.display),{orientation:'portrait',rotation:0,fit:'contain'});
 await player.setViewportSize({width:720,height:1280});assert.deepEqual(await player.evaluate(()=>displayGeometry(innerWidth,innerHeight,manifest.display)),{angle:0,width:720,height:1280});
 // Reopen after a fresh state fetch to verify persisted values, not stale controls.
 await page.evaluate(()=>load());await page.locator(`[data-device-display="${device}"]`).locator('..').locator('..').locator('summary').click();await page.locator(`[data-device-display="${device}"]`).click();assert.equal(await page.locator('#displayForm [name=fit]').inputValue(),'contain');
 await page.screenshot({path:'output/display-settings.png'});console.log('PASS: mobile settings, four rotations, aspect-preserving fit, viewport resize and offline settings persistence.');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
