(() => {
 const dialog=document.createElement('dialog');dialog.id='sendContentDialog';
 dialog.innerHTML=`<form id="sendContentForm"><div class="dialog-head"><h2>Enviar contenido</h2><button type="button" data-close aria-label="Cerrar">×</button></div><p id="sendScreenName"></p><label>Qué quieres enviar<select name="kind"><option value="asset">Imagen o video</option><option value="playlist">Lista de reproducción</option></select></label><label>Contenido<select name="content" required></select></label><div id="sendPreview"></div><label id="sendDuration">Duración de la imagen (segundos)<input name="seconds" type="number" min="1" max="3600" value="10" required></label><button type="button" id="sendUpload">Subir archivo a la biblioteca</button><p>Se cambiará la lista habitual de esta pantalla. Los horarios programados y la pausa se conservan. La pantalla activará el contenido después de descargarlo; si está desconectada, quedará pendiente.</p><p id="sendResult" role="status"></p><button class="primary" id="sendPublish">Confirmar y enviar</button></form>`;
 document.body.append(dialog);const form=dialog.querySelector('form');let device,owner,busy=false;
 function preview(){
  const media=form.elements.kind.value==='asset',a=media?state.assets.find(a=>a.id===form.elements.content.value):null;
  $('#sendDuration').hidden=!a?.type.startsWith('image/');
  $('#sendPreview').innerHTML=a?(a.type.startsWith('image/')?`<img src="/api/assets/${a.id}/media" alt="${esc(a.name)}">`:`<video src="/api/assets/${a.id}/media" controls preload="metadata" playsinline></video>`):'';
 }
 function choices(){const list=form.elements.kind.value==='asset'?state.assets:state.playlists;form.elements.content.innerHTML='<option value="">Selecciona contenido…</option>'+list.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');preview();}
 window.openSendContent=id=>{
  if(state.role==='viewer')return;
  device=state.devices.find(d=>d.id===id);if(!device)return;
  owner=state.email;form.reset();$('#sendScreenName').textContent='Pantalla: '+device.name;$('#sendResult').textContent='';choices();dialog.showModal();
 };
 form.elements.kind.onchange=choices;form.elements.content.onchange=preview;
 $('#sendUpload').onclick=()=>{dialog.close();view='library';render();notice('Sube el archivo y vuelve a Pantallas → Enviar contenido para publicarlo.');$('#upload').click();};
 dialog.addEventListener('close',()=>$('#sendPreview').replaceChildren());
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 form.onsubmit=async e=>{
  e.preventDefault();if(busy||state.email!==owner||state.role==='viewer')return;
  busy=true;const payload={confirm:true,[form.elements.kind.value]:form.elements.content.value,seconds:Number(form.elements.seconds.value)};
  form.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
  try{await api('/api/devices/'+device.id+'/content',payload);dialog.close();await load();notice('Contenido enviado. La descarga se confirma cuando el reproductor sincroniza.');}
  catch(error){$('#sendResult').textContent=error.message;}
  finally{busy=false;form.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);}
 };
})();
