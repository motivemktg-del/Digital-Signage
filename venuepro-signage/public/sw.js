const CACHE='venuepro-player-shell-v2';
const SHELL=['/player.html','/player.css','/player.js','/favicon.svg','/offline.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 // Only public player files are cached. Never cache sessions, API data or SSO URLs.
 if(SHELL.includes(url.pathname)&&!url.search){
  event.respondWith(fetch(event.request).then(response=>{
   if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(url.pathname,copy)));}
   return response;
  }).catch(()=>caches.match(url.pathname)));
 }else if(event.request.mode==='navigate'&&url.pathname==='/'){
  event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
 }
});
