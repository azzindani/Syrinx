# tts-kokoro sidecar. Two targets:
#   stub (default): stdlib-only, low-register sine fallback — no GPU.
#   live: torch + kokoro weights (hexgrad/Kokoro-82M) — GPU box only.
FROM python:3.12-slim AS stub
WORKDIR /srv
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references
ENV BIND=0.0.0.0 KOKORO_PORT=8103
EXPOSE 8103
HEALTHCHECK --interval=5s --retries=12 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8103/health').status==200 else 1)"
CMD ["python3", "server.py"]

FROM nvidia/cuda:12.6.0-runtime-ubuntu24.04 AS live
ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg curl espeak-ng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY pyproject.toml ./
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references \
 && pip3 install --no-cache-dir "torch==2.8.0" --index-url https://download.pytorch.org/whl/cu126 \
 && pip3 install --no-cache-dir huggingface_hub "kokoro>=0.9" onnxruntime
# Live needs: KOKORO_CKPT mount + CORE_STRICT=1.
ENV BIND=0.0.0.0 KOKORO_PORT=8103 CORE_STRICT=1
EXPOSE 8103
HEALTHCHECK --interval=10s --retries=30 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8103/health').status==200 else 1)"
CMD ["python3", "server.py"]
