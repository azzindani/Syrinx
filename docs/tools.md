# Tools

## Plugin contract
Each tool is one dir under `tools/` with:
- `manifest.yaml`: id, backend, vram estimate, labels, tier.
- `load()`, `unload()`, `infer()` with common I/O.

Backends allowed: transformers, diffusers, audiocraft, onnx, api.
Deps isolated per tool. No giant shared requirements file.

## v1 registry (voice first)
- `tts-fish-s1mini` — transformers, gpu, ~5 GB. FishAudio S1-mini 0.5B.
  Zero-shot clone 10-30s, 13 langs, emotion tags. Flagship v1.
  License CC-BY-NC-SA-4.0 (research/personal only).
- `tts-qwen3-0.6B` — transformers, gpu, ~2.5 GB. Qwen3-TTS 0.6B.
  3s clone, 97ms streaming, 10 langs. Commercial-safe fallback.
  License Apache 2.0.
- `tts-kokoro-82M` — onnx, **cpu**, 0 GB. 54 built-in voices, no clone.
  Fast narration lane, runs anywhere. License Apache 2.0.
- `tts-cpm2` — gguf (llama.cpp-omni), gpu, ~3 GB est. CPM2-class 2B,
  30 langs, 48kHz, controllable + ultimate cloning. License Apache 2.0.
  Ungated weights; vram figure calibrates on first live run.

Only GPU tools count toward the 7GB cap. CPU tools never block.

## CPU-native fx tools (v1, in-core DSP, no sidecar)
- `fx-spectrum` — frequency peaks of an uploaded wav.
- `fx-tuner` — pitch Hz + note + cents.
- `fx-gain` — gain dB + normalize/fade, returns a playable take.
- Input via `POST /v1/uploads` (`upload:<file>` in `input_refs`).

Only the selected tool is resident. Switching cost 3-8s cached.

## v2 tools (music/SFX stubs live, same contract)
- `music-musicgen-small` — audiocraft, gpu, ~4 GB. MIT, 30s mono clips.
  Stub writes chord takes; real impl TODO in sidecar.
- `sfx-bark` — transformers, gpu, ~5 GB. MIT, laughs/SFX/ambience.
  Stub writes noise-burst takes; real impl TODO in sidecar.
- `vc-rvc` — voice conversion, ~2.5 GB. (stub TBD)
- `stt-whisper-small` — transformers, ~2 GB. (stub TBD)
- `provider-fish` — api, 0 GB. Cloud fallback, bypasses GPU. (not wanted: local-only)

Adding one is: new dir plus registry entry. No core rewrite.

## Presets (tool combos — v1 single only)
- Voice Clone: fish-s1mini alone.
- Fast Narration: kokoro or qwen3-0.6B alone.
- Music: musicgen-small alone (v2).
- SFX: bark alone (v2).

No dual-resident presets on 8GB in v1. Cloud providers can run
alongside anything (no VRAM).
