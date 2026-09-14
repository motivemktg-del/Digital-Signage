import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

// Estas 3 rutas PATCH (locations, ptz-cameras, mix-templates) se agregaron
// para poder ELIMINAR los botones de eliminar expuestos en las listas del
// panel — la eliminación real ahora vive DENTRO de un editor, y para que
// ese editor tenga sentido (no solo un formulario de un solo uso) hacía
// falta poder editar estas 3 cosas, que antes solo se podían crear/borrar.
test('PATCH de locations/ptz-cameras/mix-templates: edita de verdad, aislado por tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-edit-routes-test-'));
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

    // Locations (no hay GET /api/locations propio — se leen desde /api/state, igual que el panel)
    const loc = (await req('/api/locations', { cookie: a, body: { name: 'Sucursal 1' } })).data;
    assert.equal((await req(`/api/locations/${loc.id}`, { cookie: b, method: 'PATCH', body: { name: 'Robada' } })).status, 404);
    assert.equal((await req(`/api/locations/${loc.id}`, { cookie: a, method: 'PATCH', body: { name: 'Sucursal Centro' } })).status, 200);
    assert.equal((await req('/api/state', { cookie: a })).data.locations.find(l => l.id === loc.id).name, 'Sucursal Centro');
    assert.equal((await req('/api/locations/missing', { cookie: a, method: 'PATCH', body: { name: 'x' } })).status, 404);

    // PTZ cameras
    const cam = (await req('/api/ptz-cameras', { cookie: a, body: { name: 'PTZ 1', onvifUrl: 'onvif://u:p@192.168.1.5' } })).data;
    assert.equal((await req(`/api/ptz-cameras/${cam.id}`, { cookie: b, method: 'PATCH', body: { name: 'Robada' } })).status, 404);
    const updated = await req(`/api/ptz-cameras/${cam.id}`, { cookie: a, method: 'PATCH', body: { name: 'PTZ Escenario', onvifUrl: 'onvif://u:p@192.168.1.9', rtspUrl: null, viewUrl: 'http://x/stream.mp4' } });
    assert.equal(updated.status, 200);
    const cams = (await req('/api/ptz-cameras', { cookie: a })).data;
    assert.equal(cams.find(c => c.id === cam.id).name, 'PTZ Escenario');
    assert.equal(cams.find(c => c.id === cam.id).onvif_url, 'onvif://u:p@192.168.1.9');
    assert.equal((await req(`/api/ptz-cameras/${cam.id}`, { cookie: a, method: 'PATCH', body: { name: 'x', onvifUrl: 'x'.repeat(600) } })).status, 400);

    // Mix templates
    const tpl = (await req('/api/mix-templates', { cookie: a, body: { name: 'Happy Hour', layout: 'lower', promo: null, logo: null, text: '', muted: false } })).data;
    assert.equal((await req(`/api/mix-templates/${tpl.id}`, { cookie: b, method: 'PATCH', body: { name: 'Robada' } })).status, 404);
    assert.equal((await req(`/api/mix-templates/${tpl.id}`, { cookie: a, method: 'PATCH', body: { name: 'Happy Hour 5-7pm' } })).status, 200);
    assert.equal((await req('/api/mix-templates', { cookie: a })).data.find(t => t.id === tpl.id).name, 'Happy Hour 5-7pm');
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
