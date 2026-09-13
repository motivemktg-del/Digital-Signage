(() => {
 let queue=[],busy=false,owner='';
 const sameOwner=()=>state&&state.email===owner;
 window.renderUploadProgress=()=>{
  if(view!=='library')return;
  document.querySelectorAll('[data-action="upload"]').forEach(b=>b.disabled=busy||state?.role==='viewer');
  if(!sameOwner()||!queue.length)return;
  let panel=document.querySelector('#uploadProgress');
  if(!panel){panel=document.createElement('section');panel.id='uploadProgress';panel.className='upload-progress';document.querySelector('#upload').after(panel);}
  const saved=queue.filter(item=>item.status==='saved').length,failed=queue.filter(item=>item.status==='failed').length;
  panel.innerHTML=`<h3>${busy?'Subiendo archivos':'Carga terminada'}</h3><p role="status">${saved} guardados · ${failed} con error · ${queue.length} en total</p><div class="upload-rows">${queue.map(item=>`<div class="upload-row"><strong>${esc(item.file.name)}</strong><span>${esc(item.message)}</span><progress max="100" value="${item.progress}" aria-label="Progreso de ${esc(item.file.name)}"></progress></div>`).join('')}</div>${!busy&&failed?'<button type="button" data-upload-retry>Reintentar fallidos</button>':''}`;
 };
 function send(item){return new Promise((resolve,reject)=>{
  const file=item.file;
  if(!['image/jpeg','image/png','image/webp','video/mp4'].includes(file.type))return reject(Error('Usa JPG, PNG, WebP o MP4.'));
  if(!file.size||file.size>500*1024*1024)return reject(Error('El archivo debe pesar entre 1 byte y 500 MB.'));
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/assets');xhr.timeout=900000;xhr.setRequestHeader('Content-Type',file.type);xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
  xhr.upload.onprogress=event=>{if(event.lengthComputable){item.progress=Math.round(event.loaded/event.total*100);item.message=item.progress===100?'Guardando y verificando…':`Enviando · ${item.progress}%`;window.renderUploadProgress();}};
  xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)return resolve();reject(Error(result?.error||'No se pudo guardar el archivo.'));};
  xhr.onerror=xhr.ontimeout=()=>reject(Error('Conexión interrumpida. Revisa la biblioteca antes de reintentar.'));
  xhr.send(file);
 });}
 async function run(){
  if(busy||!sameOwner()||state.role==='viewer')return;busy=true;
  try{for(const item of queue){
   if(item.status==='saved')continue;
   if(!sameOwner())break;
   item.status='sending';item.progress=0;item.message='Preparando…';window.renderUploadProgress();
   try{await send(item);item.status='saved';item.progress=100;item.message='Guardado';}
   catch(error){item.status='failed';item.message=error.message;}
   window.renderUploadProgress();
  }}finally{busy=false;if(sameOwner()){try{await load();}catch(error){notice(error.message);}window.renderUploadProgress();}}
 }
 document.addEventListener('change',event=>{
  if(event.target.id!=='upload'||busy||!state||state.role==='viewer')return;
  const files=Array.from(event.target.files);event.target.value='';if(!files.length)return;
  owner=state.email;queue=files.map(file=>({file,status:'waiting',progress:0,message:'En espera'}));run();
 });
 document.addEventListener('click',event=>{if(event.target.closest('[data-upload-retry]'))run();});
})();
