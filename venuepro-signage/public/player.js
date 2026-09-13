const stage=document.querySelector('#stage'),statusEl=document.querySelector('#status');
let db,manifest,credentials,working=false,currentUrl=null,timer,sequence='',index=0,playing=false,stopped=false,lastError='';
const pairMarkup=stage.innerHTML;
function status(s){statusEl.textContent=s;}
async function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('venuepro-signage-player',1);r.onupgradeneeded=()=>{r.result.createObjectStore('state');r.result.createObjectStore('assets');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function get(store,key){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function put(store,key,value){return new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,key);t.oncomplete=resolve;t.onabort=()=>reject(t.error);});}
async function request(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(credentials?{Authorization:'Bearer '+credentials.secret}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(r.status===401||r.status===410){const e=Error('La vinculación ha caducado.');e.unpaired=true;throw e;}if(!r.ok)throw Error('No se pudo sincronizar ('+r.status+').');return r.json();}
function pairView(){stage.style.cssText="";document.body.classList.remove('playing');stage.innerHTML=pairMarkup;if(credentials?.qr){document.querySelector('#qr').src=credentials.qr;document.querySelector('#qr').hidden=false;document.querySelector('#code').textContent=credentials.code;document.querySelector('#pairHint').textContent='Código válido durante 10 minutos. Mantén esta ventana abierta.';}}
function selectItems(m,date=new Date()){
 for(const s of m.schedules||[]){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(date).map(p=>[p.type,p.value]));const day=parts.year+'-'+parts.month+'-'+parts.day,time=parts.hour+':'+parts.minute,weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);if(s.days.includes(weekday)&&time>=s.start&&time<s.end&&(!s.fromDate||day>=s.fromDate)&&(!s.toDate||day<=s.toDate))return s.items;}
 return m.items;
}
async function playNext(){
 if(stopped||!manifest)return;clearTimeout(timer);if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl=null;}
 if(manifest.paused){playing=false;document.body.classList.remove('playing');stage.innerHTML='<div id="pair"><span class="eyebrow">VENUEPRO SIGNAGE</span><h1>Reproducción pausada.</h1><p>Reanuda esta pantalla desde el gestor.</p></div>';timer=setTimeout(playNext,10000);return;}
 const items=selectItems(manifest),key=JSON.stringify(items);if(key!==sequence){index=0;sequence=key;}
 if(!items.length){playing=false;document.body.classList.remove('playing');stage.innerHTML='<div id="pair"><span class="eyebrow">PANTALLA VINCULADA</span><h1>Lista para tu contenido.</h1><p>Publica una lista desde el gestor o espera al próximo horario programado.</p></div>';timer=setTimeout(playNext,10000);return;}
 const item=items[index++%items.length];
 try{const blob=await get('assets',item.sha);if(!blob)throw Error('Archivo no descargado.');currentUrl=URL.createObjectURL(blob);const el=document.createElement(item.type.startsWith('video/')?'video':'img');el.src=currentUrl;stage.replaceChildren(el);applyDisplay();playing=true;document.body.classList.add('playing');el.onerror=()=>{lastError='No se pudo reproducir '+item.id;timer=setTimeout(playNext,2000);};
  if(el.tagName==='VIDEO'){el.autoplay=true;el.muted=true;el.playsInline=true;el.onended=playNext;await el.play();}else{el.alt='Contenido de la pantalla';timer=setTimeout(playNext,item.seconds*1000);}
 }catch(e){lastError=e.message;status(lastError);timer=setTimeout(playNext,3000);}
}
async function clearPlayer(){stopped=true;clearTimeout(timer);stage.querySelector('video')?.pause();if(currentUrl)URL.revokeObjectURL(currentUrl);await new Promise((resolve,reject)=>{const t=db.transaction(['state','assets'],'readwrite');t.objectStore('state').clear();t.objectStore('assets').clear();t.oncomplete=resolve;t.onabort=()=>reject(t.error);});credentials=null;manifest=null;playing=false;sequence='';index=0;stopped=false;pairView();}
async function sync(){
 if(working||stopped)return;working=true;
 try{
  if(!credentials){credentials=await request('/api/pair/start',{});await put('state','credentials',credentials);pairView();}
  const next=await request('/api/player/manifest');if(!next.paired){status('Esperando que el administrador vincule la pantalla.');return;}
  if(next.version!==manifest?.version){const items=[...next.items,...(next.schedules||[]).flatMap(s=>s.items)];const unique=[...new Map(items.map(a=>[a.sha,a])).values()];let count=0;
   for(const item of unique){status('Descargando '+(++count)+' de '+unique.length+'…');if(await get('assets',item.sha))continue;
    const url=new URL(item.url);if(url.origin!==location.origin)throw Error('Servidor de medios no permitido.');const response=await fetch(url,{headers:{Authorization:'Bearer '+credentials.secret},signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('Descarga incompleta; se conserva la lista anterior.');const blob=await response.blob();if(blob.size!==item.size)throw Error('Archivo incompleto.');const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const sha=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');if(sha!==item.sha)throw Error('Archivo no verificado.');await put('assets',item.sha,blob);
   }
   // Single IndexedDB transaction activates only a fully downloaded manifest.
   await put('state','manifest',next);manifest=next;applyDisplay();sequence='';lastError='';if(next.paused){stage.querySelector('video')?.pause();playing=false;}if(!playing)await playNext();
  }
  await request('/api/player/heartbeat',{version:manifest.version,error:lastError});status('Sincronizada · '+new Date().toLocaleTimeString());
 }catch(e){if(e.unpaired){await clearPlayer();status('Generando un código nuevo…');}else{lastError=e.message;status(manifest?'Sin conexión · Reproduciendo contenido guardado':e.message);}}
 finally{working=false;}
}
document.querySelector('#fullscreen').onclick=()=>document.documentElement.requestFullscreen().catch(e=>status(e.message));
document.querySelector('#reset').onclick=async()=>{if(working){status('Espera a que termine la sincronización.');return;}if(confirm('¿Borrar la vinculación y el contenido guardado en este navegador?')){await clearPlayer();await sync();}};
(async()=>{try{db=await openDb();credentials=await get('state','credentials');manifest=await get('state','manifest');if(manifest)await playNext();else pairView();if('serviceWorker'in navigator)await navigator.serviceWorker.register('/sw.js');await navigator.storage?.persist?.();await sync();setInterval(sync,20000);}catch(e){status(e.message);}})();

function displayGeometry(width,height,display={}){
 const mismatch=display.orientation==='portrait'&&width>height||display.orientation==='landscape'&&height>width;
 const angle=((mismatch?90:0)+(display.rotation||0))%360;
 return {angle,width:angle%180?height:width,height:angle%180?width:height};
}
function applyDisplay(){
 const el=stage.querySelector(':scope > img,:scope > video');if(!el)return;
 const settings=manifest?.display||{},g=displayGeometry(innerWidth,innerHeight,settings);
 el.style.width=g.width+'px';el.style.height=g.height+'px';el.style.position='absolute';el.style.left='50%';el.style.top='50%';el.style.transform='translate(-50%,-50%) rotate('+g.angle+'deg)';el.style.objectFit=settings.fit||'cover';el.style.objectPosition='center';
}
window.addEventListener('resize',applyDisplay);
