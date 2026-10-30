/**
 * NEXUS-LPR — Enterprise License Plate Recognition Platform
 * Backend Engine: Node.js + Express + SQLite
 * Linares, Región del Maule, Chile
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { leerConfig } = require('./lib/config');
const { abrir } = require('./lib/db');
const bcrypt = require('bcryptjs');
const { crearAuth, sha256 } = require('./lib/auth');
const { analizar, normalizar } = require('./lib/plates');
const { crearNotificador } = require('./lib/notify');
const retencion = require('./lib/retention');
const respaldo = require('./lib/backup');
const { version } = require('./package.json');

function crearApp(cfg, log = console) {
  const db = abrir(cfg.dbPath);
  fs.mkdirSync(cfg.fotosDir, { recursive: true });
  const auth = crearAuth(db, cfg);
  const notificador = crearNotificador(cfg, log);

  // Primer arranque: crear administrador si no hay usuarios
  if (db.prepare('SELECT COUNT(*) n FROM usuarios').get().n === 0) {
    const pass = cfg.adminPasswordInicial || auth.nuevoSecreto(12);
    auth.crearUsuario('admin', pass, 'admin');
    if (!cfg.adminPasswordInicial) {
      log.log('='.repeat(64));
      log.log('[NEXUS-LPR] Usuario administrador creado');
      log.log(`            usuario: admin   contraseña: ${pass}`);
      log.log('            Guárdela y cámbiela desde el panel de Usuarios.');
      log.log('='.repeat(64));
    }
  }

  const auditar = (req, accion, detalle) => {
    db.prepare('INSERT INTO auditoria (usuario, accion, detalle, ip) VALUES (?, ?, ?, ?)')
      .run(req.usuario?.usuario || req.camara?.id || 'anónimo', accion,
        detalle == null ? null : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle)), req.ip);
  };

  const app = express();
  app.set('trust proxy', cfg.trustProxy); // Cloudflare Tunnel / proxy local (IP real y HTTPS)
  app.disable('x-powered-by');

  // Cabeceras de seguridad
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.use(express.json({ limit: '32kb' }));
  // JSON malformado → 400 en vez de caída
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    next(err);
  });

  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  // ================================================================ público
  app.get('/api/salud', (req, res) => res.json({ ok: true, version }));

  app.post('/api/login', auth.limiteLogin, (req, res) => {
    const { usuario, password } = req.body || {};
    const u = auth.verificar(usuario, password);
    if (!u) {
      auth.registrarFallo(req.ip);
      auditar(req, 'LOGIN_FALLIDO', { usuario: String(usuario || '').slice(0, 32) });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    auth.limpiarFallos(req.ip);
    const { token, expira } = auth.iniciarSesion(u.id);
    req.usuario = u;
    auditar(req, 'LOGIN');
    res.set('Set-Cookie', auth.cookieHeader(token, expira, req.secure));
    res.json({ usuario: u.usuario, rol: u.rol });
  });

  app.post('/api/logout', (req, res) => {
    auth.cerrarSesion(auth.leerCookie(req));
    res.set('Set-Cookie', auth.cookieHeader('', 0, req.secure));
    res.json({ ok: true });
  });

  // ============================================================== cámaras
  const formatoConfianza = (c) => {
    if (c == null || c === '') return 'N/D';
    const n = parseFloat(String(c).replace('%', ''));
    if (isNaN(n)) return 'N/D';
    return `${(n <= 1 ? n * 100 : n).toFixed(1)}%`;
  };

  /** POST /api/alerta — Ingesta lectura OCR, cruza hotlist, registra evento */
  app.post('/api/alerta', auth.requiereCamara, (req, res) => {
    const body = req.body || {};
    const lectura = typeof body.patente === 'string' ? body.patente : '';
    const a = analizar(lectura);
    if (!a) {
      return res.status(422).json({ error: 'Parámetro "patente" faltante o no corresponde a una patente chilena', lectura });
    }
    const patente = a.patente;
    const hit = db.prepare(`
      SELECT * FROM hotlist WHERE patente = ? AND (vence IS NULL OR vence >= date('now'))
    `).get(patente);
    const estado = hit ? `LISTA NEGRA: ${hit.motivo}` : 'ACCESO AUTORIZADO';
    // Hora de captura del nodo edge (lecturas reenviadas desde su cola offline);
    // se acepta solo si está dentro de las últimas 24 h y no en el futuro.
    const cap = Date.parse(body.capturado);
    const ahora = Date.now();
    const ts = !isNaN(cap) && cap <= ahora + 60e3 && cap >= ahora - 24 * 3600e3
      ? new Date(Math.min(cap, ahora)).toISOString() : new Date(ahora).toISOString();
    const pasaje = req.camara.ubicacion;

    const info = db.prepare(`
      INSERT INTO eventos (pasaje, patente, estado, nivel, confianza, camara, timestamp, lectura_cruda)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pasaje, patente, estado, hit ? hit.nivel : null, formatoConfianza(body.confianza),
      req.camara.id, ts, lectura.slice(0, 32));

    if (hit) {
      notificador.alerta({ patente, motivo: hit.motivo, nivel: hit.nivel, camara: req.camara.id, ubicacion: pasaje, timestamp: ts });
    }
    res.status(201).json({
      id: info.lastInsertRowid, patente, estado, alerta: Boolean(hit),
      nivel: hit ? hit.nivel : null, corregida: a.corregida,
    });
  });

  app.post('/api/heartbeat', auth.requiereCamara, (req, res) => {
    res.json({ ok: true, camara: req.camara.id, hora: new Date().toISOString() });
  });

  /** Foto de evidencia: solo para alertas, de la misma cámara, dentro de 10 min */
  app.put('/api/eventos/:id/foto', auth.requiereCamara,
    express.raw({ type: ['image/jpeg', 'image/jpg'], limit: '3mb' }), (req, res) => {
      const ev = db.prepare('SELECT * FROM eventos WHERE id = ?').get(Number(req.params.id));
      if (!ev || ev.camara !== req.camara.id) return res.status(404).json({ error: 'Evento no encontrado' });
      if (!ev.nivel) return res.status(409).json({ error: 'Solo se guardan fotos de alertas (minimización de datos)' });
      if (Date.now() - Date.parse(ev.timestamp) > 10 * 60e3) return res.status(409).json({ error: 'Plazo vencido' });
      if (!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body[0] !== 0xff || req.body[1] !== 0xd8) {
        return res.status(400).json({ error: 'Se espera una imagen JPEG' });
      }
      const archivo = `ev-${ev.id}.jpg`;
      fs.writeFileSync(path.join(cfg.fotosDir, archivo), req.body);
      db.prepare('UPDATE eventos SET foto = ? WHERE id = ?').run(archivo, ev.id);
      res.status(201).json({ ok: true });
    });

  // ========================================================= operadores
  const sesion = auth.requiereSesion();
  const soloAdmin = auth.requiereSesion('admin');

  app.get('/api/yo', sesion, (req, res) => res.json(req.usuario));

  const filaEvento = (e) => ({
    id: e.id, pasaje: e.pasaje, patente: e.patente, estado: e.estado, nivel: e.nivel,
    confianza: e.confianza, camara: e.camara, timestamp: e.timestamp, foto: Boolean(e.foto),
  });

  /** GET /api/eventos — Últimos 50 eventos (o desde un id) */
  app.get('/api/eventos', sesion, (req, res) => {
    const limite = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM eventos ORDER BY id DESC LIMIT ?').all(limite);
    res.json(rows.map(filaEvento));
  });

  app.get('/api/resumen', sesion, (req, res) => {
    const desde = new Date(Date.now() - 24 * 3600e3).toISOString();
    const r = db.prepare(`
      SELECT COUNT(*) lecturas,
             SUM(CASE WHEN nivel IS NOT NULL THEN 1 ELSE 0 END) alertas,
             AVG(CAST(REPLACE(confianza, '%', '') AS REAL)) confianza
      FROM eventos WHERE timestamp >= ?`).get(desde);
    const hotlist = db.prepare("SELECT COUNT(*) n FROM hotlist WHERE vence IS NULL OR vence >= date('now')").get().n;
    const limiteOnline = new Date(Date.now() - cfg.camaraOfflineMin * 60e3).toISOString();
    const cams = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN ultimo_contacto >= ? THEN 1 ELSE 0 END) online FROM camaras WHERE activa = 1`).get(limiteOnline);
    res.json({
      lecturas24h: r.lecturas || 0, alertas24h: r.alertas || 0,
      confianzaPromedio: r.confianza ? Number(r.confianza.toFixed(1)) : null,
      hotlist, camarasOnline: cams.online || 0, camarasTotal: cams.total || 0,
    });
  });

  // ---- hotlist
  app.get('/api/hotlist', sesion, (req, res) => {
    res.json(db.prepare("SELECT * FROM hotlist WHERE vence IS NULL OR vence >= date('now') ORDER BY id DESC").all());
  });

  /** POST /api/hotlist — Agrega o actualiza un encargo */
  app.post('/api/hotlist', sesion, (req, res) => {
    const body = req.body || {};
    const patente = normalizar(body.patente);
    if (!patente) return res.status(400).json({ error: 'Parámetro "patente" faltante o inválido' });
    const motivo = typeof body.motivo === 'string' && body.motivo.trim() ? body.motivo.trim().slice(0, 120) : 'Sin motivo especificado';
    const nivel = ['CRITICA', 'PRECAUCION'].includes(String(body.nivel || '').toUpperCase()) ? String(body.nivel).toUpperCase() : 'PRECAUCION';
    const vence = /^\d{4}-\d{2}-\d{2}$/.test(body.vence || '') ? body.vence : null;
    db.prepare(`
      INSERT INTO hotlist (patente, motivo, nivel, vence, creado_por) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(patente) DO UPDATE SET motivo = excluded.motivo, nivel = excluded.nivel,
        vence = excluded.vence, creado_por = excluded.creado_por
    `).run(patente, motivo, nivel, vence, req.usuario.usuario);
    auditar(req, 'HOTLIST_GUARDAR', { patente, motivo, nivel, vence });
    res.status(201).json({ patente, motivo, nivel, vence });
  });

  app.delete('/api/hotlist/:patente', sesion, (req, res) => {
    const patente = normalizar(req.params.patente);
    const r = db.prepare('DELETE FROM hotlist WHERE patente = ?').run(patente);
    if (!r.changes) return res.status(404).json({ error: 'No está en la hotlist' });
    auditar(req, 'HOTLIST_ELIMINAR', { patente });
    res.json({ ok: true });
  });

  // ---- historial (acceso a datos personales: siempre auditado)
  function consultarHistorial(q) {
    const where = [], args = [];
    if (q.patente) {
      const p = normalizar(q.patente);
      if (p) { where.push('patente = ?'); args.push(p); }
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(q.desde || '')) { where.push('timestamp >= ?'); args.push(new Date(q.desde).toISOString()); }
    if (/^\d{4}-\d{2}-\d{2}/.test(q.hasta || '')) {
      const h = new Date(q.hasta); if (q.hasta.length === 10) h.setUTCDate(h.getUTCDate() + 1);
      where.push('timestamp < ?'); args.push(h.toISOString());
    }
    if (q.camara) { where.push('camara = ?'); args.push(String(q.camara)); }
    if (q.solo_alertas === '1' || q.solo_alertas === 'true') where.push('nivel IS NOT NULL');
    const limite = Math.min(Number(q.limit) || 500, 5000);
    const sql = `SELECT * FROM eventos ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, limite);
  }

  app.get('/api/historial', sesion, (req, res) => {
    const filas = consultarHistorial(req.query);
    auditar(req, 'HISTORIAL_CONSULTA', { ...req.query, resultados: filas.length });
    res.json(filas.map(filaEvento));
  });

  app.get('/api/historial.csv', sesion, (req, res) => {
    const filas = consultarHistorial(req.query);
    auditar(req, 'HISTORIAL_EXPORTAR', { ...req.query, resultados: filas.length });
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['id,fecha_hora_local,patente,estado,nivel,confianza,camara,ubicacion']
      .concat(filas.map((e) => [e.id, new Date(e.timestamp).toLocaleString('es-CL', { timeZone: cfg.timezone }),
        e.patente, e.estado, e.nivel, e.confianza, e.camara, e.pasaje].map(esc).join(',')))
      .join('\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nexus-historial.csv"' });
    res.send('﻿' + csv);
  });

  /** Derecho de supresión (Ley 21.719): borra todos los registros de una patente */
  app.delete('/api/historial', soloAdmin, (req, res) => {
    const patente = normalizar(req.query.patente);
    if (!patente) return res.status(400).json({ error: 'Indique la patente a suprimir' });
    const fotos = db.prepare('SELECT foto FROM eventos WHERE patente = ? AND foto IS NOT NULL').all(patente);
    for (const { foto } of fotos) { try { fs.unlinkSync(path.join(cfg.fotosDir, path.basename(foto))); } catch { /* ok */ } }
    const r = db.prepare('DELETE FROM eventos WHERE patente = ?').run(patente);
    auditar(req, 'SUPRESION_DATOS', { patente, registros: r.changes, motivo: String(req.query.motivo || '').slice(0, 200) });
    res.json({ patente, eliminados: r.changes });
  });

  app.get('/api/eventos/:id/foto', sesion, (req, res) => {
    const ev = db.prepare('SELECT id, foto, patente FROM eventos WHERE id = ?').get(Number(req.params.id));
    if (!ev || !ev.foto) return res.status(404).json({ error: 'Sin foto' });
    auditar(req, 'FOTO_VER', { evento: ev.id, patente: ev.patente });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(cfg.fotosDir, path.basename(ev.foto)));
  });

  // ---- cámaras
  app.get('/api/camaras', sesion, (req, res) => {
    const limiteOnline = new Date(Date.now() - cfg.camaraOfflineMin * 60e3).toISOString();
    const rows = db.prepare('SELECT id, nombre, ubicacion, activa, ultimo_contacto, creada FROM camaras ORDER BY id').all();
    res.json(rows.map((c) => ({ ...c, activa: Boolean(c.activa), online: Boolean(c.activa && c.ultimo_contacto && c.ultimo_contacto >= limiteOnline) })));
  });

  app.post('/api/camaras', soloAdmin, (req, res) => {
    const { id, nombre, ubicacion } = req.body || {};
    try {
      const apiKey = auth.crearCamara(String(id || '').toUpperCase().trim(), nombre, ubicacion);
      auditar(req, 'CAMARA_CREAR', { id, nombre, ubicacion });
      res.status(201).json({ id: String(id).toUpperCase().trim(), apiKey });
    } catch (e) {
      res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Ya existe una cámara con ese ID' : e.message });
    }
  });

  app.post('/api/camaras/:id/rotar', soloAdmin, (req, res) => {
    const apiKey = auth.rotarClave(req.params.id);
    if (!apiKey) return res.status(404).json({ error: 'Cámara no encontrada' });
    auditar(req, 'CAMARA_ROTAR_CLAVE', { id: req.params.id });
    res.json({ id: req.params.id, apiKey });
  });

  app.patch('/api/camaras/:id', soloAdmin, (req, res) => {
    const activa = req.body && typeof req.body.activa === 'boolean' ? (req.body.activa ? 1 : 0) : null;
    if (activa === null) return res.status(400).json({ error: 'Se espera { activa: true|false }' });
    const r = db.prepare('UPDATE camaras SET activa = ? WHERE id = ?').run(activa, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Cámara no encontrada' });
    auditar(req, activa ? 'CAMARA_ACTIVAR' : 'CAMARA_DESACTIVAR', { id: req.params.id });
    res.json({ ok: true });
  });

  // ---- usuarios
  app.get('/api/usuarios', soloAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, usuario, rol, activo, creado FROM usuarios ORDER BY id').all()
      .map((u) => ({ ...u, activo: Boolean(u.activo) })));
  });

  app.post('/api/usuarios', soloAdmin, (req, res) => {
    const { usuario, password, rol } = req.body || {};
    try {
      auth.crearUsuario(usuario, password, rol || 'operador');
      auditar(req, 'USUARIO_CREAR', { usuario, rol: rol || 'operador' });
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'Ese usuario ya existe' : e.message });
    }
  });

  app.patch('/api/usuarios/:id', soloAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { activo } = req.body || {};
    if (typeof activo === 'boolean') {
      if (!activo && u.id === req.usuario.id) return res.status(400).json({ error: 'No puede desactivarse a sí mismo' });
      db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, id);
      if (!activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
      auditar(req, activo ? 'USUARIO_ACTIVAR' : 'USUARIO_DESACTIVAR', { usuario: u.usuario });
    }
    res.json({ ok: true });
  });

  /** Cambiar la propia contraseña */
  app.post('/api/yo/password', sesion, (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!auth.verificar(req.usuario.usuario, actual)) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    if (typeof nueva !== 'string' || nueva.length < 10) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
    db.prepare('UPDATE usuarios SET hash = ? WHERE id = ?').run(bcrypt.hashSync(nueva, 12), req.usuario.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token_hash != ?')
      .run(req.usuario.id, sha256(req.sessionToken));
    auditar(req, 'PASSWORD_CAMBIO');
    res.json({ ok: true });
  });

  app.get('/api/auditoria', soloAdmin, (req, res) => {
    const limite = Math.min(Number(req.query.limit) || 200, 2000);
    res.json(db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?').all(limite));
  });

  app.get('/api/config', sesion, (req, res) => {
    res.json({
      retencionDias: cfg.retentionDays, retencionAlertasDias: cfg.alertRetentionDays,
      telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), zonaHoraria: cfg.timezone, version,
    });
  });

  // 404 API
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // Error genérico: nunca botar el proceso
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    log.error('[NEXUS-LPR] Error:', err);
    res.status(500).json({ error: 'Error interno' });
  });

  return { app, db, auth };
}

if (require.main === module) {
  const cfg = leerConfig();
  const { app, db } = crearApp(cfg);
  retencion.programar(db, cfg, console);
  respaldo.programar(db, cfg, console);
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`[NEXUS-LPR] v${version} operativo en http://${cfg.host}:${cfg.port}`);
    console.log(`[NEXUS-LPR] Datos en ${cfg.dataDir} · retención ${cfg.retentionDays} días (alertas ${cfg.alertRetentionDays})`);
  });
  const cerrar = () => { server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGTERM', cerrar);
  process.on('SIGINT', cerrar);
}

module.exports = { crearApp };
