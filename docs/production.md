# Production (single-user)

Production-grade here means reliable on one machine, not high RPS.

## Must-haves
- Durable jobs: create is transactional. Crash restarts resume queued
  jobs, mark GPU-leased job as interrupted with retry.
- VRAM guard: refuse load when `used + needed > 7 GB`. Clear error
  with current holder and one-click unload.
- Model switch: drain GPU lease, stop backend, free cache,
  load next, warmup one chunk, then resume queue.
- Offline: works after first model and engine download (local tools).
  Cloud providers require net, fail with actionable message.
- Logs: daemon log plus per-job log. `status` shows GPU, loaded tool,
  queue depth.
- Updates: pull plus restart. DB migrations forward-only.
- Backpressure: stream queue preempts batch. Batch resumes
  automatically. No manual cleanup.

## Checks on boot
GPU present, driver version, free VRAM, cache dir writable,
sidecar envs present, `ffmpeg` present, ref audio dir writable.
Fail with actionable message. Warn if `Optic` core already running
(same GPU) — refuse dual-run in v1.

## Limits v1
One active GPU job at a time. Concurrent uploads allowed, concurrent
GPU infer is not. This is intentional for 8 GB stability.
Cloud provider jobs can run concurrent (no GPU).
