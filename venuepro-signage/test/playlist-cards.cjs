const {chromium}=require('C:/Users/MAKRO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.TEST_URL||'http://localhost:3081/');await page.locator('#loginForm [name=email]').fill('demo@signage.local');await page.locator('#loginForm [name=password]').fill('Signage-demo-local-2026');await page.locator('#loginForm .primary').click();await page.locator('#shell').waitFor({state:'visible'});
 const fixture=await page.evaluate(async()=>{const s=await api('/api/state');const p=await api('/api/playlists',{name:'Portada · Prueba',items:s.assets.slice(0,2).map(a=>({asset:a.id,seconds:10}))});return {id:p.id,device:s.devices[0].id};});
 await page.reload();await page.locator('#shell').waitFor({state:'visible'});await page.locator('[data-view=playlists]').click();const card=page.locator(`[data-playlist-card="${fixture.id}"]`);
 await card.locator('img').waitFor();assert(await card.locator('img').evaluate(e=>e.complete&&e.naturalWidth>0));
 assert.equal(await card.locator('.playlist-slides span').textContent(),'1 / 2');await card.locator('[aria-label="Archivo siguiente"]').click();assert.equal(await card.locator('.playlist-slides span').textContent(),'2 / 2');
 await card.locator('.playlist-media').click();await page.locator('#previewDialog').waitFor({state:'visible'});await page.locator('#previewDialog [data-close]').click();
 await card.locator('select').selectOption(fixture.device);await page.waitForFunction(({id,device})=>state.devices.some(d=>d.id===device&&d.playlist===id),fixture);
 assert.equal(await card.locator(`option[value="${fixture.device}"]`).isDisabled(),true);
 await card.locator('[data-action=editList]').click();await page.locator('#playlistDialog').waitFor({state:'visible'});await page.locator('#playlistDialog [data-close]').click();
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.setViewportSize({width:390,height:844});await card.screenshot({path:'output/playlist-card.png'});assert.deepEqual(errors,[]);
 console.log('PASS: real cover, slide navigation, preview, screen assignment, edit and responsive layout.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
