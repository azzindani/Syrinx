# music-musicgen-small sidecar — stub + real (transformers) paths.
# Meta MusicGen-small (300M, MIT): text-to-music, 30s mono clips at 32kHz.
# STUB fallback writes a chord-arpeggio WAV so music takes are
# distinguishable from voice takes in switching tests.
# REAL: run this file with system python3 (shared user-site torch +
# transformers), then POST /load once. Weights auto-download from HF
# on first load (facebook/musicgen-small, ~1GB).
# Contract:
#   GET  /health -> {ok, mode, loaded, ckpt}
#   POST /load -> {ok, mode} (loads ~1GB to GPU, warmup)
#   POST /unload -> {ok} (free VRAM)
#   POST /infer {prompt, seed} -> {audio_ref, transcript, chunks, mode}
# Env: MUSIC_PORT (default 8104), ARTIFACT_DIR (default ./artifacts),
#      MUSIC_MODEL (default facebook/musicgen-small), MUSIC_DURATION
#      (seconds per take, default 10, max 30),
#      core side: MUSIC_URL=http://127.0.0.1:8104.
import json
import math
import os
import struct
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("MUSIC_PORT", os.environ.get("PORT", "8104")))
BIND = os.environ.get("BIND", "127.0.0.1")
ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", os.path.join(os.path.dirname(__file__), "artifacts"))
MODEL_ID = os.environ.get("MUSIC_MODEL", "facebook/musicgen-small")
DURATION = min(30, max(4, int(os.environ.get("MUSIC_DURATION", "10"))))
os.makedirs(ARTIFACT_DIR, exist_ok=True)

_loaded = False
_real_available = False
try:
    import importlib.util as _ilu  # noqa
    _real_available = _ilu.find_spec("transformers") is not None
except Exception:
    _real_available = False

_music_model = None
_music_processor = None


def _ensure_music():
    """Lazy-load MusicGen-small (transformers) onto CUDA. Raises on cause."""
    global _music_model, _music_processor
    if _music_model is not None:
        return _music_model, _music_processor
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("need CUDA for the real path (stub otherwise)")
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    _music_processor = AutoProcessor.from_pretrained(MODEL_ID)
    _music_model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
    _music_model.to("cuda")
    return _music_model, _music_processor


def _chord_wav(path: str, seconds: float = 8.0, sr: int = 32000, root: float = 220.0):
    # I–iii–V arpeggio feel: root, +4st, +7st cycling per second.
    steps = [0, 4, 7, 4]
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n):
            st = steps[int(i / sr) % len(steps)]
            f = root * (2 ** (st / 12))
            v = int(11000 * math.sin(2 * math.pi * f * i / sr)
                    + 5000 * math.sin(2 * math.pi * f * 2 * i / sr))
            w.writeframes(struct.pack("<h", max(-32768, min(32767, v))))


def _try_real_infer(prompt: str, seed, out_path: str) -> bool:
    """MusicGen-small generate (50 tokens/sec). True iff out_path written."""
    import torch
    model, processor = _ensure_music()
    if isinstance(seed, int):
        torch.manual_seed(seed)
    inputs = processor(text=[prompt], padding=True, return_tensors="pt")
    inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in inputs.items()}
    # 50 audio tokens per second; +256 decoder primer.
    max_tokens = min(30, DURATION) * 50 + 256
    with torch.no_grad():
        audio = model.generate(
            **inputs, max_new_tokens=max_tokens, guidance_scale=3.0)
    wav = audio[0, 0].detach().float().cpu().numpy()
    peak = max(1e-9, float(abs(wav).max()))
    import soundfile as sf
    sf.write(out_path, (wav / peak * 0.95).astype("float32"), 32000)
    return True


def _unload_music():
    global _music_model
    _music_model = None
    try:
        import torch
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send({"ok": True, "mode": "real" if _real_available else "stub",
                        "loaded": _loaded, "ckpt": MODEL_ID})
            return
        if parsed.path.startswith("/audio/"):
            name = os.path.basename(parsed.path[len("/audio/"):])
            path = os.path.join(ARTIFACT_DIR, name)
            if not os.path.isfile(path):
                self._send({"error": "unknown audio"}, 404)
                return
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._send({"error": "unknown route"}, 404)

    def do_POST(self):
        global _loaded
        if self.path == "/load":
            if _real_available:
                try:
                    _ensure_music()
                except Exception as e:
                    self._send({"error": f"real load failed: {e}"}, 502)
                    return
            _loaded = True
            self._send({"ok": True, "mode": "real" if _real_available else "stub"})
            return
        if self.path == "/unload":
            if _real_available:
                _unload_music()
            _loaded = False
            self._send({"ok": True})
            return
        if self.path == "/infer":
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            prompt = req.get("prompt", "")
            seed = req.get("seed")
            if not isinstance(prompt, str) or not prompt.strip():
                self._send({"error": "prompt (non-empty string) is required"}, 400)
                return
            if req.get("ref_id") is not None:
                self._send({"error": "music tools take no ref_id"}, 400)
                return
            seconds = min(30.0, max(4.0, len(prompt) / 5.0))
            fname = f"music-{int(time.time()*1000)}-{abs(hash(prompt))%9999}.wav"
            out_path = os.path.join(ARTIFACT_DIR, fname)
            mode = "stub"
            strict = os.environ.get("CORE_STRICT", "") not in ("", "0")
            if _real_available:
                try:
                    if _try_real_infer(prompt, seed, out_path):
                        mode = "real"
                    else:
                        raise RuntimeError("real infer returned False")
                except Exception as e:
                    if strict:
                        self._send({"error": f"real infer failed: {e}"}, 502)
                        return
                    root = 196.0 + (abs(hash(str(seed))) % 120)
                    _chord_wav(out_path, seconds=seconds, root=root)
            else:
                root = 196.0 + (abs(hash(str(seed))) % 120)
                _chord_wav(out_path, seconds=seconds, root=root)
            self._send({
                "audio_ref": fname,
                "transcript": prompt,
                "chunks": int(seconds),
                "mode": mode,
            })
            return
        self._send({"error": "unknown route"}, 404)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    HTTPServer((BIND, PORT), H).serve_forever()
