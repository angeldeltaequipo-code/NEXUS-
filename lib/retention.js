/**
 * NEXUS-LPR — Retención automática de datos (Ley 21.719: plazo limitado,
 * proporcional a la finalidad).
 *
 *  - Lecturas sin alerta:   RETENTION_DAYS        (por defecto 30 días)
 *  - Lecturas con alerta:   ALERT_RETENTION_DAYS  (por defecto 365 días)
 *  - Auditoría:             AUDIT_RETENTION_DAYS  (por defecto 730 días)
 *  - Sesiones expiradas y hotlist vencida se limpian siempre.
 */
const fs = require('fs');
const path = require('path');

function purgar(db, cfg, log = console) {
  const ahora = Date.now();
  const antes = (dias) => new Date(ahora - dias * 86400e3).toISOString();

  // Fotos de evidencia de eventos que se van a borrar
  const conFoto = db.prepare(`
    SELECT foto FROM eventos WHERE foto IS NOT NULL AND (
      (nivel IS NULL AND timestamp < ?) OR (nivel IS NOT NULL AND timestamp < ?))
  `).all(antes(cfg.retentionDays), antes(cfg.alertRetentionDays));
  for (const { foto } of conFoto) {
    try { fs.unlinkSync(path.join(cfg.fotosDir, path.basename(foto))); } catch { /* ya no existe */ }
  }

  const tx = db.transaction(() => ({
    normales: db.prepare('DELETE FROM eventos WHERE nivel IS NULL AND timestamp < ?').run(antes(cfg.retentionDays)).changes,
    alertas: db.prepare('DELETE FROM eventos WHERE nivel IS NOT NULL AND timestamp < ?').run(antes(cfg.alertRetentionDays)).changes,
    auditoria: db.prepare('DELETE FROM auditoria WHERE ts < ?').run(antes(cfg.auditRetentionDays)).changes,
    sesiones: db.prepare('DELETE FROM sesiones WHERE expira < ?').run(new Date(ahora).toISOString()).changes,
    hotlistVencida: db.prepare("DELETE FROM hotlist WHERE vence IS NOT NULL AND vence < date('now')").run().changes,
  }));
  const r = tx();
  if (r.normales || r.alertas || r.hotlistVencida) {
    db.prepare('INSERT INTO auditoria (usuario, accion, detalle) VALUES (?, ?, ?)')
      .run('sistema', 'RETENCION_PURGA', JSON.stringify(r));
    log.log(`[RETENCION] Purga: ${JSON.stringify(r)}`);
  }
  return r;
}

function programar(db, cfg, log) {
  purgar(db, cfg, log);
  return setInterval(() => purgar(db, cfg, log), 60 * 60e3).unref(); // cada hora
}

module.exports = { purgar, programar };
