/** NEXUS-LPR — Autenticación: usuarios (sesiones) y cámaras (API keys) */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'nexus_sesion';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nuevoSecreto = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function crearAuth(db, cfg) {
  const HASH_FICTICIO = bcrypt.hashSync(nuevoSecreto(), 12);

  // ---------------------------------------------------------------- usuarios
  function crearUsuario(usuario, password, rol = 'operador') {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(usuario || '')) throw new Error('Usuario inválido (3–32 caracteres: letras, números, . _ -)');
    if (typeof password !== 'string' || password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
    if (!['admin', 'operador'].includes(rol)) throw new Error('Rol inválido');
    const hash = bcrypt.hashSync(password, 12);
    return db.prepare('INSERT INTO usuarios (usuario, hash, rol) VALUES (?, ?, ?)').run(usuario, hash, rol);
  }

  function verificar(usuario, password) {
    const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario || '');
    // Comparación siempre ejecutada para no filtrar qué usuarios existen por tiempo de respuesta
    const ok = bcrypt.compareSync(String(password || ''), u ? u.hash : HASH_FICTICIO);
    return ok && u ? u : null;
  }

  function iniciarSesion(usuarioId) {
    const token = nuevoSecreto();
    const expira = new Date(Date.now() + cfg.sessionHours * 3600e3).toISOString();
    db.prepare('INSERT INTO sesiones (token_hash, usuario_id, expira) VALUES (?, ?, ?)').run(sha256(token), usuarioId, expira);
    return { token, expira };
  }

  function cerrarSesion(token) {
    if (token) db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(sha256(token));
  }

  function leerCookie(req) {
    const raw = req.headers.cookie || '';
    for (const parte of raw.split(';')) {
      const [k, ...v] = parte.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  /** secure: true cuando la conexión llega por HTTPS (ej. Cloudflare Tunnel) */
  function cookieHeader(token, expira, secure = false) {
    const partes = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (cfg.cookieSecure || secure) partes.push('Secure');
    partes.push(token ? `Expires=${new Date(expira).toUTCString()}` : 'Max-Age=0');
    return partes.join('; ');
  }

  /** Middleware: exige sesión válida. Opcionalmente un rol. */
  function requiereSesion(rol) {
    return (req, res, next) => {
      const token = leerCookie(req);
      if (!token) return res.status(401).json({ error: 'No autenticado' });
      const fila = db.prepare(`
        SELECT u.id, u.usuario, u.rol, s.expira FROM sesiones s
        JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token_hash = ? AND u.activo = 1`).get(sha256(token));
      if (!fila || fila.expira < new Date().toISOString()) {
        if (fila) cerrarSesion(token);
        return res.status(401).json({ error: 'Sesión expirada' });
      }
      if (rol && fila.rol !== rol) return res.status(403).json({ error: 'Permiso insuficiente' });
      req.usuario = { id: fila.id, usuario: fila.usuario, rol: fila.rol };
      req.sessionToken = token;
      next();
    };
  }

  // ---------------------------------------------------------------- cámaras
  function crearCamara(id, nombre, ubicacion) {
    if (!/^[A-Z0-9-]{3,32}$/.test(id || '')) throw new Error('ID de cámara inválido (ej. CAM-EDGE-01)');
    const apiKey = `nxk_${nuevoSecreto(24)}`;
    db.prepare('INSERT INTO camaras (id, nombre, ubicacion, api_key_hash) VALUES (?, ?, ?, ?)')
      .run(id, (nombre || id).trim(), (ubicacion || 'Sin ubicación').trim(), sha256(apiKey));
    return apiKey; // se muestra UNA sola vez
  }

  function rotarClave(id) {
    const apiKey = `nxk_${nuevoSecreto(24)}`;
    const r = db.prepare('UPDATE camaras SET api_key_hash = ? WHERE id = ?').run(sha256(apiKey), id);
    return r.changes ? apiKey : null;
  }

  /** Middleware: exige header X-API-Key de una cámara activa. */
  function requiereCamara(req, res, next) {
    const key = req.get('X-API-Key');
    if (!key) return res.status(401).json({ error: 'Falta X-API-Key' });
    const cam = db.prepare('SELECT * FROM camaras WHERE api_key_hash = ? AND activa = 1').get(sha256(key));
    if (!cam) return res.status(401).json({ error: 'API key inválida o cámara desactivada' });
    db.prepare('UPDATE camaras SET ultimo_contacto = ? WHERE id = ?').run(new Date().toISOString(), cam.id);
    req.camara = cam;
    next();
  }

  // --------------------------------------------- límite de intentos de login
  const intentos = new Map(); // ip -> { n, hasta }
  function limiteLogin(req, res, next) {
    const ip = req.ip;
    const r = intentos.get(ip);
    if (r && r.hasta > Date.now() && r.n >= 5) {
      return res.status(429).json({ error: 'Demasiados intentos. Espere 15 minutos.' });
    }
    next();
  }
  function registrarFallo(ip) {
    const r = intentos.get(ip);
    if (!r || r.hasta < Date.now()) intentos.set(ip, { n: 1, hasta: Date.now() + 15 * 60e3 });
    else r.n++;
  }
  function limpiarFallos(ip) { intentos.delete(ip); }

  return {
    crearUsuario, verificar, iniciarSesion, cerrarSesion, leerCookie, cookieHeader,
    requiereSesion, crearCamara, rotarClave, requiereCamara,
    limiteLogin, registrarFallo, limpiarFallos, nuevoSecreto,
  };
}

module.exports = { crearAuth, sha256 };
