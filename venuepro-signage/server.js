import express from 'express';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream, mkdirSync } from 'node:fs';
import { unlink, stat, readFile, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, token, hash, verify, password } from './store.js';
import { installAgency } from './agency.js';
import { installStudio } from './studio.js';
const here = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const nameOf = value => { if (typeof value !== 'string' || !value.trim() || value.length > 120) throw fail(400, 'Nombre inválido.'); return value.trim(); };
export function deviceManifest(db, d, origin) {
 const expand=id=>{const p=db.prepare('SELECT * FROM playlists WHERE id=? AND tenant=?').get(id,d.tenant);return p?JSON.parse(p.items).map(item=>{const a=db.prepare('SELECT * FROM assets WHERE id=? AND tenant=?').get(item.asset,d.tenant);return {id:a.id,sha:a.sha,size:a.size,type:a.type,seconds:item.seconds,url:origin+'/api/player/media/'+a.id};}):[];};
 const schedules=db.prepare('SELECT * FROM schedules WHERE device=? AND tenant=? ORDER BY priority DESC,id ASC').all(d.id,d.tenant).map(s=>({id:s.id,name:s.name,timezone:s.timezone,days:JSON.parse(s.days),start:s.start,end:s.end,fromDate:s.fromDate,toDate:s.toDate,priority:s.priority,items:expand(s.playlist)}));
 const payload={paired:true,name:d.name,paused:!!d.paused,revision:d.revision||0,display:{orientation:d.orientation||'auto',rotation:d.rotation||0,fit:d.fit||'cover'},items:expand(d.playlist),schedules};return {...payload,version:hash(JSON.stringify(payload))};
}
export function createApp(env = process.env, studioOptions = {}) {
 const data = resolve(env.DATA_DIR || './data'), db = openStore(data), app = express();
 const origin = new URL(env.PUBLIC_URL || 'http://localhost:3080').origin;
 const local = env.STORAGE_MODE === 'local';
 if (local && !['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw Error('Local storage is development only');
 if (!local && (!env.BUNNY_STORAGE_ZONE || !env.BUNNY_STORAGE_PASSWORD)) throw Error('Configure Bunny storage before starting');
 const mediaDir = join(data, 'media'); mkdirSync(mediaDir, { recursive: true });
 const bunny = path => `https://${env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com'}/${encodeURIComponent(env.BUNNY_STORAGE_ZONE)}/${path}`;
 app.disable('x-powered-by');
 app.use((req,res,next) => {
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store','Permissions-Policy':'camera=(self)'});
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.headers.origin && req.headers.origin !== origin) return res.status(403).json({error:'Origen no permitido.'});
  if (req.headers['sec-fetch-site'] === 'cross-site'&&!['GET','HEAD'].includes(req.method)) return res.status(403).json({error:'Solicitud no permitida.'});
  next();
 });
 app.use(express.json({ limit:'64kb',verify(req,res,buf){req.rawBody=buf.toString('utf8');} }));
 installAgency(app,db,env,origin,deviceManifest);
 const management=new Map();
 const managed=(action,handler)=>{management.set(action,handler);return handler;};
 app.locals.runManagement=(action,tenant,body,req,res)=>{const handler=management.get(action);if(!handler)throw fail(400,'Acción no permitida.');req.user={tenant,role:'admin'};req.params={id:body.id};if(!['upload','studio.export'].includes(action))req.body=body;return handler(req,res);};
 const limits = new Map();
 const limit = (label, max) => (req,res,next) => {
  const now = Date.now(), key = label + req.socket.remoteAddress;
  for (const [k,v] of limits) if (v.until < now) limits.delete(k);
  const record = limits.get(key) || { count:0, until:now+60000 }; record.count++; limits.set(key,record);
  if (record.count > max) return res.status(429).json({error:'Demasiados intentos. Espera un minuto.'}); next();
 };
 const admin = (req,res,next) => {
  const sid = (req.headers.cookie || '').match(/(?:^|; )sid=([a-f0-9]{64})(?:;|$)/)?.[1];
  req.user = sid && db.prepare('SELECT u.email,u.tenant,u.role,t.name FROM sessions s JOIN users u ON u.email=s.email JOIN tenants t ON t.id=u.tenant WHERE s.hash=? AND s.expires>?').get(hash(sid),Date.now());
  if (!req.user) return res.status(401).json({error:'Inicia sesión.'});
  if(req.user.role==='viewer'&&req.method!=='GET'&&req.path!=='/api/logout')return res.status(403).json({error:'Tu acceso es de solo lectura.'});next();
 };
 const player = (req,res,next) => {
  const secret = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  req.device = secret && db.prepare('SELECT * FROM devices WHERE secret=?').get(hash(secret));
  if (!req.device) return res.status(401).json({error:'Dispositivo no autorizado.'}); next();
 };
 app.get('/health', (req,res) => { db.prepare('SELECT 1').get(); res.json({ok:true}); });
 app.post('/api/login',limit('login',10),wrap(async(req,res)=>{
  const {email,password} = req.body;
  if (typeof email!=='string' || typeof password!=='string' || password.length>256) throw fail(400,'Credenciales inválidas.');
  const user=db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!user || !verify(password,user.password)) throw fail(401,'Correo o contraseña incorrectos.');
  const sid=token(); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(sid),user.email,Date.now()+12*3600000);
  res.cookie('sid',sid,{httpOnly:true,sameSite:'strict',secure:origin.startsWith('https:'),maxAge:12*3600000,path:'/'}).json({ok:true});
 }));
 app.post('/api/logout',admin,(req,res)=>{ const sid=(req.headers.cookie||'').match(/sid=([a-f0-9]{64})/)?.[1]; if(sid) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(sid)); res.clearCookie('sid',{path:'/'}).json({ok:true}); });
 const owner=(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'Solo el administrador puede gestionar usuarios.'});
 app.get('/api/users',admin,owner,(req,res)=>res.json(db.prepare("SELECT email,role FROM users WHERE tenant=? AND email NOT LIKE 'agency:%' ORDER BY email").all(req.user.tenant)));
 app.post('/api/users',admin,owner,wrap(async(req,res)=>{
  const b=req.body,email=String(b.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>180||typeof b.password!=='string'||b.password.length<12||b.password.length>256||!['admin','editor','viewer'].includes(b.role))throw fail(400,'Revisa correo, rol y contraseña (mínimo 12 caracteres).');
  if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))throw fail(409,'No se puede usar ese correo.');db.prepare('INSERT INTO users (email,tenant,password,role) VALUES (?,?,?,?)').run(email,req.user.tenant,password(b.password),b.role);res.status(201).json({ok:true});
 }));
 app.delete('/api/users/:email',admin,owner,wrap(async(req,res)=>{
  const user=db.prepare('SELECT * FROM users WHERE email=? AND tenant=?').get(req.params.email,req.user.tenant);if(!user)throw fail(404,'Usuario no encontrado.');if(user.email===req.user.email)throw fail(409,'No puedes eliminar tu propio acceso.');
  if(user.role==='admin'&&db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant=? AND role='admin'").get(req.user.tenant).n<=1)throw fail(409,'Debe existir al menos un administrador.');
  db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM sessions WHERE email=?').run(user.email);db.prepare('DELETE FROM agency_tickets WHERE email=?').run(user.email);db.prepare('DELETE FROM users WHERE email=? AND tenant=?').run(user.email,req.user.tenant);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}res.json({ok:true});
 }));
 app.patch('/api/assets/:id',admin,wrap(managed('asset.rename',async(req,res)=>{if(!db.prepare('UPDATE assets SET name=? WHERE id=? AND tenant=? AND archived=0').run(nameOf(req.body.name),req.params.id,req.user.tenant).changes)throw fail(404,'Archivo no encontrado.');res.json({ok:true});})));
 app.delete('/api/assets/:id',admin,wrap(managed('asset.archive',async(req,res)=>{
  const used=db.prepare('SELECT items FROM playlists WHERE tenant=?').all(req.user.tenant).some(p=>JSON.parse(p.items).some(i=>i.asset===req.params.id));if(used)throw fail(409,'El archivo está en una lista. Quítalo de esa lista antes de archivarlo.');
  if(!db.prepare('UPDATE assets SET archived=1 WHERE id=? AND tenant=? AND archived=0').run(req.params.id,req.user.tenant).changes)throw fail(404,'Archivo no encontrado.');res.json({ok:true});
 })));
 app.delete('/api/playlists/:id',admin,wrap(managed('playlist.delete',async(req,res)=>{
  if(db.prepare('SELECT 1 FROM devices WHERE tenant=? AND playlist=?').get(req.user.tenant,req.params.id)||db.prepare('SELECT 1 FROM schedules WHERE tenant=? AND playlist=?').get(req.user.tenant,req.params.id))throw fail(409,'La lista está asignada a una pantalla o un programa. Cambia esa asignación primero.');
  if(!db.prepare('DELETE FROM playlists WHERE id=? AND tenant=?').run(req.params.id,req.user.tenant).changes)throw fail(404,'Lista no encontrada.');res.json({ok:true});
 })));
 app.get('/api/state',admin,(req,res)=>res.json({workspaceId:req.user.tenant,tenant:req.user.name,role:req.user.role,email:req.user.email,locations:db.prepare('SELECT id,name FROM locations WHERE tenant=? ORDER BY name').all(req.user.tenant),devices:db.prepare('SELECT id,tenant,name,playlist,seen,version,error,location,paused,revision,orientation,rotation,fit FROM devices WHERE tenant=?').all(req.user.tenant).map(d=>({...d,targetVersion:deviceManifest(db,d,origin).version})),assets:db.prepare('SELECT id,name,type,size,sha FROM assets WHERE tenant=? AND archived=0').all(req.user.tenant),playlists:db.prepare('SELECT * FROM playlists WHERE tenant=?').all(req.user.tenant).map(p=>({...p,items:JSON.parse(p.items)})),schedules:db.prepare('SELECT * FROM schedules WHERE tenant=? ORDER BY start,priority DESC').all(req.user.tenant).map(s=>({...s,days:JSON.parse(s.days)}))}));
 app.post('/api/devices/:id/display',admin,wrap(managed('device.display',async(req,res)=>{
  const {orientation,rotation,fit}=req.body;
  if(!['auto','landscape','portrait'].includes(orientation)||![0,90,180,270].includes(rotation)||!['cover','contain'].includes(fit))throw fail(400,'Configuración de pantalla inválida.');
  if(!db.prepare('UPDATE devices SET orientation=?,rotation=?,fit=?,revision=revision+1 WHERE id=? AND tenant=?').run(orientation,rotation,fit,req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.');
  res.json({ok:true});
 })));
 app.post('/api/pair/start',limit('pair-start',20),wrap(async(req,res)=>{
  db.prepare('DELETE FROM devices WHERE tenant IS NULL AND expires<?').run(Date.now());
  const id=randomUUID(),secret=token(),code=token().slice(0,12).toUpperCase();
  db.prepare('INSERT INTO devices (id,secret,code,expires) VALUES (?,?,?,?)').run(id,hash(secret),code,Date.now()+10*60000);
  const qr=await QRCode.toDataURL('venuepro-signage:'+code,{width:480,margin:2});
  res.json({id,secret,code,qr,expiresIn:600});
 }));
 app.post('/api/pair/claim',limit('pair-claim',20),admin,wrap(managed('pair.claim',async(req,res)=>{
  const code=String(req.body.code||'').replace(/^venuepro-signage:/,'').replace(/\s/g,'').toUpperCase();
  const location=req.body.location||null;if(location&&!db.prepare('SELECT 1 FROM locations WHERE id=? AND tenant=?').get(location,req.user.tenant))throw fail(404,'Ubicación no encontrada.');
  const result=db.prepare('UPDATE devices SET tenant=?,name=?,location=?,code=NULL,expires=NULL WHERE code=? AND tenant IS NULL AND expires>?').run(req.user.tenant,nameOf(req.body.name),location,code,Date.now());
  if(!result.changes) throw fail(400,'Código vencido o ya utilizado.'); res.json({ok:true});
 })));
 app.post('/api/locations',admin,wrap(managed('location.create',async(req,res)=>{const id=randomUUID();db.prepare('INSERT INTO locations VALUES (?,?,?)').run(id,req.user.tenant,nameOf(req.body.name));res.json({id});})));
 app.post('/api/devices/:id/location',admin,wrap(managed('device.location',async(req,res)=>{const location=req.body.location||null;if(location&&!db.prepare('SELECT 1 FROM locations WHERE id=? AND tenant=?').get(location,req.user.tenant))throw fail(404,'Ubicación no encontrada.');if(!db.prepare('UPDATE devices SET location=? WHERE id=? AND tenant=?').run(location,req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.');res.json({ok:true});})));
 app.post('/api/devices/:id/playback',admin,wrap(managed('device.playback',async(req,res)=>{if(typeof req.body.paused!=='boolean')throw fail(400,'Estado inválido.');if(!db.prepare('UPDATE devices SET paused=? WHERE id=? AND tenant=?').run(req.body.paused?1:0,req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.');res.json({ok:true});})));
 app.post('/api/devices/:id/sync',admin,wrap(managed('device.sync',async(req,res)=>{if(!db.prepare('UPDATE devices SET revision=revision+1 WHERE id=? AND tenant=?').run(req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.');res.json({ok:true});})));
 app.post('/api/assets',admin,wrap(managed('upload',async(req,res)=>{
  const name=nameOf(decodeURIComponent(req.headers['x-file-name']||''));
  const type=req.headers['content-type']; const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'}[type];
  if(!ext) throw fail(415,'Usa JPG, PNG, WebP o video MP4.');
  const id=randomUUID(),temp=join(mediaDir,id+'.part'),path=`signage/${req.user.tenant}/${id}.${ext}`;
  let size=0; const {createHash}=await import('node:crypto'); const digest=createHash('sha256'); let head=Buffer.alloc(0);
  try {
   await pipeline(req,new Transform({transform(chunk,enc,cb){size+=chunk.length; if(size>500*1024*1024) return cb(fail(413,'Máximo 500 MB.')); if(head.length<16)head=Buffer.concat([head,chunk]).subarray(0,16);digest.update(chunk);cb(null,chunk);}}),createWriteStream(temp,{flags:'wx'}));
   const valid=ext==='jpg'?head[0]===255&&head[1]===216:ext==='png'?head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):ext==='webp'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP':head.toString('ascii',4,8)==='ftyp';
   if(!size||!valid) throw fail(400,'El archivo no coincide con su formato.');
   if(!local){
    const response=await fetch(bunny(path),{method:'PUT',headers:{AccessKey:env.BUNNY_STORAGE_PASSWORD,'Content-Type':type,'Content-Length':String(size)},body:createReadStream(temp),duplex:'half',signal:AbortSignal.timeout(300000)});
    if(!response.ok) throw fail(502,'No se pudo guardar el archivo en Bunny.');
   }
   db.prepare('INSERT INTO assets (id,tenant,name,type,size,sha,path) VALUES (?,?,?,?,?,?,?)').run(id,req.user.tenant,name,type,size,digest.digest('hex'),local?id+'.part':path);
   if(!local) await unlink(temp); res.status(201).json({id});
  } catch(e){await unlink(temp).catch(()=>{});throw e;}
 })));
 app.post('/api/playlists/:id/assets',admin,wrap(async(req,res)=>{
  const playlist=db.prepare('SELECT * FROM playlists WHERE id=? AND tenant=?').get(req.params.id,req.user.tenant);
  if(!playlist)throw fail(404,'Lista no encontrada.');
  if(typeof req.body.asset!=='string'||!db.prepare('SELECT 1 FROM assets WHERE id=? AND tenant=? AND archived=0').get(req.body.asset,req.user.tenant))throw fail(404,'Archivo no disponible.');
  const items=JSON.parse(playlist.items);
  if(items.some(item=>item.asset===req.body.asset))return res.json({ok:true,added:false});
  if(items.length>=200)throw fail(400,'La lista ya contiene 200 archivos.');
  items.push({asset:req.body.asset,seconds:10});
  db.prepare('UPDATE playlists SET items=?,version=? WHERE id=? AND tenant=?').run(JSON.stringify(items),randomUUID(),playlist.id,req.user.tenant);
  res.json({ok:true,added:true});
 }));
 app.post('/api/playlists',admin,wrap(managed('playlist.save',async(req,res)=>{
  const name=nameOf(req.body.name),items=req.body.items;
  if(!Array.isArray(items)||!items.length||items.length>200) throw fail(400,'Agrega entre 1 y 200 archivos.');
  const clean=items.map(item=>{
   if(!item||typeof item.asset!=='string'||!Number.isInteger(item.seconds)||item.seconds<1||item.seconds>3600) throw fail(400,'Duración inválida (1–3600 segundos).');
   if(!db.prepare('SELECT 1 FROM assets WHERE id=? AND tenant=? AND archived=0').get(item.asset,req.user.tenant))throw fail(400,'Archivo no disponible.');
   return {asset:item.asset,seconds:item.seconds};
  });
  const id=req.body.id||randomUUID(),version=randomUUID();
  if(req.body.id){ if(!db.prepare('UPDATE playlists SET name=?,items=?,version=? WHERE id=? AND tenant=?').run(name,JSON.stringify(clean),version,id,req.user.tenant).changes)throw fail(404,'Lista no encontrada.'); }
  else db.prepare('INSERT INTO playlists VALUES (?,?,?,?,?)').run(id,req.user.tenant,name,JSON.stringify(clean),version);
  res.json({id,version});
 })));
 app.locals.publishContent=(tenant,device,b)=>{
  if(b.confirm!==true)throw fail(400,'Confirma la publicación.');
  if(typeof device!=='string'||(b.asset!==undefined&&typeof b.asset!=='string')||(b.playlist!==undefined&&typeof b.playlist!=='string'))throw fail(400,'Contenido o pantalla inválidos.');
  if(!db.prepare('SELECT 1 FROM devices WHERE id=? AND tenant=?').get(device,tenant))throw fail(404,'Pantalla no encontrada.');
  if(Boolean(b.asset)===Boolean(b.playlist))throw fail(400,'Selecciona un archivo o una lista.');
  let playlist=b.playlist,asset;
  if(b.asset){
   asset=db.prepare('SELECT * FROM assets WHERE id=? AND tenant=? AND archived=0').get(b.asset,tenant);
   if(!asset)throw fail(404,'Archivo no disponible.');
   if(!Number.isInteger(b.seconds)||b.seconds<1||b.seconds>3600)throw fail(400,'Duración inválida (1–3600 segundos).');
  }else if(!db.prepare('SELECT 1 FROM playlists WHERE id=? AND tenant=?').get(playlist,tenant))throw fail(404,'Lista no encontrada.');
  db.exec('BEGIN');
  try{
   if(asset){
    const items=JSON.stringify([{asset:asset.id,seconds:b.seconds}]);
    playlist=db.prepare('SELECT id FROM playlists WHERE tenant=? AND items=? ORDER BY rowid LIMIT 1').get(tenant,items)?.id;
    if(!playlist){playlist=randomUUID();db.prepare('INSERT INTO playlists VALUES (?,?,?,?,?)').run(playlist,tenant,asset.name,items,randomUUID());}
   }
   db.prepare('UPDATE devices SET playlist=? WHERE id=? AND tenant=?').run(playlist,device,tenant);
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true,playlist};
 };
 app.post('/api/devices/:id/content',admin,wrap(async(req,res)=>res.json(app.locals.publishContent(req.user.tenant,req.params.id,req.body))));
 app.post('/api/devices/:id/assign',admin,wrap(async(req,res)=>{
  if(!db.prepare('SELECT 1 FROM playlists WHERE id=? AND tenant=?').get(req.body.playlist,req.user.tenant)) throw fail(404,'Lista no encontrada.');
  if(!db.prepare('UPDATE devices SET playlist=? WHERE id=? AND tenant=?').run(req.body.playlist,req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.'); res.json({ok:true});
 }));
 app.delete('/api/devices/:id',admin,wrap(managed('device.revoke',async(req,res)=>{
  if(!db.prepare('DELETE FROM devices WHERE id=? AND tenant=?').run(req.params.id,req.user.tenant).changes)throw fail(404,'Pantalla no encontrada.');res.json({ok:true});
 })));
 app.post('/api/schedules',admin,wrap(managed('schedule.save',async(req,res)=>{
  const b=req.body,name=nameOf(b.name);
  if(!db.prepare('SELECT 1 FROM devices WHERE id=? AND tenant=?').get(b.device,req.user.tenant)||!db.prepare('SELECT 1 FROM playlists WHERE id=? AND tenant=?').get(b.playlist,req.user.tenant))throw fail(404,'Pantalla o lista no encontrada.');
  try{new Intl.DateTimeFormat('en',{timeZone:b.timezone}).format();}catch{throw fail(400,'Zona horaria inválida.');}
  if(typeof b.timezone!=='string'||!b.timezone||!Array.isArray(b.days)||!b.days.length||b.days.some(d=>!Number.isInteger(d)||d<0||d>6))throw fail(400,'Selecciona los días y la zona horaria.');
  const time=/^([01]\d|2[0-3]):[0-5]\d$/;if(!time.test(b.start)||!time.test(b.end)||b.start>=b.end)throw fail(400,'La hora final debe ser posterior a la inicial. Divide horarios nocturnos en dos programas.');
  for(const v of [b.fromDate,b.toDate])if(v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))throw fail(400,'Fecha inválida.');
  if(b.fromDate&&b.toDate&&b.fromDate>b.toDate)throw fail(400,'Revisa el intervalo de fechas.');
  if(!Number.isInteger(b.priority)||b.priority<0||b.priority>100)throw fail(400,'La prioridad debe estar entre 0 y 100.');
  const values=[req.user.tenant,b.device,b.playlist,name,b.timezone,JSON.stringify([...new Set(b.days)]),b.start,b.end,b.fromDate||'',b.toDate||'',b.priority];
  const id=b.id||randomUUID();
  if(b.id){if(!db.prepare('UPDATE schedules SET tenant=?,device=?,playlist=?,name=?,timezone=?,days=?,start=?,end=?,fromDate=?,toDate=?,priority=? WHERE id=? AND tenant=?').run(...values,id,req.user.tenant).changes)throw fail(404,'Programa no encontrado.');}
  else db.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,...values);
  res.json({id});
 })));
 app.delete('/api/schedules/:id',admin,wrap(managed('schedule.delete',async(req,res)=>{if(!db.prepare('DELETE FROM schedules WHERE id=? AND tenant=?').run(req.params.id,req.user.tenant).changes)throw fail(404,'Programa no encontrado.');res.json({ok:true});})));
 app.get('/api/player/manifest',player,wrap(async(req,res)=>{
  const d=req.device;if(!d.tenant){if(d.expires<Date.now())throw fail(410,'Código vencido.');return res.json({paired:false});}
  res.json(deviceManifest(db,d,origin));
 }));
 app.post('/api/player/heartbeat',player,(req,res)=>{
  db.prepare('UPDATE devices SET seen=?,version=?,error=? WHERE id=?').run(Date.now(),String(req.body.version||'').slice(0,80),String(req.body.error||'').slice(0,300),req.device.id);res.json({ok:true});
 });
 const streamAsset=async(a,req,res)=>{
  res.type(a.type);
  if(local) return res.sendFile(join(mediaDir,a.path));
  const headers={AccessKey:env.BUNNY_STORAGE_PASSWORD}; if(req.headers.range)headers.Range=req.headers.range;
  const response=await fetch(bunny(a.path),{headers,signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw fail(502,'Archivo temporalmente no disponible.');
  for(const key of ['content-length','content-range','accept-ranges'])if(response.headers.has(key))res.set(key,response.headers.get(key));
  res.status(response.status);await pipeline(Readable.fromWeb(response.body),res);
 };
 app.get('/api/assets/:id/media',admin,wrap(async(req,res)=>{const a=db.prepare('SELECT * FROM assets WHERE id=? AND tenant=?').get(req.params.id,req.user.tenant);if(!a)throw fail(404,'Archivo no encontrado.');await streamAsset(a,req,res);}));
 app.get('/api/player/media/:id',player,wrap(async(req,res)=>{
  const d=req.device,m=deviceManifest(db,d,origin);
  if(![...m.items,...m.schedules.flatMap(s=>s.items)].some(i=>i.id===req.params.id))throw fail(404,'Archivo no asignado.');
  const a=db.prepare('SELECT * FROM assets WHERE id=? AND tenant=?').get(req.params.id,d.tenant);if(!a)throw fail(404,'Archivo no encontrado.');await streamAsset(a,req,res);
 }));

 const readAsset=async(tenant,id,max)=>{const a=db.prepare('SELECT * FROM assets WHERE id=? AND tenant=?').get(id,tenant);if(!a||!a.type.startsWith('image/')||a.size>max)throw fail(400,'Selecciona una imagen de hasta 20 MB de esta empresa.');if(local)return {bytes:await readFile(join(mediaDir,a.path)),type:a.type};const r=await fetch(bunny(a.path),{headers:{AccessKey:env.BUNNY_STORAGE_PASSWORD},signal:AbortSignal.timeout(30000)});if(!r.ok)throw fail(502,'Imagen no disponible.');const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>max)throw fail(413,'Imagen demasiado grande.');chunks.push(Buffer.from(chunk));}return {bytes:Buffer.concat(chunks),type:a.type};};
 const saveImage=async(tenant,name,bytes,hidden)=>{if(bytes.length>20*1024*1024)throw fail(413,'Imagen superior a 20 MB.');const id=randomUUID(),path=local?id+'.png':'signage/'+tenant+'/'+id+'.png';if(local)await writeFile(join(mediaDir,path),bytes,{flag:'wx'});else{const r=await fetch(bunny(path),{method:'PUT',headers:{AccessKey:env.BUNNY_STORAGE_PASSWORD,'Content-Type':'image/png'},body:bytes,signal:AbortSignal.timeout(120000)});if(!r.ok)throw fail(502,'No se pudo guardar en Bunny.');}db.prepare('INSERT INTO assets(id,tenant,name,type,size,sha,path,archived) VALUES (?,?,?,?,?,?,?,?)').run(id,tenant,name,'image/png',bytes.length,hash(bytes),path,hidden?1:0);return {id};};
 app.locals.readPreview=(tenant,id)=>readAsset(tenant,id,20*1024*1024);
 installStudio(app,{db,env,admin,wrap,readAsset,saveImage,streamAsset,managed,...studioOptions});
 app.get('/vendor/scanner.js',(req,res)=>res.sendFile(join(here,'node_modules/html5-qrcode/html5-qrcode.min.js')));
 app.use(express.static(join(here,'public')));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status||500).json({error:err.status?err.message:'No se pudo completar la operación.'});});
 return {app,db};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {app}=createApp();app.listen(Number(process.env.PORT||3080),process.env.BIND_HOST||'0.0.0.0',()=>console.log('Digital Signage ready'));
}
