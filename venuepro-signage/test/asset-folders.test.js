import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { password } from '../store.js';

test('Carpetas de biblioteca: aislamiento por tenant, no borra archivos, bloquea si no está vacía', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signage-folders-test-'));
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

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(base + '/api/assets', { method: 'POST', headers: { Cookie: a, 'Content-Type': 'image/png', 'X-File-Name': 'promo.png' }, body: png });
    const assetId = (await upload.json()).id;

    // Crear carpeta
    const folder = await req('/api/asset-folders', { cookie: a, body: { name: 'Promos' } });
    assert.equal(folder.status, 201);
    assert.equal((await req('/api/asset-folders', { cookie: a })).data.length, 1);
    assert.equal((await req('/api/asset-folders', { cookie: b })).data.length, 0); // aislado por tenant

    // Mover el archivo a la carpeta
    assert.equal((await req(`/api/assets/${assetId}/folder`, { cookie: b, body: { folder: folder.data.id } })).status, 404); // b no la ve
    assert.equal((await req(`/api/assets/${assetId}/folder`, { cookie: a, body: { folder: 'missing' } })).status, 404);
    assert.equal((await req(`/api/assets/${assetId}/folder`, { cookie: a, body: { folder: folder.data.id } })).status, 200);
    let assets = (await req('/api/state', { cookie: a })).data.assets;
    assert.equal(assets.find(x => x.id === assetId).folder, folder.data.id);

    // No se puede borrar una carpeta con archivos dentro
    assert.equal((await req(`/api/asset-folders/${folder.data.id}`, { cookie: a, method: 'DELETE' })).status, 409);

    // Sacar el archivo de la carpeta (folder:null) y ahí sí se puede borrar
    assert.equal((await req(`/api/assets/${assetId}/folder`, { cookie: a, body: { folder: null } })).status, 200);
    assets = (await req('/api/state', { cookie: a })).data.assets;
    assert.equal(assets.find(x => x.id === assetId).folder, null);
    assert.equal((await req(`/api/asset-folders/${folder.data.id}`, { cookie: a, method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/asset-folders', { cookie: a })).data.length, 0);

    // Borrar una carpeta ajena o inexistente da 404
    assert.equal((await req(`/api/asset-folders/missing`, { cookie: a, method: 'DELETE' })).status, 404);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
