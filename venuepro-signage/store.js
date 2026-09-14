import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export const token = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function password(value, salt = randomBytes(16).toString('hex')) { return salt + ':' + scryptSync(value, salt, 64).toString('hex'); }
export function verify(value, stored) { const [salt] = stored.split(':'); return timingSafeEqual(Buffer.from(password(value, salt)), Buffer.from(stored)); }
export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'signage.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES users(email), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret TEXT NOT NULL UNIQUE, tenant TEXT REFERENCES tenants(id), code TEXT UNIQUE, expires INTEGER, name TEXT NOT NULL DEFAULT 'Pantalla nueva', playlist TEXT, seen INTEGER, version TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, items TEXT NOT NULL, version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, playlist TEXT NOT NULL REFERENCES playlists(id), name TEXT NOT NULL, timezone TEXT NOT NULL, days TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, fromDate TEXT NOT NULL, toDate TEXT NOT NULL, priority INTEGER NOT NULL);
  `);
  db.exec('CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL)');
  const columns=db.prepare('PRAGMA table_info(devices)').all().map(c=>c.name);
  if(!columns.includes('location'))db.exec('ALTER TABLE devices ADD COLUMN location TEXT REFERENCES locations(id)');
  if(!columns.includes('paused'))db.exec('ALTER TABLE devices ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
  if(!columns.includes('revision'))db.exec('ALTER TABLE devices ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if(!columns.includes('orientation'))db.exec("ALTER TABLE devices ADD COLUMN orientation TEXT NOT NULL DEFAULT 'auto'");
  if(!columns.includes('rotation'))db.exec('ALTER TABLE devices ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0');
  if(!columns.includes('fit'))db.exec("ALTER TABLE devices ADD COLUMN fit TEXT NOT NULL DEFAULT 'cover'");
  // Fuente en vivo local (ej. go2rtc en la LAN del local) — reemplaza la
  // lista mientras esté puesta. NULL = usa la lista asignada, como antes.
  if(!columns.includes('live_source'))db.exec('ALTER TABLE devices ADD COLUMN live_source TEXT');
  // Guarda la ÚLTIMA URL real que se puso, aunque ahora esté "apagada"
  // (live_source=NULL porque se volvió a Lista de reproducción) — así al
  // reactivar "Señal en vivo" no hay que volver a escribirla desde cero.
  if(!columns.includes('live_source_saved'))db.exec('ALTER TABLE devices ADD COLUMN live_source_saved TEXT');
  // Mezcla sobre la señal en vivo: {layout:'lower'|'split'|'full', promo:assetId|null, muted}.
  // Solo tiene sentido con live_source puesto; igual que command en
  // ptz_cameras, es la ÚLTIMA intención — el reproductor real (Android o el
  // agente local) es quien compone la imagen de verdad. NULL = sin mezcla.
  if(!columns.includes('mix'))db.exec('ALTER TABLE devices ADD COLUMN mix TEXT');
  if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='role'))db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  if(!db.prepare('PRAGMA table_info(assets)').all().some(c=>c.name==='archived'))db.exec('ALTER TABLE assets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  // Carpetas para organizar la biblioteca (solo agrupan — no cambian dónde
  // se guarda el archivo). NULL = "sin carpeta", como estaba antes.
  db.exec('CREATE TABLE IF NOT EXISTS asset_folders (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL)');
  if(!db.prepare('PRAGMA table_info(assets)').all().some(c=>c.name==='folder'))db.exec('ALTER TABLE assets ADD COLUMN folder TEXT REFERENCES asset_folders(id)');
  // Cámaras PTZ de una ubicación. "command"/"command_seq" son un buzón: la
  // API solo GUARDA la última intención (mover/preset/zoom) con un número
  // de secuencia que sube cada vez — el agente local (todavía no existe)
  // sería quien la lea y de verdad hable ONVIF/VISCA con la cámara. Sin
  // agente local, guardar un comando aquí no mueve nada físicamente todavía.
  db.exec(`CREATE TABLE IF NOT EXISTS ptz_cameras (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id),
    location TEXT REFERENCES locations(id), name TEXT NOT NULL,
    onvif_url TEXT, rtsp_url TEXT, presets TEXT NOT NULL DEFAULT '[]',
    command TEXT, command_seq INTEGER NOT NULL DEFAULT 0, updated INTEGER
  )`);
  // view_url: URL http(s) visible en navegador (típicamente stream.html de
  // go2rtc) para "Enviar a las pantallas" — onvif_url/rtsp_url son para el
  // agente local, no se pueden abrir en un <iframe>.
  if(!db.prepare('PRAGMA table_info(ptz_cameras)').all().some(c=>c.name==='view_url'))db.exec('ALTER TABLE ptz_cameras ADD COLUMN view_url TEXT');
  // Plantillas de mezcla reutilizables (layout + texto + logo + promo ya
  // armados) para no rehacer la combinación cada vez — ver el bloque de
  // /api/devices/:id/mix en server.js para el formato exacto de cada campo.
  db.exec(`CREATE TABLE IF NOT EXISTS mix_templates (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL, layout TEXT NOT NULL, promo TEXT, logo TEXT,
    text TEXT NOT NULL DEFAULT '', muted INTEGER NOT NULL DEFAULT 0
  )`);
  // Canales: la fuente en vivo se configura UNA vez por ubicación acá (no
  // en cada pantalla) — la ficha de pantalla solo prende/apaga un switch
  // por canal disponible en su ubicación. Reemplaza el flujo viejo de
  // escribir la URL a mano en cada pantalla con un prompt().
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants(id),
    location TEXT REFERENCES locations(id), name TEXT NOT NULL, url TEXT NOT NULL
  )`);
  return db;
}
