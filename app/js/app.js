// app.js — vistas + navegación. Sin framework: un render() que regenera
// el HTML de #app a partir de `ui` (estado de navegación/UI) y de los
// datos de data.js (que hacen de "estado del servidor"). Los clics se
// resuelven por delegación de eventos usando atributos data-action/data-arg.

const ui = {
  route: 'home',
  history: [],
  agencyId: 'nv',
  agencySheetOpen: false,
  filter: 'all',
  detailScreenId: null,
  clientId: null,
  locOpen: null,
  screenId: null,   // pantalla "en contexto" para fuente/mezclador
  locationId: null, // ubicación "en contexto" para encoders/ptz
  encOpen: null,
  camId: null,
  toast: null
};

function esc(s) { return String(s == null ? '' : s); }
function A(action, arg) { return `data-action="${action}" data-arg="${esc(arg)}"`; }

function navigate(route, params) {
  ui.history.push({ route: ui.route, params: snapshotParams() });
  Object.assign(ui, params || {});
  ui.route = route;
  render();
}
function snapshotParams() {
  return { agencyId: ui.agencyId, clientId: ui.clientId, screenId: ui.screenId, locationId: ui.locationId, encOpen: ui.encOpen, camId: ui.camId, filter: ui.filter, detailScreenId: ui.detailScreenId, locOpen: ui.locOpen };
}
function goBack() {
  const prev = ui.history.pop();
  if (!prev) { ui.route = 'home'; render(); return; }
  Object.assign(ui, prev.params);
  ui.route = prev.route;
  render();
}
function showToast(msg) {
  ui.toast = msg;
  render();
  setTimeout(() => { ui.toast = null; render(); }, 1800);
}

// ---- acciones -----------------------------------------------------------

const actions = {
  toggleAgencySheet() { ui.agencySheetOpen = !ui.agencySheetOpen; render(); },
  pickAgency(id) {
    ui.agencyId = id; ui.agencySheetOpen = false; ui.filter = 'all'; ui.detailScreenId = null;
    ui.clientId = getClients(id)[0] ? getClients(id)[0].id : null;
    render();
  },
  setFilter(id) { ui.filter = id; render(); },
  openDetail(idStr) { ui.detailScreenId = Number(idStr); render(); },
  closeDetail() { ui.detailScreenId = null; render(); },
  goTab(route) { ui.route = route; ui.history = []; render(); },

  pickClient(id) { ui.clientId = id; ui.locOpen = null; render(); },
  toggleLoc(id) { ui.locOpen = (ui.locOpen === id) ? null : id; render(); },

  openSource(idStr) {
    navigate('source', { screenId: Number(idStr) });
  },
  pickSource(sourceId) {
    const found = findScreen(ui.screenId);
    if (!found) return;
    found.screen.source = sourceId;
    if ((sourceId === 'live' || sourceId === 'split') && !found.screen.mixer) {
      found.screen.mixer = { layout: 'lower', promo: 'p1', muted: true };
    }
    render();
  },
  applySource() {
    const found = findScreen(ui.screenId);
    sendPlayerCommand(ui.screenId, 'set_source', { source: found && found.screen.source }).then(() => {
      showToast('Aplicado a la pantalla');
      goBack();
    });
  },
  openMixer() { navigate('mixer', { screenId: ui.screenId }); },
  pickLayout(layoutId) {
    const found = findScreen(ui.screenId);
    if (found) { found.screen.mixer.layout = layoutId; render(); }
  },
  pickPromo(promoId) {
    const found = findScreen(ui.screenId);
    if (found) { found.screen.mixer.promo = promoId; render(); }
  },
  toggleMute() {
    const found = findScreen(ui.screenId);
    if (found) { found.screen.mixer.muted = !found.screen.mixer.muted; render(); }
  },
  applyMix() {
    sendPlayerCommand(ui.screenId, 'set_mix', {}).then(() => { showToast('Mezcla en emisión'); goBack(); });
  },

  openEncoders(locationId) {
    const rec = getLocation(locationId);
    const first = rec && rec.location.encoders[0];
    navigate('encoders', { locationId, encOpen: first ? first.id : null });
  },
  pickEncoder(id) { ui.encOpen = id; render(); },

  openPtz(locationId) {
    const rec = getLocation(locationId);
    const first = rec && rec.location.ptzCams[0];
    if (first && !first.state) first.state = { x: 0, y: 0, zoom: 1.4, presetId: null, rec: false };
    navigate('ptz', { locationId, camId: first ? first.id : null });
  },
  pickCam(id) {
    const rec = getLocation(ui.locationId);
    const cam = rec && rec.location.ptzCams.find(c => c.id === id);
    if (cam && !cam.state) cam.state = { x: 0, y: 0, zoom: 1.4, presetId: null, rec: false };
    ui.camId = id; render();
  },
  ptzPreset(presetId) {
    const cam = currentCam(); const p = PTZ_PRESETS.find(p => p.id === presetId);
    if (cam && p) { cam.state.presetId = p.id; cam.state.x = p.x; cam.state.y = p.y; cam.state.zoom = p.z; render(); }
  },
  ptzNudge(dir) {
    const cam = currentCam(); if (!cam) return;
    const s = cam.state; s.presetId = null;
    if (dir === 'up') s.y = Math.max(-24, s.y - 6);
    if (dir === 'down') s.y = Math.min(24, s.y + 6);
    if (dir === 'left') s.x = Math.max(-40, s.x - 8);
    if (dir === 'right') s.x = Math.min(40, s.x + 8);
    render();
  },
  ptzHome() { const cam = currentCam(); if (cam) { cam.state.x = 0; cam.state.y = 0; cam.state.presetId = null; render(); } },
  ptzZoom(dir) {
    const cam = currentCam(); if (!cam) return;
    const s = cam.state; s.presetId = null;
    s.zoom = dir === 'in' ? Math.min(3.2, +(s.zoom + .3).toFixed(1)) : Math.max(1, +(s.zoom - .3).toFixed(1));
    render();
  },
  togglePtzRec() {
    const cam = currentCam(); if (!cam) return;
    cam.state.rec = !cam.state.rec;
    sendPtzCommand(ui.locationId, cam.id, cam.state.rec ? 'send_to_screens' : 'stop', {});
    render();
  },

  back() { goBack(); }
};

function currentCam() {
  const rec = getLocation(ui.locationId);
  return rec && rec.location.ptzCams.find(c => c.id === ui.camId);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset.arg);
});

// ---- piezas reutilizables -------------------------------------------------

function tabbar() {
  return `<div class="tabbar">
    <button class="tab ${ui.route === 'home' ? 'active' : ''}" ${A('goTab', 'home')}><div class="ico"></div><span>Pantallas</span></button>
    <button class="tab ${ui.route === 'clients' ? 'active' : ''}" ${A('goTab', 'clients')}><div class="ico"></div><span>Clientes</span></button>
  </div>`;
}

function toast() {
  if (!ui.toast) return '';
  return `<div style="position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#1b1d22;border:1px solid var(--line);color:#fff;padding:10px 16px;border-radius:12px;font:600 12.5px var(--sans);z-index:30;box-shadow:0 6px 20px rgba(0,0,0,.35)">${esc(ui.toast)}</div>`;
}

// ---- Vista: Pantallas (home) ---------------------------------------------

function viewHome() {
  const agency = getAgency(ui.agencyId);
  const clients = getClients(ui.agencyId);
  const totalScreens = clients.reduce((n, c) => n + c.locations.reduce((m, l) => m + l.screens.length, 0), 0);
  const mine = getScreensForAgency(ui.agencyId);
  const filtered = ui.filter === 'issues' ? mine.filter(s => s.status !== 'on') : mine;
  const onCount = mine.filter(s => s.status === 'on').length;
  const issueCount = mine.filter(s => s.status !== 'on').length;

  return `<div class="screen">
    <div class="content" style="padding-top:14px">
      <div class="row row-tap card" style="padding:11px 13px;margin-bottom:18px" ${A('toggleAgencySheet')}>
        <div style="width:34px;height:34px;border-radius:10px;background:${agency.color};color:${agency.ink};display:flex;align-items:center;justify-content:center;font:700 13px var(--sans);flex:none">${agency.initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font:600 13.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${agency.name}</div>
          <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${totalScreens} pantallas · ${clients.length} clientes</div>
        </div>
        <div style="color:var(--ink-faint);font:400 12px var(--sans)">▾</div>
      </div>

      <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:15px">
        <div style="font:700 25px var(--sans);letter-spacing:-.02em">Pantallas</div>
        <div style="font:400 11px var(--mono);color:var(--ink-dim)">${onCount} emitiendo · ${issueCount} con aviso</div>
      </div>

      <div class="row" style="gap:8px;margin-bottom:16px">
        <div class="pill" style="background:${ui.filter === 'all' ? 'var(--accent)' : 'var(--card-2)'};color:${ui.filter === 'all' ? '#fff' : 'var(--ink)'}" ${A('setFilter', 'all')}>Todas · ${mine.length}</div>
        <div class="pill" style="background:${ui.filter === 'issues' ? 'var(--accent)' : 'var(--card-2)'};color:${ui.filter === 'issues' ? '#fff' : 'var(--ink)'}" ${A('setFilter', 'issues')}>Avisos · ${issueCount}</div>
      </div>

      <div class="grid-2">
        ${filtered.map(screenCard).join('')}
      </div>
      ${filtered.length === 0 ? `<div style="padding:40px 0;text-align:center;color:var(--ink-faint);font:400 12.5px var(--sans)">Ninguna pantalla en este filtro.</div>` : ''}
    </div>
    ${tabbar()}
    ${ui.agencySheetOpen ? agencySheet() : ''}
    ${ui.detailScreenId != null ? detailSheet() : ''}
    ${toast()}
  </div>`;
}

function screenCard(s) {
  return `<div class="card row-tap" style="overflow:hidden" ${A('openDetail', s.id)}>
    <div class="thumb">
      <span>${esc(s.locationName)} · ${esc(s.name)}</span>
      ${s.status === 'off' ? `<div style="position:absolute;inset:0;background:rgba(14,15,18,.74);display:flex;align-items:center;justify-content:center;font:600 10px var(--mono);color:var(--red);letter-spacing:.08em">SIN SEÑAL</div>` : ''}
    </div>
    <div style="padding:10px 11px 12px">
      <div class="row" style="gap:6px;margin-bottom:4px">
        <div class="dot dot-sm" style="background:${STATUS_COLOR[s.status]}"></div>
        <div style="font:600 12.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</div>
      </div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.content)}</div>
    </div>
  </div>`;
}

function agencySheet() {
  return `<div class="backdrop" ${A('toggleAgencySheet')}></div>
  <div class="sheet">
    <div class="sheet-grip"></div>
    <div class="eyebrow">Cambiar de agencia</div>
    <div class="stack">
      ${getAgencies().map(a => `<div class="row row-tap card-flat" style="padding:12px 13px;border:1px solid ${a.id === ui.agencyId ? 'rgba(47,123,246,.35)' : 'transparent'}" ${A('pickAgency', a.id)}>
        <div style="width:32px;height:32px;border-radius:9px;background:${a.color};color:${a.ink};display:flex;align-items:center;justify-content:center;font:700 12px var(--sans);flex:none">${a.initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font:600 13px var(--sans)">${esc(a.name)}</div>
          <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${getClients(a.id).length} clientes</div>
        </div>
        ${a.id === ui.agencyId ? `<div style="color:var(--accent);font:600 14px var(--sans)">✓</div>` : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

function detailSheet() {
  const found = findScreen(ui.detailScreenId);
  if (!found) return '';
  const { screen, location, client } = found;
  const src = SOURCE_TYPES.find(s => s.id === screen.source) || SOURCE_TYPES[0];
  return `<div class="backdrop" ${A('closeDetail')}></div>
  <div class="sheet" style="max-height:88vh">
    <div class="sheet-grip"></div>
    <div class="row" style="gap:8px;margin-bottom:3px">
      <div class="dot" style="background:${STATUS_COLOR[screen.status]}"></div>
      <div style="font:700 20px var(--sans);letter-spacing:-.01em">${esc(screen.name)}</div>
    </div>
    <div style="font:400 11px var(--mono);color:var(--ink-dimmer);margin-bottom:14px">${esc(client.name)} · ${esc(location.name)} · ${STATUS_LABEL[screen.status]}</div>
    <div class="thumb" style="margin-bottom:14px"><span>captura en vivo · hace 12 s</span></div>
    <div style="display:flex;gap:9px;margin-bottom:16px">
      <div class="btn btn-primary" style="flex:1;padding:12px 0;font-size:13px" ${A('openSource', screen.id)}>Cambiar fuente</div>
    </div>
    <div class="eyebrow">Fuente actual</div>
    <div class="row card-flat" style="padding:11px 13px">
      <div style="flex:1;min-width:0">
        <div style="font:600 12.5px var(--sans)">${esc(src.label)}</div>
        <div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${esc(src.sub)}</div>
      </div>
      <div class="tag" style="background:rgba(255,255,255,.07);color:var(--ink-dim)">${esc(src.tag)}</div>
    </div>
  </div>`;
}

// ---- Vista: Clientes (tenants) -------------------------------------------

function viewClients() {
  const agency = getAgency(ui.agencyId);
  const clients = getClients(ui.agencyId);
  if (!ui.clientId || !clients.find(c => c.id === ui.clientId)) ui.clientId = clients[0] && clients[0].id;
  const cl = getClient(ui.clientId);
  if (!cl) return `<div class="screen"><div class="content"><div class="topbar"><div class="title">Sin clientes</div></div></div>${tabbar()}</div>`;

  const { usedLoc, usedScr, unlimited } = usageForClient(cl);
  const pct = unlimited ? 42 : Math.min(100, Math.round(usedLoc / cl.locLimit * 100));
  const nearCap = !unlimited && usedLoc / cl.locLimit >= 0.75;
  const showUpsell = nearCap || (!unlimited && usedLoc >= cl.locLimit);

  return `<div class="screen">
    <div class="content" style="padding-top:14px">
      <div class="eyebrow">Clientes de ${esc(agency.name)}</div>
      <div class="row" style="gap:8px;margin-bottom:20px">
        ${clients.map(c => `<div class="row-tap" style="flex:1;padding:10px 10px 11px;border-radius:12px;background:${c.id === cl.id ? c.accent : 'var(--card-2)'};color:${c.id === cl.id ? c.accentInk : 'var(--ink)'};border:1px solid ${c.id === cl.id ? c.accent : 'var(--line)'}" ${A('pickClient', c.id)}>
          <div style="font:700 12px var(--sans);margin-bottom:3px">${esc(c.initials)}</div>
          <div style="font:500 9.5px var(--mono);opacity:.75">${esc(c.plan)}</div>
        </div>`).join('')}
      </div>

      <div class="row" style="align-items:flex-start;gap:12px;margin-bottom:16px">
        <div style="width:44px;height:44px;border-radius:13px;flex:none;display:flex;align-items:center;justify-content:center;font:700 15px var(--sans);background:${cl.accent};color:${cl.accentInk}">${esc(cl.initials)}</div>
        <div style="flex:1;min-width:0;padding-top:2px">
          <div style="font:700 20px var(--sans);letter-spacing:-.02em">${esc(cl.name)}</div>
          <div style="margin-top:4px;font:400 11px var(--mono);color:var(--ink-dimmer)">Plan ${esc(cl.plan)}</div>
        </div>
      </div>

      <div class="card" style="padding:14px 15px;margin-bottom:20px">
        <div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:9px">
          <div style="font:600 12.5px var(--sans)">${unlimited ? `${usedLoc} ubicaciones · sin límite` : `${usedLoc} de ${cl.locLimit} ubicaciones`}</div>
          <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${unlimited ? `${usedScr} pantallas · sin límite` : `${usedScr} de ${cl.scrLimit} pantallas`}</div>
        </div>
        <div class="progress-track" style="margin-bottom:10px"><div class="progress-fill" style="width:${pct}%;background:${nearCap ? 'var(--amber)' : cl.accent}"></div></div>
        <div style="font:400 10.5px/1.5 var(--mono);color:var(--ink-dim)">${unlimited ? 'Plan Enterprise · ubicaciones y pantallas ilimitadas' : nearCap ? `Te quedan ${cl.locLimit - usedLoc} ubicaciones en el plan ${cl.plan}.` : `Plan ${cl.plan} · puedes añadir ${cl.locLimit - usedLoc} ubicaciones más.`}</div>
        ${showUpsell ? `<div class="row" style="margin-top:12px;padding:10px 12px;border-radius:11px;background:rgba(240,180,41,.09);border:1px solid rgba(240,180,41,.25)">
          <div style="font:400 11px/1.4 var(--sans);color:#d3b271;flex:1">Amplía el plan para seguir añadiendo ubicaciones.</div>
          <div class="tag" style="background:var(--amber);color:#1a1204;padding:7px 12px;font:600 11px var(--sans)">Mejorar</div>
        </div>` : ''}
      </div>

      <div class="eyebrow">Ubicaciones</div>
      <div class="stack">
        ${cl.locations.map(l => locationRow(l)).join('')}
        <div style="padding:13px 0;text-align:center;border-radius:13px;border:1px dashed var(--line);color:var(--ink-dim);font:600 12px var(--sans)">+ Añadir ubicación</div>
      </div>
    </div>
    ${tabbar()}
    ${toast()}
  </div>`;
}

function locationRow(l) {
  const open = ui.locOpen === l.id;
  const on = l.screens.filter(s => s.status === 'on').length;
  const off = l.screens.filter(s => s.status === 'off').length;
  const dots = l.screens.map(s => `<div style="width:5px;height:16px;border-radius:2px;background:${s.status === 'on' ? 'var(--green)' : s.status === 'off' ? 'var(--red)' : 'rgba(255,255,255,.16)'}"></div>`).join('');
  const srvOnline = l.localServer.status === 'online';
  return `<div class="card" style="overflow:hidden">
    <div class="row row-tap" style="padding:13px 14px" ${A('toggleLoc', l.id)}>
      <div style="flex:1;min-width:0">
        <div style="font:600 13px var(--sans);margin-bottom:3px">${esc(l.name)}</div>
        <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer)">${esc(l.city)} · ${l.screens.length} pantallas</div>
      </div>
      <div class="row" style="gap:3px;flex:none">${dots}</div>
      <div style="color:var(--ink-faint);font:400 12px var(--sans);flex:none">${open ? '▴' : '▾'}</div>
    </div>
    ${l.note ? `<div style="padding:0 14px 11px;margin-top:-4px;font:400 10.5px var(--mono);color:var(--red)">⚠ ${esc(l.note)}</div>` : ''}
    ${open ? `<div style="padding:0 14px 14px">
      <div class="row" style="padding:9px 0;border-top:1px solid var(--line-soft);margin-bottom:2px">
        <div class="dot dot-sm" style="background:${srvOnline ? 'var(--green)' : 'var(--red)'}"></div>
        <div style="flex:1;min-width:0;font:400 10.5px var(--mono);color:var(--ink-dimmer)">Servidor local ${srvOnline ? 'en línea' : 'sin conexión'} · ${esc(l.localServer.ip)} · ${esc(l.localServer.lastSeen)}${l.localServer.device ? ' · ' + esc(l.localServer.device) : ''}</div>
      </div>
      ${l.screens.map(s => `<div class="row row-tap" style="padding:9px 0;border-top:1px solid var(--line-soft)" ${A('openSource', s.id)}>
        <div style="width:3px;height:22px;border-radius:2px;flex:none;background:${STATUS_COLOR[s.status]}"></div>
        <div style="flex:1;min-width:0">
          <div style="font:500 12px var(--sans)">${esc(s.name)}</div>
          <div style="font:400 10px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.content)}</div>
        </div>
        <div style="color:var(--ink-faint);font:400 13px var(--sans);flex:none">›</div>
      </div>`).join('')}
      <div class="row" style="gap:8px;margin-top:11px">
        ${l.encoders.length ? `<div class="pill" style="background:var(--card-2);flex:1;text-align:center" ${A('openEncoders', l.id)}>Capturadoras · ${l.encoders.length}</div>` : ''}
        ${l.ptzCams.length ? `<div class="pill" style="background:var(--card-2);flex:1;text-align:center" ${A('openPtz', l.id)}>Cámaras PTZ · ${l.ptzCams.length}</div>` : ''}
      </div>
    </div>` : ''}
  </div>`;
}

// ---- Vista: Fuente (3a) ----------------------------------------------------

function viewSource() {
  const found = findScreen(ui.screenId);
  if (!found) { goBack(); return ''; }
  const { screen, location, client } = found;
  const isLive = screen.source === 'live' || screen.source === 'split';
  const isPtz = screen.source === 'ptz';
  const src = SOURCE_TYPES.find(s => s.id === screen.source);
  const hint = {
    menu: 'La carta se actualiza sola a las 12:00 y a las 19:30.',
    live: 'La pantalla emite lo que entre por la capturadora SDI/HDMI del local. Latencia ~2 s.',
    loop: 'Se repite en bucle hasta que cambies la fuente.',
    split: 'Carta a pantalla completa con la señal en directo en recuadro inferior.',
    ptz: 'La pantalla muestra la cámara PTZ en directo, controlable desde esta app.'
  }[screen.source];

  return `<div class="screen">
    <div class="topbar">
      <div class="back" ${A('back')}>‹</div>
      <div class="crumb">${esc(client.name)} · ${esc(location.name)}</div>
    </div>
    <div class="content">
      <div class="row" style="gap:8px;margin-bottom:3px">
        <div class="dot pulse" style="background:${STATUS_COLOR[screen.status]}"></div>
        <div style="font:700 21px var(--sans);letter-spacing:-.015em">${esc(screen.name)}</div>
      </div>
      <div style="font:400 11px var(--mono);color:var(--ink-dimmer);margin-bottom:16px">${STATUS_LABEL[screen.status]}</div>

      <div class="thumb" style="margin-bottom:9px">
        <span>${esc(src.label)}</span>
        ${isLive || isPtz ? `<div class="badge-live"><div class="dot dot-sm pulse" style="background:var(--red)"></div><span>${screen.source === 'split' ? 'MIXTA' : 'EN DIRECTO'}</span></div>` : ''}
      </div>
      <div style="font:400 10.5px/1.55 var(--mono);color:var(--ink-dim);margin-bottom:20px">${hint}</div>

      <div class="eyebrow">Fuente</div>
      <div class="stack" style="margin-bottom:16px">
        ${SOURCE_TYPES.map(s => {
          const on = s.id === screen.source;
          const disabled = s.id === 'ptz' && location.ptzCams.length === 0;
          const disabledLive = (s.id === 'live' || s.id === 'split') && location.encoders.length === 0;
          const isDisabled = disabled || disabledLive;
          return `<div class="row card-flat ${isDisabled ? '' : 'row-tap'}" style="padding:13px 14px;opacity:${isDisabled ? .45 : 1};background:${on ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${on ? 'var(--accent)' : 'var(--line)'}" ${isDisabled ? '' : A('pickSource', s.id)}>
            <div style="width:17px;height:17px;border-radius:50%;flex:none;border:1.5px solid ${on ? 'var(--accent)' : 'rgba(255,255,255,.22)'};display:flex;align-items:center;justify-content:center">
              <div style="width:8px;height:8px;border-radius:50%;background:${on ? 'var(--accent)' : 'transparent'}"></div>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font:600 13px var(--sans);margin-bottom:2px">${esc(s.label)}</div>
              <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isDisabled ? 'No disponible en este local' : esc(s.sub)}</div>
            </div>
            <div class="tag" style="background:${s.id === 'live' || s.id === 'ptz' ? 'rgba(242,99,90,.14)' : 'rgba(255,255,255,.07)'};color:${s.id === 'live' || s.id === 'ptz' ? 'var(--red)' : 'var(--ink-dim)'}">${esc(s.tag)}</div>
          </div>`;
        }).join('')}
      </div>

      ${isLive ? `<div class="btn btn-ghost" style="margin-bottom:10px" ${A('openMixer')}>Configurar mezcla →</div>` : ''}
      ${isPtz ? `<div class="btn btn-ghost" style="margin-bottom:10px" ${A('openPtz', location.id)}>Abrir control PTZ →</div>` : ''}
    </div>
    <div class="sticky-cta"><div class="btn btn-primary" ${A('applySource')}>Aplicar a esta pantalla</div></div>
    ${toast()}
  </div>`;
}

// ---- Vista: Mezclador (3b) -------------------------------------------------

function viewMixer() {
  const found = findScreen(ui.screenId);
  if (!found || !found.screen.mixer) { goBack(); return ''; }
  const { screen, location, client } = found;
  const mx = screen.mixer;
  const layout = MIX_LAYOUTS.find(l => l.id === mx.layout);
  const enc = location.encoders[0];

  const overlay = ({
    lower: `<div style="position:absolute;left:0;right:0;bottom:0;height:32px;background:rgba(47,123,246,.9);display:flex;align-items:center;padding:0 12px;font:600 10.5px var(--sans);color:#fff">${PROMOS.find(p => p.id === mx.promo).title}</div>`,
    corner: `<div style="position:absolute;right:11px;bottom:11px;padding:8px 12px;border-radius:8px;background:rgba(47,123,246,.92);font:700 10px var(--sans);color:#fff">${esc(client.name).toUpperCase()}</div>`,
    side: `<div style="position:absolute;right:0;top:0;bottom:0;width:30%;background:var(--accent);padding:12px">
      <div style="font:700 10px var(--sans);color:#fff;margin-bottom:7px">TAPAS</div>
      <div style="display:flex;flex-direction:column;gap:5px"><div style="height:5px;border-radius:2px;background:rgba(255,255,255,.32)"></div><div style="height:5px;border-radius:2px;background:rgba(255,255,255,.32);width:78%"></div></div>
    </div>`,
    full: `<div style="position:absolute;inset:0;background:var(--accent);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
      <div style="font:700 17px var(--sans);color:#fff">${PROMOS.find(p => p.id === mx.promo).title.toUpperCase()}</div>
      <div style="font:600 10px var(--mono);color:rgba(255,255,255,.7)">vuelve a la señal en 10 s</div>
    </div>`
  })[mx.layout];

  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('back')}>‹</div><div class="crumb">${esc(screen.name)}</div></div>
    <div class="content">
      <div style="font:700 21px/1.15 var(--sans);letter-spacing:-.02em;margin-bottom:3px">Mezclar sobre la señal</div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);margin-bottom:12px">${enc ? esc(enc.name) + ' · ' + esc(enc.input) : 'Sin capturadora'}</div>

      <div class="thumb" style="margin-bottom:8px">
        <span>señal en directo</span>
        <div class="badge-live"><div class="dot dot-sm pulse" style="background:var(--red)"></div><span>EN DIRECTO</span></div>
        ${overlay}
      </div>
      <div style="font:400 10.5px/1.45 var(--mono);color:var(--ink-dim);margin-bottom:11px;min-height:30px">${layout.note}</div>

      <div class="eyebrow">Composición</div>
      <div class="grid-2" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
        ${MIX_LAYOUTS.map(l => `<div class="row-tap" style="text-align:center;padding:9px 4px;border-radius:10px;background:${mx.layout === l.id ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${mx.layout === l.id ? 'var(--accent)' : 'var(--line)'}" ${A('pickLayout', l.id)}>
          <div style="font:600 10.5px var(--sans);color:${mx.layout === l.id ? 'var(--ink)' : 'var(--ink-dim)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.label.split(' ')[0]}</div>
        </div>`).join('')}
      </div>

      <div class="eyebrow">Qué se superpone</div>
      <div class="stack" style="margin-bottom:12px">
        ${PROMOS.map(p => {
          const on = mx.promo === p.id;
          return `<div class="row row-tap card-flat" style="padding:8px 13px;background:${on ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${on ? 'var(--accent)' : 'var(--line)'}" ${A('pickPromo', p.id)}>
            <div style="width:19px;height:19px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;font:700 10px var(--sans);color:#fff;background:${on ? 'var(--accent)' : 'transparent'};border:1.5px solid ${on ? 'var(--accent)' : 'rgba(255,255,255,.22)'}">${on ? '✓' : ''}</div>
            <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans)">${esc(p.title)}</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${esc(p.meta)}</div></div>
          </div>`;
        }).join('')}
      </div>

      <div class="row row-tap card-flat" style="padding:11px 14px" ${A('toggleMute')}>
        <div style="flex:1;min-width:0"><div style="font:600 12.5px var(--sans);margin-bottom:2px">Audio de la señal</div><div style="font:400 10px var(--mono);color:var(--ink-dimmer)">${mx.muted ? 'Silenciada' : 'Con sonido'}</div></div>
        <div class="toggle" style="background:${mx.muted ? 'rgba(255,255,255,.09)' : 'var(--accent)'}"><div class="knob" style="left:${mx.muted ? '3px' : '21px'}"></div></div>
      </div>
    </div>
    <div class="sticky-cta"><div class="btn btn-primary" ${A('applyMix')}>Emitir mezcla</div></div>
    ${toast()}
  </div>`;
}

// ---- Vista: Encoders / capturadoras (3c) -----------------------------------

function viewEncoders() {
  const rec = getLocation(ui.locationId);
  if (!rec) { goBack(); return ''; }
  const { location, client } = rec;
  const enc = location.encoders.find(e => e.id === ui.encOpen) || location.encoders[0];

  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('back')}>‹</div></div>
    <div class="content">
      <div style="font:700 25px/1.1 var(--sans);letter-spacing:-.02em;margin-bottom:4px">Entradas SDI/HDMI</div>
      <div style="font:400 11px var(--mono);color:var(--ink-dimmer);margin-bottom:18px">${esc(client.name)} · ${esc(location.name)} · ${location.encoders.length} capturadoras</div>

      ${enc ? `<div class="card" style="padding:16px;margin-bottom:20px">
        <div class="row" style="margin-bottom:12px">
          <div class="dot" style="background:${ENC_COLOR[enc.status]}"></div>
          <div style="font:600 15px var(--sans);flex:1;min-width:0">${esc(enc.name)}</div>
          <div style="font:600 9.5px var(--mono);letter-spacing:.07em;flex:none;color:${ENC_COLOR[enc.status]}">${ENC_LABEL[enc.status]}</div>
        </div>
        <div class="thumb" style="margin-bottom:13px">
          ${enc.status === 'error' ? `<span style="color:var(--amber);font:600 11px var(--mono);letter-spacing:.06em">SIN ENTRADA</span>` : `<span>previsualización de la señal</span>`}
        </div>
        <div class="row" style="gap:9px;margin-bottom:13px">
          <div class="card-flat" style="flex:1;padding:10px 11px"><div style="font:400 9px var(--mono);color:var(--ink-dimmer);letter-spacing:.06em;margin-bottom:4px">ENTRADA</div><div style="font:500 11px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(enc.input)}</div></div>
          <div class="card-flat" style="flex:0 1 76px;padding:10px 11px"><div style="font:400 9px var(--mono);color:var(--ink-dimmer);letter-spacing:.06em;margin-bottom:4px">SEÑAL</div><div style="font:600 11px var(--sans)">${esc(enc.res)}</div></div>
          <div class="card-flat" style="flex:0 1 84px;padding:10px 11px"><div style="font:400 9px var(--mono);color:var(--ink-dimmer);letter-spacing:.06em;margin-bottom:4px">BITRATE</div><div style="font:600 11px var(--sans)">${esc(enc.bitrate)}</div></div>
        </div>
        <div style="font:400 10.5px/1.55 var(--mono);color:var(--ink-dim)">${
          enc.status === 'live' ? 'Recibiendo señal estable desde hace 4 h 12 m.'
          : enc.status === 'idle' ? 'Capturadora en línea pero sin señal en la entrada. Enchufa la fuente.'
          : 'No se detecta cable. Revisa la conexión física en el local.'
        }</div>
      </div>` : `<div style="padding:30px 0;text-align:center;color:var(--ink-faint)">Sin capturadoras en esta ubicación.</div>`}

      ${location.encoders.length ? `<div class="eyebrow">Todas las capturadoras</div>
      <div class="stack">
        ${location.encoders.map(e => `<div class="row row-tap card-flat" style="padding:13px 14px;border:1.5px solid ${e.id === ui.encOpen ? 'rgba(47,123,246,.45)' : 'transparent'}" ${A('pickEncoder', e.id)}>
          <div class="dot" style="background:${ENC_COLOR[e.status]}"></div>
          <div style="flex:1;min-width:0"><div style="font:600 13px var(--sans);margin-bottom:2px">${esc(e.name)}</div><div style="font:400 10.5px var(--mono);color:var(--ink-dimmer);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.input)} · ${e.screens === 1 ? '1 pantalla' : e.screens + ' pantallas'}</div></div>
          <div class="tag" style="background:rgba(255,255,255,.06);color:${ENC_COLOR[e.status]}">${ENC_LABEL[e.status]}</div>
        </div>`).join('')}
      </div>` : ''}
    </div>
    ${toast()}
  </div>`;
}

// ---- Vista: PTZ (4a) --------------------------------------------------------

function viewPtz() {
  const rec = getLocation(ui.locationId);
  if (!rec) { goBack(); return ''; }
  const { location, client } = rec;
  const cam = currentCam();
  if (!cam) { goBack(); return ''; }
  const s = cam.state;
  const zoomPct = Math.round((s.zoom - 1) / 2.2 * 100);
  const panLabel = (s.x === 0 && s.y === 0) ? 'centrada' : `pan ${s.x > 0 ? '+' : ''}${s.x}° · tilt ${s.y > 0 ? '+' : ''}${s.y}°`;
  const frameW = Math.round(100 / s.zoom) + '%';

  return `<div class="screen">
    <div class="topbar"><div class="back" ${A('back')}>‹ Fuentes</div></div>
    <div class="content">
      <div class="row" style="gap:8px;margin-bottom:3px">
        <div class="dot pulse" style="background:var(--red)"></div>
        <div style="font:700 21px var(--sans);letter-spacing:-.02em">${esc(cam.name)}</div>
      </div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-faint);margin-bottom:2px">${cam.protocol === 'onvif' ? `ONVIF ${cam.onvif.profile} · ${esc(cam.onvif.xAddr)}` : 'VISCA-over-IP'}</div>
      <div style="font:400 10px var(--mono);color:var(--ink-faint);margin-bottom:12px">stream RTSP · ${esc(cam.rtsp)}</div>

      <div style="position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:repeating-linear-gradient(135deg,#242830 0 7px,#1c1f25 7px 14px);margin-bottom:7px">
        ${cam.go2rtc && cam.go2rtc.host
          ? `<iframe title="stream" src="http://${esc(cam.go2rtc.host)}/stream.html?src=${encodeURIComponent(cam.go2rtc.streamId)}&mode=webrtc,mse" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="autoplay"></iframe>`
          : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:500 10px var(--mono);color:var(--ink-faint)">señal PTZ en directo · configura go2rtc en data.js</div>`}
        <div style="position:absolute;top:50%;left:50%;width:${frameW};height:${frameW};border:1.5px solid rgba(47,123,246,.85);border-radius:6px;box-shadow:0 0 0 9999px rgba(14,15,18,.45);transform:translate(-50%,-50%) translate(${s.x}px,${s.y}px);transition:all .22s ease;pointer-events:none"></div>
        <div class="badge-live"><div class="dot dot-sm pulse" style="background:var(--red)"></div><span>EN DIRECTO</span></div>
        <div style="position:absolute;bottom:11px;right:11px;padding:4px 9px;border-radius:6px;background:rgba(14,15,18,.84);font:600 9.5px var(--mono);color:#c4c9cf">${s.zoom.toFixed(1)}×</div>
      </div>
      <div style="font:400 10.5px var(--mono);color:var(--ink-dim);margin-bottom:11px">${panLabel}</div>

      <div class="eyebrow">Encuadres guardados</div>
      <div class="grid-2" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
        ${PTZ_PRESETS.map(p => `<div class="row-tap" style="text-align:center;padding:9px 4px;border-radius:10px;background:${s.presetId === p.id ? 'rgba(47,123,246,.12)' : 'var(--card-2)'};border:1.5px solid ${s.presetId === p.id ? 'var(--accent)' : 'var(--line)'}" ${A('ptzPreset', p.id)}>
          <div style="font:600 10.5px var(--sans);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label)}</div>
        </div>`).join('')}
      </div>

      <div class="row" style="gap:14px;align-items:center;margin-bottom:12px">
        <div style="display:grid;grid-template-columns:repeat(3,40px);grid-template-rows:repeat(3,40px);gap:5px;flex:none">
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'up')}>▲</div>
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'left')}>◀</div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:10px;background:#1b1d22;border:1px solid rgba(255,255,255,.12);font:600 9px var(--mono);color:var(--ink-dim)" ${A('ptzHome')}>HOME</div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'right')}>▶</div>
          <div></div>
          <div class="row-tap" style="display:flex;align-items:center;justify-content:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line)" ${A('ptzNudge', 'down')}>▼</div>
          <div></div>
        </div>
        <div style="flex:1;min-width:0">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><span style="font:600 10.5px var(--mono);color:var(--ink-dimmer);letter-spacing:.08em">ZOOM</span><span style="font:600 11px var(--sans)">${s.zoom.toFixed(1)}×</span></div>
          <div class="progress-track" style="margin-bottom:10px"><div class="progress-fill" style="width:${zoomPct}%;background:var(--accent)"></div></div>
          <div class="row" style="gap:8px">
            <div class="row-tap" style="flex:1;padding:11px 0;text-align:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line);font:600 14px var(--sans)" ${A('ptzZoom', 'out')}>−</div>
            <div class="row-tap" style="flex:1;padding:11px 0;text-align:center;border-radius:10px;background:var(--card-2);border:1px solid var(--line);font:600 14px var(--sans)" ${A('ptzZoom', 'in')}>+</div>
          </div>
        </div>
      </div>

      <div class="eyebrow">Cámaras del local</div>
      <div class="row" style="gap:7px;overflow-x:auto">
        ${location.ptzCams.map(c => `<div class="row-tap" style="display:flex;align-items:center;gap:7px;padding:9px 11px;border-radius:11px;white-space:nowrap;background:var(--card-2);border:1.5px solid ${c.id === cam.id ? 'rgba(47,123,246,.45)' : 'var(--line)'}" ${A('pickCam', c.id)}>
          <div class="dot dot-sm" style="background:${c.status === 'live' ? 'var(--red)' : 'var(--ink-faint)'}"></div>
          <span style="font:600 11.5px var(--sans)">${esc(c.name.replace('PTZ ', ''))}</span>
        </div>`).join('')}
      </div>
    </div>
    <div class="sticky-cta"><div class="btn ${s.rec ? '' : 'btn-primary'}" style="${s.rec ? 'background:rgba(242,99,90,.14);color:var(--red);border:1.5px solid rgba(242,99,90,.4)' : ''}" ${A('togglePtzRec')}>${s.rec ? 'Emitiendo en las pantallas' : 'Enviar a las pantallas'}</div></div>
    ${toast()}
  </div>`;
}

// ---- Render principal -------------------------------------------------------

function render() {
  const clients = getClients(ui.agencyId);
  if (!ui.clientId || !clients.find(c => c.id === ui.clientId)) ui.clientId = clients[0] && clients[0].id;

  let html;
  switch (ui.route) {
    case 'clients': html = viewClients(); break;
    case 'source': html = viewSource(); break;
    case 'mixer': html = viewMixer(); break;
    case 'encoders': html = viewEncoders(); break;
    case 'ptz': html = viewPtz(); break;
    default: html = viewHome();
  }
  document.getElementById('app').innerHTML = html;
}

render();
