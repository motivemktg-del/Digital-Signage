(() => {
 let pending;
 const buttons=document.querySelectorAll('[data-install]');
 const dialog=document.querySelector('#installDialog');
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 const refresh=()=>buttons.forEach(button=>button.hidden=standalone());
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pending=event;refresh();});
 window.addEventListener('appinstalled',()=>{pending=null;buttons.forEach(button=>button.hidden=true);});
 buttons.forEach(button=>button.addEventListener('click',async()=>{
  if(pending){const prompt=pending;pending=null;await prompt.prompt();await prompt.userChoice;return;}
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  document.querySelector('#installSteps').textContent=ios
   ?'Abre este gestor en Safari. Pulsa Compartir → Añadir a pantalla de inicio y activa Abrir como app web si aparece. Entra con tu usuario para gestionar las pantallas de tu organización.'
   :'Abre el menú de Chrome y elige Instalar aplicación o Añadir a pantalla de inicio. Si no aparece, actualiza Chrome y vuelve a abrir este gestor.';
  dialog.showModal();
 }));
 document.querySelector('#installClose').addEventListener('click',()=>dialog.close());
 const connection=()=>document.querySelector('#connectionStatus').hidden=navigator.onLine;
 window.addEventListener('online',connection);window.addEventListener('offline',connection);
 refresh();connection();
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
