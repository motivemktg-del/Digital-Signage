import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, deviceManifest } from '../server.js';
import { password } from '../store.js';

test('Alerta de emergencia: por pantalla y broadcast, sin requerir señal en vivo, aislado por tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-alerts-test-'));
  const { app, db } = createApp({ STORAGE_MODE: 'local', PUBLIC_URL: 'http://localhost:3080', DATA_DIR: dir });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function req(path, { body, cookie, method } = {}) {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
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

    // Validaciones: texto vacío, nivel inválido
    assert.equal((await req(`/api/devices/${deviceId}/alert`, { cookie: a, body: { text: '', level: 'critical' } })).status, 400);
    assert.equal((await req(`/api/devices/${deviceId}/alert`, { cookie: a, body: { text: 'Cierre anticipado', level: 'panic' } })).status, 400);
    assert.equal((await req(`/api/devices/${deviceId}/alert`, { cookie: b, body: { text: 'Ajena', level: 'info' } })).status, 404); // otro tenant

    // A diferencia de mix, funciona SIN señal en vivo (dispositivo recién
    // pareado, sin live_source ni playlist asignada todavía)
    const saved = await req(`/api/devices/${deviceId}/alert`, { cookie: a, body: { text: 'Alerta de tornado en la zona', level: 'critical' } });
    assert.equal(saved.status, 200);
    let state = (await req('/api/state', { cookie: a })).data;
    assert.equal(state.devices[0].alert.text, 'Alerta de tornado en la zona');
    assert.equal(state.devices[0].alert.level, 'critical');
    assert.ok(typeof state.devices[0].alert.issued === 'number');

    // El manifiesto del reproductor la trae tal cual
    let dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    let manifest = deviceManifest(db, dev, 'http://localhost:3080');
    assert.equal(manifest.alert.text, 'Alerta de tornado en la zona');
    assert.equal(manifest.alert.level, 'critical');

    // clear explícito por pantalla
    assert.equal((await req(`/api/devices/${deviceId}/alert`, { cookie: a, body: { clear: true } })).status, 200);
    state = (await req('/api/state', { cookie: a })).data;
    assert.equal(state.devices[0].alert, null);

    // Broadcast a todas las pantallas del tenant
    const pair2 = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair2.code, name: 'Cocina' } });
    const loc = (await req('/api/locations', { cookie: a, body: { name: 'Sucursal 2' } })).data;
    const pair3 = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair3.code, name: 'Otra sucursal', location: loc.id } });

    assert.equal((await req('/api/alerts/broadcast', { cookie: a, body: { text: 'Cierre por mantenimiento', level: 'warning' } })).status, 200);
    const broadcast = await req('/api/alerts/broadcast', { cookie: a, body: { text: 'Cierre por mantenimiento', level: 'warning' } });
    assert.equal(broadcast.data.applied, 3);
    state = (await req('/api/state', { cookie: a })).data;
    assert.ok(state.devices.every(d => d.alert && d.alert.text === 'Cierre por mantenimiento' && d.alert.level === 'warning'));
    // otro tenant no ve nada
    assert.equal((await req('/api/state', { cookie: b })).data.devices.length, 0);

    // Broadcast acotado a una ubicación — solo esa pantalla la recibe distinta
    const scoped = await req('/api/alerts/broadcast', { cookie: a, body: { text: 'Solo sucursal 2', level: 'info', location: loc.id } });
    assert.equal(scoped.data.applied, 1);
    state = (await req('/api/state', { cookie: a })).data;
    const sucursal2 = state.devices.find(d => d.name === 'Otra sucursal');
    const otras = state.devices.filter(d => d.name !== 'Otra sucursal');
    assert.equal(sucursal2.alert.text, 'Solo sucursal 2');
    assert.ok(otras.every(d => d.alert.text === 'Cierre por mantenimiento')); // no las tocó

    assert.equal((await req('/api/alerts/broadcast', { cookie: a, body: { text: 'x', level: 'info', location: 'missing' } })).status, 404);

    // clear-all apaga todas de una
    const cleared = await req('/api/alerts/clear-all', { cookie: a, body: {} });
    assert.equal(cleared.data.applied, 3);
    state = (await req('/api/state', { cookie: a })).data;
    assert.ok(state.devices.every(d => d.alert === null));
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
