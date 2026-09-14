import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, deviceManifest } from '../server.js';
import { password } from '../store.js';

test('Mezcla sobre la señal en vivo: requiere live_source, valida assets, plantillas por tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-mix-test-'));
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

    const pair = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'Barra' } });
    const deviceId = (await req('/api/state', { cookie: a })).data.devices[0].id;

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(base + '/api/assets', { method: 'POST', headers: { Cookie: a, 'Content-Type': 'image/png', 'X-File-Name': 'logo.png' }, body: png });
    const logoId = (await upload.json()).id;

    // Sin señal en vivo, no se puede mezclar
    assert.equal((await req(`/api/devices/${deviceId}/mix`, { cookie: a, body: { layout: 'lower', promo: null, logo: null, text: 'Hola', muted: false } })).status, 409);

    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: 'http://192.168.1.10:1984/stream.html?src=mivideo' } });

    // Layout inválido, o logo de otro tenant, rechazados
    assert.equal((await req(`/api/devices/${deviceId}/mix`, { cookie: a, body: { layout: 'diagonal', promo: null, logo: null, text: '', muted: false } })).status, 400);
    assert.equal((await req(`/api/devices/${deviceId}/mix`, { cookie: b, body: { layout: 'lower', promo: null, logo: logoId, text: '', muted: false } })).status, 400);

    // Mezcla válida con texto + logo
    const saved = await req(`/api/devices/${deviceId}/mix`, { cookie: a, body: { layout: 'lower', promo: null, logo: logoId, text: '2x1 en cervezas', muted: true } });
    assert.equal(saved.status, 200);
    let state = (await req('/api/state', { cookie: a })).data;
    assert.deepEqual(state.devices[0].mix, { layout: 'lower', promo: null, logo: logoId, text: '2x1 en cervezas', muted: true });

    // El manifiesto del reproductor trae la mezcla con la URL del logo resuelta
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    const manifest = deviceManifest(db, dev, 'http://localhost:3080');
    assert.equal(manifest.mix.text, '2x1 en cervezas');
    assert.ok(manifest.mix.logoUrl.includes('/api/player/media/' + logoId));

    // Quitar la fuente en vivo borra la mezcla también
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: null } });
    state = (await req('/api/state', { cookie: a })).data;
    assert.equal(state.devices[0].mix, null);

    // clear explícito
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: 'http://192.168.1.10:1984/stream.html?src=mivideo' } });
    await req(`/api/devices/${deviceId}/mix`, { cookie: a, body: { layout: 'full', promo: null, logo: null, text: 'x', muted: false } });
    assert.equal((await req(`/api/devices/${deviceId}/mix`, { cookie: a, body: { clear: true } })).status, 200);
    state = (await req('/api/state', { cookie: a })).data;
    assert.equal(state.devices[0].mix, null);

    // Plantillas: aisladas por tenant, y con la misma validación de assets
    const tpl = await req('/api/mix-templates', { cookie: a, body: { name: 'Happy Hour', layout: 'split', promo: null, logo: logoId, text: 'Happy hour 5-7pm', muted: false } });
    assert.equal(tpl.status, 201);
    assert.equal((await req('/api/mix-templates', { cookie: a })).data.length, 1);
    assert.equal((await req('/api/mix-templates', { cookie: b })).data.length, 0);
    assert.equal((await req('/api/mix-templates', { cookie: b, body: { name: 'Ajena', layout: 'lower', promo: null, logo: logoId, text: '', muted: false } })).status, 400);
    assert.equal((await req(`/api/mix-templates/${tpl.data.id}`, { cookie: b, method: 'DELETE' })).status, 404);
    assert.equal((await req(`/api/mix-templates/${tpl.data.id}`, { cookie: a, method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/mix-templates', { cookie: a })).data.length, 0);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
