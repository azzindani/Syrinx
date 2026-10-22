# Syrinx — Concept

## What it is
General audio workstation in one project. Catalog can grow to all
audio tech (TTS, voice clone, voice conversion, STT, music, SFX,
composing). Only one tool resident on GPU at a time.

Sibling to `Optic/` (vision). Separate repo/folder, same pattern,
same box. No shared code in v1.

## Why
- One tool for audio productivity: point at text, get voice now,
  clone voice when needed, generate music/SFX when needed.
- Same backend serves automation and humans.
- Fits single 8GB GPU via explicit select-to-load.

## v1 flagship (local-first)
1. **TTS + voice clone (Fish S1-mini 0.5B):** zero-shot clone from
   10-30s reference, 13 langs, emotion/tone tags.
   Optimized for quality on 8GB.
2. **Fast narration fallback:** Kokoro-82M or Qwen3-TTS-0.6B for
   low VRAM / commercial-safe path.

Music/SFX (MusicGen-small, SA3-small, Bark) are v2 tools, same
contract, not resident with TTS.

## Two performance modes (both required)
- **Batch:** long music/SFX renders, minutes per job.
- **Stream:** TTS first-chunk fast (<500ms target), progressive
  waveform chunks for human playback.

Not simultaneous at full blast on 8GB. Scheduler prioritizes
interactive/stream over batch.

## Dual interface
- **Headless:** REST API and CLI for batch jobs.
- **UI:** web player subscribing to same jobs over SSE,
  showing waveform, transcript, takes, and download live.

## Rule
Project root is `Syrinx`. Core dir is `core`. No sub dir, package,
module, or function uses `syrinx` as prefix or name.
