#!/usr/bin/env node
/**
 * Registra una cámara y muestra su API key (una sola vez).
 * Uso: node scripts/agregar-camara.js CAM-EDGE-01 "Acceso Norte" "Pasaje Piloto - Linares"
 */
const { leerConfig } = require('../lib/config');
const { abrir } = require('../lib/db');
const { crearAuth } = require('../lib/auth');

const [id, nombre, ubicacion] = process.argv.slice(2);
if (!id) {
  console.error('Uso: node scripts/agregar-camara.js <ID> "<nombre>" "<ubicación>"');
  process.exit(1);
}
const cfg = leerConfig();
const db = abrir(cfg.dbPath);
const auth = crearAuth(db, cfg);
try {
  const key = auth.crearCamara(id.toUpperCase(), nombre, ubicacion);
  db.prepare('INSERT INTO auditoria (usuario, accion, detalle) VALUES (?, ?, ?)')
    .run('consola', 'CAMARA_CREAR', JSON.stringify({ id, nombre, ubicacion }));
  console.log(`Cámara ${id.toUpperCase()} registrada.`);
  console.log(`API key (guárdela en el .env del nodo edge, no se vuelve a mostrar):\n\n  ${key}\n`);
} catch (e) {
  console.error(/UNIQUE/.test(e.message) ? 'Ya existe una cámara con ese ID' : e.message);
  process.exit(1);
}
