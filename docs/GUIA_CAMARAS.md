# Guía de compra e instalación de cámaras — NEXUS-LPR

NEXUS-LPR lee patentes desde **cualquier cámara IP con stream RTSP**. No necesita
cámaras "LPR/ANPR" dedicadas (que cuestan varias veces más): el reconocimiento
lo hace el software en el equipo local.

> Los precios son referencias aproximadas de octubre 2026 y varían según tienda y
> stock. Cotice en al menos dos distribuidores de seguridad.

## Lista de compra para un acceso (piloto)

| Ítem | Especificación mínima | Referencia de precio |
| --- | --- | --- |
| Cámara IP bullet | 4 MP, **lente varifocal motorizado 2.8–12 mm**, IR ≥ 30 m, WDR, PoE, IP67, RTSP/ONVIF | Bullet 4 MP de lente fija desde ~$105.000 CLP (Hikvision en tienda chilena); varifocal motorizado, más |
| Equipo local | Mini PC **Intel N100, 16 GB RAM, SSD 256–512 GB** (recomendado) o Raspberry Pi 5 (8 GB) | Mini PC N100 16 GB: ~US$180–250 |
| Switch PoE | 4 u 8 puertos PoE (802.3af/at), con al menos 1 puerto más que cámaras | — |
| UPS | 600–850 VA para switch + mini PC + router | — |
| Cable | UTP Cat6 exterior (con protección UV) y conectores RJ45 | — |
| Montaje | Caja estanca, brazo/soporte a poste o muro, abrazaderas | — |
| Internet | Cualquier plan hogar/fibra; solo para acceso remoto y alertas | — |

### ¿Por qué lente varifocal?

La patente debe ocupar **al menos 130–150 píxeles de ancho** en la imagen. Con
lente fija de 2.8 mm (gran angular) la patente queda diminuta a más de 3 m. Con
varifocal 2.8–12 mm usted hace "zoom" hasta el punto exacto donde pasan los autos.

### Mini PC vs Raspberry Pi

| | Mini PC N100 16 GB | Raspberry Pi 5 8 GB |
| --- | --- | --- |
| Cámaras soportadas | 2–4 (a 3 cuadros/s) | 1–2 (a 1–2 cuadros/s) |
| Velocidad OCR por cuadro | ~0,3 s (medido en pruebas) | más lento (ARM) |
| Almacenamiento | SSD incluido | requiere SSD por USB/NVMe (no use solo microSD) |
| Recomendación | **Producción** | Piloto de 1 cámara |

### Cámaras LPR dedicadas (opción premium)

Hikvision y Dahua venden cámaras ANPR con reconocimiento integrado (ej. series
Hikvision iDS-2CD7A46G0/P), a precios de distribuidor de cientos de dólares por
unidad. No son necesarias para NEXUS-LPR, pero sirven igual: se conectan por
RTSP como cualquier otra cámara.

## Instalación física (lo que más influye en la precisión)

1. **Altura:** 2,5 a 4 m.
2. **Ángulo:** lo más de frente posible. Máximo **30° horizontal** y **30° vertical** respecto a la patente.
3. **Distancia:** 4 a 10 m del punto de lectura, con varifocal ajustado para que la patente se vea grande y nítida.
4. **Punto de lectura:** donde los autos van **lento** (entrada del pasaje, lomo de toro, portón). A más velocidad, más borrosa la patente.
5. **Un solo carril por cámara** idealmente.
6. **Evite contraluz** (sol de frente al lente al amanecer/atardecer) y faroles apuntando a la cámara.

## Configuración de la cámara (desde su página web)

| Parámetro | Valor recomendado | Por qué |
| --- | --- | --- |
| Resolución | 2560×1440 (4 MP) o 1920×1080 | Suficiente detalle de la patente |
| Códec | H.264 | Máxima compatibilidad |
| Cuadros por segundo | 15 | No se necesitan más |
| **Obturador (shutter)** | **1/500 a 1/1000 s** | Congela el movimiento: es el ajuste más importante |
| WDR | Activado | Patentes reflectantes y focos de autos |
| IR nocturno | Activado, potencia media | Las patentes chilenas son retrorreflectantes: IR muy fuerte las "quema" |
| Usuario | Cree un usuario solo-lectura para el RTSP | No use el usuario admin de la cámara |
| Contraseña | Cambie la de fábrica | Seguridad básica |
| Hora | NTP activado | Fechas correctas en evidencia |

## Red

- Conecte cámaras y mini PC al **mismo switch PoE**, en una red local separada si es posible.
- **Nunca** abra puertos de las cámaras en el router hacia internet. El acceso remoto se hace solo al panel, por Cloudflare Tunnel (ver `GUIA_INSTALACION.md`).
- Asigne **IP fija** a cada cámara (desde la cámara o reserva DHCP en el router).

## Prueba antes de instalar en altura

1. Conecte la cámara en su casa y saque una foto de un auto estacionado a la distancia real.
2. Ejecute: `python3 edge/edge_daemon.py --test-image foto.jpg`
3. Si lee la patente, ajuste el zoom/foco con ese mismo encuadre en el lugar definitivo.

También puede grabar con el celular un video del pasaje (de frente, a la altura
donde irá la cámara) y usarlo como `RTSP_URL=/ruta/video.mp4`: el sistema lo
procesa a velocidad real como si fuera una cámara.
