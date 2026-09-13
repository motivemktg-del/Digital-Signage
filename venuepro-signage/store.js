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
  if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='role'))db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  if(!db.prepare('PRAGMA table_info(assets)').all().some(c=>c.name==='archived'))db.exec('ALTER TABLE assets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  return db;
}
