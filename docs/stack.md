# Stack

Locked for v1 single-user. No Python in production path.

## Core (`core/`)
- Runtime: Node 24, TypeScript strict.
- API: Fastify for REST plus SSE.
  Routes: `POST /v1/jobs`, `GET /v1/jobs/:id`,
  `GET /v1/jobs/:id/events` (SSE), `GET /v1/jobs/:id/result`,
  `POST /v1/jobs/:id/input`, `POST /v1/jobs/:id/cancel`,
  `POST /v1/jobs/:id/retry` (child take), `GET /v1/gpu`,
  `POST /v1/tools/:id/load`.
- Package: pnpm workspaces, tsc, vitest, eslint.
- Daemon: localhost only. Commands: `start`, `stop`, `status`.
  PID file plus health endpoint. No fleet code in v1.
  Must not run at same time as `Optic` core on same GPU in v1.

## Web (`core/web/`)
- React plus Vite plus TypeScript: Synthesize / FX / Refs tabs, SSE tail,
  `<audio>` playback via `/v1/audio/:ref`.
- Dev: `vite` on :5174 with `/v1` proxied to core :3001.
- Prod: `vite build`, served by core at `/app/` (no separate deploy).
  Inline player at `GET /` remains as zero-build fallback.

## Tools (`tools/*/`)
- Sidecar per tool over localhost HTTP. Core never imports ML code.
- `tts-fish-s1mini`, `tts-qwen3`, `tts-kokoro`: Python micro-servers
  with isolated `uv` envs (torch 2.8, torchaudio). Only code
  allowed to use Python.
- `music-musicgen`, `sfx-bark`: Python micro-servers with isolated
  `uv` envs (transformers, diffusers, audiocraft).
- `provider-fish`, `provider-eleven`: thin cloud proxies, no GPU.
- Manifest per tool: id, backend, vram estimate, tier, version.
- System deps: `ffmpeg`, `libsox-dev`, `portaudio19-dev`.

## Store and queue v1
- SQLite for jobs plus filesystem for audio and artifacts.
- In-process queue behind `Queue` interface. Same interface takes
  Redis or NATS later.
- Model cache under user cache dir. HF weights cached across
  restarts. Offline after first download (local tools only).

## Deferred
Redis, Postgres, S3, Docker Compose fleet, K8s, SSO. See foundations.

## Escape hatches (no rewrite)
- GPU manager plus scheduler can move to Go later. HTTP contract stays.
- Web can wrap in Tauri or Electron later. Same endpoints.
- Local tool can swap to cloud provider without route change.
