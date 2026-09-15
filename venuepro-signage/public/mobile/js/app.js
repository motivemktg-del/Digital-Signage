// app.js — interfaz nueva (visual Claude Design) conectada a la API real
// de venuepro-signage (server.js). Sin framework: render() regenera el
// HTML de #app; los clics se resuelven por delegación con data-action.

// El QR de una TV sin emparejar ahora es una URL http(s) de verdad
// (?pair=CODE, ver /api/pair/start en server.js) — para que la cámara
// NATIVA del celular la reconozca y abra el panel sola, sin depender del
// escáner de adentro de la página (en iOS Safari ese escáner a veces
// simplemente no arranca la cámara, sin ningún error — problema conocido
// de la librería ahí). Se lee UNA vez al cargar y se limpia de la URL
// (más abajo, con history.replaceState) para que no se repita si el
// usuario refresca o vuelve atrás.
const pairCodeFromUrl = (() => { try { return new URLSearchParams(location.search).get('pair') || ''; } catch { return ''; } })();
const ui = {
  authed: null,      // null = todavía no sabemos, true/false una vez consultado
  route: pairCodeFromUrl ? 'pair' : 'home',      // home | content | schedule | team | pair
  pairCodeFromUrl,    // precarga el campo de código en viewPair() — ver arriba
  loginError: '',
  toast: null,
  detailDeviceId: null,
  deviceMoreOpen: false, // "Ubicación" + "Pantalla" en la ficha van juntas en un solo colapsable, arranca cerrado
  currentLocationId: null, // ubicación abierta en viewLocationDetail (null = "Sin ubicación", un grupo real, no "ninguna")
  // { [ubicaciónId]: "channel:ID"|"playlist:ID" } — qué fuente se está
  // viendo/configurando en el selector de cada ubicación
  // (viewLocationDetail). Una fuente puede ser un canal en vivo O una
  // lista de reproducción — ambas son "algo que un TV puede estar
  // mostrando". Se acuerda de la última elegida por ubicación (no se
  // resetea al salir y volver a entrar) — nunca queda "en blanco": si una
  // ubicación no tiene entrada acá todavía, se usa su primera fuente
  // disponible (canal antes que lista) como default.
  locationSource: {},
  currentFolderId: null,   // carpeta de biblioteca abierta en viewAssetFolder
  previewAssetId: null,    // asset mostrado a pantalla completa (lightbox)
  playlistDraft: null, // { id, name, items:[{asset,seconds}|{channel,seconds}] } al crear/editar lista
  scheduleDraft: null, // objeto de horario al crear/editar
  studioConfig: null,   // resultado de getStudioConfig(), null = sin cargar aún
  studioDrafts: null,   // lista de borradores
  studioDraftId: null,  // borrador abierto
  studioDraft: null,    // { id, name, data, revision, created }
  studioJob: null,      // job de generación en curso/último para este borrador
  studioPolling: false,
  studioConfigForm: null, // { apiKey:'', enabled, monthlyLimit } al editar la config
  ptzCameraId: null,  // cámara abierta en viewPtz
  ptzLocal: null,      // { x, y, zoom, presetId } — posición ASUMIDA, sin
                        // confirmación real de la cámara (no hay agente local)
  mixDeviceId: null,  // pantalla abierta en viewMix
  mixDraft: null,      // { layout, promo, logo, text, muted } — se guarda con saveMixNow()
  // Editores tipo sheet — mismo patrón que playlistDraft/scheduleDraft:
  // {id:null,...} = creando nuevo, {id,...} = editando uno existente. Con
  // id, el editor muestra un 🗑️ para eliminar — así ninguna lista de
  // arriba necesita exponer un botón de eliminar suelto.
  locationDraft: null,    // { id, name }
  channelDraft: null,     // { id, name, url }
  assetFolderDraft: null, // { id, name }
  ptzCameraDraft: null,   // { id, location, name, onvifUrl, rtspUrl, viewUrl }
  mixTemplateDraft: null, // { id, name } — solo el nombre es editable in-place
  theme: (() => { try { return localStorage.getItem('signage-theme') || 'dark'; } catch { return 'dark'; } })(),
};
applyTheme(ui.theme);

// Preferencia solo del dispositivo (localStorage) — no es dato de negocio,
// no hace falta guardarla en el servidor ni sincronizarla entre pantallas.
function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
}

let remote = null; // último resultado de getState(): { tenant, role, email, locations, devices, assets, playlists, schedules }
// Verdadero solo durante el render() que ABRE una ficha (.sheet) — así esa
// ficha toca la animación de entrada una sola vez; los siguientes render()
// mientras sigue abierta (prender un canal, guardar algo) no la repiten.
// Lo pone en true la acción que abre la ficha, justo antes de llamar
// render(); render() mismo lo vuelve a false al terminar de dibujar.
let sheetEntering = false;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function A(action, arg) { return `data-action="${action}" data-arg="${esc(arg)}"`; }
// Enlace de "eliminar" al FONDO de un editor, lejos de cualquier botón de
// uso frecuente (Cerrar, Guardar) — a propósito: ponerlo pegado a Cerrar
// (como estaba antes) hace fácil tocar el equivocado por accidente.
function dangerLink(label, action, arg) {
  return `<div class="row-tap" style="text-align:center;padding:12px 0;margin-top:14px;font:600 12px var(--sans);color:var(--red)" ${A(action, arg)}>${esc(label)}</div>`;
}
function fmtTime(ms) { if (!ms) return 'nunca'; const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return `hace ${s}s`; if (s < 3600) return `hace ${Math.round(s / 60)}m`; return `hace ${Math.round(s / 3600)}h`; }

function showToast(msg, isError) {
  ui.toast = { msg, isError: !!isError };
  render();
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { ui.toast = null; render(); }, 2600);
}

// Firma de lo que trae getState() SIN el latido ("seen") de cada TV — ese
// campo cambia solo por seguir viva (cada ~1s por el heartbeat de
// MainActivity.java), no porque haya algo nuevo que mostrar. La usa el
// auto-refresh silencioso de abajo para saber si de verdad vale la pena
// volver a dibujar, o si sería puro ruido.
let lastStateSignature = null;
function stateSignature(r) {
  try { return JSON.stringify(r, (k, v) => k === 'seen' ? undefined : v); } catch { return null; }
}
async function refresh() {
  try { remote = await getState(); ui.authed = true; lastStateSignature = stateSignature(remote); }
  catch (e) { ui.authed = false; remote = null; lastStateSignature = null; }
  render();
}

async function run(promise, okMsg) {
  try { const r = await promise; if (okMsg) showToast(okMsg); await refresh(); return r; }
  catch (e) { showToast(e.message || 'Error', true); render(); throw e; }
}

// ---- acciones -------------------------------------------------------------

const actions = {
  goTab(route) { ui.route = route; ui.detailDeviceId = null; render(); },

  async submitLogin(_, form) {
    const f = form.closest('form');
    const email = f.email.value.trim(), password = f.password.value;
    ui.loginError = '';
    try { await login(email, password); await refresh(); }
    catch (e) { ui.loginError = e.message || 'No se pudo entrar.'; render(); }
  },
  async logoutNow() { try { await logout(); } catch {} ui.authed = false; remote = null; render(); },
  toggleTheme() {
    ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('signage-theme', ui.theme); } catch {}
    applyTheme(ui.theme); render();
  },

  openDevice(id) { ui.detailDeviceId = id; ui.deviceMoreOpen = false; sheetEntering = true; render(); },
  closeDevice() { ui.detailDeviceId = null; render(); },
  toggleDeviceMore() { ui.deviceMoreOpen = !ui.deviceMoreOpen; render(); },
  async togglePause(id) {
    const d = remote.devices.find(d => d.id === id); if (!d) return;
    await run(setDevicePlayback(id, !d.paused));
  },
  async syncNow(id) { await run(syncDevice(id), 'Sincronización solicitada'); },
  async revoke(id) {
    if (!confirm('¿Quitar esta TV? Tendrás que emparejarla de nuevo.')) return;
    ui.detailDeviceId = null; await run(revokeDevice(id), 'TV eliminada');
  },
  async assignPlaylistTo(id, select) {
    const sel = select.closest('.row').querySelector('select');
    await run(assignPlaylist(id, sel.value), 'Lista asignada');
  },
  async setDisplayOpt(id, el) {
    const wrap = el.closest('[data-display-form]');
    const orientation = wrap.querySelector('[name=orientation]').value;
    const rotation = Number(wrap.querySelector('[name=rotation]').value);
    const fit = wrap.querySelector('[name=fit]').value;
    await run(setDeviceDisplay(id, { orientation, rotation, fit }), 'TV actualizada');
  },
  async moveDevice(id, select) {
    await run(setDeviceLocation(id, select.value || null), 'Ubicación actualizada');
  },
  addLocation() { ui.locationDraft = { id: null, name: '' }; render(); },
  editLocationNow(id) {
    const l = remote.locations.find(l => l.id === id); if (!l) return;
    ui.locationDraft = { id: l.id, name: l.name }; render();
  },
  cancelLocation() { ui.locationDraft = null; render(); },
  async saveLocationDraft(_, form) {
    const name = form.name.value.trim(); if (!name) return;
    const id = ui.locationDraft.id;
    ui.locationDraft = null;
    await run(id ? renameLocation(id, name) : createLocation(name), id ? 'Ubicación actualizada' : 'Ubicación creada');
  },
  async deleteLocationFromEditor() {
    const loc = remote.locations.find(l => l.id === ui.locationDraft.id);
    if (!confirm(`¿Eliminar la ubicación "${loc ? loc.name : ''}"? Esto no se puede deshacer.`)) return;
    const id = ui.locationDraft.id;
    ui.locationDraft = null;
    await run(deleteLocation(id), 'Ubicación eliminada');
  },

  // -- cámaras PTZ (backend real; sin agente local todavía, ver PLAYER_SPEC.md) --
  addPtzCamera(locationId) {
    ui.ptzCameraDraft = { id: null, location: locationId, name: '', onvifUrl: '', rtspUrl: '', viewUrl: '' }; render();
  },
  editPtzCameraNow(id) {
    const c = remote.ptzCameras.find(c => c.id === id); if (!c) return;
    ui.ptzCameraDraft = { id: c.id, location: c.location, name: c.name, onvifUrl: c.onvif_url || '', rtspUrl: c.rtsp_url || '', viewUrl: c.view_url || '' };
    render();
  },
  cancelPtzCamera() { ui.ptzCameraDraft = null; render(); },
  async savePtzCameraDraft(_, form) {
    const name = form.name.value.trim(); if (!name) return;
    const payload = { name, onvifUrl: form.onvifUrl.value.trim() || null, rtspUrl: form.rtspUrl.value.trim() || null, viewUrl: form.viewUrl.value.trim() || null };
    const { id, location } = ui.ptzCameraDraft;
    ui.ptzCameraDraft = null;
    await run(id ? updatePtzCamera(id, payload) : createPtzCamera({ ...payload, location }), id ? 'Cámara actualizada' : 'Cámara agregada');
  },
  async deletePtzCameraFromEditor() {
    if (!confirm('¿Eliminar esta cámara PTZ?')) return;
    const id = ui.ptzCameraDraft.id;
    ui.ptzCameraDraft = null;
    await run(deletePtzCamera(id), 'Cámara eliminada');
  },
  openPtz(camId) {
    ui.ptzCameraId = camId; ui.ptzLocal = { x: 0, y: 0, zoom: 1, presetId: null };
    ui.detailDeviceId = null; ui.route = 'ptz'; render();
  },
  // Desde la ficha de pantalla: si su ubicación tiene una sola cámara PTZ
  // la abre directo; si tiene varias, va a la ubicación a elegir.
  openPtzFromDevice(deviceId) {
    const d = remote.devices.find(x => x.id === deviceId); if (!d || !d.location) return;
    const cams = remote.ptzCameras.filter(c => c.location === d.location);
    if (cams.length === 0) return;
    if (cams.length === 1) actions.openPtz(cams[0].id);
    else actions.openLocation(d.location);
  },
  backFromPtz() { ui.route = 'locationDetail'; render(); },
  async sendPtzToScreensNow() {
    const cam = remote.ptzCameras.find(c => c.id === ui.ptzCameraId); if (!cam) return;
    if (!cam.view_url) return showToast('Configura primero la URL de video (viewUrl) de esta cámara', true);
    const n = remote.devices.filter(d => d.location === cam.location).length;
    if (n === 0) return showToast('Esta ubicación no tiene TVs', true);
    if (!confirm(`¿Mostrar "${cam.name}" en vivo en las ${n} TV(s) de esta ubicación?`)) return;
    await run(sendPtzToScreens(cam.id), `Enviada a ${n} TV(s)`);
  },
  ptzNudge(dir) {
    const s = ui.ptzLocal; s.presetId = null;
    const dx = dir === 'left' ? -8 : dir === 'right' ? 8 : 0, dy = dir === 'up' ? -6 : dir === 'down' ? 6 : 0;
    s.x = Math.max(-40, Math.min(40, s.x + dx)); s.y = Math.max(-24, Math.min(24, s.y + dy));
    sendPtzCommand(ui.ptzCameraId, 'nudge', { dx, dy }).catch(e => showToast(e.message, true));
    render();
  },
  ptzHome() {
    ui.ptzLocal = { x: 0, y: 0, zoom: 1, presetId: null };
    sendPtzCommand(ui.ptzCameraId, 'home', {}).catch(e => showToast(e.message, true));
    render();
  },
  ptzZoom(dir) {
    const s = ui.ptzLocal; s.presetId = null;
    s.zoom = dir === 'in' ? Math.min(3.2, +(s.zoom + .3).toFixed(1)) : Math.max(1, +(s.zoom - .3).toFixed(1));
    sendPtzCommand(ui.ptzCameraId, 'zoom', { delta: dir === 'in' ? 1 : -1 }).catch(e => showToast(e.message, true));
    render();
  },
  ptzGoPreset(presetId) {
    const cam = remote.ptzCameras.find(c => c.id === ui.ptzCameraId); if (!cam) return;
    const p = cam.presets.find(p => p.id === presetId); if (!p) return;
    ui.ptzLocal = { x: p.pan, y: p.tilt, zoom: p.zoom, presetId: p.id };
    sendPtzCommand(ui.ptzCameraId, 'preset', { pan: p.pan, tilt: p.tilt, zoom: p.zoom }).catch(e => showToast(e.message, true));
    render();
  },
  async ptzSavePresetNow() {
    const label = prompt('Nombre del encuadre (ej. Barra, Cocina):'); if (!label) return;
    const s = ui.ptzLocal;
    await run(savePtzPreset(ui.ptzCameraId, { label, pan: s.x, tilt: s.y, zoom: s.zoom }), 'Encuadre guardado');
  },
  async ptzDeletePresetNow(presetId) {
    if (!confirm('¿Eliminar este encuadre guardado?')) return;
    await run(deletePtzPreset(ui.ptzCameraId, presetId), 'Encuadre eliminado');
  },
  openLocation(id) { ui.currentLocationId = id; ui.route = 'locationDetail'; render(); },
  // "Sin ubicación" no es una fila real de la tabla locations — no tiene
  // id para pasarle a openLocation() (A() convertiría null en '' y
  // rompería el filtro d.location===loc.id, que sí necesita null real).
  openUnassignedLocation() { ui.currentLocationId = null; ui.route = 'locationDetail'; render(); },
  // Cambiar de fuente en esta vista NO toca ningún TV todavía — solo
  // decide qué fuente se está mirando/configurando (el preview grande y
  // qué TVs se resaltan en la grilla). Tocar una TV abajo sí actúa de una.
  // Se guarda por ubicación (data-arg = su locationKey) para que la
  // próxima vez que se entre a ESA ubicación se quede en la misma fuente
  // — nunca vuelve a quedar "en blanco".
  setLocationSourcePreview(locationKey, select) { ui.locationSource[locationKey] = select.value; render(); },
  // Tocar una TV en la grilla de una fuente: la ASIGNA a esta fuente — NO
  // es un interruptor de encendido/apagado. Una TV nunca se apaga sola
  // desde acá tocándola de nuevo; solo deja de tener ESTA fuente cuando
  // OTRA fuente la toma (se toca su ícono estando esa otra elegida
  // arriba). Volver a "sin ninguna fuente" no existe desde acá — la más
  // parecido es asignarle una lista de reproducción como fuente.
  // arg = "deviceId:channel:ID" o "deviceId:playlist:ID" — el kind decide
  // qué endpoint llamar; asignar una lista TAMBIÉN apaga cualquier canal
  // en vivo que tuviera encima (si no, la lista quedaría guardada pero
  // tapada por el canal, que deviceManifest() prioriza).
  async assignDeviceToSource(arg) {
    const [deviceId, kind, sourceId] = arg.split(':');
    const d = remote.devices.find(x => x.id === deviceId);
    if (kind === 'channel') {
      if (d && d.liveChannel === sourceId) return; // ya está en esta fuente, nada que hacer
      await run(setLiveChannel(deviceId, sourceId), 'Fuente activada');
    } else {
      if (d && !d.liveChannel && d.playlist === sourceId) return; // ya está mostrando esta lista
      await run(Promise.all([assignPlaylist(deviceId, sourceId), d && d.liveChannel ? setLiveChannel(deviceId, null) : null].filter(Boolean)), 'Fuente activada');
    }
  },
  // Mezclar desde la vista de fuente: sin una TV puntual seleccionada (acá
  // se trabaja por fuente, no por TV), se abre el editor sobre la PRIMERA
  // TV con esa fuente activa — mismo mix que ya existe, ver openMix().
  openMixForChannel(channelId) {
    const d = remote.devices.find(x => x.liveChannel === channelId);
    if (!d) return showToast('Ninguna TV tiene esta fuente activa todavía', true);
    actions.openMix(d.id);
  },

  // -- estudio IA --
  async goStudio() {
    ui.route = 'studio'; render();
    try { ui.studioConfig = await getStudioConfig(); } catch (e) { showToast(e.message, true); }
    if (ui.studioConfig && ui.studioConfig.eligible) {
      try { ui.studioDrafts = await listStudioDrafts(); } catch (e) { showToast(e.message, true); }
    }
    render();
  },
  editStudioConfig() {
    const c = ui.studioConfig;
    ui.studioConfigForm = { apiKey: '', enabled: !!c.enabled, monthlyLimit: c.monthlyLimit || 10 };
    render();
  },
  cancelStudioConfig() { ui.studioConfigForm = null; render(); },
  async saveStudioConfigNow(_, form) {
    const f = form.closest('form');
    const payload = { enabled: f.enabled.checked, monthlyLimit: Number(f.monthlyLimit.value) };
    if (f.apiKey.value.trim()) payload.apiKey = f.apiKey.value.trim();
    try {
      ui.studioConfig = await saveStudioConfig(payload);
      ui.studioConfigForm = null; showToast('Configuración guardada'); render();
    } catch (e) { showToast(e.message, true); }
  },
  async verifyStudioNow() {
    try { ui.studioConfig = await verifyStudio(); showToast('Acceso al modelo confirmado'); render(); }
    catch (e) { showToast(e.message, true); }
  },
  async newStudioDraft() {
    const name = prompt('Nombre del poster (ej. Promo viernes):'); if (!name) return;
    try {
      const created = await createStudioDraft({ name, kind: 'promotion', orientation: 'portrait', style: '', notes: '', layers: [] });
      ui.studioDrafts = await listStudioDrafts();
      actions.openStudioDraft(created.id);
    } catch (e) { showToast(e.message, true); }
  },
  async deleteStudioDraftFromEditor() {
    if (!confirm('¿Eliminar este borrador de poster? No se puede deshacer.')) return;
    const id = ui.studioDraftId;
    try {
      await deleteStudioDraft(id); ui.studioDrafts = await listStudioDrafts();
      showToast('Borrador eliminado'); actions.backToStudio();
    } catch (e) { showToast(e.message, true); }
  },
  async openStudioDraft(id) {
    ui.studioDraftId = id; ui.route = 'studioDraft'; ui.studioJob = null; render();
    try { ui.studioDraft = await getStudioDraft(id); } catch (e) { showToast(e.message, true); }
    render();
  },
  backToStudio() { ui.route = 'studio'; ui.studioDraft = null; ui.studioDraftId = null; render(); },
  setDraftField(field, el) { ui.studioDraft.data[field] = el.value; },
  setDraftKind(_, el) { ui.studioDraft.data.kind = el.value; render(); },
  setDraftOrientation(_, el) { ui.studioDraft.data.orientation = el.value; render(); },
  addTextLayer() {
    ui.studioDraft.data.layers.push({ text: 'Texto', x: 10, y: 10, size: 48, color: '#ffffff' });
    render();
  },
  removeTextLayer(idx) { ui.studioDraft.data.layers.splice(Number(idx), 1); render(); },
  setLayerField(argStr, el) {
    const [idx, field] = argStr.split(':');
    const layer = ui.studioDraft.data.layers[Number(idx)];
    layer[field] = (field === 'x' || field === 'y' || field === 'size') ? Number(el.value) : el.value;
    drawStudioCanvas(); // repinta sin re-renderizar el HTML (no pierde el foco al escribir)
  },
  async saveStudioDraftNow() {
    const d = ui.studioDraft;
    try {
      const saved = await updateStudioDraft(d.id, d.data, d.revision);
      ui.studioDraft = saved; showToast('Borrador guardado');
    } catch (e) { showToast(e.message, true); }
    render();
  },
  async generateStudioNow() {
    const d = ui.studioDraft;
    if (!confirm(`Esto usa 1 de tus ${ui.studioConfig.monthlyLimit} solicitudes mensuales de tu cuenta de OpenAI. ¿Generar el fondo ahora?`)) return;
    try {
      await updateStudioDraft(d.id, d.data, d.revision).then(saved => ui.studioDraft = saved);
      const requestId = crypto.randomUUID();
      await generateStudioDraft(d.id, ui.studioDraft.revision, requestId);
      showToast('Generando… puede tardar hasta un minuto');
      pollStudioJob(requestId);
    } catch (e) { showToast(e.message, true); }
  },
  async retryStudioSaveNow() {
    if (!ui.studioJob) return;
    try { await retryStudioSave(ui.studioJob.id); showToast('Reintentando guardado…'); pollStudioJob(ui.studioJob.id); }
    catch (e) { showToast(e.message, true); }
  },
  async exportStudioNow() {
    const canvas = document.getElementById('studio-canvas');
    if (!canvas) return showToast('Genera el fondo primero', true);
    canvas.toBlob(async blob => {
      try {
        await exportStudioDraft(ui.studioDraft.id, ui.studioDraft.revision, blob);
        showToast('Guardado en tu biblioteca'); await refresh(); actions.backToStudio();
      } catch (e) { showToast(e.message, true); }
    }, 'image/png');
  },

  // -- canales (fuente en vivo configurada UNA vez, no en cada pantalla —
  // ver server.js /api/channels). Solo pide nombre y URL: un canal está
  // disponible para TODAS las pantallas (switch en Fuente) y para TODAS
  // las listas de reproducción (item más), sin restringirlo por ubicación.
  newChannel() { ui.channelDraft = { id: null, name: '', url: '' }; render(); },
  editChannelNow(id) {
    const c = remote.channels.find(c => c.id === id); if (!c) return;
    ui.channelDraft = { id: c.id, name: c.name, url: c.url }; render();
  },
  cancelChannel() { ui.channelDraft = null; render(); },
  async saveChannelDraft(_, form) {
    const name = form.name.value.trim(), url = form.url.value.trim(); if (!name || !url) return;
    const id = ui.channelDraft.id;
    ui.channelDraft = null;
    await run(id ? updateChannel(id, { name, url }) : createChannel({ name, url }), id ? 'Canal actualizado' : 'Canal creado');
  },
  async deleteChannelFromEditor() {
    if (!confirm('¿Eliminar este canal? Las TVs que lo tengan activo se quedarán sin fuente.')) return;
    const id = ui.channelDraft.id;
    ui.channelDraft = null;
    await run(deleteChannel(id), 'Canal eliminado');
  },
  // Un solo <select> decide la Fuente: "" = lista de reproducción, o el id
  // de un canal — por id, no por URL (si dos canales llegaran a compartir
  // la misma URL, viejos de antes de bloquear eso al crear, comparar por
  // URL los mostraría "prendidos" juntos; el id nunca se repite).
  async setDeviceSource(id, select) {
    await run(setLiveChannel(id, select.value || null), select.value ? 'Canal activado' : 'Volviendo a la lista');
  },
  // -- mezclador (backend real: layout+texto+logo+promo sobre la señal en
  // vivo, ver /api/devices/:id/mix en server.js) --
  openMix(id) {
    const d = remote.devices.find(d => d.id === id);
    if (!d || !d.liveSource) return showToast('Activa una señal en vivo primero', true);
    ui.mixDeviceId = id;
    ui.mixDraft = newMixDraft(d.mix);
    ui.detailDeviceId = null; ui.route = 'mix'; render();
  },
  backFromMix() {
    // Vuelve a "home", no "content" — ui.detailDeviceId (la ficha de
    // pantalla que se estaba editando) solo lo abre viewHome(); en
    // "content" no hace nada, así que antes se perdía y aterrizabas en
    // Contenido en vez de volver a la pantalla de donde saliste.
    const id = ui.mixDeviceId;
    ui.route = 'home'; ui.mixDeviceId = null; ui.mixDraft = null; ui.detailDeviceId = id; sheetEntering = true; render();
  },
  setMixLayout(layout) { ui.mixDraft.layout = layout; render(); },
  setMixText(_, el) { ui.mixDraft.text = el.value; },
  toggleMixMuted() { ui.mixDraft.muted = !ui.mixDraft.muted; render(); },
  setMixPromo(id) { ui.mixDraft.promo = ui.mixDraft.promo === id ? null : id; render(); },
  async pickMixLogo(_, input) {
    const file = input.files[0]; if (!file) return;
    showToast('Subiendo logo…');
    try { const a = await uploadAsset(file); await refresh(); ui.mixDraft.logo = a.id; render(); }
    catch (e) { showToast(e.message, true); }
    input.value = '';
  },
  clearMixLogo() { ui.mixDraft.logo = null; render(); },
  // -- micro-editor: colores/tamaño/grosor/velocidad del fundido --
  setMixStripeColor(_, el) { ui.mixDraft.stripeColor = el.value; render(); },
  setMixTextColor(_, el) { ui.mixDraft.textColor = el.value; render(); },
  setMixFontSize(_, el) { ui.mixDraft.fontSize = Number(el.value); render(); },
  setMixThickness(_, el) { ui.mixDraft.thickness = Number(el.value); render(); },
  setMixFadeMs(_, el) { ui.mixDraft.fadeMs = Number(el.value); render(); },
  async saveMixNow() { await run(setMix(ui.mixDeviceId, mixDraftPayload(ui.mixDraft)), 'Mezcla guardada'); },
  async clearMixNow() {
    if (!confirm('¿Quitar la mezcla de esta TV?')) return;
    ui.mixDraft = newMixDraft();
    await run(clearMix(ui.mixDeviceId), 'Mezcla quitada');
  },
  async saveMixTemplateNow() {
    const name = prompt('Nombre de la plantilla (ej. Happy Hour):'); if (!name) return;
    await run(createMixTemplate({ name, ...mixDraftPayload(ui.mixDraft) }), 'Plantilla guardada');
  },
  applyMixTemplate(id) {
    const t = (remote.mixTemplates || []).find(t => t.id === id); if (!t) return;
    ui.mixDraft = newMixDraft({ layout: t.layout, promo: t.promo, logo: t.logo, text: t.text, muted: !!t.muted, ...(t.style || {}) });
    render();
  },
  editMixTemplateNow(id) {
    const t = (remote.mixTemplates || []).find(t => t.id === id); if (!t) return;
    ui.mixTemplateDraft = { id: t.id, name: t.name }; render();
  },
  cancelMixTemplate() { ui.mixTemplateDraft = null; render(); },
  async saveMixTemplateDraft(_, form) {
    const name = form.name.value.trim(); if (!name) return;
    const id = ui.mixTemplateDraft.id;
    ui.mixTemplateDraft = null;
    await run(renameMixTemplate(id, name), 'Plantilla actualizada');
  },
  async deleteMixTemplateFromEditor() {
    if (!confirm('¿Eliminar esta plantilla?')) return;
    const id = ui.mixTemplateDraft.id;
    ui.mixTemplateDraft = null;
    await run(deleteMixTemplate(id), 'Plantilla eliminada');
  },
  // "Marca consistente en cada pantalla que manejas" — aplica de un toque,
  // con el mismo patrón de confirmar-antes-de-actuar que todo lo demás.
  async applyMixTemplateToLocation(id) {
    const t = (remote.mixTemplates || []).find(t => t.id === id); if (!t) return;
    const d = remote.devices.find(d => d.id === ui.mixDeviceId);
    const location = d ? d.location : null;
    if (!location) return showToast('Esta TV no tiene ubicación asignada', true);
    const loc = remote.locations.find(l => l.id === location);
    const n = remote.devices.filter(x => x.location === location && x.liveSource).length;
    if (n === 0) return showToast('Ninguna TV de esta ubicación tiene señal en vivo', true);
    if (!confirm(`¿Aplicar "${t.name}" a las ${n} TV(s) con señal en vivo de "${loc ? loc.name : 'esta ubicación'}"?`)) return;
    await run(applyMixTemplateToAll(id, location), `Aplicada a ${n} TV(s)`);
  },
  async applyMixTemplateToAllNow(id) {
    const t = (remote.mixTemplates || []).find(t => t.id === id); if (!t) return;
    const n = remote.devices.filter(x => x.liveSource).length;
    if (n === 0) return showToast('Ninguna de tus TVs tiene señal en vivo', true);
    if (!confirm(`¿Aplicar "${t.name}" a TODAS tus TVs con señal en vivo (${n})?`)) return;
    await run(applyMixTemplateToAll(id, null), `Aplicada a ${n} TV(s)`);
  },
  // -- alerta de emergencia (backend real: ver /api/devices/:id/alert y
  // /api/alerts/broadcast en server.js) — a diferencia del mezclador,
  // funciona con CUALQUIER cosa en pantalla, no necesita señal en vivo.
  async sendAlertNow(id) {
    const text = prompt('Texto de la alerta (ej. "Cierre anticipado por clima"):'); if (!text) return;
    const level = (prompt('Nivel: info / warning / critical', 'warning') || '').trim().toLowerCase();
    if (!['info', 'warning', 'critical'].includes(level)) return showToast('Nivel inválido — usa info, warning o critical', true);
    await run(setAlert(id, { text, level }), 'Alerta enviada');
  },
  async clearAlertNow(id) {
    await run(clearAlert(id), 'Alerta quitada');
  },
  async broadcastAlertNow() {
    const n = remote.devices.length;
    if (n === 0) return showToast('No tienes TVs todavía', true);
    const text = prompt(`Texto de la alerta para TODAS tus TVs (${n}):`); if (!text) return;
    const level = (prompt('Nivel: info / warning / critical', 'warning') || '').trim().toLowerCase();
    if (!['info', 'warning', 'critical'].includes(level)) return showToast('Nivel inválido — usa info, warning o critical', true);
    if (!confirm(`¿Enviar esta alerta a las ${n} TV(s)?`)) return;
    const res = await run(broadcastAlert({ text, level, location: null }), null);
    if (res) showToast(`Alerta enviada a ${res.applied} TV(s)`);
  },
  async clearAllAlertsNow() {
    if (!confirm('¿Quitar la alerta de TODAS tus TVs?')) return;
    const res = await run(clearAllAlerts(null), null);
    if (res) showToast(`Alerta quitada de ${res.applied} TV(s)`);
  },
  // -- emparejar --
  // El código lo genera la PANTALLA (la TV/tablet llama a /api/pair/start
  // sola, sin sesión, y muestra su propio QR+código) — el admin solo lo
  // escanea o lo escribe aquí y lo reclama con pairClaim().
  startPairing() { ui.route = 'pair'; render(); },
  async confirmPair(_, form) {
    const f = form.closest('form');
    const code = f.code.value.trim(), name = f.name.value.trim(), location = f.location.value || null;
    try {
      await pairClaim(code, name, location);
      stopScanner(); showToast('TV vinculada'); ui.route = 'home'; await refresh();
    } catch (e) { showToast(e.message, true); }
  },
  cancelPair() { stopScanner(); ui.route = 'home'; render(); },

  // -- multimedia --
  async pickUpload(_, input) {
    const file = input.files[0]; if (!file) return;
    showToast('Subiendo…');
    try { await uploadAsset(file); showToast('Archivo subido'); await refresh(); }
    catch (e) { showToast(e.message, true); }
    input.value = '';
  },
  async renameAsset(id) {
    const a = remote.assets.find(a => a.id === id); const name = prompt('Nuevo nombre:', a ? a.name : ''); if (!name) return;
    await run(renameAsset(id, name), 'Renombrado');
  },
  async archiveAsset(id) {
    if (!confirm('¿Archivar este archivo? No podrás usarlo en listas nuevas.')) return;
    await run(archiveAsset(id), 'Archivado');
  },
  openAssetPreview(id) { ui.previewAssetId = id; render(); },
  closeAssetPreview() { ui.previewAssetId = null; render(); },

  // -- carpetas de biblioteca (solo agrupan, no mueven el archivo real) --
  newAssetFolder() { ui.assetFolderDraft = { id: null, name: '' }; render(); },
  editAssetFolderNow(id) {
    const f = (remote.assetFolders || []).find(f => f.id === id); if (!f) return;
    ui.assetFolderDraft = { id: f.id, name: f.name }; render();
  },
  cancelAssetFolder() { ui.assetFolderDraft = null; render(); },
  async saveAssetFolderDraft(_, form) {
    const name = form.name.value.trim(); if (!name) return;
    const id = ui.assetFolderDraft.id;
    ui.assetFolderDraft = null;
    await run(id ? renameAssetFolder(id, name) : createAssetFolder(name), id ? 'Carpeta actualizada' : 'Carpeta creada');
  },
  async deleteAssetFolderFromEditor() {
    const f = (remote.assetFolders || []).find(f => f.id === ui.assetFolderDraft.id);
    if (!confirm(`¿Eliminar la carpeta "${f ? f.name : ''}"? Debe estar vacía.`)) return;
    const id = ui.assetFolderDraft.id;
    ui.assetFolderDraft = null;
    await run(deleteAssetFolder(id), 'Carpeta eliminada');
  },
  openAssetFolder(id) { ui.currentFolderId = id; ui.route = 'assetFolder'; render(); },
  backFromAssetFolder() { ui.route = 'content'; ui.currentFolderId = null; render(); },
  async addAssetToFolder(_, select) {
    if (!select.value) return;
    await run(setAssetFolder(select.value, ui.currentFolderId), 'Archivo movido a la carpeta');
    select.value = '';
  },
  async removeAssetFromFolderNow(id) {
    await run(setAssetFolder(id, null), 'Archivo movido a "Sin carpeta"');
  },
  async moveAssetToFolderNow(assetId, select) {
    if (!select.value) return;
    await run(setAssetFolder(assetId, select.value), 'Archivo movido a la carpeta');
    select.value = '';
  },
  newPlaylist() { ui.playlistDraft = { id: null, name: '', items: [] }; sheetEntering = true; render(); },
  editPlaylist(id) {
    const p = remote.playlists.find(p => p.id === id); if (!p) return;
    ui.playlistDraft = { id: p.id, name: p.name, items: p.items.map(i => ({ ...i })) }; sheetEntering = true; render();
  },
  cancelPlaylist() { ui.playlistDraft = null; render(); },
  addDraftItem(_, select) {
    // El <select> mezcla archivos y canales en vivo — el valor viene
    // prefijado ("asset:ID" / "channel:ID") para saber cuál es cuál.
    const value = select.value; if (!value) return;
    const [kind, id] = value.split(':');
    ui.playlistDraft.items.push(kind === 'channel' ? { channel: id, seconds: 10 } : { asset: id, seconds: 10 });
    render();
  },
  removeDraftItem(idx) { ui.playlistDraft.items.splice(Number(idx), 1); render(); },
  setDraftSeconds(idx, input) { ui.playlistDraft.items[Number(idx)].seconds = Math.max(1, Number(input.value) || 10); },
  setDraftName(_, input) { ui.playlistDraft.name = input.value; },
  async savePlaylistDraft() {
    const d = ui.playlistDraft;
    if (!d.name.trim()) return showToast('Ponle un nombre a la lista', true);
    if (!d.items.length) return showToast('Agrega al menos un archivo', true);
    await run(savePlaylist({ id: d.id || undefined, name: d.name.trim(), items: d.items }), 'Lista guardada');
    ui.playlistDraft = null; render();
  },
  async deletePlaylistFromEditor() {
    if (!confirm('¿Eliminar esta lista?')) return;
    const id = ui.playlistDraft.id;
    ui.playlistDraft = null;
    await run(deletePlaylist(id), 'Lista eliminada');
  },

  // -- horarios --
  newSchedule() {
    ui.scheduleDraft = { id: null, device: remote.devices[0]?.id || '', playlist: remote.playlists[0]?.id || '', name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', fromDate: '', toDate: '', priority: 0 };
    sheetEntering = true; render();
  },
  editSchedule(id) {
    const s = remote.schedules.find(s => s.id === id); if (!s) return;
    ui.scheduleDraft = { ...s }; sheetEntering = true; render();
  },
  cancelSchedule() { ui.scheduleDraft = null; render(); },
  toggleDraftDay(dayStr) {
    const day = Number(dayStr); const d = ui.scheduleDraft;
    d.days = d.days.includes(day) ? d.days.filter(x => x !== day) : [...d.days, day];
    render();
  },
  async saveScheduleDraft(_, form) {
    const f = form.closest('form'); const d = ui.scheduleDraft;
    const payload = { id: d.id || undefined, device: f.device.value, playlist: f.playlist.value, name: f.name.value.trim(), timezone: f.timezone.value.trim(), days: d.days, start: f.start.value, end: f.end.value, fromDate: f.fromDate.value || undefined, toDate: f.toDate.value || undefined, priority: Number(f.priority.value) };
    if (!payload.name) return showToast('Ponle un nombre al programa', true);
    if (!payload.days.length) return showToast('Selecciona al menos un día', true);
    await run(saveSchedule(payload), 'Programa guardado');
    ui.scheduleDraft = null; render();
  },
  async deleteScheduleFromEditor() {
    if (!confirm('¿Eliminar este programa?')) return;
    const id = ui.scheduleDraft.id;
    ui.scheduleDraft = null;
    await run(deleteSchedule(id), 'Programa eliminado');
  },

  // -- equipo --
  async addUser() {
    const email = prompt('Correo del nuevo acceso:'); if (!email) return;
    const pass = prompt('Contraseña inicial (mínimo 12 caracteres):'); if (!pass) return;
    const role = prompt('Rol: admin / editor / viewer', 'editor'); if (!role) return;
    try { await createUser(email.trim().toLowerCase(), pass, role.trim()); showToast('Usuario creado'); loadUsers(); }
    catch (e) { showToast(e.message, true); }
  },
  async removeUser(email) {
    if (!confirm(`¿Quitar el acceso de ${email}?`)) return;
    try { await deleteUser(email); showToast('Acceso eliminado'); loadUsers(); }
    catch (e) { showToast(e.message, true); }
  }
};

// Mantener presionado (data-longpress) — para la grilla de TVs: un toque
// corto prende/apaga la fuente, mantener presionado abre la ficha completa
// de esa TV. Genérico por si hace falta en otro lado después. Se cancela
// solo si el dedo se mueve más de ~10px (para no disparar durante un
// scroll) o se suelta antes de tiempo; si SÍ dispara, se marca
// longPressFired para que el click que sigue (el navegador siempre manda
// uno al soltar) no dispare TAMBIÉN la acción corta de data-action.
let longPressTimer = null, longPressFired = false, longPressStart = null;
function cancelLongPress() { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } longPressStart = null; }
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-longpress]');
  if (!el) return;
  longPressStart = { x: e.clientX, y: e.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null; longPressFired = true;
    const fn = actions[el.dataset.longpress];
    // Arg PROPIO (data-longpress-arg), no data-arg — un mismo elemento
    // puede tener data-action (toque corto) y data-longpress (mantener
    // presionado) a la vez, cada uno con su arg distinto (ver deviceTile);
    // si compartieran data-arg, el HTML solo se queda con el PRIMER valor
    // que aparece en el string y el otro gesto lee el arg equivocado.
    if (fn) fn(el.dataset.longpressArg, el);
    if (navigator.vibrate) navigator.vibrate(12);
  }, 480);
});
document.addEventListener('pointerup', cancelLongPress);
document.addEventListener('pointercancel', cancelLongPress);
document.addEventListener('pointermove', e => {
  if (!longPressStart) return;
  if (Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y) > 10) cancelLongPress();
});
// Suprime el menú contextual (guardar imagen, etc.) que Android/iOS abren
// solo al mantener presionada una <img> — chocaría con el long-press de arriba.
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-longpress]')) e.preventDefault(); });
document.addEventListener('click', e => {
  if (longPressFired) { longPressFired = false; e.preventDefault(); e.stopPropagation(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset.arg, el);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = actions[el.dataset.change];
  if (fn) fn(el.dataset.arg, el);
});
// CSP del backend real es script-src 'self' (sin 'unsafe-inline'): nada de
// onclick/onsubmit/oninput en el HTML, todo por delegación aquí.
document.addEventListener('submit', e => {
  const el = e.target.closest('[data-submit]');
  if (!el) return;
  e.preventDefault();
  const fn = actions[el.dataset.submit];
  if (fn) fn(el.dataset.arg, el);
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  const fn = actions[el.dataset.input];
  if (fn) fn(el.dataset.arg, el);
});

// ---- piezas reutilizables ---------------------------------------------------

// SVG trazados (currentColor) en vez de los cuadros vacíos que había antes.
const TAB_ICONS = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2.2"/><path d="M8.5 20.5h7M12 17v3.5"/></svg>`,
  playlists: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h13M4 12h13M4 18h9"/><path d="M19 15l3 2-3 2v-4z" fill="currentColor" stroke="none"/></svg>`,
  content: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.7" y="2.7" width="8" height="8" rx="1.8"/><rect x="13.3" y="2.7" width="8" height="8" rx="1.8"/><rect x="2.7" y="13.3" width="8" height="8" rx="1.8"/><rect x="13.3" y="13.3" width="8" height="8" rx="1.8"/></svg>`,
  schedule: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.3"/><path d="M12 7v5.2l3.6 2.1"/></svg>`,
};
function tabbar() {
  const tabs = [['home', 'TVs', TAB_ICONS.home], ['playlists', 'Listas', TAB_ICONS.playlists], ['content', 'Contenido', TAB_ICONS.content], ['schedule', 'Horarios', TAB_ICONS.schedule]];
  return `<div class="tabbar">${tabs.map(([r, label, icon]) => `
    <button class="tab ${ui.route === r ? 'active' : ''}" ${A('goTab', r)}><div class="ico">${icon}</div><span>${label}</span></button>`).join('')}</div>`;
}
function toastHtml() {
  if (!ui.toast) return '';
  return `<div style="position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:${ui.toast.isError ? '#3a1f1d' : '#1b1d22'};border:1px solid ${ui.toast.isError ? 'rgba(242,99,90,.4)' : 'var(--line)'};color:#fff;padding:10px 16px;border-radius:6px;font:600 12.5px var(--sans);z-index:30;max-width:88%;box-shadow:0 6px 20px rgba(0,0,0,.35)">${esc(ui.toast.msg)}</div>`;
}
function topbar(title) {
  // El 🚨 solo va en la pestaña Home (hoy: Ubicaciones) — es un disparador
  // de emergencia para TODAS las TVs de una, no pinta tenerlo repetido en
  // cada pestaña. Se fija por ruta, no por el texto del título, para que
  // no dependa de cómo se llame esa pantalla.
  return `<div class="topbar" style="justify-content:space-between">
    <div class="title">${esc(title)}</div>
    <div style="display:flex;align-items:center;gap:14px">
      ${ui.route === 'home' ? `<div class="row-tap" title="Alerta de emergencia a todas las TVs" style="font-size:18px;line-height:1" ${A('broadcastAlertNow')}>🚨</div>` : ''}
      <div class="row-tap" title="Ajustes" style="font-size:18px;line-height:1" ${A('goTab', 'settings')}>⚙️</div>
    </div>
  </div>`;
}

// ---- Login ------------------------------------------------------------------

function viewLogin() {
  return `<div class="screen" style="align-items:center;justify-content:center;padding:24px">
    <div style="width:100%;max-width:340px">
      <div style="font:700 26px var(--sans);letter-spacing:-.02em;margin-bottom:6px">Motive Signage</div>
      <div style="font:400 12.5px var(--sans);color:var(--ink-dim);margin-bottom:24px">Accede al panel de tu organización.</div>
      <form data-submit="submitLogin">
        <div class="stack">
          <input name="email" type="email" required placeholder="Correo" autocomplete="username" style="padding:13px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);font:500 14px var(--sans)">
          <input name="password" type="password" required placeholder="Contraseña" autocomplete="current-password" style="padding:13px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);font:500 14px var(--sans)">
          ${ui.loginError ? `<div style="font:400 11.5px var(--sans);color:var(--red)">${esc(ui.loginError)}</div>` : ''}
          <button type="submit" class="btn btn-primary" style="margin-top:6px;border:none">Entrar</button>
        </div>
      </form>
    </div>
    ${toastHtml()}
  </div>`;
}

// ---- Home (Pantallas) --------------------------------------------------------

// Home pasa a ser Ubicaciones directo (antes era una lista de TVs con una
// fila "📍 N ubicaciones ›" que llevaba a una pantalla aparte — ahora esa
// pantalla aparte ES el home, un nivel menos de navegación). Elegir una
// fuente y decidir en qué TVs se ve vive en viewLocationDetail(), un nivel
// más adentro.
function viewHome() {
  const counts = new Map(remote.locations.map(l => [l.id, 0]));
  let unassigned = 0;
  for (const d of remote.devices) { if (counts.has(d.location)) counts.set(d.location, counts.get(d.location) + 1); else unassigned++; }
  return `<div class="screen">
    ${topbar('Ubicaciones')}
    <div class="content">
      <div class="row" style="gap:8px;margin-bottom:16px">
        <div class="row-tap" style="flex:1;text-align:center;padding:11px 0;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 12.5px var(--sans);color:var(--ink-dim)" ${A('startPairing')}>+ Emparejar TV</div>
      </div>
      ${remote.locations.length === 0 && unassigned === 0 ? emptyState('Sin ubicaciones todavía', 'Agrega la primera para empezar a organizar tus TVs.') : `<div class="stack" style="margin-bottom:16px">
        ${remote.locations.map(l => `<div class="card row row-tap" style="padding:13px 14px" ${A('openLocation', l.id)}>
          <div style="flex:1;min-width:0">
            <div style="font:600 13px var(--sans)">${esc(l.name)}</div>
            <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${counts.get(l.id) || 0} TV${counts.get(l.id) === 1 ? '' : 's'}</div>
          </div>
          <div class="row-tap" title="Editar ubicación" style="width:28px;height:28px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);margin-right:6px" ${A('editLocationNow', l.id)}>✏️</div>
          <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
        </div>`).join('')}
        ${unassigned ? `<div class="card row row-tap" style="padding:13px 14px;opacity:.75" ${A('openUnassignedLocation')}>
          <div style="flex:1;min-width:0">
            <div style="font:600 13px var(--sans)">Sin ubicación</div>
            <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${unassigned} TV${unassigned === 1 ? '' : 's'}</div>
          </div>
          <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
        </div>` : ''}
      </div>`}
      <div class="btn btn-ghost row-tap" ${A('addLocation')}>+ Añadir ubicación</div>
      <div style="font:400 11px/1.5 var(--sans);color:var(--ink-faint);margin-top:14px">Solo se puede eliminar una ubicación vacía (sin TVs).</div>
    </div>
    ${tabbar()}
    ${ui.locationDraft ? locationEditor(ui.locationDraft) : ''}
    ${toastHtml()}
  </div>`;
}

function locationEditor(d) {
  return `<div class="backdrop" ${A('cancelLocation')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar ubicación' : 'Nueva ubicación'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelLocation')}>✕</div>
    </div>
    <form data-submit="saveLocationDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. Sucursal Centro)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      </div>
    </form>
    ${d.id ? dangerLink('Eliminar ubicación', 'deleteLocationFromEditor') : ''}
  </div>`;
}

// "Sin ubicación" (loc.id null) es un grupo de verdad pero no una fila de
// la tabla locations — sin canales propios (los canales siempre son de
// una ubicación real) ni cámaras PTZ, así que ahí solo se ve la grilla de
// TVs (para moverlas a una ubicación real desde su ficha).
function viewLocationDetail() {
  const loc = ui.currentLocationId === null ? { id: null, name: 'Sin ubicación' } : remote.locations.find(l => l.id === ui.currentLocationId);
  if (loc === undefined) { ui.route = 'home'; return viewHome(); }
  const devices = remote.devices.filter(d => d.location === loc.id);
  // Un canal sin ubicación asignada (!c.location) está disponible para
  // CUALQUIER TV, no solo las de una ubicación puntual — mismo filtro que
  // ya usa el selector de Fuente de la ficha individual (ver deviceSheet).
  const chans = (remote.channels || []).filter(c => !c.location || c.location === loc.id);
  // Las listas de reproducción NO son de una ubicación (se pueden usar en
  // cualquier TV) — todas cuentan como fuente posible acá también. Una
  // "fuente" ya no es solo "señal en vivo": es cualquier cosa que un TV
  // pueda estar mostrando, y el selector tiene que reflejar eso completo.
  const sourceOptions = [
    ...chans.map(c => ({ value: `channel:${c.id}`, kind: 'channel', id: c.id, label: esc(c.name) })),
    ...remote.playlists.map(p => ({ value: `playlist:${p.id}`, kind: 'playlist', id: p.id, label: `▶ ${esc(p.name)}` })),
  ];
  // "Sin ubicación" no tiene id real — se guarda bajo una llave de texto
  // fija en vez de "null" (las claves de un objeto JS siempre son string,
  // "null" se prestaría a confusión leyendo el código).
  const locationKey = loc.id === null ? 'unassigned' : loc.id;
  // NUNCA en blanco: si todavía no se eligió nada para esta ubicación (o
  // lo que se había elegido ya no existe/no aplica acá), cae a la primera
  // fuente disponible — el selector solo queda vacío si de plano no hay
  // NINGÚN canal ni lista (sourceOptions.length===0), caso aparte abajo.
  const selected = sourceOptions.find(o => o.value === ui.locationSource[locationKey]) || sourceOptions[0] || null;
  // "Activa" para un canal = esta TV lo tiene prendido. Para una lista =
  // esta TV la está mostrando DE VERDAD (sin un canal encima tapándola).
  const activeCount = !selected ? 0 : devices.filter(d => selected.kind === 'channel' ? d.liveChannel === selected.id : (!d.liveChannel && d.playlist === selected.id)).length;
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goTab', 'home')}>‹</div><div class="title">${esc(loc.name)}</div></div>
    <div class="content">
      ${locationSourceBlock(locationKey, sourceOptions, selected, activeCount)}
      <div class="eyebrow">TVs${devices.length ? ' · ' + devices.length : ''}</div>
      ${devices.length === 0 ? emptyState('Sin TVs aquí todavía', 'Empareja una TV y elige esta ubicación, o mueve una existente desde su detalle.') : `<div class="grid-4" style="margin-bottom:20px">${devices.map(d => deviceTile(d, selected)).join('')}</div>`}
    </div>
    ${ui.detailDeviceId ? deviceSheet() : ''}
    ${ui.ptzCameraDraft ? ptzCameraEditor(ui.ptzCameraDraft) : ''}
    ${toastHtml()}
  </div>`;
}

// Selector de fuente de la ubicación (arriba de la grilla de TVs) — una
// fuente ahora es un canal en vivo O una lista de reproducción, lo que
// sea que ya se haya armado en Contenido/Listas. NUNCA queda en blanco —
// siempre hay algo elegido mientras exista al menos una opción (ver
// selected en viewLocationDetail). Elegir acá solo cambia el preview
// grande y qué TVs se resaltan abajo; para de verdad asignársela a una TV
// hay que tocarla en la grilla. "Mezclar" solo aplica a canales en vivo
// (el mix necesita señal en vivo real) — se oculta con una lista elegida.
function locationSourceBlock(locationKey, sourceOptions, selected, activeCount) {
  const box = 'width:100%;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:repeating-linear-gradient(135deg,#242830 0 7px,#1c1f25 7px 14px);display:flex;align-items:center;justify-content:center;margin-bottom:14px;position:relative';
  return `<div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
    <div class="eyebrow" style="margin:0">Fuente</div>
    ${selected && selected.kind === 'channel' ? `<div class="badge-live" style="position:static"><div class="dot dot-sm" style="background:var(--red)"></div><span>EN DIRECTO</span></div>` : ''}
  </div>
  <div style="${box}">${sourcePreviewHtml(selected)}</div>
  ${sourceOptions.length === 0 ? `<div class="row card-flat row-tap" style="padding:11px 14px;opacity:.6;margin-bottom:16px" ${A('goTab', 'content')}>
    <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans);margin-bottom:2px">Sin fuentes todavía</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">crea un canal en Contenido, o una lista en Listas</div></div>
  </div>` : `<div class="row" style="gap:8px;margin-bottom:6px">
    <select data-change="setLocationSourcePreview" data-arg="${esc(locationKey)}" style="flex:1;min-width:0;padding:11px;border-radius:6px;background:var(--card-2);border:1.5px solid var(--accent);color:var(--ink)">
      ${sourceOptions.filter(o => o.kind === 'channel').length ? `<optgroup label="Canales en vivo">${sourceOptions.filter(o => o.kind === 'channel').map(o => `<option value="${esc(o.value)}" ${selected.value === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</optgroup>` : ''}
      ${sourceOptions.filter(o => o.kind === 'playlist').length ? `<optgroup label="Listas de reproducción">${sourceOptions.filter(o => o.kind === 'playlist').map(o => `<option value="${esc(o.value)}" ${selected.value === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</optgroup>` : ''}
    </select>
    ${selected.kind === 'channel' ? `<div class="row-tap" style="flex:none;padding:11px 16px;border-radius:6px;background:${activeCount ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1px solid ${activeCount ? 'var(--accent)' : 'var(--line)'};font:600 12px var(--sans)" ${A('openMixForChannel', selected.id)}>🎛️ Mezclar</div>` : ''}
  </div>
  <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin:0 0 16px">Toca una TV abajo para asignarle esta fuente · ${activeCount} activa${activeCount === 1 ? '' : 's'}</div>`}`;
}
// Vista previa del recuadro grande: video en vivo para un canal, primer
// archivo de la lista para una lista (mismo patrón que bigPreview(), pero
// sin depender de un TV puntual — acá se previsualiza la FUENTE sola).
function sourcePreviewHtml(selected) {
  if (!selected) return `<span style="font:500 10px var(--mono);color:var(--ink-faint)">sin fuentes todavía</span>`;
  if (selected.kind === 'channel') return `<video autoplay muted playsinline data-webrtc-offer="/api/channels/${esc(selected.id)}/webrtc-offer" data-mp4-src="${channelLiveFeedUrl(selected.id)}" data-snapshot-src="${channelLiveFeedUrl(selected.id, 'snapshot')}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`;
  const p = remote.playlists.find(pl => pl.id === selected.id);
  const firstItem = p && p.items[0];
  if (!firstItem) return `<span style="font:500 10px var(--mono);color:var(--ink-faint)">lista vacía</span>`;
  if (firstItem.channel) {
    const c = remote.channels.find(x => x.id === firstItem.channel);
    if (!c) return `<span style="font:500 10px var(--mono);color:var(--ink-faint)">canal no disponible</span>`;
    return `<video autoplay muted playsinline data-webrtc-offer="/api/channels/${esc(c.id)}/webrtc-offer" data-mp4-src="${channelLiveFeedUrl(c.id)}" data-snapshot-src="${channelLiveFeedUrl(c.id, 'snapshot')}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`;
  }
  const a = remote.assets.find(x => x.id === firstItem.asset);
  if (!a) return `<span style="font:500 10px var(--mono);color:var(--ink-faint)">sin contenido</span>`;
  return a.type.startsWith('image/')
    ? `<img src="${assetMediaUrl(a.id)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`
    : `<video src="${assetMediaUrl(a.id)}#t=0.5" muted playsinline preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`;
}

function ptzCameraEditor(d) {
  return `<div class="backdrop" ${A('cancelPtzCamera')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar cámara' : 'Nueva cámara PTZ'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelPtzCamera')}>✕</div>
    </div>
    <form data-submit="savePtzCameraDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. PTZ Escenario)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <input name="onvifUrl" value="${esc(d.onvifUrl)}" placeholder="URL ONVIF — ej. onvif://usuario:pass@192.168.1.41" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <input name="rtspUrl" value="${esc(d.rtspUrl)}" placeholder="URL RTSP del video (opcional)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <input name="viewUrl" value="${esc(d.viewUrl)}" placeholder="URL de VIDEO de go2rtc — ej. http://host:1984/api/stream.mp4?src=ptz1" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      </div>
    </form>
    ${d.id ? dangerLink('Eliminar cámara', 'deletePtzCameraFromEditor') : ''}
  </div>`;
}

// Control PTZ. La cruceta/zoom/presets mandan comandos reales al backend
// (ver PLAYER_SPEC.md), pero la posición que se ve aquí es la que ASUME el
// panel, no una confirmada por la cámara — no hay agente local todavía que
// hable ONVIF de verdad y devuelva la posición real.
function viewPtz() {
  const cam = (remote.ptzCameras || []).find(c => c.id === ui.ptzCameraId);
  if (!cam) return `<div class="screen"><div class="topbar"><div class="back" ${A('backFromPtz')}>‹</div></div><div class="content" style="padding-top:30px;text-align:center;color:var(--ink-faint)">Cámara no encontrada.</div></div>`;
  const s = ui.ptzLocal;
  const zoomPct = Math.round((s.zoom - 1) / 2.2 * 100);
  const frameW = Math.round(100 / s.zoom) + '%';
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('backFromPtz')}>‹</div><div class="title">${esc(cam.name)}</div></div>
    <div class="content">
      <div style="font:400 10px var(--mono);color:var(--ink-faint);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cam.onvif_url ? 'ONVIF · ' + esc(cam.onvif_url) : 'Sin URL ONVIF configurada todavía'}</div>

      <div style="position:relative;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:repeating-linear-gradient(135deg,#242830 0 7px,#1c1f25 7px 14px);margin-bottom:7px">
        ${cam.view_url ? `<video autoplay muted playsinline src="/api/ptz-cameras/${esc(cam.id)}/live-feed" data-snapshot-src="/api/ptz-cameras/${esc(cam.id)}/live-feed?mode=snapshot" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video><div class="badge-live" style="position:absolute;top:10px;left:10px"><div class="dot dot-sm" style="background:var(--red)"></div><span>EN DIRECTO</span></div>` : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:500 10px var(--mono);color:var(--ink-faint);text-align:center;padding:0 16px">sin URL de video configurada</div>`}
        <div style="position:absolute;top:50%;left:50%;width:${frameW};height:${frameW};border:1.5px solid rgba(47,123,246,.85);border-radius:6px;box-shadow:0 0 0 9999px rgba(14,15,18,.45);transform:translate(-50%,-50%) translate(${s.x}px,${s.y}px);transition:all .22s cubic-bezier(.22,.9,.3,1)"></div>
        <div style="position:absolute;bottom:11px;right:11px;padding:4px 9px;border-radius:6px;background:rgba(14,15,18,.84);font:600 9.5px var(--mono);color:#c4c9cf">${s.zoom.toFixed(1)}×</div>
      </div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dim);margin-bottom:2px">${(s.x === 0 && s.y === 0) ? 'centrada' : `pan ${s.x > 0 ? '+' : ''}${s.x}° · tilt ${s.y > 0 ? '+' : ''}${s.y}°`}</div>
      <div style="font:400 9.5px var(--mono);color:var(--ink-faint);margin-bottom:14px">posición estimada — sin confirmar contra la cámara</div>

      <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:9px">
        <div class="eyebrow" style="margin:0">Encuadres guardados</div>
        <div class="row-tap" style="font:600 11px var(--sans);color:var(--accent)" ${A('ptzSavePresetNow')}>+ Guardar actual</div>
      </div>
      <div class="grid-2" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        ${cam.presets.length === 0 ? `<div style="grid-column:1/-1;padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11px var(--sans)">Sin encuadres guardados.</div>` : cam.presets.map(p => `<div style="position:relative">
          <div class="row-tap" style="text-align:center;padding:9px 4px;border-radius:6px;background:${s.presetId === p.id ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${s.presetId === p.id ? 'var(--accent)' : 'var(--line)'}" ${A('ptzGoPreset', p.id)}>
            <div style="font:600 10.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label)}</div>
          </div>
          <div class="row-tap" title="Eliminar" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font:600 10px var(--sans);color:var(--red)" ${A('ptzDeletePresetNow', p.id)}>×</div>
        </div>`).join('')}
      </div>

      <div class="row" style="gap:14px;align-items:center">
        <div style="display:grid;grid-template-columns:repeat(3,40px);grid-template-rows:repeat(3,40px);gap:5px;flex:none">
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'up')}>▲</div>
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'left')}>◀</div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:6px;background:#1b1d22;border:1px solid rgba(255,255,255,.12);font:600 9px var(--mono);color:var(--ink-dim)" ${A('ptzHome')}>HOME</div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'right')}>▶</div>
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'down')}>▼</div>
          <div></div>
        </div>
        <div style="flex:1;min-width:0">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><span style="font:600 10.5px var(--mono);color:var(--ink-dimmer);letter-spacing:.08em">ZOOM</span><span style="font:600 11px var(--sans)">${s.zoom.toFixed(1)}×</span></div>
          <div class="progress-track" style="margin-bottom:10px"><div class="progress-fill" style="width:${zoomPct}%;background:var(--accent)"></div></div>
          <div class="row" style="gap:8px">
            <div class="row-tap" style="flex:1;padding:11px 0;text-align:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 14px var(--sans)" ${A('ptzZoom', 'out')}>−</div>
            <div class="row-tap" style="flex:1;padding:11px 0;text-align:center;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 14px var(--sans)" ${A('ptzZoom', 'in')}>+</div>
          </div>
        </div>
      </div>

      ${(() => {
        const siblings = remote.ptzCameras.filter(c => c.location === cam.location);
        if (siblings.length < 2) return '';
        return `<div class="eyebrow" style="margin-top:20px">Cámaras del local</div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:6px">
          ${siblings.map(c => `<div class="row-tap" style="padding:8px 12px;border-radius:6px;background:${c.id === cam.id ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${c.id === cam.id ? 'var(--accent)' : 'var(--line)'};display:flex;align-items:center;gap:6px" ${A('openPtz', c.id)}>
            <div class="dot dot-sm" style="background:${c.view_url ? 'var(--red)' : 'var(--ink-faint)'}"></div>
            <span style="font:600 11.5px var(--sans)">${esc(c.name)}</span>
          </div>`).join('')}
        </div>`;
      })()}

      <div class="btn btn-primary row-tap" style="margin-top:14px" ${A('sendPtzToScreensNow')}>Enviar a las TVs</div>
      ${!cam.view_url ? `<div style="font:400 10px var(--mono);color:var(--ink-faint);text-align:center;margin-top:6px">Falta configurar la URL de video de esta cámara</div>` : ''}
    </div>
    ${toastHtml()}
  </div>`;
}

// Tarjeta compacta de TV para la grilla de 4 — mismo previewThumb() de
// siempre, solo que más chica. El toque corto ASIGNA la fuente elegida
// arriba a esta TV (nunca la apaga — ver assignDeviceToSource); abrir su
// ficha completa (nombre, ubicación, orientación...) es SIEMPRE con
// mantener presionado, sin excepción — así el toque nunca es ambiguo.
// "selected" solo puede venir null si de plano no hay NINGUNA fuente
// (ni canal ni lista) en esta ubicación; ahí el toque corto cae de vuelta
// a abrir la ficha, ya que no hay nada que asignar.
function deviceTile(d, selected) {
  const status = deviceStatus(d);
  const playlist = remote.playlists.find(p => p.id === d.playlist);
  const firstItem = playlist && playlist.items[0];
  const firstChannel = firstItem && firstItem.channel ? remote.channels.find(c => c.id === firstItem.channel) : null;
  const firstAsset = firstItem && !firstItem.channel ? remote.assets.find(a => a.id === firstItem.asset) : null;
  const active = selected && (selected.kind === 'channel' ? d.liveChannel === selected.id : (!d.liveChannel && d.playlist === selected.id));
  const tapAttrs = selected ? A('assignDeviceToSource', `${d.id}:${selected.kind}:${selected.id}`) : A('openDevice', d.id);
  return `<div class="card row-tap" style="overflow:hidden;position:relative;${active ? 'box-shadow:0 0 0 2px var(--amber)' : ''}" ${tapAttrs} data-longpress="openDevice" data-longpress-arg="${esc(d.id)}">
    ${d.alert ? `<div title="${esc(d.alert.text)}" style="position:absolute;top:4px;right:4px;z-index:1;font-size:11px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">🚨</div>` : ''}
    ${d.error ? `<div title="${esc(d.error)}" style="position:absolute;top:4px;left:4px;z-index:1;font-size:11px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">⚠️</div>` : ''}
    ${previewThumb(d, firstAsset, firstChannel)}
    <div style="padding:5px 6px 6px">
      <div class="row" style="gap:4px">
        <div class="dot dot-sm" style="background:${STATUS_COLOR[status]}"></div>
        <div style="font:600 10.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}${d.paused ? ' ⏸' : ''}</div>
      </div>
      ${d.error ? `<div style="font:400 9px var(--mono);color:var(--red);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${esc(d.error)}</div>` : ''}
    </div>
  </div>`;
}

// Ventana grande de preview (detalle de pantalla) — hoy muestra el primer
// archivo de la lista asignada; el día que exista una fuente en vivo (el
// "Canal ONVIF" u otra señal externa), este mismo cuadro sería donde se
// mostraría ese stream — es el hueco que se deja para eso.
function bigPreview(d) {
  // Proporción según la orientación configurada de la pantalla — la
  // mayoría de TVs de bar/restaurante son horizontales (16:9); solo las
  // que se configuraron explícitamente en vertical usan 9:16.
  const ratio = d.orientation === 'portrait' ? '9/16' : '16/9';
  const box = `width:100%;aspect-ratio:${ratio};max-height:340px;border-radius:6px;overflow:hidden;background:repeating-linear-gradient(135deg,#242830 0 7px,#1c1f25 7px 14px);display:flex;align-items:center;justify-content:center;margin-bottom:14px;position:relative`;
  // Fuente en vivo real: el navegador NUNCA pide la URL de la LAN
  // directamente (chocaría con contenido mixto y con la CSP del propio
  // backend) — intenta primero WebRTC directo (casi cero latencia si el
  // navegador está en la misma red que el Mini PC, igual que el
  // dashboard de Home Assistant — ver wireLiveFeedFallbacks()) y si no
  // logra conectar (navegador remoto, etc.) cae solo al MP4 de siempre
  // por /api/devices/:id/live-feed. live_source debe ser un endpoint de
  // video puro (ej. .../api/stream.mp4?src=NOMBRE de go2rtc), no una
  // página como stream.html (esa abre su propio WebSocket, que esto no proxea).
  if (d.liveSource) {
    return `<div style="${box}">
      <video autoplay muted playsinline data-webrtc-offer="/api/devices/${esc(d.id)}/webrtc-offer" data-mp4-src="/api/devices/${esc(d.id)}/live-feed" data-snapshot-src="/api/devices/${esc(d.id)}/live-feed?mode=snapshot" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
      ${d.mix ? mixOverlayHtml(d.mix) : ''}
      <div class="badge-live" style="position:absolute;top:10px;left:10px"><div class="dot dot-sm" style="background:var(--red)"></div><span>EN DIRECTO</span></div>
    </div>`;
  }
  const playlist = remote.playlists.find(p => p.id === d.playlist);
  const firstItem = playlist && playlist.items[0];
  // El primer item de la lista puede ser un canal en vivo, no un archivo
  // — mismo proxy que la fuente en vivo de la pantalla, pero apuntando
  // al canal (ver /api/channels/:id/live-feed en server.js).
  if (firstItem && firstItem.channel) {
    const c = remote.channels.find(c => c.id === firstItem.channel);
    if (!c) return `<div style="${box}"><span style="font:500 10px var(--mono);color:var(--ink-faint)">canal no disponible</span></div>`;
    return `<div style="${box}">
      <video autoplay muted playsinline data-webrtc-offer="/api/channels/${esc(c.id)}/webrtc-offer" data-mp4-src="${channelLiveFeedUrl(c.id)}" data-snapshot-src="${channelLiveFeedUrl(c.id, 'snapshot')}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
      <div class="badge-live" style="position:absolute;top:10px;left:10px"><div class="dot dot-sm" style="background:var(--red)"></div><span>EN DIRECTO</span></div>
    </div>`;
  }
  const asset = firstItem ? remote.assets.find(a => a.id === firstItem.asset) : null;
  if (!asset) return `<div style="${box}"><span style="font:500 10px var(--mono);color:var(--ink-faint)">sin contenido asignado</span></div>`;
  const media = asset.type.startsWith('image/')
    ? `<img src="${assetMediaUrl(asset.id)}" style="width:100%;height:100%;object-fit:cover">`
    : `<video src="${assetMediaUrl(asset.id)}#t=0.5" preload="metadata" muted playsinline controls style="width:100%;height:100%;object-fit:cover"></video>`;
  return `<div style="${box}">${media}</div>`;
}

// d: el dispositivo (para saber si tiene fuente en vivo); a: primer
// archivo de su lista, o null. Para la miniatura de la grilla usamos la
// FOTO (?mode=snapshot, la misma del respaldo de Safari) en vez de video
// en vivo de verdad — un <video>/<iframe> por tarjeta sería muy pesado
// con varias pantallas en la grilla; una sola foto no.
function previewThumb(d, a, channel) {
  const s = 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000';
  if (d.liveSource) return `<div class="thumb" style="aspect-ratio:16/9;position:relative">
    <img src="/api/devices/${esc(d.id)}/live-feed?mode=snapshot" style="${s}" alt="señal en vivo">
    <span style="position:absolute;bottom:6px;left:7px;color:var(--red);font:600 10px var(--mono);letter-spacing:.06em;text-shadow:0 1px 3px rgba(0,0,0,.85)">● EN VIVO</span>
  </div>`;
  // La lista puede tener un canal en vivo como primer item (en vez de un
  // switch de pantalla) — misma miniatura, pero pidiendo la foto del
  // canal en vez de la de la pantalla.
  if (channel) return `<div class="thumb" style="aspect-ratio:16/9;position:relative">
    <img src="${channelLiveFeedUrl(channel.id, 'snapshot')}" style="${s}" alt="señal en vivo">
    <span style="position:absolute;bottom:6px;left:7px;color:var(--red);font:600 10px var(--mono);letter-spacing:.06em;text-shadow:0 1px 3px rgba(0,0,0,.85)">● EN VIVO</span>
  </div>`;
  if (!a) return `<div class="thumb" style="aspect-ratio:16/9"><span>sin contenido</span></div>`;
  return a.type.startsWith('image/')
    ? `<img src="${assetMediaUrl(a.id)}" style="${s}">`
    : `<video src="${assetMediaUrl(a.id)}#t=0.5" preload="metadata" muted playsinline style="${s}"></video>`;
}

// El "estilo" (colores/tamaño/grosor/fundido) del mixer viaja FLAT junto a
// layout/promo/logo/text/muted en ui.mixDraft y en lo que ya devuelve el
// servidor (state.devices[x].mix) — más simple de leer para el preview.
// Al GUARDAR sí hay que empacarlo en "style" aparte, que es como lo espera
// /api/devices/:id/mix y /api/mix-templates (ver styleOf() en server.js).
const DEFAULT_MIX_STYLE = { stripeColor: '#111111', textColor: '#ffffff', fontSize: 16, thickness: 64, fadeMs: 400 };
function newMixDraft(base) {
  return { layout: 'lower', promo: null, logo: null, text: '', muted: false, ...DEFAULT_MIX_STYLE, ...(base || {}) };
}
function mixDraftPayload(d) {
  const { layout, promo, logo, text, muted, stripeColor, textColor, fontSize, thickness, fadeMs } = d;
  return { layout, promo, logo, text, muted, style: { stripeColor, textColor, fontSize, thickness, fadeMs } };
}

// Overlay visual de la mezcla (layout+logo+texto+estilo) — se dibuja EN EL
// PANEL con CSS puro sobre la señal en vivo; el reproductor real compone
// la imagen de verdad leyendo este mismo objeto del manifiesto (mix/mixOut
// en server.js ya manda promoUrl/logoUrl resueltos para eso). El fundido
// (fadeMs) no se ve aquí de forma continua — es cómo el REPRODUCTOR anima
// la entrada/salida del overlay, este preview solo muestra el resultado.
function mixOverlayHtml(m) {
  if (!m) return '';
  const promoAsset = m.promo ? remote.assets.find(a => a.id === m.promo) : null;
  const logoAsset = m.logo ? remote.assets.find(a => a.id === m.logo) : null;
  const promoImg = id => `<img src="${assetMediaUrl(id)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`;
  const logoImg = (id, h) => `<img src="${assetMediaUrl(id)}" style="max-height:${h}px;max-width:80%;object-fit:contain">`;
  const muteTag = m.muted ? `<div style="position:absolute;top:8px;right:8px;padding:3px 7px;border-radius:6px;background:rgba(14,15,18,.8);font:600 9px var(--mono);color:#c4c9cf;z-index:2">🔇 MUDO</div>` : '';
  const stripe = m.stripeColor || DEFAULT_MIX_STYLE.stripeColor;
  const textColor = m.textColor || DEFAULT_MIX_STYLE.textColor;
  const fontSize = m.fontSize || DEFAULT_MIX_STYLE.fontSize;
  const thickness = m.thickness || DEFAULT_MIX_STYLE.thickness;
  if (m.layout === 'full') {
    return `<div style="position:absolute;inset:0;background:${stripe};display:flex;align-items:center;justify-content:center">
      ${promoAsset ? `<div style="position:absolute;inset:0;opacity:.55">${promoImg(promoAsset.id)}</div>` : ''}
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 16px">
        ${logoAsset ? logoImg(logoAsset.id, 44) : ''}
        ${m.text ? `<div style="font:700 ${fontSize}px var(--sans);color:${textColor};text-shadow:0 1px 4px rgba(0,0,0,.7);text-align:center">${esc(m.text)}</div>` : ''}
      </div>
    </div>${muteTag}`;
  }
  if (m.layout === 'split') {
    return `<div style="position:absolute;inset:0;display:flex">
      <div style="flex:1"></div>
      <div style="width:38%;background:${stripe};position:relative;display:flex;align-items:center;justify-content:center">
        ${promoAsset ? `<div style="position:absolute;inset:0;opacity:.5">${promoImg(promoAsset.id)}</div>` : ''}
        <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:0 8px">
          ${logoAsset ? logoImg(logoAsset.id, 30) : ''}
          ${m.text ? `<div style="font:700 ${Math.round(fontSize * .7)}px var(--sans);color:${textColor};text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.7)">${esc(m.text)}</div>` : ''}
        </div>
      </div>
    </div>${muteTag}`;
  }
  if (m.layout === 'corner') {
    return `<div style="position:absolute;right:10px;bottom:10px;max-width:44%;background:${stripe};border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;align-items:center;gap:4px;box-shadow:0 4px 14px rgba(0,0,0,.4);overflow:hidden">
      ${promoAsset ? `<div style="position:absolute;inset:0;opacity:.3">${promoImg(promoAsset.id)}</div>` : ''}
      ${logoAsset ? `<div style="position:relative">${logoImg(logoAsset.id, 24)}</div>` : ''}
      ${m.text ? `<div style="position:relative;font:700 ${Math.round(fontSize * .65)}px var(--sans);color:${textColor};text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px">${esc(m.text)}</div>` : ''}
    </div>${muteTag}`;
  }
  // lower — "thickness" es la altura de la franja completa; el logo escala con ella.
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:${thickness}px;box-sizing:border-box;background:linear-gradient(0deg,${stripe}d9,${stripe}00);padding:10px 12px 8px;display:flex;align-items:center;gap:8px">
    ${logoAsset ? `<img src="${assetMediaUrl(logoAsset.id)}" style="height:${Math.round(thickness * .34)}px;width:${Math.round(thickness * .34)}px;object-fit:contain;border-radius:4px;flex:none">` : ''}
    ${m.text ? `<div style="flex:1;min-width:0;font:700 ${fontSize}px var(--sans);color:${textColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.text)}</div>` : ''}
  </div>${muteTag}`;
}

function viewMix() {
  const d = remote.devices.find(d => d.id === ui.mixDeviceId);
  if (!d || !ui.mixDraft) return `<div class="screen"><div class="topbar"><div class="back" ${A('backFromMix')}>‹</div></div><div class="content" style="padding-top:30px;text-align:center;color:var(--ink-faint)">TV no encontrada.</div></div>`;
  const m = ui.mixDraft;
  // "Composición" — los 4 formatos del mockup (Franja/Esquina/Lateral/Corte),
  // cada uno con una guía corta de cuándo tiene sentido usarlo.
  const layouts = [
    ['lower', 'Franja', 'Barra abajo, no tapa el contenido'],
    ['corner', 'Esquina', 'Logo chico en una esquina, discreto'],
    ['split', 'Lateral', 'Panel a un lado, dos tercios visibles'],
    ['full', 'Corte', 'Toma toda la pantalla'],
  ];
  const layoutLabel = { lower: 'franja', corner: 'esquina', split: 'lateral', full: 'corte' };
  const logoAsset = m.logo ? remote.assets.find(a => a.id === m.logo) : null;
  const images = remote.assets.filter(a => a.type.startsWith('image/'));
  const templates = remote.mixTemplates || [];
  const fadeLabel = ms => ms === 0 ? 'Corte seco' : ms < 700 ? 'Rápido' : ms < 1600 ? 'Suave' : 'Muy suave';
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('backFromMix')}>‹</div><div class="title">Mezclar — ${esc(d.name)}</div></div>
    <div class="content">
      <div style="width:100%;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:#000;position:relative;margin-bottom:16px">
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:500 10px var(--mono);color:var(--ink-faint)">señal en vivo</div>
        ${mixOverlayHtml(m)}
      </div>

      <div class="eyebrow">Composición</div>
      <div class="row" style="gap:6px;margin-bottom:6px">
        ${layouts.map(([v, label]) => `<div class="row-tap" style="flex:1;text-align:center;padding:11px 4px;border-radius:6px;background:${m.layout === v ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${m.layout === v ? 'var(--accent)' : 'var(--line)'};font:600 11px var(--sans)" ${A('setMixLayout', v)}>${label}</div>`).join('')}
      </div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:18px">${layouts.find(([v]) => v === m.layout)[2]}</div>

      <div class="eyebrow">Fundido</div>
      <div style="padding:14px 14px 10px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);margin-bottom:18px">
        <input type="range" min="0" max="3000" step="50" value="${m.fadeMs}" data-change="setMixFadeMs" style="width:100%;accent-color:var(--accent)">
        <div class="row" style="justify-content:space-between;margin-top:4px">
          <span style="font:400 9.5px var(--mono);color:var(--ink-faint)">corte seco</span>
          <span style="font:700 11px var(--sans);color:var(--accent)">${fadeLabel(m.fadeMs)} · ${(m.fadeMs / 1000).toFixed(2)}s</span>
          <span style="font:400 9.5px var(--mono);color:var(--ink-faint)">fundido lento</span>
        </div>
      </div>

      <div class="eyebrow">Texto</div>
      <input value="${esc(m.text)}" maxlength="140" placeholder="Texto a mostrar (ej. 2x1 en cervezas)" data-input="setMixText" style="width:100%;box-sizing:border-box;padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:12px">
      <div class="row" style="gap:10px;margin-bottom:18px">
        <div class="row" style="gap:8px;flex:1;align-items:center">
          <input type="color" value="${m.textColor}" data-change="setMixTextColor" style="width:36px;height:36px;border-radius:6px;border:1px solid var(--line);background:none;padding:0;flex:none">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer)">color de texto</span>
        </div>
        <div class="row" style="gap:8px;flex:1;align-items:center">
          <input type="range" min="10" max="48" value="${m.fontSize}" data-change="setMixFontSize" style="flex:1;accent-color:var(--accent)">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer);flex:none">${m.fontSize}px</span>
        </div>
      </div>

      <div class="eyebrow">Franja / panel</div>
      <div class="row" style="gap:10px;margin-bottom:18px">
        <div class="row" style="gap:8px;flex:1;align-items:center">
          <input type="color" value="${m.stripeColor}" data-change="setMixStripeColor" style="width:36px;height:36px;border-radius:6px;border:1px solid var(--line);background:none;padding:0;flex:none">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer)">color de fondo</span>
        </div>
        <div class="row" style="gap:8px;flex:1;align-items:center">
          <input type="range" min="20" max="200" value="${m.thickness}" data-change="setMixThickness" style="flex:1;accent-color:var(--accent)">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer);flex:none">${m.thickness}px</span>
        </div>
      </div>

      <div class="eyebrow">Logo</div>
      <div class="row" style="gap:10px;align-items:center;margin-bottom:18px">
        <div style="width:52px;height:52px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none">
          ${logoAsset ? `<img src="${assetMediaUrl(logoAsset.id)}" style="max-width:100%;max-height:100%;object-fit:contain">` : `<span style="font:400 9px var(--mono);color:var(--ink-faint)">sin logo</span>`}
        </div>
        <label class="btn btn-ghost row-tap" style="flex:1;text-align:center;cursor:pointer;font-size:12px">
          ${logoAsset ? 'Cambiar logo' : 'Subir logo'}
          <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none" data-change="pickMixLogo">
        </label>
        ${logoAsset ? `<div class="row-tap" title="Quitar logo" style="width:36px;height:36px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(242,99,90,.12)" ${A('clearMixLogo')}>🗑️</div>` : ''}
      </div>

      <div class="eyebrow">Promo de fondo (biblioteca)</div>
      <div class="grid-2" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px">
        ${images.length === 0 ? `<div style="grid-column:1/-1;padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11px var(--sans)">Sin imágenes en tu biblioteca.</div>` : images.map(a => `
        <div class="row-tap" style="position:relative;aspect-ratio:1/1;border-radius:6px;overflow:hidden;border:1.5px solid ${m.promo === a.id ? 'var(--accent)' : 'var(--line)'}" ${A('setMixPromo', a.id)}>
          <img src="${assetMediaUrl(a.id)}" style="width:100%;height:100%;object-fit:cover">
          ${m.promo === a.id ? `<div style="position:absolute;inset:0;background:rgba(47,123,246,.28);display:flex;align-items:center;justify-content:center;font:700 14px var(--sans);color:#fff">✓</div>` : ''}
        </div>`).join('')}
      </div>

      <div class="row card-flat row-tap" style="padding:12px 14px;margin-bottom:20px" ${A('toggleMixMuted')}>
        <div style="width:17px;height:17px;border-radius:5px;flex:none;border:1.5px solid ${m.muted ? 'var(--accent)' : 'rgba(255,255,255,.22)'};background:${m.muted ? 'var(--accent)' : 'transparent'};display:flex;align-items:center;justify-content:center;font:700 11px var(--sans);color:#fff">${m.muted ? '✓' : ''}</div>
        <div style="font:600 13px var(--sans)">Silenciar audio de la señal en vivo</div>
      </div>

      <div class="row" style="gap:8px;margin-bottom:24px">
        <div class="btn btn-primary row-tap" style="flex:1;text-align:center" ${A('saveMixNow')}>Guardar mezcla</div>
        <div class="row-tap" style="padding:12px 16px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 12.5px var(--sans)" ${A('clearMixNow')}>Quitar</div>
      </div>

      <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:9px">
        <div class="eyebrow" style="margin:0">Plantillas</div>
        <div class="row-tap" style="font:600 11px var(--sans);color:var(--accent)" ${A('saveMixTemplateNow')}>+ Guardar como plantilla</div>
      </div>
      <div class="stack" style="margin-bottom:16px">
        ${templates.length === 0 ? `<div style="padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11px var(--sans)">Sin plantillas guardadas.</div>` : templates.map(t => `
        <div class="row card-flat row-tap" style="padding:11px 13px;gap:6px" ${A('applyMixTemplate', t.id)}>
          <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${layoutLabel[t.layout] || t.layout}${t.text ? ' · ' + esc(t.text) : ''}</div></div>
          ${d.location ? `<div class="row-tap" title="Aplicar a toda la ubicación" style="width:28px;height:28px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card)" ${A('applyMixTemplateToLocation', t.id)}>📍</div>` : ''}
          <div class="row-tap" title="Aplicar a todas mis TVs" style="width:28px;height:28px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card)" ${A('applyMixTemplateToAllNow', t.id)}>📡</div>
          <div class="row-tap" title="Editar" style="width:28px;height:28px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card)" ${A('editMixTemplateNow', t.id)}>✏️</div>
        </div>`).join('')}
      </div>
    </div>
    ${ui.mixTemplateDraft ? mixTemplateEditor(ui.mixTemplateDraft) : ''}
    ${toastHtml()}
  </div>`;
}

function mixTemplateEditor(d) {
  return `<div class="backdrop" ${A('cancelMixTemplate')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">Editar plantilla</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelMixTemplate')}>✕</div>
    </div>
    <form data-submit="saveMixTemplateDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre de la plantilla" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      </div>
    </form>
    ${dangerLink('Eliminar plantilla', 'deleteMixTemplateFromEditor')}
  </div>`;
}

function deviceSheet() {
  const d = remote.devices.find(d => d.id === ui.detailDeviceId); if (!d) return '';
  const status = deviceStatus(d);
  const playlist = remote.playlists.find(p => p.id === d.playlist);
  return `<div class="backdrop" ${A('closeDevice')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}" style="max-height:90vh">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:3px">
      <div class="dot" style="background:${STATUS_COLOR[status]}"></div>
      <div style="font:700 19px var(--sans);flex:1;min-width:0">${esc(d.name)}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('closeDevice')}>✕</div>
    </div>
    <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:16px">${STATUS_LABEL[status]} · ${fmtTime(d.seen)}${d.error ? ' · ' + esc(d.error) : ''}</div>
    ${bigPreview(d)}

    ${(() => {
      // Un canal está disponible para cualquier pantalla — no se restringe
      // por ubicación (salvo los pocos creados antes de este cambio que sí
      // tengan una ubicación asignada; esos solo se ofrecen a pantallas de
      // esa misma ubicación).
      const chans = (remote.channels || []).filter(c => !c.location || c.location === d.location);
      return `<div class="eyebrow">Fuente</div>
      <div class="row" style="gap:8px;margin-bottom:${d.liveSource ? '10px' : '16px'}">
        <select data-change="setDeviceSource" data-arg="${esc(d.id)}" style="flex:1;min-width:0;padding:11px;border-radius:6px;background:var(--card-2);border:1.5px solid ${d.liveChannel ? 'var(--accent)' : 'var(--line)'};color:var(--ink)">
          <option value="" ${!d.liveChannel ? 'selected' : ''}>▶ Lista de reproducción${playlist ? ' — ' + esc(playlist.name) : ''}</option>
          ${chans.map(c => `<option value="${esc(c.id)}" ${d.liveChannel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        ${d.liveSource ? `<div class="row-tap" style="padding:7px 14px;border-radius:6px;flex:none;background:${d.mix ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1px solid ${d.mix ? 'var(--accent)' : 'var(--line)'};font:600 12px var(--sans)" ${A('openMix', d.id)}>🎛️ Mezclar</div>` : ''}
        <div class="row-tap" style="padding:7px 14px;border-radius:6px;flex:none;background:${d.alert ? 'rgba(242,99,90,.14)' : 'var(--card-2)'};border:1px solid ${d.alert ? 'var(--red)' : 'var(--line)'};font:600 12px var(--sans)" ${A('sendAlertNow', d.id)}>🚨 Alerta</div>
      </div>
      ${chans.length === 0 ? `<div class="row card-flat row-tap" style="padding:11px 14px;opacity:.6;margin-bottom:16px" ${A('goTab', 'content')}>
        <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans);margin-bottom:2px">Sin canales todavía</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">configúralos en Contenido → Canales</div></div>
      </div>` : ''}`;
    })()}
    ${d.alert ? `<div class="row" style="gap:8px;padding:9px 12px;border-radius:6px;background:rgba(242,99,90,.1);border:1px solid rgba(242,99,90,.3);margin-bottom:12px">
      <div style="flex:1;min-width:0"><div style="font:600 11.5px var(--sans);color:var(--red)">${esc(d.alert.text)}</div><div style="font:400 9.5px var(--mono);color:var(--ink-dimmer)">${{ info: 'informativa', warning: 'advertencia', critical: 'crítica' }[d.alert.level] || d.alert.level}</div></div>
      <div class="row-tap" style="font:600 11px var(--sans);color:var(--ink-dimmer)" ${A('clearAlertNow', d.id)}>Quitar</div>
    </div>` : ''}
    ${d.location && remote.ptzCameras.some(c => c.location === d.location) ? `<div class="row-tap" style="text-align:center;padding:10px 0;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 12px var(--sans);margin-bottom:16px" ${A('openPtzFromDevice', d.id)}>📹 Control PTZ</div>` : ''}

    <div class="eyebrow">Lista de reproducción</div>
    <div class="row" style="gap:8px;margin-bottom:16px">
      <select style="flex:1;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        ${remote.playlists.map(p => `<option value="${esc(p.id)}" ${p.id === d.playlist ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <div class="btn btn-primary row-tap" style="padding:11px 16px;font-size:13px" ${A('assignPlaylistTo', d.id)}>Asignar</div>
    </div>

    ${(() => {
      const loc = remote.locations.find(l => l.id === d.location);
      // Ubicación y Pantalla no cambian casi nunca comparado con Fuente/
      // lista — van juntas en un solo colapsable cerrado por defecto para
      // no ocupar espacio de la tarjeta con ajustes que rara vez se tocan.
      return `<div class="row-tap" style="justify-content:space-between;padding:10px 2px;margin-bottom:${ui.deviceMoreOpen ? '8px' : '16px'}" ${A('toggleDeviceMore')}>
        <div class="eyebrow" style="margin:0">Más ajustes${!ui.deviceMoreOpen ? ` · ${loc ? esc(loc.name) : 'sin ubicación'}` : ''}</div>
        <div style="color:var(--ink-faint);font:400 12px var(--sans)">${ui.deviceMoreOpen ? '▲' : '▼'}</div>
      </div>
      ${ui.deviceMoreOpen ? `
      <div class="eyebrow">Ubicación</div>
      <select data-change="moveDevice" data-arg="${esc(d.id)}" style="width:100%;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:16px">
        <option value="">Sin ubicación</option>
        ${remote.locations.map(l => `<option value="${esc(l.id)}" ${l.id === d.location ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>

      <div class="eyebrow">TV</div>
      <div data-display-form style="margin-bottom:16px" class="stack">
        <select name="orientation" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          <option value="auto" ${d.orientation === 'auto' ? 'selected' : ''}>Automática</option>
          <option value="landscape" ${d.orientation === 'landscape' ? 'selected' : ''}>Horizontal</option>
          <option value="portrait" ${d.orientation === 'portrait' ? 'selected' : ''}>Vertical</option>
        </select>
        <select name="fit" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          <option value="cover" ${d.fit === 'cover' ? 'selected' : ''}>Rellenar (recorta)</option>
          <option value="contain" ${d.fit === 'contain' ? 'selected' : ''}>Mostrar completo</option>
        </select>
        <select name="rotation" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          ${[0, 90, 180, 270].map(r => `<option value="${r}" ${d.rotation === r ? 'selected' : ''}>Giro ${r}°</option>`).join('')}
        </select>
      </div>` : ''}`;
    })()}

    <div class="row-tap" style="text-align:center;padding:12px 0;margin-top:4px;font:600 12px var(--sans);color:var(--red)" ${A('revoke', d.id)}>Quitar esta TV</div>
  </div>`;
}

// ---- Emparejar --------------------------------------------------------------

function viewPair() {
  // El código lo genera la propia pantalla (TV/tablet) al arrancar sin
  // emparejar — la muestra en su QR. Aquí solo la escaneamos o tecleamos
  // el código, y se reclama con nombre + ubicación.
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('cancelPair')}>‹</div><div class="title">Emparejar TV</div></div>
    <div class="content">
      <div style="font:400 12px/1.5 var(--sans);color:var(--ink-dim);margin-bottom:14px">La TV física muestra su propio QR y código al encenderse sin emparejar. Escanéalo con la cámara o escríbelo abajo.</div>
      <div id="qr-reader" style="border-radius:6px;overflow:hidden;margin-bottom:12px;min-height:0"></div>
      <div class="btn btn-ghost row-tap" id="qr-toggle" style="margin-bottom:16px" ${A('toggleScanner')}>Abrir cámara</div>
      ${remote.locations.length === 0 ? `<div class="row card-flat row-tap" style="padding:11px 14px" ${A('addLocation')}>
        <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans);margin-bottom:2px">Crea una ubicación primero</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">toda TV vive dentro de una ubicación</div></div>
      </div>` : `<form data-submit="confirmPair">
        <div class="stack">
          <input id="qr-code-field" name="code" required value="${esc(ui.pairCodeFromUrl || '')}" placeholder="Código (ej. ABC123DEF456)" style="padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);text-transform:uppercase">
          <input name="name" required placeholder="Nombre (ej. Barra 01)" style="padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          <select name="location" required style="padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
            <option value="" disabled selected>Elegir ubicación…</option>
            ${remote.locations.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary" style="border:none;margin-top:6px">Confirmar emparejamiento</button>
        </div>
      </form>`}
    </div>
    ${ui.locationDraft ? locationEditor(ui.locationDraft) : ''}
    ${toastHtml()}
  </div>`;
}

// Escaneo de QR reutilizando /vendor/scanner.js (html5-qrcode) que ya sirve
// el propio backend — misma librería que usaba la interfaz anterior.
let qrScanner = null;
function stopScanner() {
  if (qrScanner) { qrScanner.stop().catch(() => {}).then(() => qrScanner.clear()); qrScanner = null; }
}
actions.toggleScanner = async function () {
  const box = document.getElementById('qr-reader'), btn = document.getElementById('qr-toggle');
  if (qrScanner) { stopScanner(); if (box) box.style.minHeight = '0'; if (btn) btn.textContent = 'Abrir cámara'; return; }
  if (typeof Html5Qrcode === 'undefined') return showToast('Cámara no disponible en este navegador', true);
  try {
    qrScanner = new Html5Qrcode('qr-reader');
    await qrScanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, text => {
      const code = text.replace(/^venuepro-signage:/, '').trim();
      const field = document.getElementById('qr-code-field'); if (field) field.value = code;
      stopScanner(); if (box) box.style.minHeight = '0'; if (btn) btn.textContent = 'Abrir cámara';
      showToast('Código leído');
    }, () => {});
    if (box) box.style.minHeight = '260px'; if (btn) btn.textContent = 'Cerrar cámara';
  } catch (e) { showToast('No se pudo abrir la cámara: ' + e.message, true); qrScanner = null; }
};

// ---- Contenido (assets + listas) ---------------------------------------------

// Tarjeta de archivo — SOLO miniatura + nombre, tapable (abre el lightbox
// a tamaño real). Renombrar/mover/eliminar viven ADENTRO del lightbox
// (assetPreviewOverlay), no expuestos aquí — nada de iconos sueltos en la
// grilla.
function assetCard(a) {
  return `<div class="card row-tap" style="overflow:hidden" ${A('openAssetPreview', a.id)}>
    ${a.type.startsWith('image/')
      ? `<img src="${assetMediaUrl(a.id)}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000">`
      : `<video src="${assetMediaUrl(a.id)}#t=0.5" preload="metadata" muted playsinline style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000"></video>`}
    <div style="padding:9px 10px;font:600 12px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
  </div>`;
}

// Lightbox a pantalla completa — la imagen/video se ve en su proporción
// real (object-fit:contain), nunca recortada a un cuadrado como en la
// miniatura de la grilla. Renombrar/mover de carpeta/eliminar viven acá
// abajo, en una barra de acciones — es el "editor" del archivo, así que
// eliminar (Archivar) no necesita estar expuesto en la grilla.
function assetPreviewOverlay() {
  const a = ui.previewAssetId && remote.assets.find(x => x.id === ui.previewAssetId);
  if (!a) return '';
  const media = a.type.startsWith('image/')
    ? `<img src="${assetMediaUrl(a.id)}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;display:block">`
    : `<video src="${assetMediaUrl(a.id)}" controls autoplay playsinline style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;display:block"></video>`;
  return `<div class="backdrop" style="background:rgba(6,7,9,.92);z-index:40" ${A('closeAssetPreview')}></div>
  <div style="position:fixed;inset:0;z-index:41;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;pointer-events:none">
    <div style="pointer-events:auto;max-width:100%;max-height:76%;position:relative;animation:popUp .2s cubic-bezier(.22,.9,.3,1)">
      ${media}
      <div class="row-tap" title="Cerrar" style="position:absolute;top:-16px;right:-16px;width:32px;height:32px;border-radius:50%;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font:600 14px var(--sans)" ${A('closeAssetPreview')}>✕</div>
    </div>
    <div style="pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:9px 13px">
      <div style="font:600 12.5px var(--sans);color:#fff;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</div>
      <div class="row-tap" title="Renombrar" ${A('renameAsset', a.id)}>✏️</div>
      ${a.folder ? `<div class="row-tap" title="Quitar de la carpeta" ${A('removeAssetFromFolderNow', a.id)}>📁↩</div>` : `<select data-change="moveAssetToFolderNow" data-arg="${esc(a.id)}" style="font:400 10px var(--mono);background:var(--card-2);color:#fff;border:1px solid var(--line);border-radius:6px;padding:3px 5px">
        <option value="">📁 mover…</option>
        ${(remote.assetFolders || []).map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}
      </select>`}
      <div class="row-tap" title="Eliminar" ${A('archiveAsset', a.id)}>🗑️</div>
    </div>
  </div>`;
}

// Listas de reproducción tiene su propia pestaña (antes vivía arriba de
// Canales, dentro de Contenido) — se compone y se asigna desde acá, pero
// sigue usando remote.assets/remote.channels (de Contenido) como
// ingredientes, igual que antes.
function viewPlaylists() {
  const d = ui.playlistDraft;
  return `<div class="screen">
    ${topbar('Listas')}
    <div class="content">
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:11px">
        <div class="eyebrow" style="margin:0">Listas de reproducción</div>
        <div class="row-tap" style="font:600 11.5px var(--sans);color:var(--accent)" ${A('newPlaylist')}>+ Nueva</div>
      </div>
      <div class="stack" style="margin-bottom:22px">
        ${remote.playlists.length === 0 ? `<div style="padding:16px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin listas todavía.</div>` : remote.playlists.map(p => `
        <div class="card row" style="padding:12px 14px">
          <div style="flex:1;min-width:0">
            <div style="font:600 12.5px var(--sans)">${esc(p.name)}</div>
            <div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${p.items.length} elemento${p.items.length === 1 ? '' : 's'}${p.items.some(i => i.channel) ? ' · incluye canal en vivo' : ''}</div>
          </div>
          <div class="row-tap" style="font:500 11px var(--sans);color:var(--ink-dim)" ${A('editPlaylist', p.id)}>Editar</div>
        </div>`).join('')}
      </div>
    </div>
    ${tabbar()}
    ${d ? playlistEditor(d) : ''}
    ${toastHtml()}
  </div>`;
}

function viewContent() {
  const unfoldered = remote.assets.filter(a => !a.folder);
  return `<div class="screen">
    ${topbar('Contenido')}
    <div class="content">
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:11px">
        <div class="eyebrow" style="margin:0">Canales</div>
        <div class="row-tap" style="font:600 11.5px var(--sans);color:var(--accent)" ${A('newChannel')}>+ Nuevo</div>
      </div>
      <div class="stack" style="margin-bottom:22px">
        ${(remote.channels || []).length === 0 ? `<div style="padding:16px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin canales todavía — crea uno para usarlo como fuente en cualquier TV o dentro de una lista.</div>` : remote.channels.map(c => {
          const loc = remote.locations.find(l => l.id === c.location);
          return `<div class="card row" style="padding:12px 14px">
            <div style="flex:1;min-width:0">
              <div style="font:600 12.5px var(--sans)">${esc(c.name)}</div>
              <div style="font:400 10px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${loc ? esc(loc.name) + ' · ' : ''}${esc(c.url)}</div>
            </div>
            <div class="row-tap" style="font:500 11px var(--sans);color:var(--ink-dim)" ${A('editChannelNow', c.id)}>Editar</div>
          </div>`;
        }).join('')}
      </div>

      <div class="eyebrow">Biblioteca</div>
      <div class="row" style="gap:8px;margin-bottom:8px">
        <label class="btn btn-ghost" style="flex:1;text-align:center;cursor:pointer;font-size:12.5px">
          + Subir archivo
          <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4" style="display:none" data-change="pickUpload">
        </label>
        <div class="row-tap" style="flex:1;text-align:center;padding:12px 0;border-radius:6px;background:var(--card-2);border:1px solid var(--line);font:600 12.5px var(--sans)" ${A('newAssetFolder')}>📁+ Nueva carpeta</div>
      </div>

      ${(remote.assetFolders || []).length > 0 ? `<div class="stack" style="margin-bottom:16px">
        ${remote.assetFolders.map(f => {
          const count = remote.assets.filter(a => a.folder === f.id).length;
          return `<div class="row card-flat row-tap" style="padding:12px 14px" ${A('openAssetFolder', f.id)}>
            <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans)">📁 ${esc(f.name)}</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${count} archivo${count === 1 ? '' : 's'}</div></div>
            <div class="row-tap" style="font:500 11px var(--sans);color:var(--ink-dim)" ${A('editAssetFolderNow', f.id)}>Editar</div>
          </div>`;
        }).join('')}
      </div>` : ''}

      <div class="row row-tap card-flat" style="padding:12px 13px;margin-bottom:20px" ${A('goStudio')}>
        <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans)">🎨 Estudio IA</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">Generar un fondo de poster con OpenAI</div></div>
        <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
      </div>
      <div class="grid-2" style="margin-bottom:20px">
        ${unfoldered.length === 0 ? `<div style="grid-column:1/-1;padding:24px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin archivos todavía.</div>` : unfoldered.map(assetCard).join('')}
      </div>
    </div>
    ${tabbar()}
    ${assetPreviewOverlay()}
    ${ui.channelDraft ? channelEditor(ui.channelDraft) : ''}
    ${ui.assetFolderDraft ? assetFolderEditor(ui.assetFolderDraft) : ''}
    ${toastHtml()}
  </div>`;
}

function channelEditor(d) {
  return `<div class="backdrop" ${A('cancelChannel')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar canal' : 'Nuevo canal'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelChannel')}>✕</div>
    </div>
    <form data-submit="saveChannelDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. Digital Signage, TV Bar)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <input name="url" required value="${esc(d.url)}" placeholder="URL de VIDEO puro de go2rtc — ej. http://host:1984/api/stream.mp4?src=mivideo" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      </div>
    </form>
    ${d.id ? dangerLink('Eliminar canal', 'deleteChannelFromEditor') : ''}
  </div>`;
}

function assetFolderEditor(d) {
  return `<div class="backdrop" ${A('cancelAssetFolder')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar carpeta' : 'Nueva carpeta'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelAssetFolder')}>✕</div>
    </div>
    <form data-submit="saveAssetFolderDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. Promociones, Menú)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      </div>
    </form>
    ${d.id ? dangerLink('Eliminar carpeta', 'deleteAssetFolderFromEditor') : ''}
  </div>`;
}

function viewAssetFolder() {
  const f = (remote.assetFolders || []).find(f => f.id === ui.currentFolderId);
  if (!f) return `<div class="screen"><div class="topbar"><div class="back" ${A('backFromAssetFolder')}>‹</div></div><div class="content" style="padding-top:30px;text-align:center;color:var(--ink-faint)">Carpeta no encontrada.</div></div>`;
  const items = remote.assets.filter(a => a.folder === f.id);
  const available = remote.assets.filter(a => a.folder !== f.id);
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('backFromAssetFolder')}>‹</div><div class="title">📁 ${esc(f.name)}</div></div>
    <div class="content">
      <select data-change="addAssetToFolder" style="width:100%;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:16px">
        <option value="">+ Agregar archivo a esta carpeta…</option>
        ${available.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
      </select>
      <div class="grid-2">
        ${items.length === 0 ? `<div style="grid-column:1/-1;padding:24px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Carpeta vacía — agrega archivos arriba.</div>` : items.map(assetCard).join('')}
      </div>
    </div>
    ${assetPreviewOverlay()}
    ${toastHtml()}
  </div>`;
}

function playlistEditor(d) {
  return `<div class="backdrop" ${A('cancelPlaylist')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}" style="max-height:90vh">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar lista' : 'Nueva lista'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelPlaylist')}>✕</div>
    </div>
    <input value="${esc(d.name)}" placeholder="Nombre de la lista" data-input="setDraftName" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:14px">
    <div class="stack" style="margin-bottom:12px">
      ${d.items.map((it, idx) => {
        const c = it.channel ? remote.channels.find(c => c.id === it.channel) : null;
        const a = it.channel ? null : remote.assets.find(a => a.id === it.asset);
        const label = c ? c.name : (a ? a.name : (it.channel || it.asset));
        return `<div class="row card-flat" style="padding:9px 12px">
          <div style="flex:1;min-width:0;font:500 12px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</div>
          <input type="number" min="1" value="${it.seconds}" data-change="setDraftSeconds" data-arg="${idx}" style="width:56px;padding:6px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-align:center">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer)">seg</span>
          <div class="row-tap" style="color:var(--red);font:600 14px var(--sans)" ${A('removeDraftItem', idx)}>×</div>
        </div>`;
      }).join('') || `<div style="padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11.5px var(--sans)">Agrega archivos o canales abajo.</div>`}
    </div>
    <select data-change="addDraftItem" style="width:100%;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:14px">
      <option value="">+ Agregar archivo o canal…</option>
      ${(remote.channels || []).length ? `<optgroup label="Canales en vivo">${remote.channels.map(c => `<option value="channel:${esc(c.id)}">${esc(c.name)}</option>`).join('')}</optgroup>` : ''}
      ${remote.assets.length ? `<optgroup label="Archivos">${remote.assets.map(a => `<option value="asset:${esc(a.id)}">${esc(a.name)}</option>`).join('')}</optgroup>` : ''}
    </select>
    <div class="btn btn-primary" ${A('savePlaylistDraft')}>Guardar lista</div>
    ${d.id ? dangerLink('Eliminar lista', 'deletePlaylistFromEditor') : ''}
  </div>`;
}

// ---- Horarios ----------------------------------------------------------------

const DAY_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

function viewSchedule() {
  const d = ui.scheduleDraft;
  return `<div class="screen">
    ${topbar('Horarios')}
    <div class="content">
      <div class="row" style="justify-content:flex-end;margin-bottom:14px">
        <div class="btn btn-primary row-tap" style="padding:10px 16px;font-size:12.5px" ${A('newSchedule')}>+ Nuevo programa</div>
      </div>
      <div class="stack">
        ${remote.schedules.length === 0 ? emptyState('Sin programas todavía', 'Crea uno para que una TV cambie sola de contenido según la hora.') : remote.schedules.map(s => {
          const dev = remote.devices.find(x => x.id === s.device); const pl = remote.playlists.find(x => x.id === s.playlist);
          return `<div class="card" style="padding:13px 14px">
            <div class="row" style="justify-content:space-between;margin-bottom:5px">
              <div style="font:600 13px var(--sans)">${esc(s.name)}</div>
              <div style="font:400 10px var(--mono);color:var(--ink-dimmer)">prioridad ${s.priority}</div>
            </div>
            <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:8px">${dev ? esc(dev.name) : '?'} · ${pl ? esc(pl.name) : '?'} · ${s.start}–${s.end}</div>
            <div class="row" style="gap:4px;margin-bottom:10px">${[0,1,2,3,4,5,6].map(n => `<span style="width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font:600 9.5px var(--sans);background:${s.days.includes(n) ? 'var(--accent)' : 'var(--card-2)'};color:${s.days.includes(n) ? '#fff' : 'var(--ink-faint)'}">${DAY_SHORT[n]}</span>`).join('')}</div>
            <div class="row-tap" style="font:500 11.5px var(--sans);color:var(--ink-dim)" ${A('editSchedule', s.id)}>Editar</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    ${tabbar()}
    ${d ? scheduleEditor(d) : ''}
    ${toastHtml()}
  </div>`;
}

function scheduleEditor(d) {
  return `<div class="backdrop" ${A('cancelSchedule')}></div>
  <div class="sheet${sheetEntering ? ' entering' : ''}" style="max-height:92vh">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:14px">
      <div style="font:700 18px var(--sans);flex:1;min-width:0">${d.id ? 'Editar programa' : 'Nuevo programa'}</div>
      <div class="row-tap" title="Cerrar" style="width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card-2);font:600 14px var(--sans)" ${A('cancelSchedule')}>✕</div>
    </div>
    <form data-submit="saveScheduleDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. Menú del día)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <select name="device" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">${remote.devices.map(x => `<option value="${esc(x.id)}" ${x.id === d.device ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <select name="playlist" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">${remote.playlists.map(x => `<option value="${esc(x.id)}" ${x.id === d.playlist ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="row" style="gap:4px">${[0,1,2,3,4,5,6].map(n => `<div class="row-tap" ${A('toggleDraftDay', n)} style="flex:1;text-align:center;padding:9px 0;border-radius:6px;font:600 11px var(--sans);background:${d.days.includes(n) ? 'var(--accent)' : 'var(--card-2)'};color:${d.days.includes(n) ? '#fff' : 'var(--ink-dim)'}">${DAY_SHORT[n]}</div>`).join('')}</div>
        <div class="row" style="gap:8px"><input name="start" type="time" value="${d.start}" style="flex:1;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"><input name="end" type="time" value="${d.end}" style="flex:1;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"></div>
        <input name="timezone" value="${esc(d.timezone)}" placeholder="Zona horaria (ej. America/Mexico_City)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <div class="row" style="gap:8px"><input name="fromDate" type="date" value="${d.fromDate || ''}" style="flex:1;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"><input name="toDate" type="date" value="${d.toDate || ''}" style="flex:1;padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"></div>
        <input name="priority" type="number" min="0" max="100" value="${d.priority}" placeholder="Prioridad (0-100)" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none;margin-top:4px">Guardar programa</button>
      </div>
    </form>
    ${d.id ? dangerLink('Eliminar programa', 'deleteScheduleFromEditor') : ''}
  </div>`;
}

// ---- Estudio IA (real — ver studio.js/STUDIO-IA.md) ----------------------------

function viewStudio() {
  const c = ui.studioConfig;
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goTab', 'content')}>‹</div><div class="title">Estudio IA</div></div>
    <div class="content">
      ${!c ? `<div style="padding:30px 0;text-align:center;color:var(--ink-faint)">Cargando…</div>`
        : !c.eligible ? `<div style="padding:24px 0;text-align:center;color:var(--ink-dim);font:400 12.5px/1.6 var(--sans)">Estudio IA es exclusivo de empresas vinculadas a tu CRM. Esta cuenta no lo está.</div>`
        : ui.studioConfigForm ? studioConfigForm(ui.studioConfigForm)
        : !c.enabled || !c.verified ? studioConfigPrompt(c)
        : studioDraftsList(c)}
    </div>
    ${toastHtml()}
  </div>`;
}

function studioConfigPrompt(c) {
  return `<div style="padding:16px;border-radius:6px;background:var(--card-2);border:1px solid var(--line)">
    <div style="font:600 13px var(--sans);margin-bottom:6px">${remote.role === 'admin' ? 'Falta configurar Estudio IA' : 'Estudio IA no está configurado todavía'}</div>
    <div style="font:400 11.5px/1.5 var(--sans);color:var(--ink-dim);margin-bottom:${remote.role === 'admin' ? '12px' : '0'}">${c.hasKey ? 'Hay una clave cargada pero falta habilitarla o verificarla.' : 'Necesitas una clave API de OpenAI propia de esta empresa.'}</div>
    ${remote.role === 'admin' ? `<div class="btn btn-primary row-tap" style="font-size:12.5px" ${A('editStudioConfig')}>Configurar ahora</div>` : `<div style="font:400 11px var(--sans);color:var(--ink-faint)">Pide a un administrador que la configure.</div>`}
  </div>`;
}

function studioConfigForm(f) {
  return `<form data-submit="saveStudioConfigNow">
    <div class="stack">
      <input name="apiKey" type="password" placeholder="Clave API de OpenAI (sk-...)" autocomplete="off" style="padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
      <div style="font:400 10.5px var(--mono);color:var(--ink-faint)">Déjala vacía si ya hay una guardada y solo quieres cambiar el cupo.</div>
      <input name="monthlyLimit" type="number" min="0" max="1000" value="${f.monthlyLimit}" placeholder="Cupo mensual de solicitudes" style="padding:12px 14px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
      <label class="row" style="gap:10px"><input type="checkbox" name="enabled" ${f.enabled ? 'checked' : ''}><span style="font:500 12.5px var(--sans)">Habilitar Estudio IA</span></label>
      <button type="submit" class="btn btn-primary" style="border:none">Guardar</button>
      <div class="btn btn-ghost row-tap" ${A('cancelStudioConfig')}>Cancelar</div>
    </div>
  </form>`;
}

function studioDraftsList(c) {
  return `<div class="card" style="padding:13px 14px;margin-bottom:16px">
    <div class="row" style="justify-content:space-between;margin-bottom:4px"><span style="font:600 12.5px var(--sans)">Cupo mensual</span><span style="font:400 11px var(--mono);color:var(--ink-dimmer)">${c.requestsThisMonth} / ${c.monthlyLimit}</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, c.monthlyLimit ? c.requestsThisMonth / c.monthlyLimit * 100 : 0)}%;background:var(--accent)"></div></div>
    ${remote.role === 'admin' ? `<div class="row-tap" style="margin-top:10px;font:500 11px var(--sans);color:var(--ink-dim)" ${A('editStudioConfig')}>Ajustar configuración</div>` : ''}
    ${!c.verified ? `<div class="row-tap" style="margin-top:8px;font:500 11px var(--sans);color:var(--accent)" ${A('verifyStudioNow')}>Verificar acceso al modelo</div>` : ''}
  </div>
  <div class="row" style="justify-content:flex-end;margin-bottom:12px"><div class="btn btn-primary row-tap" style="padding:10px 16px;font-size:12.5px" ${A('newStudioDraft')}>+ Nuevo poster</div></div>
  <div class="stack">
    ${(ui.studioDrafts || []).map(d => `<div class="card row row-tap" style="padding:12px 14px" ${A('openStudioDraft', d.id)}>
      <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans)">${esc(d.name)}</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${fmtTime(d.created)}</div></div>
      <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
    </div>`).join('') || `<div style="padding:16px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin posters todavía.</div>`}
  </div>`;
}

function viewStudioDraft() {
  const d = ui.studioDraft;
  if (!d) return `<div class="screen"><div class="topbar"><div class="back" ${A('backToStudio')}>‹</div></div><div class="content" style="padding-top:30px;text-align:center;color:var(--ink-faint)">Cargando…</div></div>`;
  const job = ui.studioJob;
  const c = ui.studioConfig;
  const canGenerate = c && c.enabled && c.verified && c.requestsThisMonth < c.monthlyLimit;
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('backToStudio')}>‹</div><div class="title">${esc(d.name)}</div></div>
    <div class="content">
      ${job && job.status === 'ready' ? `<canvas id="studio-canvas" style="width:100%;border-radius:6px;margin-bottom:8px;background:#000"></canvas>
          <div class="btn btn-primary row-tap" style="margin-bottom:16px" ${A('exportStudioNow')}>Guardar en biblioteca</div>`
        : job && (job.status === 'processing' || job.status === 'saving') ? `<div class="thumb" style="aspect-ratio:16/9;margin-bottom:16px"><span>generando…</span></div>`
        : job && job.status === 'storage_failed' ? `<div style="padding:14px;border-radius:6px;background:rgba(240,180,41,.09);border:1px solid rgba(240,180,41,.25);margin-bottom:16px">
            <div style="font:400 11.5px/1.5 var(--sans);color:#d3b271;margin-bottom:10px">${esc(job.error || 'No se pudo guardar.')}</div>
            <div class="btn btn-ghost row-tap" style="font-size:12px" ${A('retryStudioSaveNow')}>Reintentar guardado</div>
          </div>`
        : job && (job.status === 'failed' || job.status === 'uncertain') ? `<div style="padding:14px;border-radius:6px;background:rgba(242,99,90,.09);border:1px solid rgba(242,99,90,.25);margin-bottom:16px;font:400 11.5px/1.5 var(--sans);color:#e2a29c">${esc(job.error || 'No se pudo generar.')}</div>`
        : `<div class="thumb" style="aspect-ratio:16/9;margin-bottom:16px"><span>sin generar todavía</span></div>`}

      <div class="eyebrow">Datos del poster</div>
      <div class="stack" style="margin-bottom:14px">
        <select data-change="setDraftKind" style="padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          ${Object.entries(STUDIO_KIND_LABEL).map(([k, label]) => `<option value="${k}" ${d.data.kind === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <select data-change="setDraftOrientation" style="padding:11px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          <option value="landscape" ${d.data.orientation === 'landscape' ? 'selected' : ''}>Horizontal (1920×1080)</option>
          <option value="portrait" ${d.data.orientation === 'portrait' ? 'selected' : ''}>Vertical (1080×1920)</option>
          <option value="square" ${d.data.orientation === 'square' ? 'selected' : ''}>Cuadrada (1080×1080)</option>
        </select>
        <input value="${esc(d.data.style)}" placeholder="Estilo (ej. cálido, fotográfico, minimal)" data-input="setDraftField" data-arg="style" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <textarea placeholder="Notas para la IA (qué se ve en el fondo)" data-input="setDraftField" data-arg="notes" rows="2" style="padding:11px 13px;border-radius:6px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);font-family:var(--sans);resize:vertical">${esc(d.data.notes)}</textarea>
      </div>

      <div class="eyebrow">Capas de texto</div>
      <div class="stack" style="margin-bottom:12px">
        ${d.data.layers.map((l, idx) => `<div class="card-flat" style="padding:10px 12px">
          <input value="${esc(l.text)}" data-input="setLayerField" data-arg="${idx}:text" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--ink);margin-bottom:6px">
          <div class="row" style="gap:6px">
            <input type="number" value="${l.x}" min="0" max="95" data-change="setLayerField" data-arg="${idx}:x" title="X %" style="width:0;flex:1;padding:6px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-align:center">
            <input type="number" value="${l.y}" min="0" max="95" data-change="setLayerField" data-arg="${idx}:y" title="Y %" style="width:0;flex:1;padding:6px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-align:center">
            <input type="number" value="${l.size}" min="12" max="160" data-change="setLayerField" data-arg="${idx}:size" title="Tamaño" style="width:0;flex:1;padding:6px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-align:center">
            <input type="color" value="${l.color}" data-change="setLayerField" data-arg="${idx}:color" style="width:36px;padding:0;border-radius:6px;border:1px solid var(--line);background:none;flex:none">
            <div class="row-tap" style="color:var(--red);font:600 14px var(--sans);flex:none;padding:0 4px" ${A('removeTextLayer', idx)}>×</div>
          </div>
        </div>`).join('') || `<div style="padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11.5px var(--sans)">Sin capas de texto.</div>`}
      </div>
      <div class="btn btn-ghost row-tap" style="margin-bottom:16px" ${A('addTextLayer')}>+ Agregar texto</div>

      <div class="btn btn-ghost row-tap" style="margin-bottom:10px" ${A('saveStudioDraftNow')}>Guardar borrador</div>
      ${canGenerate ? `<div class="btn btn-primary row-tap" ${A('generateStudioNow')}>Generar fondo con IA</div>` : `<div style="font:400 11px var(--sans);color:var(--ink-faint);text-align:center">${!c || !c.enabled || !c.verified ? 'Configura y verifica Estudio IA primero.' : 'Cupo mensual agotado.'}</div>`}
      ${dangerLink('Eliminar borrador', 'deleteStudioDraftFromEditor')}
    </div>
    ${toastHtml()}
  </div>`;
}

// Repinta el canvas del borrador con el fondo generado + las capas de
// texto encima — sin volver a pedir la imagen si ya está en caché.
let studioBgImage = null;
function drawStudioCanvas() {
  const canvas = document.getElementById('studio-canvas');
  if (!canvas || !ui.studioJob || ui.studioJob.status !== 'ready' || !ui.studioDraft) return;
  const [w, h] = STUDIO_SIZE[ui.studioDraft.data.orientation];
  canvas.width = w; canvas.height = h;
  const paint = img => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    for (const layer of ui.studioDraft.data.layers) {
      ctx.fillStyle = layer.color;
      ctx.font = `700 ${layer.size}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(layer.text, w * layer.x / 100, h * layer.y / 100);
    }
  };
  if (studioBgImage && studioBgImage._assetId === ui.studioJob.asset) { paint(studioBgImage); return; }
  const img = new Image();
  img.onload = () => { img._assetId = ui.studioJob.asset; studioBgImage = img; paint(img); };
  img.src = assetMediaUrl(ui.studioJob.asset);
}

// Sondea /api/studio/jobs cada 3s hasta que el job deje de estar
// 'processing'/'saving' — no hay websockets, así que es polling simple.
function pollStudioJob(requestId) {
  const check = async () => {
    try {
      const jobs = await listStudioJobs();
      const job = jobs.find(j => j.id === requestId);
      if (!job) return;
      ui.studioJob = job;
      if (job.status === 'processing' || job.status === 'saving') { setTimeout(check, 3000); return; }
      render();
      if (job.status === 'ready') drawStudioCanvas();
    } catch { /* deja de sondear en error de red; el usuario puede reabrir el borrador */ }
  };
  check();
}

// ---- Equipo -------------------------------------------------------------------

let usersCache = null;
async function loadUsers() { try { usersCache = await listUsers(); } catch { usersCache = []; } render(); }

function viewTeam() {
  if (usersCache === null) { loadUsers(); }
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goTab', 'settings')}>‹</div><div class="title">Equipo</div></div>
    <div class="content">
      ${remote.role !== 'admin' ? `<div style="padding:24px 0;text-align:center;color:var(--ink-faint);font:400 12.5px var(--sans)">Solo un administrador puede gestionar el equipo.</div>` : `
      <div class="row" style="justify-content:flex-end;margin-bottom:14px"><div class="btn btn-primary row-tap" style="padding:10px 16px;font-size:12.5px" ${A('addUser')}>+ Nuevo acceso</div></div>
      <div class="stack">
        ${(usersCache || []).map(u => `<div class="card row" style="padding:12px 14px">
          <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans)">${esc(u.email)}</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${esc(u.role)}</div></div>
          <div class="row-tap" style="font:500 11px var(--sans);color:var(--red)" ${A('removeUser', u.email)}>Quitar</div>
        </div>`).join('') || `<div style="padding:16px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Cargando…</div>`}
      </div>`}
    </div>
    ${toastHtml()}
  </div>`;
}

function viewSettings() {
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goTab', 'home')}>‹</div><div class="title">Ajustes</div></div>
    <div class="content">
      <div class="row card-flat row-tap" style="padding:13px 14px;margin-bottom:10px" ${A('goTab', 'team')}>
        <div style="flex:1;min-width:0"><div style="font:600 13px var(--sans)">Equipo</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">Quién tiene acceso a este panel</div></div>
        <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
      </div>
      <div class="row card-flat row-tap" style="padding:13px 14px" ${A('toggleTheme')}>
        <div style="flex:1;min-width:0"><div style="font:600 13px var(--sans)">Tema oscuro</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${ui.theme === 'dark' ? 'Activado' : 'Desactivado (claro)'}</div></div>
        <div style="width:44px;height:26px;border-radius:6px;background:${ui.theme === 'dark' ? 'var(--accent)' : 'var(--card-2)'};border:1px solid var(--line);position:relative;flex:none;transition:background .15s">
          <div style="position:absolute;top:2px;left:${ui.theme === 'dark' ? '20px' : '2px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>
        </div>
      </div>
      <a class="row card-flat row-tap" href="/downloads/venuepro-signage-test.apk" download style="padding:13px 14px;margin-top:10px;text-decoration:none;color:inherit">
        <div style="flex:1;min-width:0"><div style="font:600 13px var(--sans)">📱 Descargar APK</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">Reproductor Android para TVs nuevas</div></div>
        <div style="color:var(--ink-faint);font:400 13px var(--sans)">⬇</div>
      </a>
      <div style="font:400 10px var(--mono);color:var(--ink-dimmer);margin-top:20px;text-align:center">${esc(remote.tenant)} · ${esc(remote.role)}</div>
      <div class="row-tap" style="text-align:center;margin-top:14px;font:600 12px var(--sans);color:var(--red)" ${A('logoutNow')}>Cerrar sesión</div>
    </div>
    ${toastHtml()}
  </div>`;
}

function emptyState(title, sub) {
  return `<div style="padding:40px 20px;text-align:center">
    <div style="font:700 16px var(--sans);margin-bottom:6px">${esc(title)}</div>
    <div style="font:400 12px/1.5 var(--sans);color:var(--ink-dim)">${esc(sub)}</div>
  </div>`;
}

// ---- Render principal -----------------------------------------------------------

function render() {
  const app = document.getElementById('app');
  if (ui.authed === null) { app.innerHTML = `<div class="screen" style="align-items:center;justify-content:center"><div style="color:var(--ink-faint);font:400 12.5px var(--sans)">Cargando…</div></div>`; return; }
  if (!ui.authed) { app.innerHTML = viewLogin(); return; }
  usersCache = usersCache; // no-op, mantiene el caché entre renders
  switch (ui.route) {
    case 'playlists': app.innerHTML = viewPlaylists(); break;
    case 'content': app.innerHTML = viewContent(); break;
    case 'assetFolder': app.innerHTML = viewAssetFolder(); break;
    case 'schedule': app.innerHTML = viewSchedule(); break;
    case 'team': app.innerHTML = viewTeam(); break;
    case 'settings': app.innerHTML = viewSettings(); break;
    case 'pair': app.innerHTML = viewPair(); break;
    case 'locationDetail': app.innerHTML = viewLocationDetail(); break;
    case 'studio': app.innerHTML = viewStudio(); break;
    case 'studioDraft': app.innerHTML = viewStudioDraft(); break;
    case 'ptz': app.innerHTML = viewPtz(); break;
    case 'mix': app.innerHTML = viewMix(); break;
    default: app.innerHTML = viewHome();
  }
  sheetEntering = false;
  wireLiveFeedFallbacks();
}

// Safari a veces simplemente no reproduce el <video> en vivo (MP4 sin
// duración fija) — si dispara "error", lo reemplazamos por una <img> que
// se refresca sola cada 1.5s (?mode=snapshot en el mismo proxy). No usa
// onerror="" inline a propósito — la CSP del backend (script-src 'self',
// sin unsafe-inline) lo bloquearía; por eso se engancha acá, después de
// cada render().
//
// Pero no todos los navegadores móviles disparan "error" cuando esto pasa
// — Chrome/WebView en Android a veces se queda "cargando" un MP4 en vivo
// sin duración fija para siempre (sobre todo en datos móviles, más lentos
// que la red donde se probó) sin avisar con ningún evento — se ve
// exactamente como un video pausado, aunque nunca estuvo en pausa de
// verdad. Por eso, además del error explícito, si a los 4s no arrancó a
// reproducir de verdad (sigue en pausa y en el segundo 0), lo tratamos
// igual que un error y pasamos a la foto.
let snapshotTimers = [];
// PeerConnections de WebRTC abiertas por el render actual — hay que
// cerrarlas explícitamente en cada render() (innerHTML= tira el <video>
// pero no cierra solo la conexión) para no dejar conexiones fantasma.
let activePeerConnections = [];
function startMp4WithSnapshotFallback(video) {
  let swapped = false;
  const toSnapshot = () => {
    if (swapped) return; swapped = true;
    const img = document.createElement('img');
    img.setAttribute('style', video.getAttribute('style') || '');
    img.alt = 'señal en vivo';
    const base = video.dataset.snapshotSrc;
    const refresh = () => { img.src = base + (base.includes('?') ? '&' : '?') + 't=' + Date.now(); };
    refresh();
    snapshotTimers.push(setInterval(refresh, 1500));
    video.replaceWith(img);
  };
  video.addEventListener('error', toSnapshot, { once: true });
  video.src = video.dataset.mp4Src || video.getAttribute('src');
  setTimeout(() => { if (video.isConnected && video.paused && video.currentTime === 0) toSnapshot(); }, 4000);
}
// WebRTC directo (WHEP contra go2rtc) para la vista previa del panel —
// casi cero latencia si el navegador está en la misma red que el Mini PC
// (igual que el dashboard de Home Assistant), porque una vez negociada la
// oferta/respuesta SDP (lo único que pasa por nuestro proxy same-origin,
// para no romper la CSP connect-src 'self'), el video va directo por ICE
// entre el navegador y go2rtc — nunca por el VPS. Si el navegador está en
// otra red (admin remoto) simplemente no va a lograr conectar por ICE en
// unos segundos, y ahí cae solo al MP4 de siempre (misma ruta que antes).
async function tryWebrtcThenFallback(video) {
  if (typeof RTCPeerConnection === 'undefined') return startMp4WithSnapshotFallback(video);
  try {
    const pc = new RTCPeerConnection();
    activePeerConnections.push(pc);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = e => { video.srcObject = e.streams[0]; };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(video.dataset.webrtcOffer, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('oferta WebRTC rechazada');
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebRTC no conectó a tiempo')), 4000);
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); }
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { clearTimeout(timer); reject(new Error('ICE falló')); }
      });
    });
  } catch (e) {
    if (video.isConnected) startMp4WithSnapshotFallback(video);
  }
}
function wireLiveFeedFallbacks() {
  snapshotTimers.forEach(t => clearInterval(t));
  snapshotTimers = [];
  activePeerConnections.forEach(pc => pc.close());
  activePeerConnections = [];
  document.querySelectorAll('video[data-webrtc-offer]').forEach(tryWebrtcThenFallback);
  document.querySelectorAll('video[data-snapshot-src]:not([data-webrtc-offer])').forEach(startMp4WithSnapshotFallback);
}

// El panel NO se refresca solo — remote solo se actualiza cuando el
// usuario hace una acción (run() llama refresh() después). Eso significa
// que un estado que cambia SOLO (una TV que reporta un error nuevo por su
// cuenta, o cambia a "en vivo"/"apagada" sin que nadie toque nada acá)
// puede quedar viejo en pantalla indefinidamente. Mientras se está viendo
// Home o el detalle de una ubicación (las pantallas donde el estado de
// las TVs realmente importa) se refresca solo cada 4s — nunca mientras
// haya un editor/ficha abierto encima, para no pisar algo que se esté
// escribiendo a mitad de camino.
//
// OJO: esto llama a getState() directo, NO a refresh() — refresh() SIEMPRE
// llama a render(), que regenera el HTML entero con innerHTML= y por lo
// tanto recrea de cero cualquier <video>/<img> de vista previa que esté
// mostrando una fuente en vivo. Recrearlo cada 4s se ve como un parpadeo o
// corte de la reproducción aunque el contenido mostrado sea EXACTAMENTE el
// mismo (bug real: apareció justo al agregar este auto-refresh). Por eso
// acá se compara la firma del estado nuevo contra la del último dibujado
// (stateSignature(), sin el "seen" que cambia solo) y SOLO se llama a
// render() cuando de verdad cambió algo visible.
setInterval(async () => {
  if (ui.authed !== true) return;
  if (ui.route !== 'home' && ui.route !== 'locationDetail') return;
  if (ui.locationDraft || ui.detailDeviceId || ui.ptzCameraDraft) return;
  try {
    const r = await getState();
    const sig = stateSignature(r);
    if (sig === lastStateSignature) return; // nada visible cambió, no redibujar
    remote = r; lastStateSignature = sig; render();
  } catch { /* silencioso — el próximo intento (4s después) ya reintenta */ }
}, 4000);

if (pairCodeFromUrl) { try { history.replaceState(null, '', location.pathname); } catch { } }

refresh();
