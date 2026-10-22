# tts-cpm2 sidecar. Two targets:
#   stub (default): stdlib-only sine fallback — no GPU.
#   live: llama.cpp-omni voxcpm2-cli (CPU/CUDA/Vulkan) + GGUF mounts.
FROM python:3.12-slim AS stub
WORKDIR /srv
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references
ENV BIND=0.0.0.0 CPM_PORT=8106
EXPOSE 8106
HEALTHCHECK --interval=5s --retries=12 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8106/health').status==200 else 1)"
CMD ["python3", "server.py"]

FROM nvidia/cuda:12.6.0-runtime-ubuntu24.04 AS live
ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip curl git build-essential cmake ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY pyproject.toml ./
COPY server.py ./
RUN mkdir -p /srv/artifacts /srv/references \
 && git clone --depth 1 https://github.com/tc-mb/llama.cpp-omni.git /opt/llama-omni \
 && cmake -S /opt/llama-omni -B /opt/llama-omni/build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
 && cmake --build /opt/llama-omni/build --target voxcpm2-cli -j"$(nproc)" \
 && cp /opt/llama-omni/build/bin/voxcpm2-cli /usr/local/bin/ \
 && pip3 install --no-cache-dir huggingface_hub
# Live needs mounts: /checkpoints (BaseLM-Q8_0 + Acoustic-F16 gguf),
# env CPM_CKPT=/checkpoints CORE_STRICT=1.
ENV BIND=0.0.0.0 CPM_PORT=8106 CORE_STRICT=1
EXPOSE 8106
HEALTHCHECK --interval=10s --retries=30 \
  CMD python3 -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8106/health').status==200 else 1)"
CMD ["python3", "server.py"]
