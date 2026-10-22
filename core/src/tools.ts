// v1 tool registry. GPU voices + CPU-native lane (kokoro, fx).
import type { ToolManifest } from "./types.js";

export const registry = new Map<string, ToolManifest>([
  [
    "tts-fish-s1mini",
    {
      id: "tts-fish-s1mini",
      version: "s1-mini-0.5B",
      backend: "transformers",
      device: "gpu",
      vram_gb: 5,
      tier: "small",
      description: "FishAudio S1-mini 0.5B zero-shot clone, 13 langs. Flagship v1.",
    },
  ],
  [
    "tts-qwen3-0.6B",
    {
      id: "tts-qwen3-0.6B",
      version: "0.6B",
      backend: "transformers",
      device: "gpu",
      vram_gb: 2.5,
      tier: "tiny",
      description: "Qwen3-TTS CustomVoice 0.6B preset speakers. Apache-2.0.",
    },
  ],
  [
    "tts-kokoro-82M",
    {
      id: "tts-kokoro-82M",
      version: "82M",
      backend: "onnx",
      device: "cpu",
      vram_gb: 0,
      tier: "tiny",
      description: "Kokoro 82M fast narration, 54 voices, no clone. CPU-native.",
    },
  ],
  [
    "fx-spectrum",
    {
      id: "fx-spectrum",
      version: "1.0",
      backend: "local",
      device: "cpu",
      vram_gb: 0,
      tier: "tiny",
      description: "Frequency spectrum + peaks of an uploaded wav. CPU.",
    },
  ],
  [
    "fx-tuner",
    {
      id: "fx-tuner",
      version: "1.0",
      backend: "local",
      device: "cpu",
      vram_gb: 0,
      tier: "tiny",
      description: "Pitch detect: Hz + nearest note + cents. CPU.",
    },
  ],
  [
    "fx-gain",
    {
      id: "fx-gain",
      version: "1.0",
      backend: "local",
      device: "cpu",
      vram_gb: 0,
      tier: "tiny",
      description: "Apply gain dB (+ optional normalize/fade) to a wav. CPU.",
    },
  ],
  [
    "music-musicgen-small",
    {
      id: "music-musicgen-small",
      version: "small-300M",
      backend: "audiocraft",
      device: "gpu",
      vram_gb: 4,
      tier: "tiny",
      description: "MusicGen-small text-to-music, 30s mono. MIT.",
    },
  ],
  [
    "sfx-bark",
    {
      id: "sfx-bark",
      version: "bark-suno",
      backend: "transformers",
      device: "gpu",
      vram_gb: 5,
      tier: "small",
      description: "Bark speech + non-speech SFX (laughs, ambience). MIT.",
    },
  ],
  [
    "tts-cpm2",
    {
      id: "tts-cpm2",
      version: "2.0-gguf-q8",
      backend: "transformers",
      device: "gpu",
      vram_gb: 3,
      tier: "small",
      description: "CPM2-class 2B GGUF Q8_0, 30 langs, 48kHz, controllable clone. Apache-2.0.",
    },
  ],
]);
