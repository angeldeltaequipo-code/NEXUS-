/**
 * NEXUS-LPR — Respaldo diario de la base de datos (copia en caliente, consistente).
 * Guarda data/respaldos/nexus-AAAA-MM-DD.db y conserva BACKUP_KEEP_DAYS días.
 * Copie periódicamente esa carpeta FUERA del equipo (pendrive, nube cifrada).
 */
const fs = require('fs');
const path = require('path');

async function respaldar(db, cfg, log = console) {
  const dir = path.join(cfg.dataDir, 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: cfg.timezone }); // AAAA-MM-DD
  const destino = path.join(dir, `nexus-${fecha}.db`);
  await db.backup(destino);
  const limite = Date.now() - cfg.backupDias * 86400e3;
  for (const f of fs.readdirSync(dir)) {
    const ruta = path.join(dir, f);
    if (/^nexus-\d{4}-\d{2}-\d{2}\.db$/.test(f) && fs.statSync(ruta).mtimeMs < limite) fs.unlinkSync(ruta);
  }
  log.log(`[RESPALDO] ${destino}`);
  return destino;
}

function programar(db, cfg, log) {
  const correr = () => respaldar(db, cfg, log).catch((e) => log.error(`[RESPALDO] Error: ${e.message}`));
  setTimeout(correr, 60e3).unref();                 // 1 min después de arrancar
  return setInterval(correr, 24 * 3600e3).unref();  // y luego cada 24 h
}

module.exports = { respaldar, programar };
