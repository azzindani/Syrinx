# tts-qwen3 sidecar — stub + real (Qwen3-TTS CustomVoice) paths.
# Qwen3-TTS-12Hz-0.6B-CustomVoice, Apache-2.0: 9 preset speakers,
# instruction control, no reference needed. STUB fallback writes a distinct
# sine WAV (higher register) so takes are distinguishable.
# REAL: run this file with the tool venv python (torch + qwen-tts),
# then POST /load once. QWEN_MODEL accepts an HF id or local dir
# (default: the downloaded checkpoints/qwen3-0.6b-custom).
# NOTE: CustomVoice = preset speakers, NOT cloning. ref_id is rejected
# honestly in real mode (cloning needs the Base variant — follow-up).
# Contract:
#   GET  /health -> {ok, mode, loaded, ckpt}
#   POST /load -> {ok, mode} (loads model to GPU)
#   POST /unload -> {ok} (free VRAM)
#   POST /infer {prompt, seed} -> {audio_ref, transcript, chunks, mode}
# Env: QWEN_PORT (default 8102), ARTIFACT_DIR (default ./artifacts),
#      QWEN_MODEL, QWEN_SPEAKER (default first supported), QWEN_LANG
#      (default Auto), core side: QWEN_URL=http://127.0.0.1:8102.
import base64
import json
import math
import os
import re
import struct
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("QWEN_PORT", os.environ.get("PORT", "8102")))
BIND = os.environ.get("BIND", "127.0.0.1")
ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", os.path.join(os.path.dirname(__file__), "artifacts"))
REF_DIR = os.environ.get("REF_DIR", os.path.join(os.path.dirname(__file__), "references"))
MODEL_ID = os.environ.get("QWEN_MODEL", os.path.join(os.path.dirname(__file__), "checkpoints", "qwen3-0.6b-custom"))
SPEAKER = os.environ.get("QWEN_SPEAKER", "")
LANG = os.environ.get("QWEN_LANG", "Auto")
os.makedirs(ARTIFACT_DIR, exist_ok=True)
os.makedirs(REF_DIR, exist_ok=True)
_REF_RE = re.compile(r"^[\w][\w\-.]{0,63}$")

_loaded = False
_real_available = False
try:
    import importlib.util as _ilu  # noqa
    _real_available = _ilu.find_spec("qwen_tts") is not None
except Exception:
    _real_available = False

_qwen = None
_qwen_speaker = None


def _ensure_qwen():
    """Lazy-load CustomVoice model onto CUDA. Raises with the real cause."""
    global _qwen, _qwen_speaker
    if _qwen is not None:
        return _qwen
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("need CUDA for the real path (stub otherwise)")
    from qwen_tts import Qwen3TTSModel
    model_id = MODEL_ID if os.path.isdir(MODEL_ID) else "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
    _qwen = Qwen3TTSModel.from_pretrained(
        model_id, device_map="cuda:0", dtype=torch.bfloat16)
    try:
        supported = list(_qwen.get_supported_speakers() or [])
    except Exception:
        supported = []
    _qwen_speaker = SPEAKER or (supported[0] if supported else "Ryan")
    return _qwen


def _sine_wav(path: str, seconds: float = 2.0, sr: int = 22050, freq: float = 440.0):
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n):
            v = int(16000 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframes(struct.pack("<h", v))


def _try_real_infer(prompt: str, ref_id, seed, out_path: str) -> bool:
    """CustomVoice generate with preset speaker. True iff out_path written."""
    if ref_id is not None:
        raise RuntimeError("CustomVoice takes no ref_id (preset speakers only); cloning needs the Base variant")
    import torch
    model = _ensure_qwen()
    kwargs = {}
    if isinstance(seed, int):
        torch.manual_seed(seed)
        kwargs["seed"] = seed
    wavs, sr = model.generate_custom_voice(
        text=prompt, language=LANG, speaker=_qwen_speaker, **kwargs)
    import soundfile as sf
    sf.write(out_path, wavs[0], sr)
    return True


def _unload_qwen():
    global _qwen, _qwen_speaker
    _qwen = None
    _qwen_speaker = None
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
        if parsed.path == "/refs":
            try:
                ids = sorted(d for d in os.listdir(REF_DIR)
                             if os.path.isdir(os.path.join(REF_DIR, d)))
            except OSError:
                ids = []
            self._send({"refs": ids})
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
                    _ensure_qwen()
                except Exception as e:
                    self._send({"error": f"real load failed: {e}"}, 502)
                    return
            _loaded = True
            self._send({"ok": True, "mode": "real" if _real_available else "stub"})
            return
        if self.path == "/unload":
            if _real_available:
                _unload_qwen()
            _loaded = False
            self._send({"ok": True})
            return
        if self.path == "/refs":
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            ref_id = req.get("ref_id", "")
            transcript = req.get("transcript", "")
            wav_b64 = req.get("wav_b64", "")
            if not isinstance(ref_id, str) or not _REF_RE.match(ref_id):
                self._send({"error": "ref_id must match [\\w][\\w\\-.]{0,63}"}, 400)
                return
            if not isinstance(transcript, str) or not transcript.strip():
                self._send({"error": "transcript (non-empty string) is required"}, 400)
                return
            try:
                wav = base64.b64decode(wav_b64, validate=True)
            except Exception:
                self._send({"error": "wav_b64 is not valid base64"}, 400)
                return
            if len(wav) < 1000:
                self._send({"error": "wav too small (need real audio bytes)"}, 400)
                return
            dest = os.path.join(REF_DIR, ref_id)
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, "sample.wav"), "wb") as f:
                f.write(wav)
            with open(os.path.join(dest, "sample.lab"), "w") as f:
                f.write(transcript.strip() + "\n")
            self._send({"ok": True, "ref_id": ref_id, "bytes": len(wav)})
            return
        if self.path == "/infer":
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            prompt = req.get("prompt", "")
            ref_id = req.get("ref_id")
            seed = req.get("seed")
            if not isinstance(prompt, str) or not prompt.strip():
                self._send({"error": "prompt (non-empty string) is required"}, 400)
                return
            if ref_id is not None and (
                not isinstance(ref_id, str)
                or not _REF_RE.match(ref_id)
                or not os.path.isfile(os.path.join(REF_DIR, ref_id, "sample.wav"))
            ):
                self._send({"error": f"unknown ref_id {ref_id!r}. POST /refs first."}, 400)
                return
            # Clamp prompt for stub timing: ~1s per 15 chars, 1-8s.
            seconds = min(8.0, max(1.0, len(prompt) / 15.0))
            fname = f"take-{int(time.time()*1000)}-{abs(hash(prompt))%9999}.wav"
            out_path = os.path.join(ARTIFACT_DIR, fname)
            mode = "stub"
            strict = os.environ.get("CORE_STRICT", "") not in ("", "0")
            if _real_available:
                try:
                    if _try_real_infer(prompt, ref_id, seed, out_path):
                        mode = "real"
                    else:
                        raise RuntimeError("real infer returned False")
                except Exception as e:
                    if strict:
                        self._send({"error": f"real infer failed: {e}"}, 502)
                        return
                    freq = 620.0 + (abs(hash(str(seed))) % 220)
                    _sine_wav(out_path, seconds=seconds, freq=freq)
            else:
                # Distinct voice vs fish stub (higher register) for take comparison.
                freq = 620.0 + (abs(hash(str(seed))) % 220)
                _sine_wav(out_path, seconds=seconds, freq=freq)
            self._send({
                "audio_ref": fname,
                "transcript": prompt,
                "chunks": int(seconds * 2),
                "mode": mode,
                "ref_used": ref_id,
            })
            return
        self._send({"error": "unknown route"}, 404)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    HTTPServer((BIND, PORT), H).serve_forever()
