import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.js';
import {password} from '../store.js';
test('Generated output survives storage failure without another OpenAI request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ds-studio-recover-'));let calls=0,storageAvailable=false;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6m0AAAAASUVORK5CYII=','base64');
 const {app,db}=createApp({DATA_DIR:dir,STORAGE_MODE:'local',PUBLIC_URL:'http://localhost',AGENCY_SIGNAGE_SECRET:'mock-recovery-encryption-key-thirty-two'},{request:async()=>{calls++;return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));},saveImage:async()=>{if(!storageAvailable)throw Error('mock storage failure');return {id:'mock-recovered-image'};}});
 db.prepare('INSERT INTO tenants VALUES (?,?)').run('recover','Recover');db.prepare('INSERT INTO users(email,tenant,password,role) VALUES (?,?,?,?)').run('recover@test.local','recover',password('recover-test-password'),'admin');db.prepare('INSERT INTO agency_links(external,tenant,active,kind) VALUES (?,?,1,?)').run(randomUUID(),'recover','crm');app.locals.studio.syncKey('recover','mock-key');db.prepare('UPDATE studio_config SET enabled=1,verified=1,monthly_limit=3').run();
 const id=randomUUID(),job=randomUUID(),data={name:'Recovery',kind:'cover',style:'minimal',notes:'',orientation:'square',background:null,layers:[]};db.prepare('INSERT INTO studio_drafts VALUES (?,?,?,?,1,?)').run(id,'recover',data.name,JSON.stringify(data),Date.now());
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base='http://127.0.0.1:'+server.address().port;
 try{const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'recover@test.local',password:'recover-test-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});await post('/api/studio/drafts/'+id+'/generate',{revision:1,requestId:job,confirmCost:true});
  async function waitFor(status){for(let n=0;n<100;n++){if(db.prepare('SELECT status FROM studio_jobs WHERE id=?').get(job)?.status===status)return;await new Promise(r=>setTimeout(r,10));}throw Error('Expected '+status);}
  await waitFor('storage_failed');assert(db.prepare('SELECT pending FROM studio_jobs WHERE id=?').get(job).pending);const list=await (await fetch(base+'/api/studio/jobs',{headers:{Cookie:cookie}})).json();assert.equal(list[0].pending,undefined);
  storageAvailable=true;assert.equal((await post('/api/studio/jobs/'+job+'/retry-save',{})).status,202);await waitFor('ready');assert.equal(calls,1);assert.equal(db.prepare('SELECT pending FROM studio_jobs WHERE id=?').get(job).pending,null);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});}
});
test('Studio tenant keys, eligibility, layers, quotas, idempotency and explicit export (mock OpenAI only)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ds-studio-')),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6m0AAAAASUVORK5CYII=','base64');let calls=0,uncertain=false,lastBody;
 const {app,db}=createApp({DATA_DIR:dir,STORAGE_MODE:'local',PUBLIC_URL:'http://localhost:3080',AGENCY_SIGNAGE_SECRET:'test-encryption-secret-for-studio-12345'},{request:async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer tenant-key-test');if(url.includes('/models/'))return new Response(JSON.stringify({id:'gpt-image-2'}));calls++;lastBody=options.body;if(uncertain)throw Error('simulated timeout');return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}}),{headers:{'x-request-id':'mock-only'}});
 }});
 for(const id of ['a','b','standalone']){db.prepare('INSERT INTO tenants VALUES (?,?)').run(id,id);db.prepare('INSERT INTO users(email,tenant,password,role) VALUES (?,?,?,?)').run(id+'@test.local',id,password('studio-test-password'),'admin');if(id!=='standalone')db.prepare('INSERT INTO agency_links(external,tenant,active,kind) VALUES (?,?,1,?)').run(randomUUID(),id,'crm');}
 db.prepare('INSERT INTO users(email,tenant,password,role) VALUES (?,?,?,?)').run('viewer@test.local','a',password('studio-test-password'),'viewer');
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base='http://127.0.0.1:'+server.address().port;
 async function req(path,cookie,body,method){return fetch(base+path,{method:method||(body?'POST':'GET'),headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});}
 async function login(name){const r=await req('/api/login',null,{email:name+'@test.local',password:'studio-test-password'});return r.headers.get('set-cookie').split(';')[0];}
 try{const a=await login('a'),b=await login('b'),independent=await login('standalone'),viewer=await login('viewer');
  assert.equal((await req('/api/studio/drafts',independent)).status,403);assert.equal((await req('/api/studio/drafts',viewer)).status,403);
  assert.equal((await (await req('/api/studio/config',a)).json()).hasKey,false);
  app.locals.studio.syncKey('a','tenant-key-test');assert(!db.prepare('SELECT secret FROM studio_config WHERE tenant=?').get('a').secret.includes('tenant-key-test'));
  assert.equal((await req('/api/studio/config',a,{enabled:true,monthlyLimit:2})).status,200);assert.equal((await req('/api/studio/verify',a,{})).status,200);
  assert.equal((await (await req('/api/studio/config',b)).json()).hasKey,false);assert(!JSON.stringify(await (await req('/api/studio/config',a)).json()).includes('tenant-key-test'));
  const data={name:'Promo',kind:'promotion',orientation:'portrait',style:'Elegant',notes:'Restaurant dish',background:null,layers:[{text:'$19.95 · 555-0101',x:8,y:70,size:48,color:'#ffffff'}]};
  const d=await (await req('/api/studio/drafts',a,data)).json();assert.equal((await req('/api/studio/drafts/'+d.id,b)).status,404);assert.equal((await req('/api/studio/drafts/'+d.id,b,{data,revision:d.revision},'PUT')).status,409);
  const jobId=randomUUID(),generate={requestId:jobId,revision:d.revision,confirmCost:true};assert.equal((await req('/api/studio/drafts/'+d.id+'/generate',a,{...generate,confirmCost:false})).status,400);
  assert.equal((await req('/api/studio/drafts/'+d.id+'/generate',a,generate)).status,202);
  async function wait(id){for(let n=0;n<100;n++){const row=db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(id);if(!['processing','saving'].includes(row.status))return row;await new Promise(r=>setTimeout(r,10));}throw Error('Job did not finish');}
  const job=await wait(jobId);assert.equal(job.status,'ready');assert.equal(calls,1);assert.equal(JSON.parse(job.usage).total_tokens,30);assert.equal(JSON.parse(lastBody).n,1);assert(!JSON.parse(lastBody).prompt.includes('555-0101'));
  await req('/api/studio/drafts/'+d.id+'/generate',a,generate);assert.equal(calls,1);
  assert.equal((await (await req('/api/state',a)).json()).assets.length,0);assert.equal((await req('/api/assets/'+job.asset+'/media',b)).status,404);
  const edited=await (await req('/api/studio/drafts/'+d.id,a,{revision:1,data:{...data,background:job.asset}},'PUT')).json();assert.equal(edited.data.layers[0].text,'$19.95 · 555-0101');assert.equal((await req('/api/studio/drafts/'+d.id,a,{revision:1,data},'PUT')).status,409);
  const exportResult=await fetch(base+'/api/studio/drafts/'+d.id+'/export',{method:'POST',headers:{Cookie:a,'Content-Type':'image/png','X-Studio-Revision':'2'},body:png});assert.equal(exportResult.status,201);assert.equal((await (await req('/api/state',a)).json()).assets.length,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n,0);
  uncertain=true;const id2=randomUUID();await req('/api/studio/drafts/'+d.id+'/generate',a,{...generate,requestId:id2,revision:2});assert.equal((await wait(id2)).status,'uncertain');assert(lastBody instanceof FormData);assert(lastBody.get('image') instanceof Blob);assert.equal(calls,2);
  assert.equal((await req('/api/studio/drafts/'+d.id+'/generate',a,{...generate,requestId:randomUUID(),revision:2})).status,429);
  db.prepare('UPDATE agency_links SET active=0 WHERE tenant=?').run('a');assert.equal((await req('/api/studio/drafts',a)).status,403);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});}
});
