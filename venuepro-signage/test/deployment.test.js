import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
test('VPS configuration preserves agency secrets and unrelated CRM settings on rerun',()=>{
 const dir=mkdtempSync(join(tmpdir(),'signage-deploy-'));const crmPath=join(dir,'backend.env'),signagePath=join(dir,'signage.env');
 try{
  writeFileSync(crmPath,'DATABASE_URL=postgres://private\nJWT_SECRET=keep-this\n');
  const run=()=>spawnSync(process.execPath,[resolve('scripts/configure-vps.mjs')],{encoding:'utf8',input:JSON.stringify({BUNNY_STORAGE_ZONE:'test-zone',BUNNY_STORAGE_PASSWORD:'test$key#literal',BUNNY_STORAGE_HOST:'storage.bunnycdn.com'}),env:{...process.env,SIGNAGE_ENV_PATH:signagePath,CRM_ENV_PATH:crmPath,TRAEFIK_NETWORK:'crm_network'}});
  const first=run();assert.equal(first.status,0,first.stderr);const initial=readFileSync(signagePath,'utf8'),settings=parseEnv(initial);assert.equal(settings.AGENCY_SIGNAGE_SECRET.length,64);assert.equal(settings.TRAEFIK_NETWORK,'crm_network');
  const crm=parseEnv(readFileSync(crmPath,'utf8'));assert.equal(crm.JWT_SECRET,'keep-this');assert.equal(crm.AGENCY_SIGNAGE_SECRET,settings.AGENCY_SIGNAGE_SECRET);assert(!first.stdout.includes('test$key'));
  assert.equal(run().status,0);assert.equal(readFileSync(signagePath,'utf8'),initial);
  writeFileSync(crmPath,'AGENCY_SIGNAGE_SECRET='+ 'f'.repeat(64)+'\n');assert.equal(run().status,1);assert.equal(readFileSync(signagePath,'utf8'),initial);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
