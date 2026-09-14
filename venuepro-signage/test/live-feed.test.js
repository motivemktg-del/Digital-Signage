import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp, deviceManifest } from '../server.js';
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

// Simula go2rtc de verdad: sirve distinto contenido en /api/stream.mp4 y
// /api/frame.jpeg (para probar que ?mode=snapshot pide la foto, no el video).
function fakeGo2rtc() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const path = req.url.split('?')[0];
      if (path === '/api/stream.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end('fake-mp4-bytes'); }
      else if (path === '/api/frame.jpeg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end('fake-jpeg-bytes'); }
      else { res.writeHead(404); res.end(); }
    });
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
  let go2rtc;
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

    // ?mode=snapshot deriva /api/stream.mp4 -> /api/frame.jpeg en la misma URL,
    // para el respaldo de Safari (no reproduce MP4 en vivo sin duración fija)
    go2rtc = await fakeGo2rtc();
    const go2rtcUrl = `http://127.0.0.1:${go2rtc.address().port}/api/stream.mp4?src=mivideo`;
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: go2rtcUrl } });
    const video = await req(`/api/devices/${deviceId}/live-feed`, { cookie: a });
    assert.equal(video.buf.toString(), 'fake-mp4-bytes');
    const snapshot = await req(`/api/devices/${deviceId}/live-feed?mode=snapshot`, { cookie: a });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('content-type'), 'image/jpeg');
    assert.equal(snapshot.buf.toString(), 'fake-jpeg-bytes');

    // El manifiesto que consume la APK trae la URL RTSP derivada (mucho
    // menos buffer que el MP4 progresivo que usa el proxy del panel)
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    const manifest = deviceManifest(db, dev, 'http://localhost:3080');
    assert.equal(manifest.liveSourceRtsp, 'rtsp://127.0.0.1:8554/mivideo'); // 8554 = puerto RTSP fijo de go2rtc, no el de la API
    go2rtc.close();

    // Si la cámara está caída, el proxy responde 502 (no cuelga ni revienta)
    const dead = await fakeUpstream(200, 'image/jpeg', Buffer.from('x'));
    const deadUrl = `http://127.0.0.1:${dead.address().port}/x`;
    dead.close();
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: deadUrl } });
    assert.equal((await req(`/api/devices/${deviceId}/live-feed`, { cookie: a })).status, 502);
  } finally {
    server.close(); upstream.close(); go2rtc.close?.(); await rm(dir, { recursive: true, force: true });
  }
});
