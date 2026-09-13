// data.js — capa de datos.
//
// Todo esto es un "mock" en memoria por ahora (front-end solo, sin backend
// real todavía). El modelo sí está pensado ya para lo real:
//
//   Agencia            tenant de la plataforma (una empresa que gestiona
//                       pantallas de sus propios clientes)
//     └─ Tenant/Cliente  el negocio final (ej. un restaurante, una cadena)
//          └─ Ubicación   un local físico de ese cliente. TIENE SU PROPIO
//                         SERVIDOR LOCAL — es el que habla con las
//                         capturadoras (SDI/HDMI) y las cámaras PTZ (RTSP)
//                         en la red del local, y el único punto que
//                         sincroniza con el VPS. El VPS nunca habla
//                         directo con hardware en la LAN del restaurante.
//               ├─ Pantallas   media players (ej. la APK VenuePro)
//               ├─ Capturadoras (encoders SDI/HDMI) — el servidor local
//               │   les habla DIRECTO por la LAN (no hay vuelta al VPS
//               │   para leer la señal ni para diagnosticar el hardware).
//               └─ Cámaras PTZ — vídeo por RTSP, control por ONVIF
//                   Profile S (estándar, sirve para "una PTZ genérica"),
//                   con VISCA-over-IP como plan B si la cámara no trae
//                   ONVIF. El control también es DIRECTO servidor↔cámara
//                   en la LAN — igual que con la capturadora, es la razón
//                   de ser del servidor local: el VPS nunca podría abrir
//                   esa conexión de fuera hacia dentro.
//
// Cuando haya backend real, cambia las funciones de más abajo (getAgencies,
// getClients, etc.) por fetch() a tu API — el resto de la app llama solo a
// esas funciones, nunca a los arrays directamente, así el cambio es
// mecánico y no toca las vistas.

const AGENCIES = [
  { id: 'nv', name: 'Norte Visual', initials: 'NV', color: '#2f7bf6', ink: '#ffffff' },
  { id: 'rm', name: 'Retail Mediterráneo', initials: 'RM', color: '#7aa2f7', ink: '#0b1220' },
  { id: 'gc', name: 'Grupo Cívico', initials: 'GC', color: '#f0b429', ink: '#1a1204' }
];

// Tenants (clientes finales) de cada agencia. El plan limita cuántas
// ubicaciones puede tener el tenant.
const CLIENTS = [
  {
    id: 'bm', agencyId: 'nv', name: 'Bodegas Marín', initials: 'BM', plan: 'Pro',
    locLimit: 8, scrLimit: 24, accent: '#2f7bf6', accentInk: '#ffffff',
    locations: [
      {
        id: 'l1', name: 'Salón principal', city: 'Valencia',
        localServer: { status: 'online', ip: '192.168.1.10', lastSeen: 'hace 8 s' },
        screens: [
          { id: 1, name: 'Barra 01', status: 'on', content: 'Señal en vivo · mezcla activa', source: 'live', encoderId: 'e1' },
          { id: 2, name: 'Salón TV', status: 'on', content: 'Carta del día', source: 'menu' },
          { id: 3, name: 'Terraza', status: 'off', content: 'Sin señal', source: 'menu' }
        ],
        encoders: [
          { id: 'e1', name: 'Capturadora Barra', input: 'SDI 1 · Decodificador TV', res: '1080p60', bitrate: '6.2 Mbps', status: 'live', screens: 1 },
          { id: 'e2', name: 'Capturadora Salón', input: 'HDMI 2 · Portátil eventos', res: '1080p30', bitrate: '—', status: 'idle', screens: 0 },
          { id: 'e3', name: 'Capturadora Terraza', input: 'HDMI 1 · Sin cable', res: '—', bitrate: '—', status: 'error', screens: 1 }
        ],
        ptzCams: [
          // "protocol: onvif" = cámara PTZ genérica: el servidor local la
          // descubre y la mueve por ONVIF Profile S (SOAP/HTTP al
          // "xAddr"), y pide el vídeo por RTSP aparte — son dos canales
          // distintos a la misma IP. Si algún día aparece una cámara sin
          // ONVIF, cae a "protocol: visca" (VISCA-over-IP, puerto 52381).
          // go2rtc: null = sin configurar todavía → la vista PTZ dibuja el
          // placeholder de siempre. Rellena "host" con la IP/dominio donde
          // corre go2rtc en el servidor local de ESTA ubicación (puerto por
          // defecto 1984) y "streamId" con el nombre que le diste al stream
          // dentro de go2rtc.yaml (sección "streams:", normalmente el mismo
          // valor que pegarías como fuente RTSP). Confirma los endpoints
          // exactos contra tu versión de go2rtc antes de dar esto por
          // bueno — han cambiado entre versiones.
          { id: 'c1', name: 'PTZ Escenario', status: 'live', protocol: 'onvif',
            onvif: { xAddr: 'http://192.168.1.41/onvif/device_service', profile: 'Profile S' },
            rtsp: 'rtsp://192.168.1.41:554/stream1',
            go2rtc: null /* { host: '192.168.1.10:1984', streamId: 'ptz_escenario' } */ },
          { id: 'c2', name: 'PTZ Cocina', status: 'live', protocol: 'onvif',
            onvif: { xAddr: 'http://192.168.1.42/onvif/device_service', profile: 'Profile S' },
            rtsp: 'rtsp://192.168.1.42:554/stream1', go2rtc: null },
          { id: 'c3', name: 'PTZ Terraza', status: 'off', protocol: 'onvif',
            onvif: { xAddr: 'http://192.168.1.43/onvif/device_service', profile: 'Profile S' },
            rtsp: 'rtsp://192.168.1.43:554/stream1', go2rtc: null }
        ]
      },
      {
        id: 'l4', name: 'Córner El Corte', city: 'Valencia',
        localServer: { status: 'online', ip: '192.168.4.10', lastSeen: 'hace 22 s' },
        screens: [
          { id: 4, name: 'Caja 1', status: 'on', content: 'Promo cruzada', source: 'loop' },
          { id: 16, name: 'Pantalla 2', status: 'idle', content: 'Sin lista asignada', source: 'menu' }
        ],
        encoders: [],
        ptzCams: []
      }
    ]
  },
  {
    id: 'cf', agencyId: 'nv', name: 'Clínica Ferrán', initials: 'CF', plan: 'Básico',
    locLimit: 3, scrLimit: 6, accent: '#7aa2f7', accentInk: '#0b1220',
    locations: [
      {
        id: 'l5', name: 'Consulta principal', city: 'Alicante',
        localServer: { status: 'online', ip: '10.0.0.10', lastSeen: 'hace 1 min' },
        screens: [
          { id: 5, name: 'Recepción', status: 'on', content: 'Bienvenida + agenda', source: 'menu' },
          { id: 17, name: 'Sala de espera A', status: 'on', content: 'Bienvenida + agenda', source: 'menu' },
          { id: 18, name: 'Pasillo', status: 'on', content: 'Bienvenida + agenda', source: 'menu' }
        ],
        encoders: [], ptzCams: []
      },
      {
        id: 'l6', name: 'Sala de espera B', city: 'Alicante',
        localServer: { status: 'offline', ip: '10.0.1.10', lastSeen: 'hace 3 h' },
        screens: [
          { id: 19, name: 'Sala B - 1', status: 'off', content: 'Sin conexión con el servidor local', source: 'menu' },
          { id: 20, name: 'Sala B - 2', status: 'off', content: 'Sin conexión con el servidor local', source: 'menu' }
        ],
        encoders: [], ptzCams: []
      }
    ]
  },
  {
    id: 'gm', agencyId: 'gc', name: 'Gimnasios Atlas', initials: 'GM', plan: 'Enterprise',
    locLimit: null, scrLimit: null, accent: '#f0b429', accentInk: '#1a1204',
    locations: [
      {
        id: 'l7', name: 'Atlas Norte', city: 'Castellón',
        localServer: { status: 'online', ip: '172.16.0.10', lastSeen: 'hace 4 s' },
        screens: [
          { id: 6, name: 'Aparcamiento', status: 'on', content: 'Avisos + tiempo', source: 'menu' },
          { id: 21, name: 'Recepción', status: 'on', content: 'Avisos + tiempo', source: 'menu' },
          { id: 22, name: 'Sala 1', status: 'on', content: 'Avisos + tiempo', source: 'menu' }
        ],
        encoders: [], ptzCams: []
      },
      {
        id: 'l8', name: 'Atlas Puerto', city: 'Castellón',
        localServer: { status: 'online', ip: '172.16.1.10', lastSeen: 'hace 15 s' },
        screens: [
          { id: 26, name: 'Recepción', status: 'off', content: 'Sin lista asignada', source: 'menu' },
          { id: 27, name: 'Sala 1', status: 'on', content: 'Avisos + tiempo', source: 'menu' }
        ],
        encoders: [], ptzCams: []
      },
      {
        id: 'l9', name: 'Atlas Sur', city: 'Vila-real',
        localServer: { status: 'online', ip: '172.16.2.10', lastSeen: 'hace 30 s' },
        screens: [
          { id: 7, name: 'Cafetería', status: 'idle', content: 'Sin lista asignada', source: 'menu' },
          { id: 30, name: 'Recepción', status: 'on', content: 'Avisos + tiempo', source: 'menu' }
        ],
        encoders: [], ptzCams: []
      }
    ]
  }
];

// Fuentes que puede reproducir una pantalla. "live"/"split" asumen una
// entrada de vídeo en directo desde la capturadora de la ubicación (SDI o
// HDMI, según lo que haya en ese local) y "ptz" asume una cámara IP de la
// ubicación, servida por RTSP.
const SOURCE_TYPES = [
  { id: 'menu', label: 'Carta digital', sub: 'Menú del día · 4 bloques', tag: 'PROGRAMADA' },
  { id: 'live', label: 'Señal en vivo (SDI/HDMI)', sub: 'Capturadora del local', tag: 'EN DIRECTO' },
  { id: 'loop', label: 'Bucle promocional', sub: 'Postres y cócteles · 6 clips', tag: 'PROGRAMADA' },
  { id: 'split', label: 'Carta + señal', sub: 'Menú 70% · vivo 30%', tag: 'MIXTA' },
  { id: 'ptz', label: 'Cámara PTZ (RTSP)', sub: 'Cámara IP de la ubicación', tag: 'EN DIRECTO' }
];

const PTZ_PRESETS = [
  { id: 'pr1', label: 'Escenario', x: 0, y: 0, z: 1.4 },
  { id: 'pr2', label: 'Barra', x: -26, y: 8, z: 2.1 },
  { id: 'pr3', label: 'Cocina', x: 22, y: -12, z: 2.6 },
  { id: 'pr4', label: 'Sala', x: 0, y: 4, z: 1 },
  { id: 'pr5', label: 'Terraza', x: 34, y: 6, z: 1.7 },
  { id: 'pr6', label: 'Entrada', x: -38, y: -4, z: 2.3 }
];

const MIX_LAYOUTS = [
  { id: 'lower', label: 'Franja inferior', note: 'La promo ocupa el 18% inferior. Recomendado para partidos: no tapa el marcador.' },
  { id: 'corner', label: 'Esquina', note: 'Poco intrusivo, ideal para el logo del local durante todo el evento.' },
  { id: 'side', label: 'Lateral', note: 'La señal se reescala a 70%. Evítalo con contenido con subtítulos.' },
  { id: 'full', label: 'Interrupción', note: 'Corta la señal 10 s cada 15 min. Úsalo solo en promociones fuertes.' }
];

const PROMOS = [
  { id: 'p1', title: 'Jarra 2×1 al descanso', meta: 'banda · 15 s' },
  { id: 'p2', title: 'Carta de tapas', meta: 'banda · bucle' },
  { id: 'p3', title: 'Logo del local', meta: 'estático' }
];

const CREATIVES = [
  { id: 'c1', title: 'Bienvenida otoño', meta: 'imagen · 1080×1920' },
  { id: 'c2', title: 'Rebajas — 15s', meta: 'vídeo · 15 s' },
  { id: 'c3', title: 'Menú del día', meta: 'plantilla dinámica' },
  { id: 'c4', title: 'Avisos + tiempo', meta: 'widget en vivo' }
];

const STATUS_COLOR = { on: '#2f7bf6', off: '#f2635a', idle: '#f0b429' };
const STATUS_LABEL = { on: 'en línea', off: 'sin señal', idle: 'en espera' };
const ENC_COLOR = { live: '#f2635a', idle: '#8a9098', error: '#f0b429' };
const ENC_LABEL = { live: 'EN DIRECTO', idle: 'EN ESPERA', error: 'SIN ENTRADA' };

// ---- API de datos (todo síncrono/mock por ahora) ----------------------

function getAgencies() { return AGENCIES; }
function getAgency(id) { return AGENCIES.find(a => a.id === id); }

function getClients(agencyId) { return CLIENTS.filter(c => c.agencyId === agencyId); }
function getClient(id) { return CLIENTS.find(c => c.id === id); }

function getLocation(locationId) {
  for (const c of CLIENTS) {
    const l = c.locations.find(l => l.id === locationId);
    if (l) return { location: l, client: c };
  }
  return null;
}

function getScreensForAgency(agencyId) {
  return getClients(agencyId).flatMap(c =>
    c.locations.flatMap(l => l.screens.map(s => ({
      ...s, clientId: c.id, clientName: c.name, locationId: l.id, locationName: l.name
    })))
  );
}

function findScreen(screenId) {
  for (const c of CLIENTS) {
    for (const l of c.locations) {
      const s = l.screens.find(s => s.id === screenId);
      if (s) return { screen: s, location: l, client: c };
    }
  }
  return null;
}

function usageForClient(client) {
  const usedLoc = client.locations.length;
  const usedScr = client.locations.reduce((n, l) => n + l.screens.length, 0);
  const unlimited = client.locLimit === null;
  return { usedLoc, usedScr, unlimited };
}

// Punto de extensión: aquí es donde iría el envío real de un comando.
// Nunca va directo al hardware — siempre pasa por el servidor local de la
// ubicación (MQTT/WebSocket), que es quien de verdad habla ONVIF/VISCA con
// la cámara o lee la capturadora SDI/HDMI. Hoy solo actualiza memoria.
function sendPlayerCommand(screenId, command, payload) {
  console.log('[mock → servidor local] sendPlayerCommand', screenId, command, payload);
  return Promise.resolve({ ok: true });
}

// El móvil/VPS nunca manda ONVIF/VISCA directo a la cámara — eso lo hace el
// servidor local, que sí tiene conexión directa por estar en la misma LAN.
// Esta función es solo el mensaje que el VPS le pasa a ese servidor local
// (por MQTT/WebSocket) para que él traduzca a ONVIF (SOAP a cam.onvif.xAddr)
// o a VISCA-over-IP si la cámara no es ONVIF.
function sendPtzCommand(locationId, camId, command, payload) {
  console.log('[mock → servidor local] sendPtzCommand', locationId, camId, command, payload);
  return Promise.resolve({ ok: true });
}

// Nota — dispositivos ESPHome/ESP32 (ej. un relé que apaga/enciende una
// pantalla, un sensor de presencia en el local):
// Encajan en el mismo esquema de arriba, por WiFi, sin nada nuevo que
// inventar:
//   - ESPHome ya trae un broker MQTT integrado (o se conecta a uno externo)
//     y publica/escucha en topics tipo "esphome/<device>/switch/pantalla_1".
//     El servidor local de la ubicación ya habla MQTT con el VPS (mismo
//     canal que usan sendPlayerCommand/sendPtzCommand) — solo hace falta que
//     también sea el broker (o cliente) para los dispositivos ESPHome de esa
//     LAN. Nunca va el ESP32 a internet directo.
//   - Alternativa sin broker: la "Native API" de ESPHome (puerto 6053,
//     encriptada) — el servidor local le habla directo por TCP, es lo que
//     usa Home Assistant.
//   - Para algo puntual (un botón, un sensor) el propio ESP32 puede exponer
//     un endpoint HTTP REST simple y el servidor local hace polling/POST.
// En los tres casos: el ESP32 nunca sale del Wi-Fi del local, y el patrón es
// idéntico al de la cámara PTZ — el VPS/app solo habla con el servidor
// local, y él trae el comando al dispositivo real.
function sendDeviceCommand(locationId, deviceId, command, payload) {
  console.log('[mock → servidor local] sendDeviceCommand', locationId, deviceId, command, payload);
  return Promise.resolve({ ok: true });
}
