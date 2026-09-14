import express from 'express';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
const fail=(status,message)=>Object.assign(Error(message),{status});
const MODEL='gpt-image-2';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
export function installStudio(app,{db,env,admin,wrap,readAsset,saveImage,streamAsset,managed=(action,handler)=>handler,request=fetch}){
 db.exec(`CREATE TABLE IF NOT EXISTS studio_config(tenant TEXT PRIMARY KEY REFERENCES tenants(id),secret TEXT,source TEXT NOT NULL DEFAULT 'tenant',enabled INTEGER NOT NULL DEFAULT 0,monthly_limit INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS studio_drafts(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS studio_jobs(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),draft TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,usage TEXT,request_id TEXT,asset TEXT,created INTEGER NOT NULL);`);
 // Never automatically repeat a request that might already have been billed.
 db.prepare("UPDATE studio_jobs SET status='uncertain',error='Proceso interrumpido. Revisa el consumo en OpenAI antes de generar otra propuesta.' WHERE status='processing'").run();
 if(!db.prepare('PRAGMA table_info(studio_jobs)').all().some(c=>c.name==='pending'))db.exec('ALTER TABLE studio_jobs ADD COLUMN pending BLOB');
 db.prepare("UPDATE studio_jobs SET status='storage_failed',error='Guardado interrumpido. Puedes reintentar guardar sin generar otra imagen.' WHERE status='saving'").run();
 const key=()=>{if(!env.AGENCY_SIGNAGE_SECRET||env.AGENCY_SIGNAGE_SECRET.length<32)throw fail(503,'Falta configurar el cifrado del servicio.');return createHash('sha256').update('venuepro-studio:'+env.AGENCY_SIGNAGE_SECRET).digest();};
 function encrypt(tenant,value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv);c.setAAD(Buffer.from(tenant));return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64');}
 function decrypt(tenant,value){const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));c.setAAD(Buffer.from(tenant));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8');}
 function linked(tenant){return !!db.prepare("SELECT 1 FROM agency_links WHERE tenant=? AND kind='crm' AND active=1").get(tenant);}
 const scope=(req,res,next)=>linked(req.user.tenant)?next():res.status(403).json({error:'Estudio IA es exclusivo de empresas VenuePro vinculadas.'});
 const editor=(req,res,next)=>req.user.role==='viewer'?res.status(403).json({error:'Se requiere acceso de editor o administrador.'}):next();
 const owner=(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'Solo el administrador configura OpenAI.'});
 const cfg=tenant=>db.prepare('SELECT * FROM studio_config WHERE tenant=?').get(tenant);
 const used=tenant=>db.prepare('SELECT COUNT(*) AS n FROM studio_jobs WHERE tenant=? AND created>=?').get(tenant,Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1)).n;
 function publicConfig(tenant){const c=cfg(tenant);return {eligible:linked(tenant),hasKey:!!c?.secret,source:c?.source||'none',enabled:!!c?.enabled,verified:!!c?.verified,monthlyLimit:c?.monthly_limit||0,requestsThisMonth:used(tenant),model:MODEL,cost:null};}
 app.locals.studio={syncKey(tenant,value){if(!linked(tenant))throw fail(403,'Empresa no vinculada.');const old=cfg(tenant);if(old?.source==='tenant'&&old.secret)return;const same=!!old?.secret&&value&&decrypt(tenant,old.secret)===value;if(same)return;db.prepare("INSERT INTO studio_config(tenant,secret,source) VALUES (?,?,'crm') ON CONFLICT(tenant) DO UPDATE SET secret=excluded.secret,source='crm',verified=0").run(tenant,value?encrypt(tenant,value):null);}};
 app.get('/api/studio/config',admin,managed('studio.getConfig',(req,res)=>res.json(publicConfig(req.user.tenant))));
 app.post('/api/studio/config',admin,scope,owner,wrap(managed('studio.config',async(req,res)=>{
  const {apiKey,enabled,monthlyLimit}=req.body;if(typeof enabled!=='boolean'||!Number.isInteger(monthlyLimit)||monthlyLimit<0||monthlyLimit>1000||apiKey!==undefined&&(typeof apiKey!=='string'||apiKey.length>1000))throw fail(400,'Configuración inválida. Cupo mensual entre 0 y 1000 solicitudes.');
  const old=cfg(req.user.tenant),secret=apiKey?.trim()?encrypt(req.user.tenant,apiKey.trim()):old?.secret||null;
  if(enabled&&!secret)throw fail(400,'Configura una clave API de OpenAI de tu empresa.');
  db.prepare('INSERT INTO studio_config(tenant,secret,source,enabled,monthly_limit,verified) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant) DO UPDATE SET secret=excluded.secret,source=excluded.source,enabled=excluded.enabled,monthly_limit=excluded.monthly_limit,verified=excluded.verified').run(req.user.tenant,secret,apiKey?.trim()?'tenant':old?.source||'tenant',+enabled,monthlyLimit,apiKey?.trim()?0:old?.verified||0);res.json(publicConfig(req.user.tenant));
 })));
 app.post('/api/studio/verify',admin,scope,owner,wrap(managed('studio.verify',async(req,res)=>{
  const c=cfg(req.user.tenant);if(!c?.secret)throw fail(400,'Falta la clave API de la empresa.');
  const response=await request('https://api.openai.com/v1/models/'+MODEL,{headers:{Authorization:'Bearer '+decrypt(req.user.tenant,c.secret)},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw fail(422,'OpenAI no confirmó acceso al modelo (HTTP '+response.status+').');const result=await response.json();if(result.id!==MODEL)throw fail(422,'Modelo no confirmado.');
  db.prepare('UPDATE studio_config SET verified=1 WHERE tenant=? AND secret=?').run(req.user.tenant,c.secret);res.json({...publicConfig(req.user.tenant),message:'Acceso al modelo comprobado. No verifica saldo ni garantiza permiso de generación de imágenes.'});
 })));
 function clean(tenant,b){
  if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>120||!['promotion','menu','event','welcome','cover'].includes(b.kind)||!['landscape','portrait','square'].includes(b.orientation)||typeof b.style!=='string'||b.style.length>200||typeof b.notes!=='string'||b.notes.length>2000||!Array.isArray(b.layers)||b.layers.length>12)throw fail(400,'Revisa el borrador.');
  if(b.background&&!db.prepare("SELECT 1 FROM assets WHERE id=? AND tenant=? AND type IN ('image/png','image/jpeg','image/webp')").get(b.background,tenant))throw fail(404,'Imagen no disponible en esta empresa.');
  const layers=b.layers.map(l=>{if(typeof l.text!=='string'||l.text.length>600||![l.x,l.y,l.size].every(Number.isFinite)||l.x<0||l.x>95||l.y<0||l.y>95||l.size<12||l.size>160||!/^#[a-f0-9]{6}$/i.test(l.color))throw fail(400,'Capa de texto inválida.');return {text:l.text,x:l.x,y:l.y,size:l.size,color:l.color};});
  return {name:b.name.trim(),kind:b.kind,orientation:b.orientation,style:b.style,notes:b.notes,background:b.background||null,layers};
 }
 const draft=(tenant,id)=>{const row=db.prepare('SELECT * FROM studio_drafts WHERE tenant=? AND id=?').get(tenant,id);if(!row)throw fail(404,'Borrador no encontrado.');return {...row,data:JSON.parse(row.data)};};
 const jobOut=j=>{const {pending,...safe}=j;return {...safe,usage:j.usage?JSON.parse(j.usage):null};};
 app.get('/api/studio/drafts',admin,scope,editor,managed('studio.drafts',(req,res)=>res.json(db.prepare('SELECT id,name,revision,created FROM studio_drafts WHERE tenant=? ORDER BY created DESC LIMIT 100').all(req.user.tenant))));
 app.get('/api/studio/drafts/:id',admin,scope,editor,wrap(managed('studio.draft',async(req,res)=>res.json(draft(req.user.tenant,req.params.id)))));
 app.post('/api/studio/drafts',admin,scope,editor,wrap(managed('studio.create',async(req,res)=>{const data=clean(req.user.tenant,req.body),id=randomUUID();db.prepare('INSERT INTO studio_drafts VALUES (?,?,?,?,1,?)').run(id,req.user.tenant,data.name,JSON.stringify(data),Date.now());res.status(201).json(draft(req.user.tenant,id));})));
 app.put('/api/studio/drafts/:id',admin,scope,editor,wrap(managed('studio.update',async(req,res)=>{const data=clean(req.user.tenant,req.body.data);if(!db.prepare('UPDATE studio_drafts SET name=?,data=?,revision=revision+1 WHERE id=? AND tenant=? AND revision=?').run(data.name,JSON.stringify(data),req.params.id,req.user.tenant,req.body.revision).changes)throw fail(409,'El borrador cambió. Vuelve a abrirlo antes de guardar.');res.json(draft(req.user.tenant,req.params.id));})));
 app.delete('/api/studio/drafts/:id',admin,scope,editor,wrap(managed('studio.deleteDraft',async(req,res)=>{
  if(!db.prepare('DELETE FROM studio_drafts WHERE id=? AND tenant=?').run(req.params.id,req.user.tenant).changes)throw fail(404,'Borrador no encontrado.');res.json({ok:true});
 })));
 app.get('/api/studio/jobs',admin,scope,editor,managed('studio.jobs',(req,res)=>res.json(db.prepare('SELECT * FROM studio_jobs WHERE tenant=? ORDER BY created DESC LIMIT 50').all(req.user.tenant).map(jobOut))));
 async function storeResult(job,name,bytes){
  try{const asset=await saveImage(job.tenant,'Fondo IA · '+name,bytes,true);db.prepare("UPDATE studio_jobs SET status='ready',asset=?,pending=NULL,error=NULL WHERE id=?").run(asset.id,job.id);}
  catch{db.prepare("UPDATE studio_jobs SET status='storage_failed',error='La imagen está generada pero no se pudo guardar en archivos. Reintenta el guardado sin otra generación.' WHERE id=?").run(job.id);}
 }
 app.post('/api/studio/jobs/:id/retry-save',admin,scope,editor,wrap(managed('studio.retry',async(req,res)=>{
  const job=db.prepare("UPDATE studio_jobs SET status='saving' WHERE id=? AND tenant=? AND status='storage_failed' AND pending IS NOT NULL RETURNING *").get(req.params.id,req.user.tenant);if(!job)throw fail(409,'No hay un guardado pendiente disponible.');
  void storeResult(job,draft(job.tenant,job.draft).name,Buffer.from(job.pending));res.status(202).json({id:job.id,status:'saving'});
 })));
 async function generate(job,c,data){
  let sent=false;try{
   let body,headers={Authorization:'Bearer '+decrypt(job.tenant,c.secret)},endpoint='generations';const fields={model:MODEL,n:1,quality:'medium',size:{landscape:'1536x1024',portrait:'1024x1536',square:'1024x1024'}[data.orientation],output_format:'png',prompt:'Create a polished digital signage background. Do not render any letters, numbers, prices, dates, phone numbers, logos or text. Text is added separately as editable layers. Leave negative space for text. Design brief: '+JSON.stringify({type:data.kind,style:data.style,notes:data.notes})};
   if(data.background){const source=await readAsset(job.tenant,data.background,20*1024*1024);body=new FormData();for(const [k,v] of Object.entries(fields))body.set(k,String(v));body.set('image',new Blob([source.bytes],{type:source.type}),'reference.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[source.type]));endpoint='edits';}else{body=JSON.stringify(fields);headers['Content-Type']='application/json';}
   sent=true;const response=await request('https://api.openai.com/v1/images/'+endpoint,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(240000)});
   if(!response.ok){const error=fail(502,'OpenAI respondió HTTP '+response.status+'. Revisa credenciales, permisos de imágenes o límites.');error.definitive=response.status>=400&&response.status<500&&response.status!==408;throw error;}
   const output=await response.json();db.prepare('UPDATE studio_jobs SET usage=?,request_id=? WHERE id=?').run(output.usage?JSON.stringify(output.usage):null,response.headers.get('x-request-id'),job.id);
   const encoded=output.data?.[0]?.b64_json;if(typeof encoded!=='string'||encoded.length>30*1024*1024)throw Error('Invalid output');const bytes=Buffer.from(encoded,'base64');if(!bytes.subarray(0,8).equals(PNG))throw Error('Invalid image');
   if(bytes.length>20*1024*1024)throw Error('Image too large');
   db.prepare("UPDATE studio_jobs SET status='saving',pending=? WHERE id=?").run(bytes,job.id);
   await storeResult(job,data.name,bytes);
  }catch(error){db.prepare('UPDATE studio_jobs SET status=?,error=? WHERE id=?').run(!sent||error.definitive?'failed':'uncertain',error.definitive?error.message:!sent?'No se pudo preparar la imagen. Revisa el archivo de referencia.':'Resultado no confirmado. Revisa el consumo en OpenAI antes de generar de nuevo. No se reintentó automáticamente.',job.id);}
 }
 app.post('/api/studio/drafts/:id/generate',admin,scope,editor,wrap(managed('studio.generate',async(req,res)=>{
  if(req.body.confirmCost!==true||! /^[a-f0-9-]{36}$/i.test(req.body.requestId||''))throw fail(400,'Confirma una solicitud de generación con costo API.');
  const old=db.prepare('SELECT * FROM studio_jobs WHERE id=?').get(req.body.requestId);if(old){if(old.tenant!==req.user.tenant||old.draft!==req.params.id)throw fail(409,'Solicitud no disponible.');return res.json(jobOut(old));}
  const d=draft(req.user.tenant,req.params.id),c=cfg(req.user.tenant);if(d.revision!==req.body.revision)throw fail(409,'Guarda y revisa la versión actual del borrador.');if(!c?.enabled||!c.secret||!c.verified)throw fail(403,'El administrador debe configurar, verificar y habilitar la clave API de esta empresa.');
  if(used(req.user.tenant)>=c.monthly_limit)throw fail(429,'Se alcanzó el cupo mensual de solicitudes del Estudio IA.');
  if(db.prepare("SELECT 1 FROM studio_jobs WHERE tenant=? AND status='processing'").get(req.user.tenant))throw fail(409,'Ya hay una generación en curso en esta empresa.');
  const job={id:req.body.requestId,tenant:req.user.tenant,draft:d.id,revision:d.revision};db.prepare("INSERT INTO studio_jobs(id,tenant,draft,revision,status,created) VALUES (?,?,?,?,'processing',?)").run(job.id,job.tenant,job.draft,job.revision,Date.now());
  void generate(job,c,d.data);res.status(202).json({id:job.id,status:'processing'});
 })));
 app.post('/api/studio/drafts/:id/export',admin,scope,editor,express.raw({type:'image/png',limit:'20mb'}),wrap(managed('studio.export',async(req,res)=>{
  const d=draft(req.user.tenant,req.params.id);if(Number(req.headers['x-studio-revision'])!==d.revision)throw fail(409,'El borrador cambió. Revisa antes de guardar.');
  if(!Buffer.isBuffer(req.body)||!req.body.subarray(0,8).equals(PNG))throw fail(400,'Exportación PNG inválida.');
  const result=await saveImage(req.user.tenant,d.name,req.body,false);res.status(201).json(result);
 })));
}
