/** NEXUS-LPR — Configuración desde variables de entorno (o archivo .env) */
const fs = require('fs');
const path = require('path');

function cargarDotenv(archivo) {
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function leerConfig(overrides = {}) {
  cargarDotenv(path.join(__dirname, '..', '.env'));
  const e = process.env;
  const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d);
  const dataDir = path.resolve(e.DATA_DIR || path.join(__dirname, '..', 'data'));
  const cfg = {
    port: num(e.PORT, 3000),
    host: e.HOST || '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'nexus.db'),
    fotosDir: path.join(dataDir, 'fotos'),
    timezone: e.TZ_DISPLAY || 'America/Santiago',
    sessionHours: num(e.SESSION_HOURS, 12),
    cookieSecure: e.COOKIE_SECURE === 'true',
    retentionDays: num(e.RETENTION_DAYS, 30),
    alertRetentionDays: num(e.ALERT_RETENTION_DAYS, 365),
    auditRetentionDays: num(e.AUDIT_RETENTION_DAYS, 730),
    camaraOfflineMin: num(e.CAMERA_OFFLINE_MIN, 3),
    telegramToken: e.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: e.TELEGRAM_CHAT_ID || '',
    notifyCooldownMin: num(e.NOTIFY_COOLDOWN_MIN, 5),
    adminPasswordInicial: e.ADMIN_PASSWORD || '',
    // Proxies de confianza: local + redes privadas (Docker / LAN donde corre cloudflared)
    trustProxy: e.TRUST_PROXY || 'loopback, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16',
    backupDias: num(e.BACKUP_KEEP_DAYS, 14),
    ...overrides,
  };
  return cfg;
}

module.exports = { leerConfig };
