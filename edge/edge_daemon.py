#!/usr/bin/env python3
"""
NEXUS-LPR — Edge OCR Pipeline
Daemon de captura y reconocimiento de patentes chilenas en el nodo de borde.

Una instancia por cámara. Lee el stream RTSP, detecta patentes con OCR,
confirma la lectura en varios cuadros y la envía al backend con su API key.

Modos:
  python3 edge_daemon.py                       # producción (usa edge/.env)
  python3 edge_daemon.py --test-image foto.jpg # prueba el OCR sobre una foto
  python3 edge_daemon.py --simulate            # lecturas sintéticas (demo)

Motores OCR:
  rapidocr (por defecto) — PaddleOCR sobre ONNX: liviano, rápido en CPU/ARM.
  easyocr                — alternativa basada en PyTorch (más pesada).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import signal
import string
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("nexus-edge")

# =====================================================================
# Configuración
# =====================================================================
def cargar_env(ruta: Path) -> None:
    if not ruta.exists():
        return
    for linea in ruta.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", linea)
        if m and m.group(1) not in os.environ:
            os.environ[m.group(1)] = m.group(2).strip().strip("'\"")


def config() -> dict:
    e = os.environ
    roi = e.get("ROI", "").strip()
    return {
        "api": e.get("NEXUS_API", "http://localhost:3000").rstrip("/"),
        "api_key": e.get("NEXUS_API_KEY", ""),
        "rtsp": e.get("RTSP_URL", ""),
        "motor": e.get("OCR_ENGINE", "rapidocr").lower(),
        # ROI: región de interés como fracciones "x,y,ancho,alto" (ej. 0.2,0.4,0.6,0.5)
        "roi": tuple(float(v) for v in roi.split(",")) if roi else None,
        "fps": float(e.get("FPS_PROCESS", "3")),
        "min_conf": float(e.get("MIN_CONF", "0.60")),
        "confirmar": int(e.get("CONFIRM_READS", "2")),
        "conf_directa": float(e.get("DIRECT_CONF", "0.92")),
        "dedup": float(e.get("DEDUP_SECONDS", "30")),
        "heartbeat": float(e.get("HEARTBEAT_SECONDS", "60")),
        "evidencia": e.get("SAVE_EVIDENCE", "true").lower() == "true",
        "cola": Path(e.get("QUEUE_FILE", str(Path(__file__).with_name("cola_pendiente.jsonl")))),
    }


# =====================================================================
# Patentes chilenas (misma lógica que lib/plates.js del backend)
# =====================================================================
FORMATOS = [
    ("auto_nuevo", re.compile(r"^([A-Z]{4})(\d{2})$")),
    ("auto_antiguo", re.compile(r"^([A-Z]{2})(\d{4})$")),
    ("moto_nuevo", re.compile(r"^([A-Z]{3})(\d{2})$")),
    ("moto_antiguo", re.compile(r"^([A-Z]{2})(\d{3})$")),
]
A_LETRA = {"0": "D", "1": "L", "2": "Z", "4": "A", "5": "S", "6": "G", "7": "T", "8": "B"}
A_DIGITO = {"O": "0", "D": "0", "Q": "0", "U": "0", "I": "1", "L": "1", "T": "7",
            "Z": "2", "S": "5", "G": "6", "B": "8", "A": "4"}
PALABRAS_IGNORADAS = {"CHILE", "CL"}
# Formato nuevo (2007+, autos y motos): solo consonantes, sin M, N, Ñ ni Q
CONSONANTES = set("BCDFGHJKLPRSTVWXYZ")
NUEVOS = {"auto_nuevo", "moto_nuevo"}


def limpiar(texto: str) -> str:
    t = unicodedata.normalize("NFD", texto.upper())
    return re.sub(r"[^A-Z0-9]", "", t)


def analizar(texto: str) -> str | None:
    """Devuelve la patente canónica (ej. BBCC-12) o None."""
    t = limpiar(texto)
    if not t or t in PALABRAS_IGNORADAS:
        return None
    for nombre, rx in FORMATOS:
        m = rx.match(t)
        if m and (nombre not in NUEVOS or set(m.group(1)) <= CONSONANTES):
            return f"{m.group(1)}-{m.group(2)}"
    for nombre, nl, nd in (("auto_nuevo", 4, 2), ("auto_antiguo", 2, 4), ("moto_nuevo", 3, 2), ("moto_antiguo", 2, 3)):
        if len(t) != nl + nd:
            continue
        out = ""
        for i, c in enumerate(t):
            if i < nl:
                out += c if c.isalpha() else A_LETRA.get(c, "?")
            else:
                out += c if c.isdigit() else A_DIGITO.get(c, "?")
        cambios = sum(a != b for a, b in zip(out, t))
        # Más de 1 corrección ya es adivinar: se descarta
        if "?" in out or cambios > 1 or (nombre in NUEVOS and not set(out[:nl]) <= CONSONANTES):
            continue
        return f"{out[:nl]}-{out[nl:]}"
    return None


# =====================================================================
# Motores OCR
# =====================================================================
class MotorOCR:
    """Devuelve lista de (texto, confianza 0-1, (x1, y1, x2, y2))."""

    def __init__(self, motor: str):
        self.nombre = motor
        if motor == "rapidocr":
            from rapidocr_onnxruntime import RapidOCR
            self._ocr = RapidOCR()
        elif motor == "easyocr":
            import easyocr
            self._ocr = easyocr.Reader(["en"], gpu=False)
        else:
            raise SystemExit(f"OCR_ENGINE desconocido: {motor} (use rapidocr o easyocr)")

    def leer(self, img) -> list:
        out = []
        if self.nombre == "rapidocr":
            res, _ = self._ocr(img)
            for caja, texto, conf in res or []:
                xs = [p[0] for p in caja]; ys = [p[1] for p in caja]
                out.append((texto, float(conf), (min(xs), min(ys), max(xs), max(ys))))
        else:
            for caja, texto, conf in self._ocr.readtext(
                    img, allowlist=string.ascii_uppercase + string.digits + "-·. "):
                xs = [p[0] for p in caja]; ys = [p[1] for p in caja]
                out.append((texto, float(conf), (min(xs), min(ys), max(xs), max(ys))))
        return out


def candidatos(resultados: list, min_conf: float) -> list:
    """
    Arma candidatos de patente: cada texto por sí solo y pares de textos
    vecinos en la misma línea (el OCR a veces separa "BBCC" de "12").
    """
    res = sorted([r for r in resultados if r[1] >= min_conf * 0.8], key=lambda r: r[2][0])
    vistos, out = set(), []

    def agregar(texto, conf, caja):
        p = analizar(texto)
        if p and conf >= min_conf and p not in vistos:
            vistos.add(p)
            out.append((p, conf, caja))

    for t, c, b in res:
        agregar(t, c, b)
    for i in range(len(res)):
        for j in range(i + 1, min(i + 3, len(res))):
            (t1, c1, b1), (t2, c2, b2) = res[i], res[j]
            alto = max(b1[3] - b1[1], b2[3] - b2[1])
            mismo_renglon = abs((b1[1] + b1[3]) / 2 - (b2[1] + b2[3]) / 2) < alto * 0.5
            cerca = 0 <= b2[0] - b1[2] < alto * 1.5
            if mismo_renglon and cerca:
                caja = (min(b1[0], b2[0]), min(b1[1], b2[1]), max(b1[2], b2[2]), max(b1[3], b2[3]))
                agregar(t1 + t2, min(c1, c2), caja)
    return out


# =====================================================================
# Confirmación entre cuadros y anti-duplicados
# =====================================================================
class Confirmador:
    """
    Agrupa las lecturas de un mismo vehículo en una "sesión" (patentes iguales o
    con 1 carácter distinto) y decide la patente por votación por carácter,
    ponderada por confianza. Así una mala lectura a distancia (D↔P, 0↔O) no
    genera un evento falso ni se impone sobre la lectura correcta.
    """

    def __init__(self, n_confirmar: int, conf_directa: float, dedup_s: float, ventana_s: float = 4.0,
                 votos_min: int = 4, espera_s: float = 1.0):
        self.n, self.directa, self.dedup, self.ventana = n_confirmar, conf_directa, dedup_s, ventana_s
        self.votos_min, self.espera = max(votos_min, n_confirmar), espera_s
        self.sesiones: list[dict] = []

    @staticmethod
    def _similares(a: str, b: str) -> bool:
        """Distancia de edición ≤ 1 (un carácter cambiado, de más o de menos)."""
        a, b = a.replace("-", ""), b.replace("-", "")
        if abs(len(a) - len(b)) > 1:
            return False
        if len(a) == len(b):
            return sum(x != y for x, y in zip(a, b)) <= 1
        if len(a) > len(b):
            a, b = b, a
        return any(b[:i] + b[i + 1:] == a for i in range(len(b)))

    @staticmethod
    def _votar(lecturas) -> str:
        largos = defaultdict(float)
        for _, p, c in lecturas:
            largos[len(p)] += c
        largo = max(largos, key=largos.get)
        votos = [defaultdict(float) for _ in range(largo)]
        for _, p, c in lecturas:
            if len(p) == largo:
                for i, ch in enumerate(p):
                    votos[i][ch] += c
        return "".join(max(v, key=v.get) for v in votos)

    def registrar(self, patente: str, conf: float, ahora: float | None = None) -> str | None:
        """Devuelve la patente a enviar cuando el vehículo queda confirmado; si no, None."""
        ahora = ahora or time.time()
        # Expirar sesiones: enviadas tras DEDUP sin verse; pendientes tras la ventana
        self.sesiones = [s for s in self.sesiones
                         if ahora - s["ultima"] <= (self.dedup if s["enviada"] else self.ventana)]
        ses = next((s for s in self.sesiones
                    if any(self._similares(patente, p) for _, p, _ in s["lecturas"])
                    or (s["enviada"] and self._similares(patente, s["enviada"]))), None)
        if ses is None:
            ses = {"lecturas": deque(maxlen=30), "enviada": None, "ultima": ahora}
            self.sesiones.append(ses)
        ses["lecturas"].append((ahora, patente, conf))
        ses["ultima"] = ahora
        if ses["enviada"]:
            return None  # mismo vehículo ya informado
        recientes = [l for l in ses["lecturas"] if ahora - l[0] <= self.ventana]
        # Se decide con suficientes votos, o antes si la lectura es muy segura
        if len(recientes) >= self.votos_min or (len(recientes) >= self.n and conf >= self.directa):
            ses["enviada"] = self._votar(recientes)
            return ses["enviada"]
        return None

    def vencidas(self, ahora: float | None = None) -> list[str]:
        """Vehículos con lecturas suficientes que dejaron de verse: se deciden con lo que hay."""
        ahora = ahora or time.time()
        listas = []
        for s in self.sesiones:
            if not s["enviada"] and len(s["lecturas"]) >= self.n and ahora - s["ultima"] >= self.espera:
                s["enviada"] = self._votar(s["lecturas"])
                listas.append(s["enviada"])
        return listas


# =====================================================================
# Cliente del backend (con cola offline)
# =====================================================================
class Cliente:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.lock = threading.Lock()

    def _req(self, metodo: str, ruta: str, datos: bytes | None, tipo: str, timeout=6):
        req = urllib.request.Request(self.cfg["api"] + ruta, data=datos, method=metodo, headers={
            "Content-Type": tipo, "X-API-Key": self.cfg["api_key"]})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cuerpo = r.read()
            return json.loads(cuerpo) if cuerpo else {}

    def enviar_lectura(self, lectura: dict) -> dict | None:
        try:
            return self._req("POST", "/api/alerta", json.dumps(lectura).encode(), "application/json")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                log.error("API key rechazada por el servidor (revise NEXUS_API_KEY)")
            elif e.code == 422:
                log.debug("Servidor descartó lectura %s", lectura.get("patente"))
            else:
                self._encolar(lectura)
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            log.warning("Servidor no disponible (%s): lectura guardada en cola", e)
            self._encolar(lectura)
            return None

    def subir_foto(self, evento_id: int, jpeg: bytes) -> None:
        try:
            self._req("PUT", f"/api/eventos/{evento_id}/foto", jpeg, "image/jpeg", timeout=15)
        except Exception as e:  # noqa: BLE001
            log.warning("No se pudo subir foto de evidencia: %s", e)

    def heartbeat(self) -> bool:
        try:
            self._req("POST", "/api/heartbeat", b"{}", "application/json")
            return True
        except Exception:  # noqa: BLE001
            return False

    def _encolar(self, lectura: dict) -> None:
        with self.lock, open(self.cfg["cola"], "a", encoding="utf-8") as f:
            f.write(json.dumps(lectura) + "\n")

    def vaciar_cola(self) -> None:
        cola: Path = self.cfg["cola"]
        if not cola.exists() or cola.stat().st_size == 0:
            return
        with self.lock:
            lineas = cola.read_text(encoding="utf-8").splitlines()
            cola.write_text("", encoding="utf-8")
        log.info("Reenviando %d lecturas pendientes", len(lineas))
        for l in lineas:
            try:
                self.enviar_lectura(json.loads(l))  # si falla, vuelve a la cola
            except json.JSONDecodeError:
                pass


# =====================================================================
# Captura RTSP con reconexión (hilo que siempre guarda el último cuadro)
# =====================================================================
class Captura(threading.Thread):
    def __init__(self, url: str, parar: threading.Event):
        super().__init__(daemon=True)
        self.url, self.parar = url, parar
        self.cuadro, self.ts = None, 0.0
        self.lock = threading.Lock()

    def run(self):
        import cv2
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        espera = 2
        while not self.parar.is_set():
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                log.error("No se pudo abrir el stream; reintento en %ss", espera)
                self.parar.wait(espera); espera = min(espera * 2, 60)
                continue
            log.info("Stream conectado")
            espera, fallos = 2, 0
            # Video grabado (no RTSP/HTTP): reproducir a velocidad real para simular una cámara
            es_archivo = not self.url.lower().startswith(("rtsp://", "rtsps://", "http://", "https://"))
            fps_video = cap.get(cv2.CAP_PROP_FPS) or 15
            t_inicio, n_cuadro = time.time(), 0
            while not self.parar.is_set():
                if es_archivo:
                    # Sincronizar con el reloj: como una cámara real, los cuadros
                    # atrasados se descartan en vez de reproducir el video más lento.
                    objetivo = int((time.time() - t_inicio) * fps_video)
                    while n_cuadro < objetivo - 1 and cap.grab():
                        n_cuadro += 1
                    adelanto = (n_cuadro - (time.time() - t_inicio) * fps_video) / fps_video
                    if adelanto > 0:
                        time.sleep(adelanto)
                ok, frame = cap.read()
                n_cuadro += 1
                if not ok:
                    fallos += 1
                    if es_archivo:
                        log.info("Fin del video; se reinicia")
                        break
                    if fallos > 50:
                        log.warning("Stream perdido; reconectando")
                        break
                    time.sleep(0.05)
                    continue
                fallos = 0
                with self.lock:
                    self.cuadro, self.ts = frame, time.time()
            cap.release()

    def ultimo(self):
        with self.lock:
            return self.cuadro, self.ts


def recortar_roi(frame, roi):
    if not roi:
        return frame, (0, 0)
    h, w = frame.shape[:2]
    x, y, rw, rh = roi
    x0, y0 = int(x * w), int(y * h)
    return frame[y0:int((y + rh) * h), x0:int((x + rw) * w)], (x0, y0)


def jpeg_evidencia(frame) -> bytes:
    import cv2
    h, w = frame.shape[:2]
    if w > 1280:
        frame = cv2.resize(frame, (1280, int(h * 1280 / w)))
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes() if ok else b""


def ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# =====================================================================
# Modos de operación
# =====================================================================
def enviar(patente, conf, frame, cfg, cliente, origen="CAM"):
    r = cliente.enviar_lectura({"patente": patente, "confianza": round(conf * 100, 1), "capturado": ahora_iso()})
    if r is None:
        return
    if r.get("alerta"):
        log.warning("🚨 ALERTA %s → %s", r.get("patente"), r.get("estado"))
        if cfg["evidencia"] and frame is not None:
            jpeg = jpeg_evidencia(frame)
            if jpeg:
                threading.Thread(target=cliente.subir_foto, args=(r["id"], jpeg), daemon=True).start()
    else:
        log.info("%s %s (%.1f%%) → %s", origen, r.get("patente"), conf * 100, r.get("estado"))


def procesar_cuadro(frame, ocr, cfg, confirmador, cliente, estado: dict):
    zona, _ = recortar_roi(frame, cfg["roi"])
    for lectura, conf, _caja in candidatos(ocr.leer(zona), cfg["min_conf"]):
        estado["mejor"][lectura] = max(conf, estado["mejor"].get(lectura, 0))
        estado["foto"] = frame
        patente = confirmador.registrar(lectura, conf)
        if patente:
            enviar(patente, estado["mejor"].get(patente, conf), frame, cfg, cliente)
    # Vehículos que salieron de cuadro antes de juntar todos los votos
    for patente in confirmador.vencidas():
        enviar(patente, estado["mejor"].get(patente, cfg["min_conf"]), estado.get("foto"), cfg, cliente)
    if len(estado["mejor"]) > 500:
        estado["mejor"].clear()


def hilos_fondo(cliente: Cliente, cfg: dict, parar: threading.Event):
    def latido():
        while not parar.is_set():
            if cliente.heartbeat():
                cliente.vaciar_cola()
            else:
                log.warning("Sin contacto con el servidor %s", cfg["api"])
            parar.wait(cfg["heartbeat"])
    threading.Thread(target=latido, daemon=True).start()


def modo_rtsp(cfg: dict, parar: threading.Event):
    if not cfg["rtsp"]:
        raise SystemExit("Falta RTSP_URL en edge/.env")
    if not cfg["api_key"]:
        raise SystemExit("Falta NEXUS_API_KEY en edge/.env (genérela con scripts/agregar-camara.js)")
    ocr = MotorOCR(cfg["motor"])
    cliente = Cliente(cfg)
    confirmador = Confirmador(cfg["confirmar"], cfg["conf_directa"], cfg["dedup"])
    hilos_fondo(cliente, cfg, parar)
    cap = Captura(cfg["rtsp"], parar); cap.start()
    log.info("Pipeline OCR (%s) activo · %.1f cuadros/s · ROI=%s", cfg["motor"], cfg["fps"], cfg["roi"])
    ultimo_ts, intervalo = 0.0, 1.0 / max(cfg["fps"], 0.1)
    estado = {"mejor": {}, "foto": None}
    while not parar.is_set():
        t0 = time.time()
        frame, ts = cap.ultimo()
        if frame is not None and ts != ultimo_ts:
            ultimo_ts = ts
            try:
                procesar_cuadro(frame, ocr, cfg, confirmador, cliente, estado)
            except Exception as e:  # noqa: BLE001 — nunca botar el daemon
                log.exception("Error procesando cuadro: %s", e)
        parar.wait(max(0.0, intervalo - (time.time() - t0)))


def modo_imagen(cfg: dict, rutas: list[str], enviar: bool):
    import cv2
    ocr = MotorOCR(cfg["motor"])
    cliente = Cliente(cfg) if enviar else None
    for ruta in rutas:
        frame = cv2.imread(ruta)
        if frame is None:
            print(f"{ruta}: no se pudo leer"); continue
        t0 = time.time()
        zona, _ = recortar_roi(frame, cfg["roi"])
        crudos = ocr.leer(zona)
        cands = candidatos(crudos, cfg["min_conf"])
        ms = (time.time() - t0) * 1000
        print(f"\n{ruta}  ({ms:.0f} ms)")
        print("  texto OCR:", [f"{t} ({c:.2f})" for t, c, _ in crudos])
        print("  patentes :", [f"{p} ({c * 100:.1f}%)" for p, c, _ in cands] or "ninguna")
        if enviar and cands:
            for p, c, _ in cands:
                print("  servidor :", cliente.enviar_lectura({"patente": p, "confianza": round(c * 100, 1)}))


def modo_simulacion(cfg: dict, parar: threading.Event, intervalo: float):
    consonantes = "BCDFGHJKLPRSTVWXYZ"
    demo = ["RJKT-83", "BCFG-21", "HLPR-09"]
    cliente = Cliente(cfg)
    hilos_fondo(cliente, cfg, parar)
    log.info("Modo simulación · intervalo %ss", intervalo)
    while not parar.is_set():
        p = random.choice(demo) if random.random() < 1 / 6 else \
            "".join(random.choices(consonantes, k=4)) + "-" + "".join(random.choices(string.digits, k=2))
        r = cliente.enviar_lectura({"patente": p, "confianza": round(random.uniform(93, 99.9), 1)})
        if r:
            log.info("%s %s → %s", "🚨" if r.get("alerta") else "  ", r.get("patente"), r.get("estado"))
        parar.wait(intervalo)


def main():
    ap = argparse.ArgumentParser(description="NEXUS-LPR Edge OCR Daemon")
    ap.add_argument("--env", default=str(Path(__file__).with_name(".env")),
                    help="Archivo de configuración de la cámara (por defecto edge/.env)")
    ap.add_argument("--test-image", nargs="+", metavar="IMG", help="Prueba el OCR sobre una o más fotos")
    ap.add_argument("--send", action="store_true", help="Con --test-image: envía las patentes al servidor")
    ap.add_argument("--simulate", action="store_true", help="Lecturas sintéticas (demo, sin cámara)")
    ap.add_argument("--interval", type=float, default=3.0, help="Segundos entre lecturas simuladas")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    cargar_env(Path(args.env))

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s [EDGE] %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    cfg = config()
    parar = threading.Event()
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, lambda *_: parar.set())

    if args.test_image:
        modo_imagen(cfg, args.test_image, args.send)
    elif args.simulate:
        modo_simulacion(cfg, parar, args.interval)
    else:
        modo_rtsp(cfg, parar)
    log.info("Daemon detenido")


if __name__ == "__main__":
    sys.exit(main())
