# tts-fish-s1mini sidecar. Two targets:
#   stub (default): stdlib-only, sine fallback — no GPU, for plumbing tests.
#   live: CUDA torch + fish-speech checkout — built on the GPU box only.
FROM python:3.12-slim AS stub
WORKDIR /srv
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references
ENV BIND=0.0.0.0 FISH_PORT=8101
EXPOSE 8101
HEALTHCHECK --interval=5s --retries=12 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8101/health').status==200 else 1)"
CMD ["python3", "server.py"]

FROM nvidia/cuda:12.6.0-runtime-ubuntu24.04 AS live
ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg libsox-dev curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY pyproject.toml ./
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references \
 && pip3 install --no-cache-dir "torch==2.8.0" "torchaudio==2.8.0" --index-url https://download.pytorch.org/whl/cu126 \
 && pip3 install --no-cache-dir huggingface_hub
# Live needs mounts: /checkpoints (weights), /repo (fish-speech checkout),
# and env: FISH_CKPT=/checkpoints/s1-mini FISH_REPO=/repo CORE_STRICT=1 BIND=0.0.0.0
ENV BIND=0.0.0.0 FISH_PORT=8101 CORE_STRICT=1
EXPOSE 8101
HEALTHCHECK --interval=10s --retries=30 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8101/health').status==200 else 1)"
CMD ["python3", "server.py"]
