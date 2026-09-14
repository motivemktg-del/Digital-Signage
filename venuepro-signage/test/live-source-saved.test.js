import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

test('Señal en vivo: recuerda la última URL puesta aunque se apague, para reactivarla sin volver a escribirla', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-livesaved-test-'));
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

    const pair = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'Barra' } });
    const deviceId = (await req('/api/state', { cookie: a })).data.devices[0].id;

    // Todavía sin nada configurado: ninguna de las dos
    let dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, null);
    assert.equal(dev.liveSourceSaved, null);

    // Poner una URL real: queda activa Y guardada
    const url = 'http://192.168.1.10:1984/api/stream.mp4?src=mivideo';
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, url);
    assert.equal(dev.liveSourceSaved, url);

    // Apagarla (volver a la lista): live_source se limpia, pero lo guardado NO se pierde
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: null } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, null);
    assert.equal(dev.liveSourceSaved, url); // <- lo importante: sigue ahí

    // Reactivarla con la misma URL guardada (como hace el botón de un toque en la UI)
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: dev.liveSourceSaved } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, url);

    // Poner una URL nueva actualiza lo guardado a la nueva (no se queda pegado a la primera)
    const url2 = 'http://192.168.1.10:1984/api/stream.mp4?src=otracamara';
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: url2 } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSourceSaved, url2);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
