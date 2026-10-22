# Syrinx — Live Test Runbook (GPU box)

Stub e2e already passes (`bash scripts/e2e.sh`, `bash scripts/docker-e2e.sh`
against compose). This box HAS the GPU in docker (verified: `nvidia-smi -L`
inside a `--gpus all` container lists the 3070 Ti), so live can run
containerized. Do this when weights / repo are ready.

## 0. Docker path (recommended on this box)
```
cd Syrinx
docker compose up --build -d   # stub stack, all healthy
bash scripts/docker-e2e.sh     # DOCKER-E2E PASS before touching live
```
Live swap per sidecar: set `target: live`, mount weights + repo, add env:
```
  fish:
    build: { context: ./tools/tts-fish-s1mini, target: live }
    environment: { FISH_CKPT: /checkpoints/s1-mini, FISH_REPO: /repo, CORE_STRICT: 1 }
    volumes: [./tools/tts-fish-s1mini/checkpoints/s1-mini:/checkpoints/s1-mini:ro,
              ./tools/tts-fish-s1mini/fish-speech:/repo:ro, ...]
```
then `docker compose up --build fish && bash scripts/docker-e2e.sh`.
Native (no-docker) path is §2-4 below.

## 1. Preconditions
- [ ] GPU box up: `nvidia-smi` shows RTX 3070 Ti 8GB, driver 596+.
- [ ] Queue, don't fight: Syrinx jobs can be created any time (API/player/
      durable SQLite), but the worker holds them `queued` with a
      `waiting-gpu` event while Optic holds VRAM past the 7GB cap —
      no OOM, they auto-run when the card frees. `CORE_GPU_WAIT` must be
      **unset** in production (test scripts/compose set it to 0 because
      stubs use no VRAM).
- [ ] Ports free: `:3001` (Syrinx core), `:8101` (fish sidecar).
- [ ] System deps: `ffmpeg`, `libsox-dev`, `portaudio19-dev`.
- [ ] HF access accepted for `fishaudio/s1-mini` (gated, CC-BY-NC-SA-4.0).

## 2. Weights (one time)
```
cd Syrinx/tools/tts-fish-s1mini
uv tool install 'huggingface_hub[cli]'
bash download.sh   # -> ./checkpoints/s1-mini
```

## 3. Real backend (one time)
```
cd Syrinx/tools/tts-fish-s1mini
uv sync
# implement _try_real_infer() in server.py against
# checkpoints/s1-mini (text2semantic + DAC codec), then:
FISH_CKPT=$PWD/checkpoints/s1-mini FISH_PORT=8101 uv run server.py
curl localhost:8101/health  # expect {"mode":"real",...}
```
Live safety: start with `CORE_STRICT=1` — real-mode failures return 502
instead of sine fallback, so a bad weight/rev can never present fake
audio as cloned. First live run validates `_try_real_infer()` filenames
against the pinned `FISH_REV`; adjust globs in `server.py` if upstream
renamed outputs, keep the HTTP contract stable.

## 4. Live test
```
cd Syrinx/core && npm run build
bash ../scripts/e2e.sh        # stub-mode gate, must stay green
# then with real sidecar on :8101:
FISH_URL=http://127.0.0.1:8101 PORT=3001 node dist/index.js
curl -X POST localhost:3001/v1/tools/tts-fish-s1mini/load
curl -X POST localhost:3001/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"hello live test"}'
# open http://127.0.0.1:3001/ -> player, compare take vs stub wav
```

## 5. Pass criteria
- `GET /v1/health` ok, `GET /v1/gpu` shows `tts-fish-s1mini` 5GB.
- Job `queued -> done`, SSE has `transcript + waveform + done`.
- `GET /v1/audio/<ref>` returns playable wav (not sine).
- `bash scripts/e2e.sh` still green after (no regressions).

## 6. Rollback
- `POST /v1/tools/tts-fish-s1mini/unload`, stop core, restart Optic.
- Real-model issues go in `tools/tts-fish-s1mini/TODO-live.md` (TBD).

## 7. Real-test status (native path, shared user-site python, no venvs)
Repro: `bash scripts/real-sweep.sh` (Optic-`sweep.sh` mirror: TSV +
saved takes in `tmp/real-sweep/`, sequential load->job->unload per tool
for the 7GB cap, honest SKIP for gated fish). Last green run below.
Verified end-to-end through core (`POST /v1/tools/<id>/load` + job ->
`done` + playable take). Sidecars run with system `python3`
(`~/.local/lib/python3.12/site-packages`, torch 2.8.0+cu126).

| Tool | Verdict | Take |
|---|---|---|
| tts-cpm2 (GGUF Q8_0, `~/.local/bin/voxcpm2-cli`) | REAL PASS | 1.92s @ 48kHz, peak 0.82 |
| music-musicgen-small (transformers) | REAL PASS | 15.06s @ 32kHz, dynamic RMS |
| tts-qwen3-0.6B (CustomVoice, preset speakers) | REAL PASS | 3.36s @ 24kHz, peak 0.70 |
| tts-kokoro-82M | REAL PASS | 2.65–3.6s @ 24kHz |
| sfx-bark (text_2 + coarse_2 + fine_2, ~12.6GB disk) | REAL PASS | 2.57s @ 24kHz native, peak 0.95 (`CORE_STRICT=1`, so no stub fallback possible) |
| tts-fish-s1mini | BLOCKED (gated) | HF file download returns **401**; needs access approval. Repo cloned at `befe400`, `fish-speech` installed (minus pyaudio/gradio). |

Gotchas (all hit live, all have fixes in tree):
- Bark + torch >= 2.6: `preload_models()` calls bare `torch.load`
  (now defaults `weights_only=True`). `tools/sfx-bark/server.py`
  wraps it with `weights_only=False` (cache is HF `suno/bark`, trusted).
- Kokoro needs `espeakng` pip + spacy `en_core_web_sm` wheel
  pre-installed (its runtime auto-`pip install` dies on
  externally-managed env). Weights wired into HF blob/snapshot cache;
  launch with `LD_LIBRARY_PATH` + `ESPEAK_DATA_PATH` pointing at
  `~/.local/espeak` (no sudo).
- cpm2 sidecar env is `CPM_CKPT` (gguf dir) + `CPM_CLI`
  (`$HOME/.local/bin/voxcpm2-cli`). Core `/load` books GPU but does
  not flip sidecar `loaded` — if a job sticks at `queued`, POST the
  sidecar `/load` directly.
- Large HF downloads: `curl -C -` with `--retry/--retry-all-errors`
  **truncates the file on retry** (lost ~2.8GB of `fine_2.pt` twice;
  a stale `dl-bark.sh` loop also survived kills and re-truncated).
  Use append-only range requests requiring HTTP 206 + matching
  Content-Range before writing (see `/tmp/dl-safe.py`), one writer
  only, and `pkill -9` + `fuser` to confirm no stale loops.
- Bark weights: `text_2.pt` (5.0G) + `coarse_2.pt` (3934534533 B) +
  `fine_2.pt` (3741740229 B) in `~/.cache/suno/bark_v0/`; verify exact
  byte sizes after download.
