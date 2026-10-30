/** NEXUS-LPR — Base de datos SQLite (esquema + migraciones simples) */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function abrir(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');   // lecturas concurrentes, resistente a cortes de luz
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS camaras (
      id           TEXT PRIMARY KEY,            -- ej. CAM-EDGE-01
      nombre       TEXT NOT NULL,
      ubicacion    TEXT NOT NULL,               -- ej. Pasaje Piloto - Linares
      api_key_hash TEXT NOT NULL UNIQUE,
      activa       INTEGER NOT NULL DEFAULT 1,
      ultimo_contacto TEXT,
      creada       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS eventos (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pasaje    TEXT,
      patente   TEXT NOT NULL,
      estado    TEXT NOT NULL,                  -- ACCESO AUTORIZADO | LISTA NEGRA: <motivo>
      nivel     TEXT,                           -- CRITICA | PRECAUCION | NULL
      confianza TEXT,
      camara    TEXT,
      timestamp TEXT NOT NULL,                  -- ISO 8601 UTC
      lectura_cruda TEXT,
      foto      TEXT                            -- archivo de evidencia (solo alertas)
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_ts ON eventos(timestamp);
    CREATE INDEX IF NOT EXISTS idx_eventos_patente ON eventos(patente);

    CREATE TABLE IF NOT EXISTS hotlist (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      patente TEXT NOT NULL UNIQUE,
      motivo  TEXT NOT NULL,
      nivel   TEXT NOT NULL CHECK (nivel IN ('CRITICA','PRECAUCION')),
      vence   TEXT,                             -- fecha opcional de expiración (YYYY-MM-DD)
      creado_por TEXT,
      creado  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario  TEXT NOT NULL UNIQUE,
      hash     TEXT NOT NULL,
      rol      TEXT NOT NULL CHECK (rol IN ('admin','operador')),
      activo   INTEGER NOT NULL DEFAULT 1,
      creado   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS sesiones (
      token_hash TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira     TEXT NOT NULL
    );

    -- Registro de accesos y cambios (exigible bajo Ley 21.719)
    CREATE TABLE IF NOT EXISTS auditoria (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      usuario TEXT,
      accion  TEXT NOT NULL,
      detalle TEXT,
      ip      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auditoria_ts ON auditoria(ts);
  `);
  return db;
}

module.exports = { abrir };
