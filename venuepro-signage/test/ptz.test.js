import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

test('Cámaras PTZ: aislamiento por tenant, presets y buzón de comandos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-ptz-test-'));
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
    for (const id of ['a', 'b']) {
      db.prepare('INSERT INTO tenants VALUES (?,?)').run(id, 'Tenant ' + id);
      db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run(id + '@test.local', id, password('correct-password'));
    }
    const a = (await req('/api/login', { body: { email: 'a@test.local', password: 'correct-password' } })).cookie;
    const b = (await req('/api/login', { body: { email: 'b@test.local', password: 'correct-password' } })).cookie;

    // Crear cámara para el tenant a
    const created = await req('/api/ptz-cameras', { cookie: a, body: { name: 'PTZ Escenario', onvifUrl: 'http://192.168.1.41/onvif/device_service', rtspUrl: 'rtsp://192.168.1.41:554/stream1' } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'PTZ Escenario');
    assert.deepEqual(created.data.presets, []);
    const camId = created.data.id;

    // El tenant b no la ve, y no puede tocarla
    assert.equal((await req('/api/ptz-cameras', { cookie: b })).data.length, 0);
    assert.equal((await req(`/api/ptz-cameras/${camId}/command`, { cookie: b, body: { type: 'home' } })).status, 404);
    assert.equal((await req(`/api/ptz-cameras/${camId}`, { cookie: b, method: 'DELETE' })).status, 404);

    // /api/state incluye la cámara del tenant a
    assert.equal((await req('/api/state', { cookie: a })).data.ptzCameras.length, 1);

    // Agregar y borrar un preset
    const preset = await req(`/api/ptz-cameras/${camId}/presets`, { cookie: a, body: { label: 'Escenario', pan: 0, tilt: 0, zoom: 1.4 } });
    assert.equal(preset.status, 201);
    let cam = (await req('/api/ptz-cameras', { cookie: a })).data[0];
    assert.equal(cam.presets.length, 1);
    assert.equal((await req(`/api/ptz-cameras/${camId}/presets/${preset.data.id}`, { cookie: a, method: 'DELETE' })).status, 200);
    cam = (await req('/api/ptz-cameras', { cookie: a })).data[0];
    assert.equal(cam.presets.length, 0);

    // Comando inválido rechazado; comando válido queda en el buzón (command_seq sube)
    assert.equal((await req(`/api/ptz-cameras/${camId}/command`, { cookie: a, body: { type: 'fly-to-moon' } })).status, 400);
    assert.equal((await req(`/api/ptz-cameras/${camId}/command`, { cookie: a, body: { type: 'nudge', payload: { dx: 8, dy: 0 } } })).status, 200);
    cam = (await req('/api/ptz-cameras', { cookie: a })).data[0];
    assert.equal(cam.command.type, 'nudge');
    assert.equal(cam.command_seq, 1);

    // Borrar la cámara
    assert.equal((await req(`/api/ptz-cameras/${camId}`, { cookie: a, method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/ptz-cameras', { cookie: a })).data.length, 0);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
