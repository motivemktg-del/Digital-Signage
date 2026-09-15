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
    // style siempre trae los 5 campos (colores/tamaño/grosor/fundido) con
    // sus defaults, aunque este POST no haya mandado "style" — así el
    // reproductor real nunca recibe un mix con estilo a medias.
    assert.deepEqual(state.devices[0].mix, {
      layout: 'lower', promo: null, logo: logoId, text: '2x1 en cervezas', muted: true,
      stripeColor: '#111111', textColor: '#ffffff', fontSize: 16, thickness: 64, fadeMs: 400,
    });

    // El manifiesto del reproductor trae la mezcla con la URL del logo resuelta
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    const manifest = deviceManifest(db, dev, 'http://localhost:3080');
    assert.equal(manifest.mix.text, '2x1 en cervezas');
    assert.ok(manifest.mix.logoUrl.includes('/api/player/media/' + logoId));

    // Micro-editor: layout "corner" (Esquina) + estilo custom, con valores
    // fuera de rango recortados a su límite en vez de rechazados de plano.
    const styled = await req(`/api/devices/${deviceId}/mix`, {
      cookie: a, body: { layout: 'corner', promo: null, logo: null, text: 'hola', muted: false,
        style: { stripeColor: '#FF00AA', textColor: 'no-es-un-color', fontSize: 999, thickness: -5, fadeMs: 50000 } },
    });
    assert.equal(styled.status, 200);
    state = (await req('/api/state', { cookie: a })).data;
    assert.equal(state.devices[0].mix.layout, 'corner');
    assert.equal(state.devices[0].mix.stripeColor, '#ff00aa'); // válido, se guarda en minúsculas
    assert.equal(state.devices[0].mix.textColor, '#ffffff'); // inválido -> default
    assert.equal(state.devices[0].mix.fontSize, 48); // recortado al máximo
    assert.equal(state.devices[0].mix.thickness, 20); // recortado al mínimo
    assert.equal(state.devices[0].mix.fadeMs, 3000); // recortado al máximo

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
    const tpl = await req('/api/mix-templates', { cookie: a, body: { name: 'Happy Hour', layout: 'split', promo: null, logo: logoId, text: 'Happy hour 5-7pm', muted: false, style: { stripeColor: '#00ff00', fontSize: 20 } } });
    assert.equal(tpl.status, 201);
    const tplList = (await req('/api/mix-templates', { cookie: a })).data;
    assert.equal(tplList.length, 1);
    // El estilo de la plantilla viaja completo (con defaults para lo que no se mandó)
    assert.deepEqual(tplList[0].style, { stripeColor: '#00ff00', textColor: '#ffffff', fontSize: 20, thickness: 64, fadeMs: 400 });
    assert.equal((await req('/api/mix-templates', { cookie: b })).data.length, 0);
    assert.equal((await req('/api/mix-templates', { cookie: b, body: { name: 'Ajena', layout: 'lower', promo: null, logo: logoId, text: '', muted: false } })).status, 400);

    // PATCH — plantilla aparte (no la que se usa más abajo en apply-all, para
    // no pisarle los valores que esas aserciones esperan).
    const tpl2 = await req('/api/mix-templates', { cookie: a, body: { name: 'Otra', layout: 'split', promo: null, logo: logoId, text: 'Original', muted: false, style: { stripeColor: '#00ff00', fontSize: 20 } } });
    // Solo con {name} (editor de "solo renombrar"): renombra sin tocar estilo
    assert.equal((await req(`/api/mix-templates/${tpl2.data.id}`, { cookie: a, method: 'PATCH', body: { name: 'Otra (renombrada)' } })).status, 200);
    let afterRename = (await req('/api/mix-templates', { cookie: a })).data.find(t => t.id === tpl2.data.id);
    assert.equal(afterRename.name, 'Otra (renombrada)');
    assert.deepEqual(afterRename.style, { stripeColor: '#00ff00', textColor: '#ffffff', fontSize: 20, thickness: 64, fadeMs: 400 });
    // Con layout presente (guardar la plantilla cargada en el Mezclador):
    // refresca TODO, incluido color y tamaño de letra — antes esto no existía
    // y ajustar esos atributos en el editor nunca se guardaba en la plantilla.
    const patched = await req(`/api/mix-templates/${tpl2.data.id}`, { cookie: a, method: 'PATCH', body: { name: 'Otra', layout: 'full', promo: null, logo: null, text: 'Nuevo texto', muted: true, style: { stripeColor: '#ff00ff', fontSize: 32 } } });
    assert.equal(patched.status, 200);
    const afterPatch = (await req('/api/mix-templates', { cookie: a })).data.find(t => t.id === tpl2.data.id);
    assert.equal(afterPatch.name, 'Otra');
    assert.equal(afterPatch.layout, 'full');
    assert.equal(afterPatch.logo, null);
    assert.equal(afterPatch.text, 'Nuevo texto');
    assert.equal(afterPatch.muted, true);
    assert.deepEqual(afterPatch.style, { stripeColor: '#ff00ff', textColor: '#ffffff', fontSize: 32, thickness: 64, fadeMs: 400 });
    assert.equal((await req(`/api/mix-templates/${tpl2.data.id}`, { cookie: b, method: 'PATCH', body: { name: 'x' } })).status, 404); // otro tenant
    assert.equal((await req(`/api/mix-templates/${tpl2.data.id}`, { cookie: a, method: 'PATCH', body: { name: 'x', layout: 'not-a-layout' } })).status, 400);
    assert.equal((await req(`/api/mix-templates/${tpl2.data.id}`, { cookie: a, method: 'DELETE' })).status, 200);

    // "Marca consistente en cada pantalla" — aplicar a muchas de un toque
    await req(`/api/devices/${deviceId}/live-source`, { cookie: a, body: { url: 'http://192.168.1.10:1984/stream.html?src=mivideo' } });
    const loc = (await req('/api/locations', { cookie: a, body: { name: 'Sucursal 2' } })).data;
    const pair2 = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair2.code, name: 'Barra 2', location: loc.id } });
    const pair3 = (await req('/api/pair/start', { method: 'POST' })).data;
    await req('/api/pair/claim', { cookie: a, body: { code: pair3.code, name: 'Sin señal' } });
    const devices = (await req('/api/state', { cookie: a })).data.devices;
    const device2Id = devices.find(d => d.name === 'Barra 2').id;
    const device3Id = devices.find(d => d.name === 'Sin señal').id;
    await req(`/api/devices/${device2Id}/live-source`, { cookie: a, body: { url: 'http://192.168.1.11:1984/stream.html?src=mivideo' } });
    // device3 se queda sin fuente en vivo — debe contarse como omitida, no fallar

    assert.equal((await req(`/api/mix-templates/${tpl.data.id}/apply-all`, { cookie: b, body: { location: null } })).status, 404); // otro tenant, no existe para él
    const applied = await req(`/api/mix-templates/${tpl.data.id}/apply-all`, { cookie: a, body: { location: null } });
    assert.equal(applied.status, 200);
    assert.equal(applied.data.applied, 2); // deviceId + device2Id (con señal en vivo)
    assert.equal(applied.data.skipped, 1); // device3Id, sin señal en vivo
    let updated = (await req('/api/state', { cookie: a })).data.devices;
    // El estilo custom de la plantilla (stripeColor/fontSize) viaja con ella al aplicarla
    assert.deepEqual(updated.find(d => d.id === device2Id).mix, {
      layout: 'split', promo: null, logo: logoId, text: 'Happy hour 5-7pm', muted: false,
      stripeColor: '#00ff00', textColor: '#ffffff', fontSize: 20, thickness: 64, fadeMs: 400,
    });
    assert.equal(updated.find(d => d.id === device3Id).mix, null);

    const appliedToLoc = await req(`/api/mix-templates/${tpl.data.id}/apply-all`, { cookie: a, body: { location: loc.id } });
    assert.equal(appliedToLoc.data.applied, 1); // solo device2Id vive en esa ubicación
    assert.equal(appliedToLoc.data.skipped, 0);
    assert.equal((await req(`/api/mix-templates/${tpl.data.id}/apply-all`, { cookie: a, body: { location: 'missing' } })).status, 404);

    assert.equal((await req(`/api/mix-templates/${tpl.data.id}`, { cookie: b, method: 'DELETE' })).status, 404);
    assert.equal((await req(`/api/mix-templates/${tpl.data.id}`, { cookie: a, method: 'DELETE' })).status, 200);
    assert.equal((await req('/api/mix-templates', { cookie: a })).data.length, 0);
  } finally {
    server.close(); await rm(dir, { recursive: true, force: true });
  }
});
