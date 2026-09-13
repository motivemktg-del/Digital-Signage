const {chromium}=require('C:/Users/MAKRO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{const {createApp}=await import('../server.js'),{password}=await import('../store.js');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ds-send-ui-'));
 const {app,db}=createApp({DATA_DIR:dir,STORAGE_MODE:'local',PUBLIC_URL:'http://127.0.0.1:3098'});
 db.prepare("INSERT INTO tenants VALUES ('ui','Restaurante')").run();db.prepare("INSERT INTO users(email,tenant,password) VALUES ('ui@test.local','ui',?)").run(password('ui-test-password'));
 db.prepare("INSERT INTO devices(id,secret,tenant,name,version) VALUES ('tv','test-secret','ui','Recepción','previous')").run();
 const server=await new Promise(r=>{const s=app.listen(3098,'127.0.0.1',()=>r(s));}),browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3098');await page.locator('#loginForm [name=email]').fill('ui@test.local');await page.locator('#loginForm [name=password]').fill('ui-test-password');await page.locator('#loginForm .primary').click();await page.locator('.send-content-button').waitFor();
 await page.locator('.send-content-button').click();await page.locator('#sendUpload').click();await page.locator('#upload').setInputFiles({name:'welcome.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=','base64')});await page.waitForFunction(()=>state.assets.length===1);
 await page.locator('[data-view=screens]').click();await page.locator('.send-content-button').click();const asset=db.prepare('SELECT id FROM assets').get().id;await page.locator('#sendContentForm [name=content]').selectOption(asset);assert.equal(db.prepare("SELECT playlist FROM devices WHERE id='tv'").get().playlist,null);
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Overflow '+width);}
 await page.locator('#sendPublish').click();await page.locator('#sendContentDialog').waitFor({state:'hidden'});assert(db.prepare("SELECT playlist FROM devices WHERE id='tv'").get().playlist);assert.equal(db.prepare("SELECT version FROM devices WHERE id='tv'").get().version,'previous');
 await page.locator('.send-content-button').click();await page.locator('#sendContentForm [name=kind]').selectOption('playlist');await page.locator('#sendContentForm [name=content]').selectOption(db.prepare('SELECT id FROM playlists').get().id);await page.locator('#sendPublish').click();await page.locator('#sendContentDialog').waitFor({state:'hidden'});
 fs.mkdirSync('output',{recursive:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/send-content-mobile.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS: upload, explicit image/list publication, real pending version, mobile layouts.');
 }finally{await browser.close();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

