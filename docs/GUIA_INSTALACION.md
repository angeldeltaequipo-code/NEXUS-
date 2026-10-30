# Guía de instalación — NEXUS-LPR en terreno

De una caja con hardware a alertas en el celular. Tiempo estimado: una tarde.

**Arquitectura**

```
 Cámara IP ──RTSP──┐
 Cámara IP ──RTSP──┤   Mini PC en el pasaje (Docker)
                   ├──►  nexus-camara-01 / 02   (OCR de patentes)
                   │          │  lectura + API key
                   │          ▼
                   │     nexus-server  ──► data/ (base de datos, fotos, respaldos)
                   │          │
                   │          ├──► Panel en la red local  http://IP:3000
                   │          ├──► Telegram (alertas)
                   │          └──► Cloudflare Tunnel ──► https://nexus.su-dominio.cl
```

Todo funciona **sin internet** dentro del pasaje; internet solo se usa para el
acceso remoto y las alertas de Telegram.

---

## 1. Preparar el equipo

1. Instale **Ubuntu Server 24.04 LTS** (mini PC) o **Raspberry Pi OS Lite 64-bit** (Raspberry Pi 5).
2. Conéctelo por cable al switch PoE donde estarán las cámaras.
3. En la BIOS del mini PC active **"Restore on AC power loss: Power On"** para que encienda solo tras un corte de luz.
4. Actualice el sistema: `sudo apt update && sudo apt upgrade -y && sudo apt install -y git curl`

## 2. Descargar e instalar NEXUS-LPR

```bash
git clone https://github.com/<su-usuario>/<su-repo>.git nexus-lpr
cd nexus-lpr
./instalar.sh
```

El instalador agrega Docker, crea `.env` con una contraseña de administrador al
azar, inicia el servidor y le muestra la dirección del panel y la contraseña.

Entre a `http://<IP-del-equipo>:3000`, inicie sesión como `admin` y **cambie la
contraseña** (menú de usuario → Cambiar contraseña). Después borre el valor de
`ADMIN_PASSWORD` en `.env`.

## 3. Registrar cada cámara

En el panel: **Cámaras → Registrar cámara** (ID `CAM-EDGE-01`, nombre, ubicación).
Copie la **API key** que aparece (se muestra una sola vez).

Por consola, equivalente:

```bash
docker compose exec nexus-server node scripts/agregar-camara.js CAM-EDGE-01 "Acceso norte" "Pasaje X - Linares"
```

## 4. Conectar la cámara

Edite `edge/camaras/camara-01.env` (plantilla: `edge/camara.env.example`):

```ini
NEXUS_API_KEY=nxk_...la clave copiada...
RTSP_URL=rtsp://lector:CLAVE@192.168.1.64:554/Streaming/Channels/101
```

Compruebe primero que el RTSP abre (desde otro PC con VLC: *Medio → Abrir ubicación de red*).
Luego inicie la cámara:

```bash
docker compose up -d --build camara-01
docker compose logs -f camara-01     # debe decir "Stream conectado"
```

Pase un auto y verifique que aparece en el panel. Para más cámaras, copie el
bloque `camara-01` en `docker-compose.yml` como `camara-02` con su propio `.env`.

## 5. Calibrar (mejora mucho la precisión)

1. Saque una captura desde la página web de la cámara (botón *Captura* / *Snapshot*) con un auto en el punto de lectura.
2. Pruébelo: `python3 edge/edge_daemon.py --test-image cuadro.jpg`
3. Defina la **región de interés** (`ROI`) donde pasan las patentes, ej. `ROI=0.25,0.45,0.5,0.5`. Recorta todo lo demás: más rápido y menos falsos positivos.
4. Ajuste `MIN_CONF` (sube = menos errores, baja = no se escapan patentes) y `FPS_PROCESS`.

Revise **Historial** el primer día: compare lecturas con la realidad y ajuste.

## 6. Hotlist

- **Encargos por robo:** gestionar convenio de acceso a la base de encargos (Asociación de Aseguradores de Chile entrega este servicio a municipios) o carga manual desde fuentes oficiales.
- **Recintos privados:** vehículos no autorizados, con fundamento.
- Use **vencimiento** para encargos temporales.

## 7. Alertas en Telegram

1. En Telegram hable con **@BotFather** → `/newbot` → copie el *token*.
2. Cree un grupo "Seguridad Pasaje", agregue el bot y envíe un mensaje en el grupo.
3. Abra `https://api.telegram.org/bot<TOKEN>/getUpdates` y copie el `chat.id` (número negativo).
4. En `.env`: `TELEGRAM_BOT_TOKEN=...` y `TELEGRAM_CHAT_ID=...`
5. `docker compose up -d nexus-server`

## 8. Acceso remoto seguro (Cloudflare Tunnel)

No abra puertos en el router. Con una cuenta gratuita de Cloudflare y un dominio:

1. Cloudflare Zero Trust → **Networks → Tunnels → Create tunnel** (tipo *Cloudflared*).
2. Copie el token y póngalo en `.env` como `CLOUDFLARE_TUNNEL_TOKEN=...`
3. En *Public Hostname*: `nexus.su-dominio.cl` → servicio `http://nexus-server:3000`.
4. `docker compose --profile remoto up -d`
5. **Muy recomendado:** Zero Trust → **Access → Applications**: proteja `nexus.su-dominio.cl` para que solo los correos autorizados lleguen siquiera a la pantalla de login.

Las cookies de sesión pasan a modo `Secure` automáticamente al entrar por HTTPS.

## 9. Respaldos

- El sistema crea cada día `data/respaldos/nexus-AAAA-MM-DD.db` y conserva 14 días.
- **Copie esa carpeta fuera del equipo** cada semana (pendrive o nube cifrada). Si roban o se quema el mini PC, eso es lo que salva la historia.
- Restaurar: detenga el servidor, copie el respaldo como `data/nexus.db`, inicie.

## 10. Operación diaria

| Tarea | Comando |
| --- | --- |
| Ver estado | `docker compose ps` |
| Logs del servidor | `docker compose logs -f nexus-server` |
| Reiniciar todo | `docker compose restart` |
| Actualizar a una nueva versión | `git pull && docker compose up -d --build` |
| Restablecer contraseña | `docker compose exec nexus-server node scripts/crear-usuario.js admin NuevaClaveLarga123 admin` |
| Ejecutar tests | `npm test` y `python3 -m unittest edge/test_edge.py` |

## Instalación sin Docker (alternativa)

```bash
sudo useradd -r -m -d /opt/nexus-lpr nexus
sudo cp -r . /opt/nexus-lpr && sudo chown -R nexus /opt/nexus-lpr
cd /opt/nexus-lpr
sudo -u nexus npm ci --omit=dev
sudo -u nexus python3 -m venv edge/venv && sudo -u nexus edge/venv/bin/pip install -r edge/requirements.txt
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-server nexus-edge@camara-01
```

Requiere Node.js 20+ y Python 3.10+.

## Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| Cámara "SIN SEÑAL" | RTSP incorrecto, cámara sin red o API key equivocada (vea `docker compose logs camara-01`) |
| Lee pocas patentes | Patente muy pequeña (ajuste zoom), shutter lento (1/500+), ángulo > 30°, falta ROI |
| Lee patentes erróneas | Suba `MIN_CONF` o `CONFIRM_READS=3` |
| De noche no lee | IR demasiado fuerte o débil; pruebe potencia media y shutter 1/250 |
| Error de permisos en `data/` | `sudo chown -R 1000:1000 data` |
