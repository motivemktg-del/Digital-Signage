import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { token, hash, password } from './store.js';
import express from 'express';
export function installAgency(app,db,env,origin,deviceManifest){
 db.exec('CREATE TABLE IF NOT EXISTS agency_uploads(hash TEXT PRIMARY KEY,external TEXT NOT NULL,tenant TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,expires INTEGER NOT NULL)');
 if(!db.prepare('PRAGMA table_info(agency_uploads)').all().some(c=>c.name==='purpose'))db.exec("ALTER TABLE agency_uploads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'upload';ALTER TABLE agency_uploads ADD COLUMN revision INTEGER");
 db.exec(`CREATE TABLE IF NOT EXISTS agency_links (external TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS agency_nonces (nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS agency_tickets (hash TEXT PRIMARY KEY,email TEXT NOT NULL REFERENCES users(email),external TEXT NOT NULL,expires INTEGER NOT NULL);`);
 if(!db.prepare('PRAGMA table_info(agency_links)').all().some(c=>c.name==='kind'))db.exec("ALTER TABLE agency_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'crm'");
 const protect=(req,res,next)=>{
  const key=env.AGENCY_SIGNAGE_SECRET,ts=req.headers['x-agency-time'],nonce=req.headers['x-agency-nonce'],sig=req.headers['x-agency-signature'];
  if(!key||key.length<32)return res.status(503).json({error:'Integración de agencia no configurada.'});
  if(!/^\d{13}$/.test(ts||'')||Math.abs(Date.now()-Number(ts))>60000||!/^[a-f0-9-]{36}$/.test(nonce||'')||!/^[a-f0-9]{64}$/.test(sig||''))return res.status(401).json({error:'Firma inválida.'});
  const expected=createHmac('sha256',key).update([ts,nonce,req.method,req.path,req.rawBody||''].join('\n')).digest('hex');
  if(!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return res.status(401).json({error:'Firma inválida.'});
  db.prepare('DELETE FROM agency_nonces WHERE expires<?').run(Date.now());
  try{db.prepare('INSERT INTO agency_nonces VALUES (?,?)').run(nonce,Date.now()+120000);}catch{return res.status(401).json({error:'Solicitud ya utilizada.'});}next();
 };
 app.post('/api/agency/studio-key',protect,(req,res)=>{const {external,apiKey}=req.body;const link=typeof external==='string'&&db.prepare("SELECT tenant FROM agency_links WHERE external=? AND active=1 AND kind='crm'").get(external);if(!link)return res.status(403).json({error:'Empresa no vinculada.'});if(typeof apiKey!=='string'||apiKey.length>1000)return res.status(400).json({error:'Credencial inválida.'});app.locals.studio.syncKey(link.tenant,apiKey);res.json({ok:true});});
 app.post('/api/agency/manage',protect,async(req,res,next)=>{
  const b=req.body,link=typeof b.external==='string'&&db.prepare("SELECT tenant FROM agency_links WHERE external=? AND active=1 AND kind='crm'").get(b.external);
  if(!link)return res.status(403).json({error:'Empresa no vinculada a Digital Signage.'});
  if(b.action==='state')return res.json({locations:db.prepare('SELECT id,name FROM locations WHERE tenant=? ORDER BY name').all(link.tenant),schedules:db.prepare('SELECT * FROM schedules WHERE tenant=? ORDER BY start').all(link.tenant).map(s=>({...s,days:JSON.parse(s.days)})),workspaceId:link.tenant,tenant:db.prepare('SELECT name FROM tenants WHERE id=?').get(link.tenant).name,devices:db.prepare('SELECT id,name,playlist,seen,version,error,location,paused,revision,orientation,rotation,fit,tenant FROM devices WHERE tenant=?').all(link.tenant).map(d=>{const targetVersion=deviceManifest(db,d,origin).version;delete d.tenant;return {...d,targetVersion};}),assets:db.prepare('SELECT id,name,type,size FROM assets WHERE tenant=? AND archived=0').all(link.tenant),playlists:db.prepare('SELECT id,name,items FROM playlists WHERE tenant=?').all(link.tenant).map(p=>({...p,items:JSON.parse(p.items)}))});
  if(b.action==='content'){try{return res.json(app.locals.publishContent(link.tenant,b.device,b));}catch(error){return res.status(error.status||500).json({error:error.status?error.message:'No se pudo publicar.'});}}
  if(b.action==='upload.ticket'){
   if(typeof b.name!=='string'||!b.name.trim()||b.name.length>120||!['image/jpeg','image/png','image/webp','video/mp4'].includes(b.type))return res.status(400).json({error:'Nombre o formato inválido.'});
   db.prepare('DELETE FROM agency_uploads WHERE expires<?').run(Date.now());const ticket=token();db.prepare('INSERT INTO agency_uploads(hash,external,tenant,name,type,expires) VALUES (?,?,?,?,?,?)').run(hash(ticket),b.external,link.tenant,b.name,b.type,Date.now()+60000);return res.json({ticket});
  }
  if(b.action==='studio.export.ticket'){
   const draft=typeof b.id==='string'&&db.prepare('SELECT revision FROM studio_drafts WHERE id=? AND tenant=?').get(b.id,link.tenant);
   if(!draft)return res.status(404).json({error:'Borrador no encontrado.'});
   if(draft.revision!==b.revision)return res.status(409).json({error:'El borrador cambió.'});
   db.prepare('DELETE FROM agency_uploads WHERE expires<?').run(Date.now());const ticket=token();db.prepare("INSERT INTO agency_uploads VALUES (?,?,?,?,'image/png',?,'studio.export',?)").run(hash(ticket),b.external,link.tenant,b.id,Date.now()+60000,b.revision);return res.json({ticket});
  }
  if(['studio.getConfig','studio.config','studio.verify','studio.drafts','studio.draft','studio.create','studio.update','studio.deleteDraft','studio.jobs','studio.retry','studio.generate'].includes(b.action)){
   try{return await app.locals.runManagement(b.action,link.tenant,b,req,res);}catch(error){return next(error);}
  }
  if(['playlist.save','playlist.delete','asset.rename','asset.archive','pair.claim','location.create','location.delete','device.location','device.display','device.liveSource','device.mix','device.playback','device.sync','device.revoke','schedule.save','schedule.delete','ptz.create','ptz.delete','ptz.savePreset','ptz.deletePreset','ptz.command','mixTemplate.create','mixTemplate.delete'].includes(b.action)){
   try{return await app.locals.runManagement(b.action,link.tenant,b,req,res);}catch(error){return next(error);}
  }
  return res.status(400).json({error:'Acción no permitida.'});
 });
 app.post('/api/agency/upload/:ticket',async(req,res,next)=>{
  try{
   if(!/^[a-f0-9]{64}$/.test(req.params.ticket))return res.status(401).json({error:'Carga no autorizada.'});
   const entry=db.prepare('DELETE FROM agency_uploads WHERE hash=? AND expires>? RETURNING *').get(hash(req.params.ticket),Date.now());
   if(!entry||!db.prepare("SELECT 1 FROM agency_links WHERE external=? AND tenant=? AND active=1 AND kind='crm'").get(entry.external,entry.tenant))return res.status(401).json({error:'Carga vencida o empresa desvinculada.'});
   if(req.headers['content-type']!==entry.type)return res.status(415).json({error:'Formato inválido.'});
   if(entry.purpose==='studio.export'){
    req.headers['x-studio-revision']=String(entry.revision);
    return express.raw({type:'image/png',limit:'20mb'})(req,res,error=>{if(error)return next(error);Promise.resolve(app.locals.runManagement('studio.export',entry.tenant,{id:entry.name},req,res)).catch(next);});
   }
   req.headers['x-file-name']=encodeURIComponent(entry.name);return await app.locals.runManagement('upload',entry.tenant,{},req,res);
  }catch(error){next(error);}
 });
 app.post('/api/agency/media',protect,async(req,res,next)=>{
  try{const b=req.body,link=typeof b.external==='string'&&db.prepare("SELECT tenant FROM agency_links WHERE external=? AND active=1 AND kind='crm'").get(b.external);
   if(!link)return res.status(403).json({error:'Empresa no vinculada.'});
   if(typeof b.asset!=='string')return res.status(400).json({error:'Archivo inválido.'});
   const asset=db.prepare("SELECT id FROM assets WHERE id=? AND tenant=? AND (archived=0 OR id IN (SELECT asset FROM studio_jobs WHERE tenant=? AND status='ready'))").get(b.asset,link.tenant,link.tenant);
   if(!asset)return res.status(404).json({error:'Archivo no encontrado.'});
   const result=await app.locals.readPreview(link.tenant,b.asset);res.type(result.type).send(result.bytes);
  }catch(error){next(error);}
 });
 app.get('/api/agency/links',protect,(req,res)=>res.json(db.prepare("SELECT external,tenant,active FROM agency_links WHERE kind='crm'").all()));
 app.get('/api/agency/accounts',protect,(req,res)=>res.json(db.prepare("SELECT l.external AS id,t.name FROM agency_links l JOIN tenants t ON t.id=l.tenant WHERE l.kind='standalone' ORDER BY t.name").all()));
 app.post('/api/agency/accounts',protect,(req,res)=>{
  const {name,email,password:pass}=req.body;
  if(typeof name!=='string'||!name.trim()||name.length>120||typeof email!=='string'||email.length>180||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())||typeof pass!=='string'||pass.length<12||pass.length>256)return res.status(400).json({error:'Revisa nombre, correo y contraseña (mínimo 12 caracteres).'});
  const login=email.trim().toLowerCase();if(db.prepare('SELECT 1 FROM users WHERE email=?').get(login))return res.status(409).json({error:'Ese correo ya tiene una cuenta de Digital Signage.'});
  const tenant=randomUUID(),external=randomUUID(),encoded=password(pass);
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenant,name.trim());
   db.prepare("INSERT INTO agency_links (external,tenant,active,kind) VALUES (?,?,1,'standalone')").run(external,tenant);
   db.prepare("INSERT INTO users (email,tenant,password,role) VALUES (?,?,?,'admin')").run(login,tenant,encoded);
   db.exec('COMMIT');res.status(201).json({id:external,name:name.trim()});
  }catch(e){db.exec('ROLLBACK');throw e;}
 });
 app.post('/api/agency/link',protect,(req,res)=>{
  const {external,name,active}=req.body;if(typeof external!=='string'||!/^[a-f0-9-]{36}$/i.test(external)||typeof name!=='string'||!name.trim()||name.length>120||typeof active!=='boolean')return res.status(400).json({error:'Vínculo inválido.'});
  db.exec('BEGIN IMMEDIATE');try{
   const existing=db.prepare('SELECT * FROM agency_links WHERE external=?').get(external);
   let tenant=existing?.tenant;
   if(!tenant){tenant=randomUUID();db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenant,name);db.prepare('INSERT INTO agency_links (external,tenant,active) VALUES (?,?,?)').run(external,tenant,active?1:0);}
   else{db.prepare('UPDATE agency_links SET active=? WHERE external=?').run(active?1:0,external);db.prepare('UPDATE tenants SET name=? WHERE id=?').run(name,tenant);}
   if(!active){db.prepare('DELETE FROM sessions WHERE email IN (SELECT email FROM users WHERE tenant=?)').run(tenant);db.prepare('DELETE FROM agency_tickets WHERE external=?').run(external);}
   db.exec('COMMIT');res.json({external,tenant,active});
  }catch(e){db.exec('ROLLBACK');throw e;}
 });
 app.post('/api/agency/ticket',protect,(req,res)=>{
  const {external,user}=req.body;const link=typeof external==='string'&&db.prepare('SELECT * FROM agency_links WHERE external=? AND active=1').get(external);
  if(!link)return res.status(403).json({error:'Digital Signage no está vinculado a esta empresa.'});
  if(typeof user!=='string'||!user||user.length>120)return res.status(400).json({error:'Usuario inválido.'});
  const email='agency:'+external+':'+hash(user);if(!db.prepare('SELECT 1 FROM users WHERE email=?').get(email))db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run(email,link.tenant,password(token()));
  db.prepare('DELETE FROM agency_tickets WHERE expires<?').run(Date.now());const ticket=token();db.prepare('INSERT INTO agency_tickets VALUES (?,?,?,?)').run(hash(ticket),email,external,Date.now()+60000);
  res.json({url:origin+'/#ticket='+ticket});
 });
 app.post('/api/agency/consume',(req,res)=>{
  const ticket=req.body.ticket;if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket))return res.status(400).json({error:'Acceso inválido.'});
  const row=db.prepare('DELETE FROM agency_tickets WHERE hash=? AND expires>? AND external IN (SELECT external FROM agency_links WHERE active=1) RETURNING email').get(hash(ticket),Date.now());
  if(!row)return res.status(401).json({error:'Acceso vencido o utilizado. Ábrelo nuevamente desde la agencia.'});
  const sid=token();db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(sid),row.email,Date.now()+3600000);
  res.cookie('sid',sid,{httpOnly:true,sameSite:'strict',secure:origin.startsWith('https:'),maxAge:3600000,path:'/'}).json({ok:true});
 });
}
