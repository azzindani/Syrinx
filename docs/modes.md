# Modes and Hardware

## Stream mode (human playback)
Goal: first chunk <500ms for TTS, progressive waveform.
Tuning: short prompt windows, fp16, torch.compile, chunked decode.
Targeted re-render on take pick only (~2-5s), never full session.

## Batch mode
Goal: full clips per hour over many prompts.
Tuning: longer renders, queued music/SFX jobs, sequential GPU infer.
30s music clip in 45-60s on 8GB class (musicgen-small).

## Scheduler rule
Stream preempts batch. Batch throughput drops during stream,
then recovers. No inference during model switch.

## Headless
- `POST /jobs` with tool, mode, prompt, ref.
- `GET /jobs/{id}` for status and artifacts.
- CLI wraps same endpoints for scripts.

## Live UI
- `GET /jobs/{id}/events` SSE streams status, chunk, waveform,
  transcript, take patches.
- Player shows waveform, play button, takes compare, approve/retry.
- Phone or desktop browser can supply reference mic audio.
  No native capture dependency.

## Current hardware (Sep 2026 check, shared with Optic)
- WSL2 Ubuntu 24.04, 20 threads i7-12700H, 23 GB RAM, 1 TB disk.
- GPU: RTX 3070 Ti Laptop 8 GB via `/dev/dxg`, driver 596.36.
- No `/dev/video`, no `/dev/dri`, no native `/dev/nvidia*`.
- VRAM budget: cap resident at 7 GB, keep 1 GB headroom.
- Rule: `Optic` or `Syrinx` core runs, never both at once in v1.
