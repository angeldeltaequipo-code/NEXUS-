#!/usr/bin/env node
/**
 * Crea un usuario del panel, o restablece su contraseña si ya existe.
 * Uso: node scripts/crear-usuario.js <usuario> <contraseña> [admin|operador]
 */
const bcrypt = require('bcryptjs');
const { leerConfig } = require('../lib/config');
const { abrir } = require('../lib/db');
const { crearAuth } = require('../lib/auth');

const [usuario, password, rol = 'operador'] = process.argv.slice(2);
if (!usuario || !password) {
  console.error('Uso: node scripts/crear-usuario.js <usuario> <contraseña> [admin|operador]');
  process.exit(1);
}
const cfg = leerConfig();
const db = abrir(cfg.dbPath);
const existe = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario);
try {
  if (existe) {
    if (password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
    db.prepare('UPDATE usuarios SET hash = ?, rol = ?, activo = 1 WHERE id = ?').run(bcrypt.hashSync(password, 12), rol, existe.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(existe.id);
    console.log(`Contraseña de "${usuario}" restablecida (rol: ${rol}).`);
  } else {
    crearAuth(db, cfg).crearUsuario(usuario, password, rol);
    console.log(`Usuario "${usuario}" creado (rol: ${rol}).`);
  }
  db.prepare('INSERT INTO auditoria (usuario, accion, detalle) VALUES (?, ?, ?)')
    .run('consola', existe ? 'USUARIO_RESET' : 'USUARIO_CREAR', JSON.stringify({ usuario, rol }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
