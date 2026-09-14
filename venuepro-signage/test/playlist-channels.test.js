import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, deviceManifest } from '../server.js';
import { password } from '../store.js';

// "canales debe ser solo para pedir el nombre y el stream y desde pantalla
// sale ese canal en el selector siempre y cuando canales haga parte del
// contenido de la listas" — un canal en vivo debe poder ser un item más
// dentro de una lista de reproducción, no solo el switch de Fuente de una
// pantalla. Este test cubre esa integración de punta a punta: guardar una
// lista con un archivo Y un canal, ver que el manifiesto del reproductor
// resuelve el item de canal como señal en vivo (con su RTSP derivado), y
// que borrar un canal en uso por una lista se bloquea (igual que un archivo).
test('Canales dentro de listas de reproducción: se pueden mezclar con archivos, el manifiesto los resuelve como items en vivo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-playlist-channels-test-'));
  const { app, db } = createApp({ STORAGE_MODE: 'local', PUBLIC_URL: 'http://localhost:3080', DATA_DIR: dir });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function req(path, { body, cookie, method } = {}) {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    db.prepare('INSERT INTO tenants VALUES (?,?)').run('a', 'Tenant a');
    db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run('a@test.local', 'a', password('correct-password'));
    const a = (await req('/api/login', { body: { email: 'a@test.local', password: 'correct-password' } })).cookie;

    // Un canal ya no pide ubicación — solo nombre y URL.
    const created = await req('/api/channels', { cookie: a, body: { name: 'TV Bar', url: 'http://192.168.1.10:1984/api/stream.mp4?src=bar' } });
    assert.equal(created.status, 201);
    const channelId = created.data.id;

    const upload = await fetch(base + '/api/assets', {
      method: 'POST', headers: { Cookie: a, 'Content-Type': 'image/png', 'x-file-name': 'foto.png' }, body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    });
    const asset = await upload.json();

    // Una lista puede mezclar archivo + canal en el mismo item set.
    const saved = await req('/api/playlists', { cookie: a, body: { name: 'Mixta', items: [{ asset: asset.id, seconds: 8 }, { channel: channelId, seconds: 20 }] } });
    assert.equal(saved.status, 200);

    // Canal inexistente: 400 (misma validación que un archivo inexistente).
    assert.equal((await req('/api/playlists', { cookie: a, body: { name: 'Rota', items: [{ channel: 'no-existe', seconds: 10 } ] } })).status, 400);

    const pair = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'TV 1' } });
    const deviceId = (await req('/api/state', { cookie: a })).data.devices[0].id;
    await req(`/api/devices/${deviceId}/assign`, { cookie: a, body: { playlist: saved.data.id } });

    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    const manifest = deviceManifest(db, dev, 'http://localhost:3080');
    assert.equal(manifest.items.length, 2);
    assert.equal(manifest.items[0].type, 'image/png'); // el item de archivo sigue resolviendo como antes
    assert.equal(manifest.items[1].type, 'live');
    assert.equal(manifest.items[1].seconds, 20);
    assert.equal(manifest.items[1].url, 'http://192.168.1.10:1984/api/stream.mp4?src=bar');
    assert.equal(manifest.items[1].rtsp, 'rtsp://192.168.1.10:8554/bar'); // derivado, mismo patrón que liveSourceRtsp

    // Un canal en uso dentro de una lista no se puede borrar sin sacarlo antes.
    assert.equal((await req(`/api/channels/${channelId}`, { cookie: a, method: 'DELETE' })).status, 409);
    await req('/api/playlists', { cookie: a, body: { id: saved.data.id, name: 'Mixta', items: [{ asset: asset.id, seconds: 8 }] } });
    assert.equal((await req(`/api/channels/${channelId}`, { cookie: a, method: 'DELETE' })).status, 200);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
