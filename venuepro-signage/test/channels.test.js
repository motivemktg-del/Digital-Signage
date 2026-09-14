import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

test('Canales: aislamiento por tenant, requieren URL válida, se pueden activar como fuente de una pantalla', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-channels-test-'));
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

    const loc = (await req('/api/locations', { cookie: a, body: { name: 'Sucursal Centro' } })).data;
    assert.equal((await req('/api/channels', { cookie: a, body: { name: 'Digital Signage', location: loc.id, url: 'no-es-url' } })).status, 400);

    const created = await req('/api/channels', { cookie: a, body: { name: 'Digital Signage', location: loc.id, url: 'http://192.168.1.10:1984/api/stream.mp4?src=mivideo' } });
    assert.equal(created.status, 201);

    // La regla es "un canal a la vez encendido" por pantalla — eso se
    // decide comparando la fuente en vivo contra la URL del canal, así
    // que dos canales con la MISMA URL serían indistinguibles y se
    // prenderían/apagarían siempre juntos. Se bloquea al crear.
    const dup = await req('/api/channels', { cookie: a, body: { name: 'Otro nombre', url: 'http://192.168.1.10:1984/api/stream.mp4?src=mivideo' } });
    assert.equal(dup.status, 409);
    // Mismo tenant y URL exacta bloquea; otro tenant SÍ puede usar esa URL (aislado).
    assert.equal((await req('/api/channels', { cookie: b, body: { name: 'Digital Signage', url: 'http://192.168.1.10:1984/api/stream.mp4?src=mivideo' } })).status, 201);

    assert.equal((await req('/api/channels', { cookie: a })).data.length, 1);
    assert.equal((await req('/api/channels', { cookie: b })).data.length, 1); // aislado por tenant (b ya tiene la suya, distinta cuenta)
    assert.equal((await req('/api/state', { cookie: a })).data.channels.length, 1);

    // Activarlo como fuente en vivo de una pantalla (lo que hace el switch en la ficha)
    const pair = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'TV Centro 1', location: loc.id } });
    const deviceId = (await req('/api/state', { cookie: a })).data.devices[0].id;
    const channel = (await req('/api/channels', { cookie: a })).data[0];
    await req(`/api/devices/${deviceId}/live-channel`, { cookie: a, body: { channel: channel.id } });
    let dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, channel.url);
    assert.equal(dev.liveChannel, channel.id);

    // Otro tenant no puede tocar el canal
    assert.equal((await req(`/api/channels/${channel.id}`, { cookie: b, method: 'DELETE' })).status, 404);

    // Borrar el canal no falla aunque una pantalla lo tenga activo (solo se desconecta la referencia)
    assert.equal((await req(`/api/channels/${channel.id}`, { cookie: a, method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/channels', { cookie: a })).data.length, 0);
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveSource, channel.url); // sigue mostrando la señal, solo ya no aparece en la lista de canales
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});

// "ESO NO ESTA CORREGIDO NUNCA PUEDEN ESTAR ACTIVOS A LA VEZ" — el bug real:
// dos canales con la MISMA URL (posible en cuentas viejas, de antes de
// bloquear eso al crear) se mostraban ambos "prendidos" porque el switch
// comparaba live_source contra la URL de cada canal. Ahora se identifica
// por canal.id (live_channel), así que aunque las URLs sean idénticas,
// solo uno puede estar activo a la vez — se prueba insertando el duplicado
// directo en la BD (como quedaría una cuenta ya afectada, sin pasar por el
// bloqueo de creación que ya cubre el otro test).
test('Canales con URL duplicada (cuentas viejas): nunca se muestran ambos activos a la vez', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-duplicate-channels-test-'));
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

    const sameUrl = 'http://192.168.1.10:1984/api/stream.mp4?src=mivideo';
    const idEspn = 'chan-espn', idFox = 'chan-fox';
    db.prepare('INSERT INTO channels (id,tenant,location,name,url) VALUES (?,?,?,?,?)').run(idEspn, 'a', null, 'ESPN', sameUrl);
    db.prepare('INSERT INTO channels (id,tenant,location,name,url) VALUES (?,?,?,?,?)').run(idFox, 'a', null, 'fox', sameUrl);

    const pair = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'TV 1' } });
    const deviceId = (await req('/api/state', { cookie: a })).data.devices[0].id;

    await req(`/api/devices/${deviceId}/live-channel`, { cookie: a, body: { channel: idEspn } });
    let dev = (await req('/api/state', { cookie: a })).data.devices[0];
    // El check que hace el switch en la ficha es "d.liveChannel === c.id" —
    // con el id, exactamente uno da true aunque las URLs sean iguales.
    assert.equal(dev.liveChannel === idEspn, true);
    assert.equal(dev.liveChannel === idFox, false);

    await req(`/api/devices/${deviceId}/live-channel`, { cookie: a, body: { channel: idFox } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveChannel === idEspn, false);
    assert.equal(dev.liveChannel === idFox, true);

    await req(`/api/devices/${deviceId}/live-channel`, { cookie: a, body: { channel: null } });
    dev = (await req('/api/state', { cookie: a })).data.devices[0];
    assert.equal(dev.liveChannel, null);
    assert.equal(dev.liveSource, null);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
