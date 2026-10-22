# Syrinx — local audio workstation

Sibling to `Optic/` (vision). `Syrinx/` does TTS / clone / music / SFX
on the same 8GB box, one model resident at a time.

- Core: Node 24 + Fastify on `:3001` (Optic uses `:3000`).
  `POST /v1/jobs` requires `prompt`. SSE `chunk/waveform/transcript/take/done`.
- GPU: 7GB cap. `tts-fish-s1mini` 5GB flagship. Never run Optic + Syrinx cores at once in v1.
- Tools: Python `uv` sidecars over localhost HTTP. See `tools/tts-fish-s1mini/`.

## Deploy (one command, stub mode, no GPU needed)
```
bash Syrinx/scripts/deploy.sh        # preflight -> install -> build -> e2e gate -> start
bash Syrinx/scripts/deploy.sh stop   # stop stub + core
bash Syrinx/scripts/deploy.sh status # health + gpu + player URL
```
Player: `http://127.0.0.1:3001/`. Live GPU steps: `docs/live-runbook.md`.

## Docker (same stack, containerized)
```
cd Syrinx
docker compose up --build -d   # core :3001, fish :8101, qwen :8102,
                               # music :8104, sfx :8105, cpm2 :8106
bash scripts/docker-e2e.sh     # gates the running stack: switch + refs + proxy
docker compose down            # clean stop
```
Sidecars carry `nvidia` GPU reservations (verified: `nvidia-smi` sees the
3070 Ti inside containers), so the live swap is env-only: `target: live` +
checkpoint mounts + `CORE_STRICT=1` (see `docs/live-runbook.md`). Refs fan
out to every sidecar on upload, so a voice works whichever tool is resident.

## Quick start (manual)
```
cd Syrinx/core
npm install
npm run build
npm test
FISH_URL=http://127.0.0.1:8101 PORT=3001 node dist/index.js &
python3 ../tools/tts-fish-s1mini/server.py &
curl -X POST http://127.0.0.1:3001/v1/tools/tts-fish-s1mini/load
curl -X POST http://127.0.0.1:3001/v1/jobs \
  -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"hello"}'
```

## Layout
```
Syrinx/
  core/  # gateway, scheduler, gpu, store, web (later)
  tools/ # tts-fish-s1mini (stub, real fish-speech TODO)
  docs/  # concept, architecture, stack, tools, modes, foundations, production
```

## License

[MIT](LICENSE)
