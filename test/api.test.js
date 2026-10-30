const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearApp } = require('../server');
const { purgar } = require('../lib/retention');

const silencio = { log() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
const cfg = {
  port: 0, host: '127.0.0.1', dataDir: dir, dbPath: path.join(dir, 'nexus.db'), fotosDir: path.join(dir, 'fotos'),
  timezone: 'America/Santiago', sessionHours: 1, cookieSecure: false,
  retentionDays: 30, alertRetentionDays: 365, auditRetentionDays: 730, camaraOfflineMin: 3,
  telegramToken: '', telegramChatId: '', notifyCooldownMin: 5, adminPasswordInicial: 'clave-admin-segura',
};
const { app, db } = crearApp(cfg, silencio);
let base, server, cookie, apiKey;

const req = async (metodo, ruta, { body, headers = {}, raw } = {}) => {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + ruta, { method: metodo, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const texto = await r.text();
  let json; try { json = JSON.parse(texto); } catch { json = texto; }
  return { status: r.status, json, headers: r.headers };
};

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('las rutas de datos exigen sesión', async () => {
  assert.equal((await req('GET', '/api/eventos')).status, 401);
  assert.equal((await req('GET', '/api/hotlist')).status, 401);
  assert.equal((await req('GET', '/api/historial')).status, 401);
});

test('login incorrecto y correcto', async () => {
  assert.equal((await req('POST', '/api/login', { body: { usuario: 'admin', password: 'mala' } })).status, 401);
  const r = await req('POST', '/api/login', { body: { usuario: 'admin', password: 'clave-admin-segura' } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await req('GET', '/api/yo', { headers: { Cookie: cookie } })).json.rol, 'admin');
});

test('admin registra cámara y obtiene API key', async () => {
  const r = await req('POST', '/api/camaras', { headers: { Cookie: cookie }, body: { id: 'cam-edge-01', nombre: 'Acceso', ubicacion: 'Pasaje Piloto - Linares' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 'CAM-EDGE-01');
  apiKey = r.json.apiKey;
  assert.match(apiKey, /^nxk_/);
});

test('/api/alerta exige API key válida', async () => {
  assert.equal((await req('POST', '/api/alerta', { body: { patente: 'BBCC12' } })).status, 401);
  assert.equal((await req('POST', '/api/alerta', { body: { patente: 'BBCC12' }, headers: { 'X-API-Key': 'nxk_falsa' } })).status, 401);
});

test('hotlist normaliza y el cruce funciona con cualquier escritura', async () => {
  const h = await req('POST', '/api/hotlist', { headers: { Cookie: cookie }, body: { patente: 'rjkt 83', motivo: 'Encargo Vigente por Robo', nivel: 'CRITICA' } });
  assert.equal(h.json.patente, 'RJKT-83');
  const a = await req('POST', '/api/alerta', { headers: { 'X-API-Key': apiKey }, body: { patente: 'RJKTB3', confianza: 0.973 } });
  assert.equal(a.status, 201);
  assert.equal(a.json.alerta, true);
  assert.equal(a.json.patente, 'RJKT-83');
  assert.equal(a.json.estado, 'LISTA NEGRA: Encargo Vigente por Robo');
  const ok = await req('POST', '/api/alerta', { headers: { 'X-API-Key': apiKey }, body: { patente: 'gtkx-45', confianza: '98.2%' } });
  assert.equal(ok.json.estado, 'ACCESO AUTORIZADO');
});

test('resiliencia: parámetros faltantes o basura no botan el servidor', async () => {
  const k = { 'X-API-Key': apiKey };
  assert.equal((await req('POST', '/api/alerta', { headers: k, body: {} })).status, 422);
  assert.equal((await req('POST', '/api/alerta', { headers: { ...k, 'Content-Type': 'application/json' }, raw: '{malo' })).status, 400);
  assert.equal((await req('POST', '/api/alerta', { headers: k, body: { patente: 12345 } })).status, 422);
  assert.equal((await req('GET', '/api/salud')).json.ok, true);
});

test('foto de evidencia: solo JPEG y solo en alertas', async () => {
  const k = { 'X-API-Key': apiKey };
  const alerta = (await req('POST', '/api/alerta', { headers: k, body: { patente: 'RJKT83' } })).json;
  const normal = (await req('POST', '/api/alerta', { headers: k, body: { patente: 'ZZXY11' } })).json;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
  const subir = (id, raw) => req('PUT', `/api/eventos/${id}/foto`, { headers: { ...k, 'Content-Type': 'image/jpeg' }, raw });
  assert.equal((await subir(normal.id, jpeg)).status, 409);
  assert.equal((await subir(alerta.id, Buffer.from('no es imagen pero es largo'.repeat(10)))).status, 400);
  assert.equal((await subir(alerta.id, jpeg)).status, 201);
  const f = await fetch(`${base}/api/eventos/${alerta.id}/foto`, { headers: { Cookie: cookie } });
  assert.equal(f.status, 200);
});

test('historial filtra por patente y queda auditado', async () => {
  const r = await req('GET', '/api/historial?patente=rjkt-83', { headers: { Cookie: cookie } });
  assert.ok(r.json.length >= 2);
  assert.ok(r.json.every((e) => e.patente === 'RJKT-83'));
  const aud = (await req('GET', '/api/auditoria', { headers: { Cookie: cookie } })).json;
  assert.ok(aud.some((a) => a.accion === 'HISTORIAL_CONSULTA'));
  const csv = await fetch(`${base}/api/historial.csv?solo_alertas=1`, { headers: { Cookie: cookie } });
  assert.match(await csv.text(), /RJKT-83/);
});

test('operador no puede administrar cámaras ni usuarios', async () => {
  assert.equal((await req('POST', '/api/usuarios', { headers: { Cookie: cookie }, body: { usuario: 'guardia', password: 'clave-guardia-123', rol: 'operador' } })).status, 201);
  const l = await req('POST', '/api/login', { body: { usuario: 'guardia', password: 'clave-guardia-123' } });
  const c2 = l.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('POST', '/api/camaras', { headers: { Cookie: c2 }, body: { id: 'CAM-X' } })).status, 403);
  assert.equal((await req('GET', '/api/usuarios', { headers: { Cookie: c2 } })).status, 403);
  assert.equal((await req('GET', '/api/eventos', { headers: { Cookie: c2 } })).status, 200);
});

test('retención borra lecturas antiguas pero conserva alertas recientes', () => {
  const viejo = new Date(Date.now() - 40 * 86400e3).toISOString();
  db.prepare("INSERT INTO eventos (pasaje, patente, estado, camara, timestamp) VALUES ('x','OLDD-11','ACCESO AUTORIZADO','CAM-EDGE-01',?)").run(viejo);
  db.prepare("INSERT INTO eventos (pasaje, patente, estado, nivel, camara, timestamp) VALUES ('x','OLDD-22','LISTA NEGRA: x','CRITICA','CAM-EDGE-01',?)").run(viejo);
  const r = purgar(db, cfg, silencio);
  assert.equal(r.normales, 1);
  assert.equal(r.alertas, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM eventos WHERE patente='OLDD-22'").get().n, 1);
});

test('supresión de datos de una patente (solo admin, auditada)', async () => {
  const r = await req('DELETE', '/api/historial?patente=gtkx45&motivo=solicitud%201', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.json.eliminados, 1);
  const h = await req('GET', '/api/historial?patente=GTKX-45', { headers: { Cookie: cookie } });
  assert.equal(h.json.length, 0);
  const aud = (await req('GET', '/api/auditoria', { headers: { Cookie: cookie } })).json;
  assert.ok(aud.some((a) => a.accion === 'SUPRESION_DATOS'));
});

test('logout invalida la sesión', async () => {
  await req('POST', '/api/logout', { headers: { Cookie: cookie } });
  assert.equal((await req('GET', '/api/eventos', { headers: { Cookie: cookie } })).status, 401);
});
