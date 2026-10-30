# NEXUS-LPR — Nodo edge (una instancia por cámara)
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp"

RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY edge_daemon.py .
RUN useradd -r -u 1001 nexus && mkdir -p /app/estado && chown nexus /app/estado
USER nexus

ENV QUEUE_FILE=/app/estado/cola_pendiente.jsonl
CMD ["python3", "edge_daemon.py", "--env", "/dev/null"]
