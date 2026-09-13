// app.js — interfaz nueva (visual Claude Design) conectada a la API real
// de venuepro-signage (server.js). Sin framework: render() regenera el
// HTML de #app; los clics se resuelven por delegación con data-action.

const ui = {
  authed: null,      // null = todavía no sabemos, true/false una vez consultado
  route: 'home',      // home | content | schedule | team | pair
  loginError: '',
  toast: null,
  detailDeviceId: null,
  currentLocationId: null, // ubicación abierta en viewLocationDetail
  playlistDraft: null, // { id, name, items:[{asset,seconds}] } al crear/editar lista
  scheduleDraft: null, // objeto de horario al crear/editar
};

let remote = null; // último resultado de getState(): { tenant, role, email, locations, devices, assets, playlists, schedules }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function A(action, arg) { return `data-action="${action}" data-arg="${esc(arg)}"`; }
function fmtTime(ms) { if (!ms) return 'nunca'; const s = Math.round((Date.now() - ms) / 1000); if (s < 60) return `hace ${s}s`; if (s < 3600) return `hace ${Math.round(s / 60)}m`; return `hace ${Math.round(s / 3600)}h`; }

function showToast(msg, isError) {
  ui.toast = { msg, isError: !!isError };
  render();
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { ui.toast = null; render(); }, 2600);
}

async function refresh() {
  try { remote = await getState(); ui.authed = true; }
  catch (e) { ui.authed = false; remote = null; }
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

  openDevice(id) { ui.detailDeviceId = id; render(); },
  closeDevice() { ui.detailDeviceId = null; render(); },
  async togglePause(id) {
    const d = remote.devices.find(d => d.id === id); if (!d) return;
    await run(setDevicePlayback(id, !d.paused));
  },
  async syncNow(id) { await run(syncDevice(id), 'Sincronización solicitada'); },
  async revoke(id) {
    if (!confirm('¿Quitar esta pantalla? Tendrás que emparejarla de nuevo.')) return;
    ui.detailDeviceId = null; await run(revokeDevice(id), 'Pantalla eliminada');
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
    await run(setDeviceDisplay(id, { orientation, rotation, fit }), 'Pantalla actualizada');
  },
  async moveDevice(id, select) {
    await run(setDeviceLocation(id, select.value || null), 'Ubicación actualizada');
  },
  async addLocation() {
    const name = prompt('Nombre de la ubicación:'); if (!name) return;
    await run(createLocation(name), 'Ubicación creada');
  },
  goLocations() { ui.route = 'locations'; render(); },
  openLocation(id) { ui.currentLocationId = id; ui.route = 'locationDetail'; render(); },

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
      stopScanner(); showToast('Pantalla vinculada'); ui.route = 'home'; await refresh();
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
  newPlaylist() { ui.playlistDraft = { id: null, name: '', items: [] }; render(); },
  editPlaylist(id) {
    const p = remote.playlists.find(p => p.id === id); if (!p) return;
    ui.playlistDraft = { id: p.id, name: p.name, items: p.items.map(i => ({ ...i })) }; render();
  },
  cancelPlaylist() { ui.playlistDraft = null; render(); },
  addDraftItem(_, select) {
    const asset = select.value; if (!asset) return;
    ui.playlistDraft.items.push({ asset, seconds: 10 }); render();
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
  async deletePlaylistNow(id) {
    if (!confirm('¿Eliminar esta lista?')) return;
    await run(deletePlaylist(id), 'Lista eliminada');
  },

  // -- horarios --
  newSchedule() {
    ui.scheduleDraft = { id: null, device: remote.devices[0]?.id || '', playlist: remote.playlists[0]?.id || '', name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', fromDate: '', toDate: '', priority: 0 };
    render();
  },
  editSchedule(id) {
    const s = remote.schedules.find(s => s.id === id); if (!s) return;
    ui.scheduleDraft = { ...s }; render();
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
  async deleteScheduleNow(id) {
    if (!confirm('¿Eliminar este programa?')) return;
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

document.addEventListener('click', e => {
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

function tabbar() {
  const tabs = [['home', 'Pantallas'], ['content', 'Contenido'], ['schedule', 'Horarios'], ['team', 'Equipo']];
  return `<div class="tabbar">${tabs.map(([r, label]) => `
    <button class="tab ${ui.route === r ? 'active' : ''}" ${A('goTab', r)}><div class="ico"></div><span>${label}</span></button>`).join('')}</div>`;
}
function toastHtml() {
  if (!ui.toast) return '';
  return `<div style="position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:${ui.toast.isError ? '#3a1f1d' : '#1b1d22'};border:1px solid ${ui.toast.isError ? 'rgba(242,99,90,.4)' : 'var(--line)'};color:#fff;padding:10px 16px;border-radius:12px;font:600 12.5px var(--sans);z-index:30;max-width:88%;box-shadow:0 6px 20px rgba(0,0,0,.35)">${esc(ui.toast.msg)}</div>`;
}
function topbar(title) {
  return `<div class="topbar" style="justify-content:space-between">
    <div class="title">${esc(title)}</div>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${esc(remote.tenant)} · ${esc(remote.role)}</span>
      <div class="row-tap" style="font:600 11px var(--sans);color:var(--ink-dim)" ${A('logoutNow')}>Salir</div>
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
          <input name="email" type="email" required placeholder="Correo" autocomplete="username" style="padding:13px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);font:500 14px var(--sans)">
          <input name="password" type="password" required placeholder="Contraseña" autocomplete="current-password" style="padding:13px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);font:500 14px var(--sans)">
          ${ui.loginError ? `<div style="font:400 11.5px var(--sans);color:var(--red)">${esc(ui.loginError)}</div>` : ''}
          <button type="submit" class="btn btn-primary" style="margin-top:6px;border:none">Entrar</button>
        </div>
      </form>
    </div>
    ${toastHtml()}
  </div>`;
}

// ---- Home (Pantallas) --------------------------------------------------------

function viewHome() {
  const devices = remote.devices;
  const byLoc = new Map(remote.locations.map(l => [l.id, []]));
  byLoc.set(null, []);
  for (const d of devices) { if (!byLoc.has(d.location)) byLoc.set(d.location, []); byLoc.get(d.location).push(d); }
  const groups = [...remote.locations.map(l => [l, byLoc.get(l.id) || []]), [{ id: null, name: 'Sin ubicación' }, byLoc.get(null) || []]].filter(([, ds]) => ds.length);

  return `<div class="screen">
    ${topbar('Pantallas')}
    <div class="content">
      <div class="row" style="gap:8px;margin-bottom:10px">
        <div class="btn btn-primary" style="flex:1;padding:12px 0;font-size:13px" ${A('startPairing')}>+ Emparejar pantalla</div>
      </div>
      <div class="row row-tap card-flat" style="padding:11px 13px;margin-bottom:16px" ${A('goLocations')}>
        <div style="flex:1;min-width:0;font:500 12.5px var(--sans);color:var(--ink-dim)">📍 ${remote.locations.length} ubicacion${remote.locations.length === 1 ? '' : 'es'}</div>
        <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
      </div>
      ${devices.length === 0 ? emptyState('Sin pantallas todavía', 'Empareja tu primera pantalla para empezar.') : groups.map(([loc, ds]) => `
        <div class="eyebrow">${esc(loc.name)} · ${ds.length}</div>
        <div class="stack" style="margin-bottom:18px">${ds.map(deviceRow).join('')}</div>
      `).join('')}
    </div>
    ${tabbar()}
    ${ui.detailDeviceId ? deviceSheet() : ''}
    ${toastHtml()}
  </div>`;
}

function viewLocations() {
  const counts = new Map(remote.locations.map(l => [l.id, 0]));
  for (const d of remote.devices) if (counts.has(d.location)) counts.set(d.location, counts.get(d.location) + 1);
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goTab', 'home')}>‹</div><div class="title">Ubicaciones</div></div>
    <div class="content">
      ${remote.locations.length === 0 ? emptyState('Sin ubicaciones todavía', 'Agrega la primera para empezar a organizar tus pantallas.') : `<div class="stack" style="margin-bottom:16px">
        ${remote.locations.map(l => `<div class="card row row-tap" style="padding:13px 14px" ${A('openLocation', l.id)}>
          <div style="flex:1;min-width:0">
            <div style="font:600 13px var(--sans)">${esc(l.name)}</div>
            <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${counts.get(l.id) || 0} pantalla${counts.get(l.id) === 1 ? '' : 's'}</div>
          </div>
          <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
        </div>`).join('')}
      </div>`}
      <div class="btn btn-ghost row-tap" ${A('addLocation')}>+ Añadir ubicación</div>
      <div style="font:400 11px/1.5 var(--sans);color:var(--ink-faint);margin-top:14px">Por ahora solo se pueden crear ubicaciones aquí — renombrar o eliminar una todavía no lo soporta el backend.</div>
    </div>
    ${toastHtml()}
  </div>`;
}

function viewLocationDetail() {
  const loc = remote.locations.find(l => l.id === ui.currentLocationId);
  if (!loc) { ui.route = 'locations'; return viewLocations(); }
  const devices = remote.devices.filter(d => d.location === loc.id);
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('goLocations')}>‹</div><div class="title">${esc(loc.name)}</div></div>
    <div class="content">
      ${devices.length === 0 ? emptyState('Sin pantallas aquí todavía', 'Empareja una pantalla y elige esta ubicación, o mueve una existente desde su detalle.') : `<div class="stack">${devices.map(deviceRow).join('')}</div>`}
    </div>
    ${ui.detailDeviceId ? deviceSheet() : ''}
    ${toastHtml()}
  </div>`;
}

function deviceRow(d) {
  const status = deviceStatus(d);
  const playlist = remote.playlists.find(p => p.id === d.playlist);
  // No es un preview EN VIVO de verdad (el player no manda capturas de
  // pantalla) — es el primer archivo de la lista asignada, que es lo que
  // debería estar mostrando la pantalla ahora mismo salvo que un horario
  // esté activo encima.
  const firstAsset = playlist && playlist.items[0] ? remote.assets.find(a => a.id === playlist.items[0].asset) : null;
  return `<div class="card row row-tap" style="padding:13px 14px" ${A('openDevice', d.id)}>
    <div class="dot" style="background:${STATUS_COLOR[status]}"></div>
    <div style="flex:1;min-width:0">
      <div style="font:600 13px var(--sans);margin-bottom:2px">${esc(d.name)}${d.paused ? ' · ⏸' : ''}</div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${playlist ? esc(playlist.name) : 'sin lista'} · ${fmtTime(d.seen)}</div>
    </div>
    ${firstAsset ? previewThumb(firstAsset) : ''}
    <div style="color:var(--ink-faint);font:400 13px var(--sans)">›</div>
  </div>`;
}

function previewThumb(a) {
  const s = 'width:84px;aspect-ratio:16/9;border-radius:9px;object-fit:cover;flex:none;background:#000';
  return a.type.startsWith('image/')
    ? `<img src="${assetMediaUrl(a.id)}" style="${s}">`
    : `<video src="${assetMediaUrl(a.id)}#t=0.5" preload="metadata" muted playsinline style="${s}"></video>`;
}

function deviceSheet() {
  const d = remote.devices.find(d => d.id === ui.detailDeviceId); if (!d) return '';
  const status = deviceStatus(d);
  return `<div class="backdrop" ${A('closeDevice')}></div>
  <div class="sheet" style="max-height:90vh">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:3px"><div class="dot" style="background:${STATUS_COLOR[status]}"></div><div style="font:700 19px var(--sans)">${esc(d.name)}</div></div>
    <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:16px">${STATUS_LABEL[status]} · ${fmtTime(d.seen)}${d.error ? ' · ' + esc(d.error) : ''}</div>

    <div class="eyebrow">Lista asignada</div>
    <div class="row" style="gap:8px;margin-bottom:16px">
      <select style="flex:1;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        ${remote.playlists.map(p => `<option value="${esc(p.id)}" ${p.id === d.playlist ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <div class="btn btn-primary row-tap" style="padding:11px 16px;font-size:13px" ${A('assignPlaylistTo', d.id)}>Asignar</div>
    </div>

    <div class="eyebrow">Ubicación</div>
    <select data-change="moveDevice" data-arg="${esc(d.id)}" style="width:100%;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:16px">
      <option value="">Sin ubicación</option>
      ${remote.locations.map(l => `<option value="${esc(l.id)}" ${l.id === d.location ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
    </select>

    <div class="eyebrow">Pantalla</div>
    <div data-display-form style="margin-bottom:16px" class="stack">
      <select name="orientation" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <option value="auto" ${d.orientation === 'auto' ? 'selected' : ''}>Automática</option>
        <option value="landscape" ${d.orientation === 'landscape' ? 'selected' : ''}>Horizontal</option>
        <option value="portrait" ${d.orientation === 'portrait' ? 'selected' : ''}>Vertical</option>
      </select>
      <select name="fit" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <option value="cover" ${d.fit === 'cover' ? 'selected' : ''}>Rellenar (recorta)</option>
        <option value="contain" ${d.fit === 'contain' ? 'selected' : ''}>Mostrar completo</option>
      </select>
      <select name="rotation" data-change="setDisplayOpt" data-arg="${esc(d.id)}" style="padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        ${[0, 90, 180, 270].map(r => `<option value="${r}" ${d.rotation === r ? 'selected' : ''}>Giro ${r}°</option>`).join('')}
      </select>
    </div>

    <div class="row" style="gap:8px;margin-bottom:10px">
      <div class="btn btn-ghost row-tap" style="flex:1;padding:11px 0;font-size:12.5px" ${A('togglePause', d.id)}>${d.paused ? 'Reanudar' : 'Pausar'}</div>
      <div class="btn btn-ghost row-tap" style="flex:1;padding:11px 0;font-size:12.5px" ${A('syncNow', d.id)}>Sincronizar</div>
    </div>
    <div class="btn btn-danger row-tap" style="padding:11px 0;font-size:12.5px" ${A('revoke', d.id)}>Quitar pantalla</div>
  </div>`;
}

// ---- Emparejar --------------------------------------------------------------

function viewPair() {
  // El código lo genera la propia pantalla (TV/tablet) al arrancar sin
  // emparejar — la muestra en su QR. Aquí solo la escaneamos o tecleamos
  // el código, y se reclama con nombre + ubicación.
  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('cancelPair')}>‹</div><div class="title">Emparejar pantalla</div></div>
    <div class="content">
      <div style="font:400 12px/1.5 var(--sans);color:var(--ink-dim);margin-bottom:14px">La pantalla física muestra su propio QR y código al encenderse sin emparejar. Escanéalo con la cámara o escríbelo abajo.</div>
      <div id="qr-reader" style="border-radius:14px;overflow:hidden;margin-bottom:12px;min-height:0"></div>
      <div class="btn btn-ghost row-tap" id="qr-toggle" style="margin-bottom:16px" ${A('toggleScanner')}>Abrir cámara</div>
      <form data-submit="confirmPair">
        <div class="stack">
          <input id="qr-code-field" name="code" required placeholder="Código (ej. ABC123DEF456)" style="padding:12px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);text-transform:uppercase">
          <input name="name" required placeholder="Nombre (ej. Barra 01)" style="padding:12px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
          <select name="location" style="padding:12px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
            <option value="">Sin ubicación</option>
            ${remote.locations.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary" style="border:none;margin-top:6px">Confirmar emparejamiento</button>
        </div>
      </form>
    </div>
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

function viewContent() {
  const d = ui.playlistDraft;
  return `<div class="screen">
    ${topbar('Contenido')}
    <div class="content">
      <div class="eyebrow">Biblioteca</div>
      <label class="btn btn-ghost" style="display:block;text-align:center;margin-bottom:14px;cursor:pointer">
        + Subir archivo (jpg, png, webp, mp4)
        <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4" style="display:none" data-change="pickUpload">
      </label>
      <div class="grid-2" style="margin-bottom:20px">
        ${remote.assets.length === 0 ? `<div style="grid-column:1/-1;padding:24px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin archivos todavía.</div>` : remote.assets.map(a => `
        <div class="card" style="overflow:hidden">
          ${a.type.startsWith('image/')
            ? `<img src="${assetMediaUrl(a.id)}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000">`
            : `<video src="${assetMediaUrl(a.id)}#t=0.5" preload="metadata" muted playsinline style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000"></video>`}
          <div style="padding:9px 10px">
            <div style="font:600 12px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px">${esc(a.name)}</div>
            <div class="row" style="gap:6px">
              <div class="row-tap" style="font:500 10.5px var(--sans);color:var(--ink-dim)" ${A('renameAsset', a.id)}>Renombrar</div>
              <div class="row-tap" style="font:500 10.5px var(--sans);color:var(--red);margin-left:auto" ${A('archiveAsset', a.id)}>Archivar</div>
            </div>
          </div>
        </div>`).join('')}
      </div>

      <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:11px">
        <div class="eyebrow" style="margin:0">Listas de reproducción</div>
        <div class="row-tap" style="font:600 11.5px var(--sans);color:var(--accent)" ${A('newPlaylist')}>+ Nueva</div>
      </div>
      <div class="stack">
        ${remote.playlists.length === 0 ? `<div style="padding:16px 0;text-align:center;color:var(--ink-faint);font:400 12px var(--sans)">Sin listas todavía.</div>` : remote.playlists.map(p => `
        <div class="card row" style="padding:12px 14px">
          <div style="flex:1;min-width:0">
            <div style="font:600 12.5px var(--sans)">${esc(p.name)}</div>
            <div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${p.items.length} archivo${p.items.length === 1 ? '' : 's'}</div>
          </div>
          <div class="row-tap" style="font:500 11px var(--sans);color:var(--ink-dim);margin-right:12px" ${A('editPlaylist', p.id)}>Editar</div>
          <div class="row-tap" style="font:500 11px var(--sans);color:var(--red)" ${A('deletePlaylistNow', p.id)}>Eliminar</div>
        </div>`).join('')}
      </div>
    </div>
    ${tabbar()}
    ${d ? playlistEditor(d) : ''}
    ${toastHtml()}
  </div>`;
}

function playlistEditor(d) {
  return `<div class="backdrop" ${A('cancelPlaylist')}></div>
  <div class="sheet" style="max-height:90vh">
    <div class="sheet-grip"></div>
    <div style="font:700 18px var(--sans);margin-bottom:14px">${d.id ? 'Editar lista' : 'Nueva lista'}</div>
    <input value="${esc(d.name)}" placeholder="Nombre de la lista" data-input="setDraftName" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:14px">
    <div class="stack" style="margin-bottom:12px">
      ${d.items.map((it, idx) => {
        const a = remote.assets.find(a => a.id === it.asset);
        return `<div class="row card-flat" style="padding:9px 12px">
          <div style="flex:1;min-width:0;font:500 12px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a ? a.name : it.asset)}</div>
          <input type="number" min="1" value="${it.seconds}" data-change="setDraftSeconds" data-arg="${idx}" style="width:56px;padding:6px;border-radius:8px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-align:center">
          <span style="font:400 10px var(--mono);color:var(--ink-dimmer)">seg</span>
          <div class="row-tap" style="color:var(--red);font:600 14px var(--sans)" ${A('removeDraftItem', idx)}>×</div>
        </div>`;
      }).join('') || `<div style="padding:10px 0;text-align:center;color:var(--ink-faint);font:400 11.5px var(--sans)">Agrega archivos abajo.</div>`}
    </div>
    <select data-change="addDraftItem" style="width:100%;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink);margin-bottom:14px">
      <option value="">+ Agregar archivo…</option>
      ${remote.assets.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
    </select>
    <div class="btn btn-primary" ${A('savePlaylistDraft')}>Guardar lista</div>
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
        ${remote.schedules.length === 0 ? emptyState('Sin programas todavía', 'Crea uno para que una pantalla cambie sola de contenido según la hora.') : remote.schedules.map(s => {
          const dev = remote.devices.find(x => x.id === s.device); const pl = remote.playlists.find(x => x.id === s.playlist);
          return `<div class="card" style="padding:13px 14px">
            <div class="row" style="justify-content:space-between;margin-bottom:5px">
              <div style="font:600 13px var(--sans)">${esc(s.name)}</div>
              <div style="font:400 10px var(--mono);color:var(--ink-dimmer)">prioridad ${s.priority}</div>
            </div>
            <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:8px">${dev ? esc(dev.name) : '?'} · ${pl ? esc(pl.name) : '?'} · ${s.start}–${s.end}</div>
            <div class="row" style="gap:4px;margin-bottom:10px">${[0,1,2,3,4,5,6].map(n => `<span style="width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font:600 9.5px var(--sans);background:${s.days.includes(n) ? 'var(--accent)' : 'var(--card-2)'};color:${s.days.includes(n) ? '#fff' : 'var(--ink-faint)'}">${DAY_SHORT[n]}</span>`).join('')}</div>
            <div class="row" style="gap:14px">
              <div class="row-tap" style="font:500 11.5px var(--sans);color:var(--ink-dim)" ${A('editSchedule', s.id)}>Editar</div>
              <div class="row-tap" style="font:500 11.5px var(--sans);color:var(--red)" ${A('deleteScheduleNow', s.id)}>Eliminar</div>
            </div>
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
  <div class="sheet" style="max-height:92vh">
    <div class="sheet-grip"></div>
    <div style="font:700 18px var(--sans);margin-bottom:14px">${d.id ? 'Editar programa' : 'Nuevo programa'}</div>
    <form data-submit="saveScheduleDraft">
      <div class="stack">
        <input name="name" required value="${esc(d.name)}" placeholder="Nombre (ej. Menú del día)" style="padding:11px 13px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <select name="device" style="padding:11px 13px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">${remote.devices.map(x => `<option value="${esc(x.id)}" ${x.id === d.device ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <select name="playlist" style="padding:11px 13px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">${remote.playlists.map(x => `<option value="${esc(x.id)}" ${x.id === d.playlist ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="row" style="gap:4px">${[0,1,2,3,4,5,6].map(n => `<div class="row-tap" ${A('toggleDraftDay', n)} style="flex:1;text-align:center;padding:9px 0;border-radius:8px;font:600 11px var(--sans);background:${d.days.includes(n) ? 'var(--accent)' : 'var(--card-2)'};color:${d.days.includes(n) ? '#fff' : 'var(--ink-dim)'}">${DAY_SHORT[n]}</div>`).join('')}</div>
        <div class="row" style="gap:8px"><input name="start" type="time" value="${d.start}" style="flex:1;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"><input name="end" type="time" value="${d.end}" style="flex:1;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"></div>
        <input name="timezone" value="${esc(d.timezone)}" placeholder="Zona horaria (ej. America/Mexico_City)" style="padding:11px 13px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <div class="row" style="gap:8px"><input name="fromDate" type="date" value="${d.fromDate || ''}" style="flex:1;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"><input name="toDate" type="date" value="${d.toDate || ''}" style="flex:1;padding:11px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)"></div>
        <input name="priority" type="number" min="0" max="100" value="${d.priority}" placeholder="Prioridad (0-100)" style="padding:11px 13px;border-radius:10px;background:var(--card-2);border:1px solid var(--line);color:var(--ink)">
        <button type="submit" class="btn btn-primary" style="border:none;margin-top:4px">Guardar programa</button>
      </div>
    </form>
  </div>`;
}

// ---- Equipo -------------------------------------------------------------------

let usersCache = null;
async function loadUsers() { try { usersCache = await listUsers(); } catch { usersCache = []; } render(); }

function viewTeam() {
  if (usersCache === null) { loadUsers(); }
  return `<div class="screen">
    ${topbar('Equipo')}
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
    ${tabbar()}
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
    case 'content': app.innerHTML = viewContent(); break;
    case 'schedule': app.innerHTML = viewSchedule(); break;
    case 'team': app.innerHTML = viewTeam(); break;
    case 'pair': app.innerHTML = viewPair(); break;
    case 'locations': app.innerHTML = viewLocations(); break;
    case 'locationDetail': app.innerHTML = viewLocationDetail(); break;
    default: app.innerHTML = viewHome();
  }
}

refresh();
