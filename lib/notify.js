/**
 * NEXUS-LPR — Notificaciones de alertas por Telegram (opcional).
 * Configurar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en .env.
 * Evita repetir la misma patente dentro de NOTIFY_COOLDOWN_MIN minutos.
 */
function crearNotificador(cfg, log = console) {
  const ultimas = new Map(); // patente -> epoch ms

  async function alerta({ patente, motivo, nivel, camara, ubicacion, timestamp }) {
    if (!cfg.telegramToken || !cfg.telegramChatId) return { enviado: false, razon: 'no configurado' };
    const ahora = Date.now();
    if (ahora - (ultimas.get(patente) || 0) < cfg.notifyCooldownMin * 60e3) {
      return { enviado: false, razon: 'cooldown' };
    }
    ultimas.set(patente, ahora);

    const hora = new Date(timestamp).toLocaleString('es-CL', { timeZone: cfg.timezone });
    const icono = nivel === 'CRITICA' ? '🚨' : '⚠️';
    const texto = [
      `${icono} *NEXUS-LPR — ${nivel === 'CRITICA' ? 'ALERTA CRÍTICA' : 'PRECAUCIÓN'}*`,
      `Patente: \`${patente}\``,
      `Motivo: ${motivo}`,
      `Lugar: ${ubicacion} (${camara})`,
      `Hora: ${hora}`,
    ].join('\n');

    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text: texto, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { enviado: true };
    } catch (e) {
      log.error(`[NOTIFY] No se pudo enviar alerta Telegram: ${e.message}`);
      return { enviado: false, razon: e.message };
    }
  }

  return { alerta };
}

module.exports = { crearNotificador };
