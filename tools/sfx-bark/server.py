# sfx-bark sidecar — stub + real (suno/bark) paths.
# Suno Bark (MIT): speech + non-speech audio (laughs, SFX, ambience).
# STUB fallback writes a noise-burst WAV so SFX takes are
# distinguishable from voice/music takes.
# REAL: run this file with the tool venv python (has torch + bark),
# then POST /load once. Weights auto-download from HF on first load
# (suno/bark, ~1GB).
# Contract:
#   GET  /health -> {ok, mode, loaded, ckpt}
#   POST /load -> {ok, mode} (preload models to GPU)
#   POST /unload -> {ok} (free VRAM)
#   POST /infer {prompt, seed} -> {audio_ref, transcript, chunks, mode}
# Env: BARK_PORT (default 8105), ARTIFACT_DIR (default ./artifacts),
#      core side: SFX_URL=http://127.0.0.1:8105.
import json
import math
import os
import random
import struct
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("BARK_PORT", os.environ.get("PORT", "8105")))
BIND = os.environ.get("BIND", "127.0.0.1")
ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", os.path.join(os.path.dirname(__file__), "artifacts"))
os.makedirs(ARTIFACT_DIR, exist_ok=True)

_loaded = False
_real_available = False
try:
    import importlib.util as _ilu  # noqa
    _real_available = _ilu.find_spec("bark") is not None
except Exception:
    _real_available = False

_bark_ready = False


def _ensure_bark():
    """Preload Bark models onto CUDA (downloads ~5GB on first run)."""
    global _bark_ready
    if _bark_ready:
        return
    import functools
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("need CUDA for the real path (stub otherwise)")
    # Bark predates torch 2.6 (weights_only defaults True now) and calls
    # bare torch.load on its own .pt checkpoints. Our cache comes straight
    # from suno/bark on HF (trusted source), so restore the old default.
    _orig_load = torch.load
    torch.load = functools.partial(_orig_load, weights_only=False)  # type: ignore[method-assign]
    try:
        from bark import preload_models
        preload_models()
    finally:
        torch.load = _orig_load
    _bark_ready = True


def _burst_wav(path: str, seconds: float = 3.0, sr: int = 22050, seed=None):
    # Decaying noise bursts: percussive/SFX feel, seeded for repeat takes.
    rnd = random.Random(seed)
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        burst = 0.0
        for i in range(n):
            if rnd.random() < 0.002:
                burst = rnd.uniform(0.4, 1.0)
            burst *= 0.9985
            v = int(16000 * burst * (rnd.uniform(-1, 1) * 0.7
                    + 0.3 * math.sin(2 * math.pi * 180 * i / sr)))
            w.writeframes(struct.pack("<h", max(-32768, min(32767, v))))


def _try_real_infer(prompt: str, seed, out_path: str) -> bool:
    """Bark generate (speech + laughs/SFX). True iff out_path written."""
    import numpy as np
    _ensure_bark()
    from bark import SAMPLE_RATE, generate_audio
    audio = generate_audio(prompt)
    audio = np.asarray(audio, dtype=np.float32)
    peak = max(1e-9, float(np.abs(audio).max()))
    import soundfile as sf
    sf.write(out_path, (audio / peak * 0.95).astype(np.float32), SAMPLE_RATE)
    return True


def _unload_bark():
    global _bark_ready
    _bark_ready = False
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
                        "loaded": _loaded, "ckpt": "suno/bark"})
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
                    _ensure_bark()
                except Exception as e:
                    self._send({"error": f"real load failed: {e}"}, 502)
                    return
            _loaded = True
            self._send({"ok": True, "mode": "real" if _real_available else "stub"})
            return
        if self.path == "/unload":
            if _real_available:
                _unload_bark()
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
                self._send({"error": "sfx tools take no ref_id"}, 400)
                return
            seconds = min(10.0, max(1.0, len(prompt) / 8.0))
            fname = f"sfx-{int(time.time()*1000)}-{abs(hash(prompt))%9999}.wav"
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
                    _burst_wav(out_path, seconds=seconds, seed=seed)
            else:
                _burst_wav(out_path, seconds=seconds, seed=seed)
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
