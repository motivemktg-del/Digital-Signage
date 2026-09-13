// data.js — cliente de la API real de venuepro-signage (server.js/agency.js).
// Nada de datos mock: esto llama a los endpoints reales por fetch(), con
// cookie de sesión (same-origin, por eso credentials:'same-origin').
// Pensado para servirse DESDE el mismo Express que expone /api/* (o sea,
// reemplaza los archivos de public/ en el VPS — no un dominio aparte).

async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers } };
  if (body !== undefined && !raw) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (raw) {
    opts.body = body; // Blob/File — headers ya vienen con content-type/x-file-name puestos
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* respuestas sin cuerpo (204, etc.) */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- sesión -----------------------------------------------------------

function login(email, password) { return api('/api/login', { method: 'POST', body: { email, password } }); }
function logout() { return api('/api/logout', { method: 'POST' }); }

// GET /api/state trae TODO lo del tenant de una — es la base de casi
// cualquier vista. Lanza 401 si no hay sesión (lo maneja quien llame).
function getState() { return api('/api/state'); }

// ---- ubicaciones y pantallas -------------------------------------------

function createLocation(name) { return api('/api/locations', { method: 'POST', body: { name } }); }
function setDeviceLocation(id, location) { return api(`/api/devices/${id}/location`, { method: 'POST', body: { location } }); }
function setDeviceDisplay(id, { orientation, rotation, fit }) { return api(`/api/devices/${id}/display`, { method: 'POST', body: { orientation, rotation, fit } }); }
function setDevicePlayback(id, paused) { return api(`/api/devices/${id}/playback`, { method: 'POST', body: { paused } }); }
function syncDevice(id) { return api(`/api/devices/${id}/sync`, { method: 'POST' }); }
function assignPlaylist(deviceId, playlist) { return api(`/api/devices/${deviceId}/assign`, { method: 'POST', body: { playlist } }); }
function publishContent(deviceId, payload) { return api(`/api/devices/${deviceId}/content`, { method: 'POST', body: { ...payload, confirm: true } }); }
function revokeDevice(id) { return api(`/api/devices/${id}`, { method: 'DELETE' }); }

// ---- emparejar pantalla nueva -------------------------------------------

function pairStart() { return api('/api/pair/start', { method: 'POST' }); }
function pairClaim(code, name, location) { return api('/api/pair/claim', { method: 'POST', body: { code, name, location } }); }

// ---- multimedia -----------------------------------------------------------

// El backend real NO usa multipart — espera el archivo crudo en el body,
// con el nombre en la cabecera x-file-name (codificado) y Content-Type
// igual al mime del archivo. Solo admite jpg/png/webp/mp4 (server.js).
function uploadAsset(file) {
  return api('/api/assets', {
    method: 'POST', raw: true, body: file,
    headers: { 'Content-Type': file.type, 'x-file-name': encodeURIComponent(file.name) }
  });
}
function renameAsset(id, name) { return api(`/api/assets/${id}`, { method: 'PATCH', body: { name } }); }
function archiveAsset(id) { return api(`/api/assets/${id}`, { method: 'DELETE' }); }
function assetMediaUrl(id) { return `/api/assets/${id}/media`; } // <img>/<video> same-origin, manda cookie sola

// ---- listas de reproducción -----------------------------------------------

function savePlaylist(playlist) { return api('/api/playlists', { method: 'POST', body: playlist }); } // {id?,name,items:[{asset,seconds}]}
function addAssetToPlaylist(playlistId, asset) { return api(`/api/playlists/${playlistId}/assets`, { method: 'POST', body: { asset } }); }
function deletePlaylist(id) { return api(`/api/playlists/${id}`, { method: 'DELETE' }); }

// ---- horarios ---------------------------------------------------------------

function saveSchedule(schedule) { return api('/api/schedules', { method: 'POST', body: schedule }); }
function deleteSchedule(id) { return api(`/api/schedules/${id}`, { method: 'DELETE' }); }

// ---- equipo (usuarios del tenant) -------------------------------------------

function listUsers() { return api('/api/users'); }
function createUser(email, password, role) { return api('/api/users', { method: 'POST', body: { email, password, role } }); }
function deleteUser(email) { return api(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE' }); }

// ---- helpers de presentación (no llaman a la API) --------------------------

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function deviceStatus(d) {
  if (d.error) return 'error';
  if (!d.seen) return 'idle';
  return (Date.now() - d.seen < 3 * 60000) ? 'on' : 'off'; // sin heartbeat en 3 min = caída
}
const STATUS_COLOR = { on: '#2f7bf6', off: '#f2635a', idle: '#8a9098', error: '#f0b429' };
const STATUS_LABEL = { on: 'en línea', off: 'sin conexión', idle: 'sin emparejar del todo', error: 'con error' };
