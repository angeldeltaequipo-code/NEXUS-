#!/usr/bin/env bash
# =====================================================================
# NEXUS-LPR — Instalador para el equipo local (Ubuntu / Debian /
# Raspberry Pi OS de 64 bits). Instala Docker y deja el sistema andando.
#
#   git clone <repo> nexus-lpr && cd nexus-lpr && ./instalar.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

verde() { printf '\033[32m%s\033[0m\n' "$*"; }
amarillo() { printf '\033[33m%s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  amarillo "Instalando Docker…"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

if [ ! -f .env ]; then
  cp .env.example .env
  PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${PASS}/" .env
  verde "Archivo .env creado."
fi

mkdir -p data edge/camaras
if [ ! -f edge/camaras/camara-01.env ]; then
  cp edge/camara.env.example edge/camaras/camara-01.env
  amarillo "Creado edge/camaras/camara-01.env — complete RTSP_URL y NEXUS_API_KEY (ver docs/GUIA_INSTALACION.md)."
fi

amarillo "Construyendo e iniciando el servidor…"
$DOCKER compose up -d --build nexus-server

for i in $(seq 1 30); do
  curl -fs http://localhost:3000/api/salud >/dev/null 2>&1 && break
  sleep 2
done

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
verde "======================================================"
verde " NEXUS-LPR está en marcha"
verde "   Panel:      http://${IP:-localhost}:3000"
verde "   Usuario:    admin"
verde "   Contraseña: $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)   (cámbiela al entrar)"
verde "======================================================"
echo
echo "Siguientes pasos:"
echo " 1. Registre la cámara:  $DOCKER compose exec nexus-server node scripts/agregar-camara.js CAM-EDGE-01 \"Acceso norte\" \"Pasaje X - Linares\""
echo " 2. Pegue la clave y la URL RTSP en edge/camaras/camara-01.env"
echo " 3. Inicie la cámara:    $DOCKER compose up -d --build camara-01"
echo " 4. Acceso remoto:       ponga CLOUDFLARE_TUNNEL_TOKEN en .env y ejecute: $DOCKER compose --profile remoto up -d"
