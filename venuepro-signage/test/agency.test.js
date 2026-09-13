import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
test('Signed agency link, tenant SSO, replay protection and unlink revocation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'signage-agency-')),key='integration-test-secret-with-more-than-32-chars';
 const {app,db}=createApp({DATA_DIR:dir,STORAGE_MODE:'local',PUBLIC_URL:'http://localhost:3080',AGENCY_SIGNAGE_SECRET:key});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base='http://127.0.0.1:'+server.address().port;
 function signed(path,body){const raw=body?JSON.stringify(body):'',method=body?'POST':'GET',ts=String(Date.now()),nonce=randomUUID();return {method,headers:{'Content-Type':'application/json','X-Agency-Time':ts,'X-Agency-Nonce':nonce,'X-Agency-Signature':createHmac('sha256',key).update([ts,nonce,method,path,raw].join('\n')).digest('hex')},body:raw||undefined};}
 try{
  const accountPath='/api/agency/accounts',accountBody={name:'Restaurante independiente',email:'restaurant@example.test',password:'Restaurant-test-2026'};
  assert.equal((await fetch(base+accountPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(accountBody)})).status,401);
  const created=await fetch(base+accountPath,signed(accountPath,accountBody));assert.equal(created.status,201);const account=await created.json();assert(account.id);assert.equal(account.password,undefined);
  assert.equal((await fetch(base+accountPath,signed(accountPath,accountBody))).status,409);
  assert.equal((await (await fetch(base+accountPath,signed(accountPath))).json()).length,1);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:accountBody.email,password:accountBody.password})});assert.equal(login.status,200);
  const standaloneCookie=login.headers.get('set-cookie').split(';')[0];const standaloneState=await (await fetch(base+'/api/state',{headers:{Cookie:standaloneCookie}})).json();assert.equal(standaloneState.tenant,accountBody.name);assert.equal(standaloneState.role,'admin');assert.equal(standaloneState.assets.length,0);
  assert.equal((await (await fetch(base+'/api/agency/links',signed('/api/agency/links'))).json()).length,0);
  const standaloneTicket=await (await fetch(base+'/api/agency/ticket',signed('/api/agency/ticket',{external:account.id,user:'platform:owner'}))).json();assert(standaloneTicket.url.includes('#ticket='));
  const external=randomUUID(),path='/api/agency/link',options=signed(path,{external,name:'Agency tenant',active:true});
  assert.equal((await fetch(base+path,options)).status,200);assert.equal((await fetch(base+path,options)).status,401);
  const forged=signed(path,{external,name:'Agency tenant',active:false});forged.body=JSON.stringify({external,name:'Stolen',active:true});assert.equal((await fetch(base+path,forged)).status,401);
  const ticket=await (await fetch(base+'/api/agency/ticket',signed('/api/agency/ticket',{external,user:'owner-1'}))).json();const value=new URL(ticket.url).hash.slice(8);
  const consume=()=>fetch(base+'/api/agency/consume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:value})});
  const consumed=await consume();assert.equal(consumed.status,200);assert.equal((await consume()).status,401);const cookie=consumed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/state',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await fetch(base+path,signed(path,{external,name:'Agency tenant',active:false}))).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(base+'/api/agency/ticket',signed('/api/agency/ticket',{external,user:'owner-1'}))).status,403);
 }finally{await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});}
});
