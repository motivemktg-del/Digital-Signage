import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';

export const expected={external:'6ea4a825-be19-4174-97b0-d3677c5032d5',empty:'24f8d023-7252-407b-8aba-c6259ebc098f',existing:'f594c8d6-6d89-472a-876d-4894e60cd5fb'};
export function repair(db){
 db.exec('BEGIN IMMEDIATE');
 try{
  const link=db.prepare('SELECT * FROM agency_links WHERE external=?').get(expected.external);
  if(!link||link.kind!=='crm'||link.active!==1)throw Error('El vínculo CRM no coincide con el diagnóstico.');
  if(link.tenant===expected.existing){db.exec('COMMIT');return {changed:false,workspaceId:expected.existing};}
  if(link.tenant!==expected.empty)throw Error('El espacio vinculado cambió; revisar antes de continuar.');
  if(!db.prepare('SELECT 1 FROM tenants WHERE id=?').get(expected.existing))throw Error('No existe el espacio con contenido.');
  if(db.prepare('SELECT 1 FROM agency_links WHERE tenant=?').get(expected.existing))throw Error('El espacio con contenido ya tiene otro vínculo.');
  for(const table of ['devices','assets','playlists','schedules','locations','studio_drafts','studio_jobs']){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare(`SELECT 1 FROM ${table} WHERE tenant=? LIMIT 1`).get(expected.empty))throw Error('El espacio anterior ya tiene datos en '+table+'. No se modificó el vínculo.');
  }
  const prefix='agency:'+expected.external+':';
  const users=db.prepare('SELECT email,tenant FROM users WHERE substr(email,1,?)=?').all(prefix.length,prefix);
  if(users.some(u=>u.tenant!==expected.empty))throw Error('Los accesos CRM no coinciden con el espacio anterior.');
  db.prepare('DELETE FROM agency_tickets WHERE external=?').run(expected.external);
  for(const user of users){db.prepare('DELETE FROM sessions WHERE email=?').run(user.email);db.prepare('UPDATE users SET tenant=? WHERE email=?').run(expected.existing,user.email);}
  db.prepare('UPDATE agency_links SET tenant=? WHERE external=?').run(expected.existing,expected.external);
  db.exec('COMMIT');
  return {changed:true,workspaceId:expected.existing,screens:db.prepare('SELECT COUNT(*) n FROM devices WHERE tenant=?').get(expected.existing).n,assets:db.prepare('SELECT COUNT(*) n FROM assets WHERE tenant=? AND archived=0').get(expected.existing).n};
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
if(process.argv.includes('--apply-david-link')){
 const dir=process.env.DATA_DIR||'/app/data',db=new DatabaseSync(join(dir,'signage.sqlite'));
 try{
  db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
  const backup=join(dir,'before-david-link-'+Date.now()+'.sqlite');
  db.prepare('VACUUM INTO ?').run(backup);chmodSync(backup,0o600);
  console.log('Respaldo privado creado:',backup);
  console.log(JSON.stringify(repair(db),null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}finally{db.close();}
}
