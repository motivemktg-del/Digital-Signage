const {chromium}=require('C:/Users/MAKRO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.TEST_URL||'http://localhost:3081/');await page.locator('#loginForm [name=email]').fill('demo@signage.local');await page.locator('#loginForm [name=password]').fill('Signage-demo-local-2026');await page.locator('#loginForm .primary').click();await page.locator('#shell').waitFor({state:'visible'});
 await page.locator('[data-view=library]').click();const card=page.locator('.asset-card').first();
 await card.locator('.asset-preview').click();await page.locator('#previewDialog').waitFor({state:'visible'});await page.locator('#previewDialog [data-close]').click();
 const name='Tarjeta verificada '+Date.now();await card.locator('.asset-name').click();await page.locator('#renameAssetName').fill(name);await page.locator('#renameAssetForm .primary').click();await page.locator('#renameAssetDialog').waitFor({state:'hidden'});assert.equal(await card.locator('.asset-name span').first().textContent(),name);
 await card.locator('select').selectOption('__new');await page.locator('#listName').fill('Asignación desde tarjeta '+Date.now());await page.locator('#playlistForm .primary').click();await page.locator('#playlistDialog').waitFor({state:'hidden'});
 await page.locator('[data-view=library]').click();assert(await card.locator('option:disabled').count()>0);
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/cards-mobile.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS: thumbnail preview, name editing, create-list assignment, duplicate indicator and responsive cards.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
