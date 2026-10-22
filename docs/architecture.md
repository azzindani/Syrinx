# Architecture

## Layout
```
Syrinx/
  core/      # gateway, scheduler, gpu manager, store, web shell
  tools/     # one dir per tool, self-contained plugin
  docs/      # concept, architecture, tools, modes
```

No `syrinx-*` sub dirs. Core is `core`.

## Core responsibilities
- **gateway:** creates jobs, routes to batch or stream queue.
  Serves `POST /v1/jobs`, `GET /v1/jobs/:id`,
  `GET /v1/jobs/:id/events` (SSE), `GET /v1/jobs/:id/result`,
  `POST /v1/jobs/:id/input`, `POST /v1/jobs/:id/cancel`,
  `POST /v1/jobs/:id/retry`, `GET /v1/gpu`,
  `POST /v1/tools/:id/load`. Stateless, scalable behind any LB.
- **scheduler:** two queues. Stream preempts batch. Batch resumes
  after. Jobs stay queued during model switch.
- **shared-GPU wait (v1 queue-and-wait):** Optic owns no common arbiter
  with Syrinx. Before GPU infer the worker checks `nvidia-smi` used VRAM;
  if our model would breach the 7GB cap it requeues silently (one
  `waiting-gpu` event per job) and retries every poll until the other
  project frees the card. `CORE_GPU_WAIT=0` bypasses this and is correct
  only when all sidecars are stubs (zero VRAM).
- **gpu manager:** select-to-load. Loads exactly the chosen tool,
  unloads the rest. Enforces VRAM cap (7 GB of 8 GB, 1 GB headroom).
  Reports `GET /gpu` status and streams load progress.
- **store:** prompts, reference audio, waveforms, clips, takes,
  transcripts. Common schema for every audio task:
  `prompt + ref -> waveform / clips / transcript + takes`.
- **web shell:** player plus tool dropdown. No per-tool UI fork.

## Flow
1. Client creates job with `tool` and `mode`.
2. Manager ensures tool loaded, else drain, unload, load, warmup.
3. Workers run sidecar infer, stream chunks.
4. Results stream as SSE events: `status`, `chunk`, `waveform`,
   `transcript`, `take`, `done`. Upstream cancel via plain POST,
   so no sticky sessions are needed.
5. Human picks take, re-runs with new seed/prompt only.

## Concurrency model
One active GPU job at a time on 8GB. Uploads concurrent, infer
serial. Text-first: validate prompt/ref before loading GPU.
Cloud providers (fish.audio API, elevenlabs) bypass GPU manager.

## Optic coexistence v1
Only one core (`Optic` or `Syrinx`) runs at a time on the same box.
Future: single arbiter owns 7GB across vision + audio tools.
HTTP contract stays identical so merge needs no route change.
