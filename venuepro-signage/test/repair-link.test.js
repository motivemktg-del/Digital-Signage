import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../store.js';
import {expected,repair} from '../scripts/repair-david-link.mjs';
test('Repair only the diagnosed empty link, preserve media and devices, invalidate old agency sessions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ds-repair-')),db=openStore(dir);
 try{
  db.exec('CREATE TABLE agency_links(external TEXT PRIMARY KEY,tenant TEXT,active INTEGER,kind TEXT);CREATE TABLE agency_tickets(hash TEXT,email TEXT,external TEXT,expires INTEGER);');
  for(const id of [expected.empty,expected.existing])db.prepare('INSERT INTO tenants VALUES (?,?)').run(id,id);
  db.prepare("INSERT INTO agency_links VALUES (?,?,1,'crm')").run(expected.external,expected.empty);
  const email='agency:'+expected.external+':test';db.prepare('INSERT INTO users(email,tenant,password) VALUES (?,?,?)').run(email,expected.empty,'not-used');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('session',email,9999999999999);db.prepare('INSERT INTO agency_tickets VALUES (?,?,?,?)').run('ticket',email,expected.external,9999999999999);
  db.prepare('INSERT INTO devices(id,secret,tenant,name) VALUES (?,?,?,?)').run('screen','secret',expected.existing,'Entrada');
  db.prepare('INSERT INTO locations VALUES (?,?,?)').run('new-location',expected.empty,'Unexpected data');
  assert.throws(()=>repair(db),/ya tiene datos/);assert.equal(db.prepare('SELECT tenant FROM agency_links').get().tenant,expected.empty);assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);
  db.prepare('DELETE FROM locations').run();assert.equal(repair(db).changed,true);assert.equal(db.prepare('SELECT tenant FROM users WHERE email=?').get(email).tenant,expected.existing);assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM agency_tickets').get().n,0);assert.equal(db.prepare('SELECT secret FROM devices').get().secret,'secret');assert.equal(db.prepare('SELECT COUNT(*) n FROM tenants').get().n,2);assert.equal(repair(db).changed,false);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
