const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state,view='screens',editing=null,items=[],assigning=null,scanner=null,noticeTimer;
function notice(message){$('#notice').textContent=message;$('#notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').hidden=true,6000);}
async function api(url,body,method='POST'){const res=await fetch(url,{method:body===undefined?'GET':method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok){if(res.status===401){$('#shell').hidden=true;$('#login').hidden=false;}throw Error(data.error);}return data;}
async function load(){state=await api('/api/state');$('#login').hidden=true;$('#shell').hidden=false;$('#tenant').textContent=state.tenant;$('#workspaceIdentity').textContent=state.workspaceId?' · Espacio '+state.workspaceId:'';$('#sessionRole').textContent=({admin:'Administrador',editor:'Editor',viewer:'Solo lectura'})[state.role]||'';window.updateStudioAccess?.();render();}
const empty=(icon,title,text,action,label)=>`<div class="empty"><div class="empty-icon">${icon}</div><h2>${title}</h2><p>${text}</p><button class="primary" data-action="${action}">${label}</button></div>`;
function render(){
 if(view==='studio'){window.renderStudio?.();return;}
 if(view==='team'){renderTeam();return;}
 if(view==='screens'){renderLocations();return;}
 if(view==='schedule'){renderSchedule();return;}
 $('#title').textContent={screens:'Pantallas',library:'Biblioteca',playlists:'Listas de reproducción',schedule:'Programación'}[view];document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 if(view==='screens'){
  const online=state.devices.filter(d=>d.seen>Date.now()-90000).length;
  $('#content').innerHTML=`<div class="stats"><div class="stat"><span>Pantallas vinculadas</span><strong>${state.devices.length}</strong></div><div class="stat"><span>En línea</span><strong>${online}</strong></div><div class="stat"><span>Sin conexión</span><strong>${state.devices.length-online}</strong></div></div><div class="toolbar"><div><h2>Mis pantallas</h2><p>Un espacio, una experiencia en cada pantalla.</p><a class="test-player" href="/player.html" target="_blank" rel="noopener">Abrir pantalla de prueba ↗</a></div><button class="primary" data-action="pair">+ Vincular pantalla</button></div>`+(state.devices.length?`<div class="grid">${state.devices.map(d=>{const p=state.playlists.find(p=>p.id===d.playlist),on=d.seen>Date.now()-90000;return `<article class="card"><div class="screen-art"><div class="mini-screen">▣</div></div><div class="card-body"><span class="status ${on?'online':''}">● ${on?'En línea':'Sin conexión'}</span><h3>${esc(d.name)}</h3><p class="muted">${esc(p?.name||'Sin lista asignada')}<br>${p?(d.version===d.targetVersion?'Lista descargada':'Pendiente de sincronizar'):'Publica tu primera lista'}${d.error?'<br>'+esc(d.error):''}</p><div class="card-actions"><button data-action="assign" data-id="${d.id}">Publicar lista</button><button data-action="revoke" data-id="${d.id}" aria-label="Desvincular ${esc(d.name)}">Desvincular</button></div></div></article>`;}).join('')}</div>`:empty('▣','Tu primera pantalla empieza aquí','Instala el reproductor, abre su QR y vincúlalo a tu organización.','pair','Vincular pantalla'));
 }else if(view==='library'){
  $('#content').innerHTML=`<div class="toolbar"><div><h2>Contenido para tus espacios</h2><p>JPG, PNG, WebP y MP4 · Hasta 500 MB por archivo</p></div><button class="primary" data-action="upload">↑ Subir archivos</button></div><input class="upload" id="upload" type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4">`+(state.assets.length?`<div class="grid">${state.assets.map(a=>`<article class="card asset-card"><button class="asset-preview" data-action="preview" data-id="${a.id}" aria-label="Vista previa de ${esc(a.name)}">${a.type.startsWith('image/')?`<img class="media-thumb" src="/api/assets/${a.id}/media" alt="${esc(a.name)}" loading="lazy">`:'<div class="video-thumb">▷</div>'}</button><div class="card-body"><h3><button class="asset-name" data-rename-asset="${a.id}" aria-label="Renombrar ${esc(a.name)}"><span>${esc(a.name)}</span><span aria-hidden="true">✎</span></button></h3><p class="muted">${a.type.startsWith('video')?'Video':'Imagen'} · ${(a.size/1048576).toFixed(1)} MB</p><div class="asset-manage"><select data-asset-list="${a.id}" aria-label="Asignar a lista: ${esc(a.name)}" ${state.role==='viewer'?'disabled':''}><option value="">Asignar a lista…</option>${state.playlists.map(p=>`<option value="${p.id}" ${p.items.some(i=>i.asset===a.id)?'disabled':''}>${esc(p.name)}${p.items.some(i=>i.asset===a.id)?' · Agregado':''}</option>`).join('')}<option value="__new">+ Nueva lista…</option></select><button data-archive-asset="${a.id}">Archivar</button></div></div></article>`).join('')}</div>`:empty('▧','Tu biblioteca está lista','Sube las imágenes y videos que quieres mostrar.','upload','Subir archivos'));
 }else{
  $('#content').innerHTML=`<div class="toolbar"><div><h2>Historias en reproducción</h2><p>Ordena tu contenido y publícalo en tus pantallas.</p></div><button class="primary" data-action="newList">+ Nueva lista</button></div>`+(state.playlists.length?`<div class="grid">${state.playlists.map(playlistCard).join('')}</div>`:empty('☷','Crea una secuencia para tu pantalla','Combina imágenes y videos en el orden que prefieras.','newList','Crear lista'));
 }
 if(view==='library')window.renderUploadProgress?.();
}
function playlistCard(p){
 const assigned=state.devices.filter(d=>d.playlist===p.id);
 return `<article class="card playlist-card" data-playlist-card="${p.id}"><div class="playlist-cover">${playlistSlide(p,0)}</div><div class="card-body"><h3>${esc(p.name)}</h3><p class="muted">${p.items.length} archivos · ${assigned.length} pantallas</p><select data-list-screen="${p.id}" aria-label="Asignar ${esc(p.name)} a pantalla" ${state.role==='viewer'||!state.devices.length?'disabled':''}><option value="">${state.devices.length?'Asignar a pantalla…':'Vincula una pantalla primero'}</option>${state.devices.map(d=>`<option value="${d.id}" ${d.playlist===p.id?'disabled':''}>${esc(d.name)}${d.playlist===p.id?' · Asignada':''}</option>`).join('')}</select><div class="playlist-actions"><button data-action="editList" data-id="${p.id}">✎ Editar</button><button data-delete-list="${p.id}">Eliminar</button></div></div></article>`;
}
function playlistSlide(p,index){
 const asset=state.assets.find(a=>a.id===p.items[index]?.asset);
 return `${asset?`<button class="playlist-media" data-action="preview" data-id="${asset.id}" aria-label="Ver ${esc(asset.name)}">${asset.type.startsWith('image/')?`<img src="/api/assets/${asset.id}/media" alt="${esc(asset.name)}" loading="lazy">`:`<video src="/api/assets/${asset.id}/media#t=0.1" preload="metadata" muted playsinline></video><span class="playlist-video">▷ Video</span>`}</button>`:'<div class="playlist-empty">Sin portada</div>'}<div class="playlist-slides">${p.items.length>1?`<button data-list-slide="${p.id}" data-slide="${(index+p.items.length-1)%p.items.length}" aria-label="Archivo anterior">‹</button>`:''}<span>${index+1} / ${p.items.length}</span>${p.items.length>1?`<button data-list-slide="${p.id}" data-slide="${(index+1)%p.items.length}" aria-label="Archivo siguiente">›</button>`:''}</div>`;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-list-slide]');if(!button)return;
 const p=state.playlists.find(p=>p.id===button.dataset.listSlide);if(!p)return;
 button.closest('.playlist-cover').innerHTML=playlistSlide(p,Number(button.dataset.slide));
});
document.addEventListener('change',async event=>{
 const select=event.target.closest('[data-list-screen]');if(!select||!select.value)return;
 const device=select.value;select.disabled=true;
 try{await api('/api/devices/'+device+'/assign',{playlist:select.dataset.listScreen});await load();notice('Lista asignada. La pantalla la descargará al sincronizar.');}
 catch(error){notice(error.message);select.value='';select.disabled=state?.role==='viewer';}
});
function listRows(){ $('#listItems').innerHTML=items.map((i,n)=>`<div class="list-row"><span>${n+1}. ${esc(state.assets.find(a=>a.id===i.asset)?.name)}</span><label><input aria-label="Duración del archivo ${n+1}" type="number" min="1" max="3600" value="${i.seconds}" data-seconds="${n}"><small>segundos</small></label><button type="button" data-up="${n}" aria-label="Subir archivo" ${n===0?'disabled':''}>↑</button><button type="button" data-remove="${n}" aria-label="Quitar archivo">×</button></div>`).join(''); }
function editList(id){if(!state.assets.length){notice('Sube archivos a la biblioteca primero.');view='library';render();return;}const p=state.playlists.find(p=>p.id===id);editing=p?.id;items=p?p.items.map(i=>({...i})):[];$('#listName').value=p?.name||'';$('#editorTitle').textContent=p?'Editar lista':'Nueva lista';$('#assetSelect').innerHTML=state.assets.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');listRows();$('#playlistDialog').showModal();}
async function stopScan(){if(scanner){try{await scanner.stop();await scanner.clear();}catch{}scanner=null;}}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{
 if(b.dataset.view){view=b.dataset.view;if(view==='screens')selectedLocation='all';render();}
 if(b.hasAttribute('data-close')){b.closest('dialog').close();await stopScan();$('#preview').replaceChildren();}
 if(b.hasAttribute('data-up')){const n=+b.dataset.up;if(n>0){[items[n-1],items[n]]=[items[n],items[n-1]];listRows();}}
 if(b.hasAttribute('data-remove')){items.splice(+b.dataset.remove,1);listRows();}
 const a=b.dataset.action,id=b.dataset.id;
 if(a==='pair'){$('#pairForm').reset();$('#pairLocation').innerHTML='<option value="">Sin ubicación</option>'+(state.locations||[]).map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('');if(selectedLocation&&selectedLocation!=='all'&&selectedLocation!=='unassigned')$('#pairLocation').value=selectedLocation;$('#pairDialog').showModal();}
 if(a==='upload')$('#upload').click();
 if(a==='newList'||a==='editList')editList(id);
 if(a==='assign')window.openSendContent?.(id);
 if(a==='revoke'&&confirm('¿Desvincular esta pantalla? Dejará de recibir contenido cuando se conecte.')){await api('/api/devices/'+id,{},'DELETE');await load();}
 if(a==='preview'){const asset=state.assets.find(a=>a.id===id);$('#preview').innerHTML=asset.type.startsWith('video')?`<video controls autoplay src="/api/assets/${id}/media"></video>`:`<img src="/api/assets/${id}/media" alt="${esc(asset.name)}">`;$('#previewDialog').showModal();}
}catch(err){notice(err.message);}});
$('#loginForm').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await api('/api/login',Object.fromEntries(new FormData(e.target)));await load();}catch(err){notice(err.message);}finally{b.disabled=false;}};
$('#logout').onclick=async()=>{try{await api('/api/logout',{});$('#shell').hidden=true;$('#login').hidden=false;state=null;}catch(e){notice(e.message);}};
$('#pairForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/pair/claim',Object.fromEntries(new FormData(e.target)));await stopScan();$('#pairDialog').close();await load();notice('Pantalla vinculada. Ahora puedes publicar una lista.');}catch(err){notice(err.message);}};
$('#scan').onclick=async()=>{if(scanner)return;try{scanner=new Html5Qrcode('reader');await scanner.start({facingMode:'environment'},{fps:10,qrbox:220},async text=>{if(!/^venuepro-signage:[A-F0-9]{12}$/.test(text)){notice('Este QR no pertenece a una pantalla.');return;}$('#pairCode').value=text.split(':')[1];await stopScan();notice('Código leído. Ponle nombre a la pantalla.');});}catch(e){await stopScan();notice('No se pudo abrir la cámara. Permite el acceso o escribe el código.');}};
$('#pairDialog').addEventListener('close',stopScan);$('#previewDialog').addEventListener('close',()=>$('#preview').replaceChildren());
$('#addItem').onclick=()=>{items.push({asset:$('#assetSelect').value,seconds:10});listRows();};
$('#listItems').onchange=e=>{if(e.target.hasAttribute('data-seconds'))items[+e.target.dataset.seconds].seconds=Number(e.target.value);};
$('#playlistForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/playlists',{id:editing,name:$('#listName').value,items});$('#playlistDialog').close();await load();notice('Lista guardada.');}catch(err){notice(err.message);}};
$('#assignForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/devices/'+assigning+'/assign',{playlist:$('#assignList').value});$('#assignDialog').close();await load();notice('Lista publicada. Se descargará en la próxima sincronización.');}catch(err){notice(err.message);}};
(async()=>{const ticket=new URLSearchParams(location.hash.slice(1)).get("ticket");if(ticket){history.replaceState(null,"",location.pathname);try{await api("/api/agency/consume",{ticket});}catch(e){notice(e.message);}}await load();})().catch(()=>{});setInterval(()=>{if(state&&view!=='studio'&&!document.querySelector('dialog[open]'))load().catch(()=>{});},30000);
let scheduleEditing=null;
function renderSchedule(){
 $('#title').textContent='Programación';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view==='schedule'));
 const days=['D','L','M','X','J','V','S'];
 $('#content').innerHTML=`<section class="schedule-intro"><div><div class="overline">EN EL MOMENTO INDICADO</div><h2>Cada contenido tiene su hora.</h2><p>Programa tus pantallas por día y horario.<br>La programación descargada también funciona sin internet.</p></div><span class="clock-art">◷</span></section><div class="toolbar"><div><h2>Tu semana en pantalla</h2><p>${state.schedules.length} programas activos</p></div><button class="primary" data-schedule-new>+ Programar</button></div>`+(state.schedules.length?`<div class="schedule-grid">${state.schedules.map(s=>`<article class="schedule-card"><div class="schedule-time">${s.start}<span>— ${s.end}</span></div><div class="schedule-details"><h3>${esc(s.name)}</h3><p>${esc(state.devices.find(d=>d.id===s.device)?.name)} · ${esc(state.playlists.find(p=>p.id===s.playlist)?.name)}</p><div class="week-days">${[1,2,3,4,5,6,0].map(d=>`<span class="${s.days.includes(d)?'selected':''}">${days[d]}</span>`).join('')}</div><small>${esc(s.timezone)} · Prioridad ${s.priority}${s.fromDate||s.toDate?'<br>'+esc(s.fromDate||'Sin inicio')+' → '+esc(s.toDate||'Sin fin'):''}</small></div><div class="schedule-actions"><button data-schedule-edit="${s.id}">Editar</button><button data-schedule-delete="${s.id}" aria-label="Eliminar ${esc(s.name)}">×</button></div></article>`).join('')}</div>`:empty('◷','Tu semana, a tu ritmo','Por ejemplo: desayunos de 8 a 11, promociones por la tarde y eventos el fin de semana.','newSchedule','Crear programación'));
}
function openSchedule(id){
 if(!state.devices.length||!state.playlists.length){notice('Vincula una pantalla y crea una lista para programar.');return;}
 const f=$('#scheduleForm');f.reset();const s=state.schedules.find(s=>s.id===id);scheduleEditing=s?.id;
 f.elements.device.innerHTML=state.devices.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');f.elements.playlist.innerHTML=state.playlists.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
 if(s){for(const k of ['name','device','playlist','start','end','timezone','fromDate','toDate','priority'])f.elements[k].value=s[k];f.querySelectorAll('[name=days]').forEach(c=>c.checked=s.days.includes(+c.value));}
 $('#scheduleDialog').showModal();
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-schedule-new')||b.dataset.action==='newSchedule')openSchedule();if(b.dataset.scheduleEdit)openSchedule(b.dataset.scheduleEdit);if(b.dataset.scheduleDelete&&confirm('¿Eliminar esta programación?')){try{await api('/api/schedules/'+b.dataset.scheduleDelete,{},'DELETE');await load();}catch(e){notice(e.message);}}});
$('#scheduleForm').onsubmit=async e=>{e.preventDefault();const f=e.target,b=Object.fromEntries(new FormData(f));b.days=[...f.querySelectorAll('[name=days]:checked')].map(c=>+c.value);b.priority=+b.priority;b.id=scheduleEditing;try{await api('/api/schedules',b);$('#scheduleDialog').close();await load();notice('Programación guardada.');}catch(err){notice(err.message);}};
if(document.modelContext?.registerTool){try{Promise.resolve(document.modelContext.registerTool({name:'read_signage_workspace',description:'Read screens, media, playlists and schedules for the signed-in tenant.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async()=>{await load();return state;}})).catch(()=>{});}catch{}}
let selectedLocation='all';
const online=d=>d.seen>Date.now()-90000;
const deviceTone=d=>!online(d)?'bad':d.error||d.version!==d.targetVersion||d.paused?'warn':'ok';
const ago=time=>!time?'Sin conexión registrada':new Intl.RelativeTimeFormat('es',{numeric:'auto'}).format(-Math.max(0,Math.round((Date.now()-time)/60000)),'minute');
function locationGroups(){const groups=(state.locations||[]).map(l=>({...l,devices:state.devices.filter(d=>d.location===l.id)}));const unassigned=state.devices.filter(d=>!d.location);if(unassigned.length||!groups.length)groups.unshift({id:'unassigned',name:'Sin ubicación',devices:unassigned});return groups;}
function renderLocations(){
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view==='screens'));document.querySelector('header .overline').textContent=state.tenant;
 const groups=locationGroups();
 if(selectedLocation!==null){const group=selectedLocation==='all'?{id:'all',name:'Todas las pantallas',devices:state.devices}:groups.find(g=>g.id===selectedLocation);if(!group){selectedLocation=null;return renderLocations();}renderScreenGroup(group);return;}
 $('#title').textContent='Ubicaciones';const count=t=>groups.filter(g=>g.devices.length&&g.devices.some(d=>deviceTone(d)===t)).length;const healthy=groups.filter(g=>g.devices.length&&g.devices.every(d=>deviceTone(d)==='ok')).length;
 $('#content').innerHTML=`<div class="stats location-stats"><div class="stat"><strong class="ok">${healthy}</strong><span>operativas</span></div><div class="stat"><strong class="warn">${count('warn')}</strong><span>con avisos</span></div><div class="stat"><strong class="bad">${count('bad')}</strong><span>sin conexión</span></div><div class="stat desktop-total"><strong>${state.devices.length}</strong><span>pantallas totales</span></div></div><div class="toolbar location-tools"><input id="locationSearch" type="search" placeholder="Buscar ubicación o pantalla…" aria-label="Buscar ubicación o pantalla"><button class="primary" data-new-location>+ Nueva ubicación</button></div><div class="location-table"><div class="location-table-head"><span>UBICACIÓN</span><span>ESTADO</span><span>PANTALLAS</span><span>ÚLTIMA CONEXIÓN</span></div><div id="locationRows">${groups.map(g=>{const off=g.devices.filter(d=>!online(d)).length,warn=g.devices.filter(d=>deviceTone(d)==='warn').length,tone=off?'bad':warn?'warn':g.devices.length?'ok':'muted';const description=off?`${off} de ${g.devices.length} sin conexión`:warn?`${warn} pendientes o con avisos`:g.devices.length?`${g.devices.length}/${g.devices.length} pantallas en línea`:'Sin pantallas vinculadas';return `<button class="location-row" data-location="${g.id}" data-search="${esc([g.name,...g.devices.map(d=>d.name)].join(' ').toLowerCase())}"><span class="location-dot ${tone}"></span><span class="location-name"><strong>${esc(g.name)}</strong><small class="${tone}">${description}</small></span><span class="location-desktop-status ${tone}">● ${off?'Sin conexión':warn?'Con avisos':g.devices.length?'Operativa':'Vacía'}</span><span class="location-count">${g.devices.length-off} / ${g.devices.length} online</span><span class="location-seen">${esc(ago(Math.max(0,...g.devices.map(d=>d.seen||0))))}</span><span class="chevron">›</span></button>`;}).join('')}</div></div><div class="location-footer"><button data-all-screens>Ver todas las pantallas</button><button data-action="pair">+ Vincular pantalla</button><a class="test-player" href="/player.html" target="_blank" rel="noopener">Probar QR en navegador ↗</a></div>`;
 $('#locationSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('.location-row').forEach(r=>r.hidden=!r.dataset.search.includes(q));};
}
function renderScreenGroup(g){
 $('#title').textContent=g.name;
 $('#content').innerHTML=`<div class="screen-group-head"><button data-locations-back aria-label="Volver a ubicaciones">‹</button><div><span>${g.devices.length} pantallas</span><small>${esc(ago(Math.max(0,...g.devices.map(d=>d.seen||0))))}</small></div><button class="primary" data-action="pair">+ Vincular</button></div>`+(g.devices.length?`<div class="grid compact-screens">${g.devices.map(d=>{const p=state.playlists.find(p=>p.id===d.playlist),a=p?.items.length?state.assets.find(a=>a.id===p.items[0].asset):null,tone=deviceTone(d);return `<article class="card device-card ${cardFadeEnabled(d.id)?'':'no-card-fade'}"><div class="device-tv"><div class="device-visual"><button type="button" class="device-label ${tone}" data-device-diagnostics="${d.id}" aria-label="${d.error?'Consultar último aviso de ':'Consultar diagnóstico de '}${esc(d.name)}">● ${deviceStatusLabel(d)}</button>${a?.type.startsWith('image/')?`<img src="/api/assets/${a.id}/media" alt="Contenido asignado a ${esc(d.name)}">` : a?.type.startsWith('video/')?`<video src="/api/assets/${a.id}/media#t=0.1" preload="metadata" muted playsinline aria-label="Portada de ${esc(d.name)}"></video>`:`<span class="player-id">player-${d.id.slice(0,8)}</span>`}</div><div class="device-info"><div><h3>${esc(d.name)}</h3><p>${!online(d)?esc(ago(d.seen)):'Lista: '+esc(p?.name||'Sin asignar')}</p></div><div class="device-controls"><button data-device-sync="${d.id}" aria-label="Solicitar sincronización">↻</button><button data-device-pause="${d.id}" aria-label="${d.paused?'Reanudar':'Pausar'} pantalla">${d.paused?'▷':'Ⅱ'}</button><button data-action="assign" data-id="${d.id}" class="send-content-button" aria-label="Enviar contenido" ${state.role==='viewer'?'disabled':''}>Enviar contenido</button></div></div></div><details class="device-more"><summary>Opciones</summary><div><label class="card-fade-toggle"><span>Fundido suave de la tarjeta</span><input type="checkbox" role="switch" data-card-fade="${d.id}" ${cardFadeEnabled(d.id)?'checked':''}></label><button data-device-display="${d.id}" ${state.role==='viewer'?'disabled':''}>Orientación y ajuste</button><button data-device-location="${d.id}">Mover ubicación</button><button data-device-diagnostics="${d.id}">Diagnóstico</button><button data-action="revoke" data-id="${d.id}">Desvincular</button></div></details></article>`;}).join('')}</div>`:empty('▣','Vincula tu primera pantalla','Instala el reproductor o abre la prueba de navegador para obtener un QR.','pair','Vincular pantalla'))+`<a class="test-player" href="/player.html" target="_blank" rel="noopener">Abrir pantalla de prueba ↗</a>`;
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{
 if(b.hasAttribute('data-location')){selectedLocation=b.dataset.location;renderLocations();}
 if(b.hasAttribute('data-locations-back')){selectedLocation=null;renderLocations();}
 if(b.hasAttribute('data-all-screens')){selectedLocation='all';renderLocations();}
 if(b.hasAttribute('data-new-location')){$('#locationForm').reset();$('#locationDialog').showModal();}
 if(b.dataset.deviceSync){await api('/api/devices/'+b.dataset.deviceSync+'/sync',{});await load();notice('Solicitud guardada. Se aplicará cuando la pantalla se conecte.');}
 if(b.dataset.devicePause){const d=state.devices.find(d=>d.id===b.dataset.devicePause);await api('/api/devices/'+d.id+'/playback',{paused:!d.paused});await load();notice('Cambio pendiente de la próxima sincronización.');}
 if(b.dataset.deviceDiagnostics)await openDeviceDiagnostics(b.dataset.deviceDiagnostics);
 if(b.dataset.deviceLocation){$('#moveDevice').value=b.dataset.deviceLocation;$('#moveLocation').innerHTML='<option value="">Sin ubicación</option>'+state.locations.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('');$('#moveLocationDialog').showModal();}
}catch(e){notice(e.message);}});
$('#locationForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/locations',{name:e.target.elements.name.value});$('#locationDialog').close();await load();}catch(e){notice(e.message);}};
$('#moveLocationForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/devices/'+$('#moveDevice').value+'/location',{location:$('#moveLocation').value});$('#moveLocationDialog').close();await load();}catch(e){notice(e.message);}};
async function renderTeam(){
 $('#title').textContent='Equipo y accesos';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view==='team'));
 $('#content').innerHTML='<div class="toolbar"><div><h2>Tu organización</h2><p>Permisos separados para administrar, editar o consultar.</p></div></div><p>Cargando usuarios…</p>';
 if(state.role!=='admin'){$('#content').innerHTML=`<div class="empty"><h2>${state.role==='editor'?'Editor de contenido':'Acceso de consulta'}</h2><p>Tu administrador gestiona los accesos de esta organización.</p><button data-signout>Cerrar sesión</button></div>`;return;}
 try{const users=await api('/api/users');if(view!=='team')return;$('#content').innerHTML=`<div class="toolbar"><div><h2>Usuarios de la organización</h2><p>Administrador, editor y solo lectura.</p></div><button class="primary" data-new-user>+ Usuario</button></div><div class="team-list">${users.map(u=>`<article class="team-row"><span class="tenant-icon">${esc(u.email[0].toUpperCase())}</span><div><strong>${esc(u.email)}</strong><small>${{admin:'Administrador',editor:'Editor de contenido',viewer:'Solo lectura'}[u.role]}</small></div>${u.email!==state.email?`<button data-delete-user="${esc(u.email)}" aria-label="Eliminar acceso de ${esc(u.email)}">Quitar</button>`:'<span class="badge">Tú</span>'}</article>`).join('')||'<p class="muted">Acceso mediante la agencia. Puedes crear usuarios propios para este tenant.</p>'}</div><div class="location-footer"><button data-signout>Cerrar mi sesión</button></div>`;}catch(e){notice(e.message);}
}
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;try{
 if(b.hasAttribute('data-new-user')){$('#userForm').reset();$('#userDialog').showModal();}
 if(b.hasAttribute('data-signout'))$('#logout').click();
 if(b.dataset.deleteUser&&confirm('¿Quitar acceso a '+b.dataset.deleteUser+'?')){await api('/api/users/'+encodeURIComponent(b.dataset.deleteUser),{},'DELETE');await renderTeam();}
 if(b.dataset.archiveAsset&&confirm('¿Archivar este archivo de la biblioteca?')){await api('/api/assets/'+b.dataset.archiveAsset,{},'DELETE');await load();}
 if(b.dataset.deleteList&&confirm('¿Eliminar esta lista?')){await api('/api/playlists/'+b.dataset.deleteList,{},'DELETE');await load();}
 if(b.dataset.renameAsset){const a=state.assets.find(a=>a.id===b.dataset.renameAsset);$('#renameAssetId').value=a.id;$('#renameAssetName').value=a.name;$('#renameAssetDialog').showModal();}
}catch(e){notice(e.message);}});
$('#userForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/users',Object.fromEntries(new FormData(e.target)));$('#userDialog').close();await renderTeam();notice('Acceso creado. Comparte las credenciales por tu canal habitual.');}catch(e){notice(e.message);}};
$('#renameAssetForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/assets/'+$('#renameAssetId').value,{name:$('#renameAssetName').value},'PATCH');$('#renameAssetDialog').close();await load();}catch(e){notice(e.message);}};
new MutationObserver(()=>{if(state?.role==='viewer')document.querySelectorAll('[data-action]:not([data-action="preview"]),[data-new-location],[data-schedule-new],[data-schedule-edit],[data-schedule-delete],[data-device-sync],[data-device-pause],[data-device-location],[data-archive-asset],[data-rename-asset],[data-delete-list]').forEach(b=>{b.disabled=true;b.title='Acceso de solo lectura';});}).observe($('#content'),{childList:true,subtree:true});

document.addEventListener('change',async event=>{
 const select=event.target.closest('[data-asset-list]');if(!select||!select.value)return;
 const asset=select.dataset.assetList,id=select.value;
 if(id==='__new'){select.value='';editList();items=[{asset,seconds:10}];listRows();return;}
 select.disabled=true;
 try{const result=await api('/api/playlists/'+id+'/assets',{asset});await load();notice(result.added?'Archivo agregado al final de la lista.':'El archivo ya está en esa lista.');}
 catch(error){notice(error.message);select.value='';select.disabled=false;}
});

document.addEventListener('click',event=>{
 const button=event.target.closest('[data-device-display]');if(!button)return;
 const d=state.devices.find(d=>d.id===button.dataset.deviceDisplay);if(!d)return;
 const form=$('#displayForm');form.elements.device.value=d.id;form.elements.orientation.value=d.orientation||'auto';form.elements.rotation.value=String(d.rotation||0);form.elements.fit.value=d.fit||'cover';$('#displayName').textContent=d.name;$('#displayDialog').showModal();
});
$('#displayForm').onsubmit=async event=>{event.preventDefault();const form=event.target,button=form.querySelector('.primary');button.disabled=true;try{await api('/api/devices/'+form.elements.device.value+'/display',{orientation:form.elements.orientation.value,rotation:Number(form.elements.rotation.value),fit:form.elements.fit.value});$('#displayDialog').close();await load();notice('Ajuste guardado. Se aplicará al sincronizar la pantalla.');}catch(error){notice(error.message);}finally{button.disabled=false;}};

// Card appearance is a local preference, independent of player configuration.
function cardFadeKey(id){return 'signage-card-fade:'+state.email+':'+id;}
function cardFadeEnabled(id){try{return localStorage.getItem(cardFadeKey(id))!=='off';}catch{return true;}}
document.addEventListener('change',event=>{
 const input=event.target.closest('[data-card-fade]');if(!input)return;
 input.closest('.device-card').classList.toggle('no-card-fade',!input.checked);
 try{localStorage.setItem(cardFadeKey(input.dataset.cardFade),input.checked?'on':'off');}catch{}
});

function deviceStatusLabel(d){const label=!online(d)?'SIN CONEXIÓN':d.paused?'PAUSADA':d.version!==d.targetVersion?'SINCRONIZANDO':d.error?'CON AVISO':'EN LÍNEA';return label+(d.error&&label!=='CON AVISO'?' · CON AVISO':'');}
async function openDeviceDiagnostics(id){
 const dialog=document.createElement('dialog');dialog.className='device-diagnostic';dialog.setAttribute('aria-labelledby','diagnosticTitle');
 dialog.innerHTML='<div class="dialog-head"><h2 id="diagnosticTitle">Diagnóstico de pantalla</h2><button type="button" aria-label="Cerrar diagnóstico">×</button></div><div data-diagnostic-content></div><p role="status">Consultando el último reporte…</p><div class="diagnostic-actions"><button type="button" data-refresh>Actualizar reporte</button><button type="button" data-retry>Reintentar sincronización</button></div>';
 document.body.append(dialog);dialog.querySelector('.dialog-head button').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.showModal();
 const content=dialog.querySelector('[data-diagnostic-content]'),status=dialog.querySelector('[role=status]'),retry=dialog.querySelector('[data-retry]'),refresh=dialog.querySelector('[data-refresh]');retry.disabled=true;
 async function report(){retry.disabled=true;refresh.disabled=true;try{
  const snapshot=await api('/api/state'),device=snapshot.devices.find(d=>d.id===id);if(!device)throw Error('La pantalla ya no está disponible en tu organización.');
  content.innerHTML='<h3>'+esc(device.name)+'</h3><dl><dt>Último error reportado</dt><dd class="diagnostic-error">'+esc(device.error||'No hay un error en el último reporte recibido.')+'</dd><dt>Fecha del error</dt><dd>No registrada por el reproductor.</dd><dt>Último contacto recibido</dt><dd>'+esc(device.seen?new Date(device.seen).toLocaleString():'Sin contacto registrado')+'</dd></dl><p>El último contacto no indica cuándo ocurrió el error. Este reporte no confirma que el problema siga activo.</p>';
  retry.disabled=snapshot.role==='viewer';retry.title=snapshot.role==='viewer'?'Tu acceso es de solo lectura':'';status.textContent='';
 }catch(error){status.textContent=error.message;}finally{refresh.disabled=false;}}
 refresh.onclick=report;
 retry.onclick=async()=>{retry.disabled=true;refresh.disabled=true;try{await api('/api/devices/'+id+'/sync',{});status.textContent='Solicitud registrada. Se intentará sincronizar cuando la pantalla se conecte; todavía no confirma que el error se haya resuelto.';}catch(error){status.textContent=error.message;}finally{refresh.disabled=false;}};
 await report();
}
