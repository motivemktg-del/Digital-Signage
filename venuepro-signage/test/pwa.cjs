const {chromium}=require('C:/Users/MAKRO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'});
  const page=await context.newPage();await page.goto('http://localhost:3080/');
  const manifest=await (await context.request.get('http://localhost:3080/manifest.webmanifest')).json();
  assert.equal(manifest.display,'standalone');assert.equal(manifest.scope,'/');
  for(const icon of manifest.icons)assert.equal((await context.request.get('http://localhost:3080'+icon.src)).status(),200);
  await page.locator('#login [data-install]').click();await page.locator('#installDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#installSteps').textContent(),/Safari/);await page.locator('#installClose').click();
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  assert.match(await page.evaluate(()=>navigator.serviceWorker.controller.scriptURL),/\/sw.js$/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const cached=await page.evaluate(async()=>{let urls=[];for(const key of await caches.keys())for(const req of await (await caches.open(key)).keys())urls.push(req.url);return urls;});
  assert(!cached.some(url=>url.includes('/api/')||new URL(url).pathname==='/'));
  await context.setOffline(true);await page.reload();assert.match(await page.textContent('h1'),/Sin conexión/);
  await context.setOffline(false);await page.locator('a').click();await page.locator('#loginForm').waitFor();
  console.log('PWA: manifest, icons, iOS install guide, private cache exclusion, offline fallback and recovery passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
