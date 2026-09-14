import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server.js';
import { password } from '../store.js';

// go2rtc habla WHEP para WebRTC: el navegador manda su oferta SDP por POST
// a /api/webrtc?src=X, go2rtc contesta con la respuesta SDP — nada de esto
// pasa por un WebSocket. El video en sí, una vez negociado, va directo por
// ICE entre el navegador y go2rtc (no por este proxy) — por eso solo
// funciona de verdad si el navegador está en la misma red; este endpoint
// solo pasa la oferta/respuesta SDP una vez, es un intercambio chiquito.
function fakeGo2rtcWhep() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/api/webrtc')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          res.writeHead(201, { 'Content-Type': 'application/sdp' });
          res.end('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=respuesta-a:' + body);
        });
      } else { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('WHEP (WebRTC) proxy: pasa la oferta SDP y devuelve la respuesta, aislado por tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-webrtc-test-'));
  const { app, db } = createApp({ STORAGE_MODE: 'local', PUBLIC_URL: 'http://localhost:3080', DATA_DIR: dir });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let go2rtc;
  async function jreq(path, { body, cookie, method } = {}) {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  async function sdpOffer(path, cookie, sdp) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/sdp', ...(cookie ? { Cookie: cookie } : {}) }, body: sdp });
    return { status: r.status, text: await r.text(), contentType: r.headers.get('content-type') };
  }
  try {
    for (const id of ['a', 'b']) {
      db.prepare('INSERT INTO tenants VALUES (?,?)').run(id, 'Tenant ' + id);
      db.prepare('INSERT INTO users (email,tenant,password) VALUES (?,?,?)').run(id + '@test.local', id, password('correct-password'));
    }
    const a = (await jreq('/api/login', { body: { email: 'a@test.local', password: 'correct-password' } })).cookie;
    const b = (await jreq('/api/login', { body: { email: 'b@test.local', password: 'correct-password' } })).cookie;

    go2rtc = await fakeGo2rtcWhep();
    const go2rtcUrl = `http://127.0.0.1:${go2rtc.address().port}/api/stream.mp4?src=mivideo`;

    // ---- Canal ----
    const channel = (await jreq('/api/channels', { cookie: a, body: { name: 'TV Bar', url: go2rtcUrl } })).data;
    const chanOffer = await sdpOffer(`/api/channels/${channel.id}/webrtc-offer`, a, 'oferta-de-prueba');
    assert.equal(chanOffer.status, 200);
    assert.equal(chanOffer.contentType, 'application/sdp; charset=utf-8');
    assert.ok(chanOffer.text.includes('oferta-de-prueba'), 'la respuesta debe traer la oferta reenviada de verdad');

    // Otro tenant no ve el canal
    assert.equal((await sdpOffer(`/api/channels/${channel.id}/webrtc-offer`, b, 'x')).status, 404);

    // ---- Pantalla ----
    const pair = (await jreq('/api/pair/start', { method: 'POST' })).data;
    await jreq('/api/pair/claim', { cookie: a, body: { code: pair.code, name: 'TV 1' } });
    const deviceId = (await jreq('/api/state', { cookie: a })).data.devices[0].id;

    // Sin fuente en vivo: 409
    assert.equal((await sdpOffer(`/api/devices/${deviceId}/webrtc-offer`, a, 'x')).status, 409);

    await jreq(`/api/devices/${deviceId}/live-channel`, { cookie: a, body: { channel: channel.id } });
    const devOffer = await sdpOffer(`/api/devices/${deviceId}/webrtc-offer`, a, 'oferta-pantalla');
    assert.equal(devOffer.status, 200);
    assert.ok(devOffer.text.includes('oferta-pantalla'));

    // Fuente que NO es go2rtc (no matchea el patrón .../api/stream.mp4): 409, no admite WebRTC
    await jreq(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: 'http://otra-camara.local/video' } });
    assert.equal((await sdpOffer(`/api/devices/${deviceId}/webrtc-offer`, a, 'x')).status, 409);
  } finally {
    server.close(); go2rtc?.close(); await rm(dir, { recursive: true, force: true });
  }
});
