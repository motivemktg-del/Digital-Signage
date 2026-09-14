import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

// Antes el reproductor solo sondeaba /api/player/manifest a intervalo FIJO
// (20s), así que un cambio real (cambiar de canal, apagar la señal en
// vivo) tardaba hasta 20s en llegar por más rápido que se guardara en el
// panel. Estas pruebas cubren el long-polling que lo reemplaza: con
// ?since=<version actual>&wait=1, la respuesta debe llegar CASI al
// instante en cuanto algo cambie de verdad (no esperar el timeout), pero
// SÍ demorarse (sin colgar el test real 18s — se usan env vars de prueba
// para eso) cuando nada cambia, y devolver la MISMA versión al vencerse.
test('Long-polling de /api/player/manifest: responde rápido cuando cambia algo, y tras el timeout cuando no', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-longpoll-test-'));
  const { app, db } = createApp({
    STORAGE_MODE: 'local', PUBLIC_URL: 'http://localhost:3080', DATA_DIR: dir,
    MANIFEST_WAIT_MS: '600', MANIFEST_POLL_MS: '30',
  });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function req(path, { body, cookie, secret, method } = {}) {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(secret ? { Authorization: 'Bearer ' + secret } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    db.prepare('INSERT INTO tenants VALUES (?,?)').run('a', 'Tenant A');
    db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run('a@test.local', 'a', password('correct-password'));
    const cookie = (await req('/api/login', { body: { email: 'a@test.local', password: 'correct-password' } })).cookie;
    const pair = (await req('/api/pair/start', { body: {} })).data;
    await req('/api/pair/claim', { cookie, body: { code: pair.code, name: 'Barra' } });
    const first = (await req('/api/player/manifest', { secret: pair.secret })).data;
    assert.equal(first.paired, true);

    // Nada cambió: con wait=1 y el mismo "since", debe demorarse ALREDEDOR
    // de MANIFEST_WAIT_MS (600ms de prueba) antes de contestar lo mismo —
    // ni instantáneo (confirmaría que el long-poll no está activo) ni
    // colgado para siempre.
    const startIdle = Date.now();
    const idle = await req(`/api/player/manifest?since=${encodeURIComponent(first.version)}&wait=1`, { secret: pair.secret });
    const idleMs = Date.now() - startIdle;
    assert.equal(idle.data.version, first.version);
    assert.ok(idleMs >= 500, `debió esperar cerca del timeout de prueba (600ms), tardó ${idleMs}ms`);

    // Algo SÍ cambia mientras hay un long-poll esperando: debe contestar
    // casi al instante (mucho antes del timeout), con la versión nueva.
    const pollPromise = req(`/api/player/manifest?since=${encodeURIComponent(first.version)}&wait=1`, { secret: pair.secret });
    await new Promise(r => setTimeout(r, 80)); // deja que el long-poll ya esté esperando adentro
    const startChange = Date.now();
    await req('/api/devices/' + pair.id + '/playback', { cookie, body: { paused: true } });
    const changed = await pollPromise;
    const changeMs = Date.now() - startChange;
    assert.notEqual(changed.data.version, first.version);
    assert.equal(changed.data.paused, true);
    assert.ok(changeMs < 400, `debió contestar casi al instante al cambiar algo, tardó ${changeMs}ms`);

    // Sin wait=1 (comportamiento de siempre): contesta ya, sin demora,
    // aunque "since" sea igual a la versión actual.
    const startNoWait = Date.now();
    const noWait = await req(`/api/player/manifest?since=${encodeURIComponent(changed.data.version)}`, { secret: pair.secret });
    assert.ok(Date.now() - startNoWait < 100);
    assert.equal(noWait.data.version, changed.data.version);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
