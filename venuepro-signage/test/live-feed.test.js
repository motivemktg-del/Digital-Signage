import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server.js';
import { password } from '../store.js';

// Simula una cámara/go2rtc real: un servidor HTTP aparte que devuelve un
// "video" (unos bytes cualquiera) con su propio content-type — así se
// prueba el proxy de verdad, sin mockear fetch.
function fakeUpstream(status, contentType, body) {
  return new Promise(resolve => {
    const server = createServer((req, res) => { res.writeHead(status, { 'Content-Type': contentType }); res.end(body); });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Proxy de video en vivo (/live-feed): mismo origen, sin exponer la URL de la LAN al navegador', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-livefeed-test-'));
  const { app, db } = createApp({ STORAGE_MODE: 'local', PUBLIC_URL: 'http://localhost:3080', DATA_DIR: dir });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const upstream = await fakeUpstream(200, 'image/jpeg', Buffer.from('fake-mjpeg-bytes'));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/frame.jpg`;
  async function req(path, { body, cookie, method } = {}) {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    for (const id of ['a', 'b']) {
      db.prepare('INSERT INTO tenants VALUES (?,?)').run(id, 'Tenant ' + id);
      db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run(id + '@test.local', id, password('correct-password'));
    }
    const a = (await req('/api/login', { body: { email: 'a@test.local', password: 'correct-password' } })).cookie;
    const b = (await req('/api/login', { body: { email: 'b@test.local', password: 'correct-password' } })).cookie;

    const startRes = await fetch(base + '/api/pair/start', { method: 'POST' });
    const started = await startRes.json();
    await req('/api/pair/claim', { cookie: a, body: { code: started.code, name: 'Barra' } });
    const stateRes = await fetch(base + '/api/state', { headers: { Cookie: a } });
    const deviceId = (await stateRes.json()).devices[0].id;

    // Sin live_source: 409
    assert.equal((await req(`/api/devices/${deviceId}/live-feed`, { cookie: a })).status, 409);

    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: upstreamUrl } });

    // Tenant ajeno: 404 (nunca ve ni la existencia del proxy)
    assert.equal((await req(`/api/devices/${deviceId}/live-feed`, { cookie: b })).status, 404);

    // El propio dueño sí — y recibe EXACTAMENTE lo que sirve la cámara falsa
    const fed = await req(`/api/devices/${deviceId}/live-feed`, { cookie: a });
    assert.equal(fed.status, 200);
    assert.equal(fed.headers.get('content-type'), 'image/jpeg');
    assert.equal(fed.buf.toString(), 'fake-mjpeg-bytes');

    // Si la cámara está caída, el proxy responde 502 (no cuelga ni revienta)
    const dead = await fakeUpstream(200, 'image/jpeg', Buffer.from('x'));
    const deadUrl = `http://127.0.0.1:${dead.address().port}/x`;
    dead.close();
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: deadUrl } });
    assert.equal((await req(`/api/devices/${deviceId}/live-feed`, { cookie: a })).status, 502);
  } finally {
    server.close(); upstream.close(); await rm(dir, { recursive: true, force: true });
  }
});
