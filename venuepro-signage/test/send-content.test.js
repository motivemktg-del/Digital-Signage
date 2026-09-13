import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {password} from '../store.js';
test('Explicit publication and signed CRM management preserve tenant isolation and actual sync',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ds-send-')),key='test-only-agency-secret-more-than-32';
 const {app,db}=createApp({DATA_DIR:dir,STORAGE_MODE:'local',PUBLIC_URL:'http://localhost:3080',AGENCY_SIGNAGE_SECRET:key});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base='http://127.0.0.1:'+server.address().port;
 async function manage(body,path='/api/agency/manage'){const raw=JSON.stringify(body),ts=String(Date.now()),nonce=randomUUID();return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Agency-Time':ts,'X-Agency-Nonce':nonce,'X-Agency-Signature':createHmac('sha256',key).update([ts,nonce,'POST',path,raw].join('\n')).digest('hex')},body:raw});}
 try{
  for(const tenant of ['a','b']){db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenant,tenant);db.prepare("INSERT INTO agency_links VALUES (?,?,1,'crm')").run(tenant,tenant);db.prepare('INSERT INTO devices(id,secret,tenant,name,version,paused) VALUES (?,?,?,?,?,1)').run(tenant,'secret-'+tenant,tenant,'TV '+tenant,'old-version');db.prepare('INSERT INTO assets(id,tenant,name,type,size,sha,path) VALUES (?,?,?,?,?,?,?)').run(tenant,tenant,'Image','image/png',1,'hash',tenant);}
  await writeFile(join(dir,'media','a'),Buffer.from([137,80,78,71]));
  const media=await manage({external:'a',asset:'a'},'/api/agency/media');assert.equal(media.status,200);assert.match(media.headers.get('content-type'),/image\/png/);assert.equal((await media.arrayBuffer()).byteLength,4);
  assert.equal((await manage({external:'b',asset:'a'},'/api/agency/media')).status,404);
  const body={external:'a',action:'content',device:'a',asset:'a',seconds:10,confirm:true};
  assert.equal((await manage({...body,confirm:false})).status,400);
  for(const extra of [{device:'b'},{asset:'b'}])assert.equal((await manage({...body,...extra})).status,404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n,0);
  assert.equal((await manage(body)).status,200);const count=db.prepare('SELECT COUNT(*) n FROM playlists').get().n;
  assert.equal((await manage(body)).status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM playlists').get().n,count);
  const state=await (await manage({external:'a',action:'state'})).json();assert.equal(state.workspaceId,'a');assert.equal(state.devices.length,1);assert.equal(state.assets.length,1);assert.equal(state.devices[0].paused,1);assert.equal(state.devices[0].version,'old-version');assert.notEqual(state.devices[0].targetVersion,'old-version');assert.equal(state.devices[0].secret,undefined);
  assert.equal((await manage({...body,asset:undefined,playlist:state.playlists[0].id})).status,200);
  db.prepare("INSERT INTO users(email,tenant,password,role) VALUES ('viewer@test.local','a',?,'viewer')").run(password('viewer-test-password'));
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'viewer@test.local',password:'viewer-test-password'})});
  assert.equal((await fetch(base+'/api/devices/a/content',{method:'POST',headers:{'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]},body:JSON.stringify(body)})).status,403);
  db.prepare("UPDATE agency_links SET active=0 WHERE external='a'").run();assert.equal((await manage(body)).status,403);
  db.prepare("UPDATE agency_links SET kind='standalone' WHERE external='b'").run();assert.equal((await manage({external:'b',action:'state'})).status,403);
  assert.equal((await fetch(base+'/api/agency/manage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});}
});
