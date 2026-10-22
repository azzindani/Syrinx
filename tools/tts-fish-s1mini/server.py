# tts-fish-s1mini sidecar — test-ready.
# Modes:
#   STUB fallback (default, no GPU/weights): writes real sine WAV per prompt
#     so core e2e validates audio_ref -> file -> playback pipeline.
#   REAL: set FISH_CKPT=/path/to/s1-mini + install fish-speech (see pyproject).
#     _try_real_infer() hook below is where fish-speech decode plugs in.
# Contract:
#   GET  /health -> {ok, mode, loaded, ckpt}
#   POST /load -> {ok, mode} (warmup / mark resident for 5GB budget)
#   POST /unload -> {ok} (free VRAM)
#   POST /infer {prompt, ref_id, seed} -> {audio_ref, transcript, chunks, mode}
# Env: PORT (default 8101), ARTIFACT_DIR (default ./artifacts),
#      FISH_CKPT (optional), FISH_URL=http://127.0.0.1:8101 (core side).
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

PORT = int(os.environ.get("FISH_PORT", os.environ.get("PORT", "8101")))
BIND = os.environ.get("BIND", "127.0.0.1")
ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", os.path.join(os.path.dirname(__file__), "artifacts"))
REF_DIR = os.environ.get("REF_DIR", os.path.join(os.path.dirname(__file__), "references"))
CKPT = os.environ.get("FISH_CKPT", "")
REPO = os.environ.get("FISH_REPO", os.path.join(os.path.dirname(__file__), "fish-speech"))
# FISH_COMPILE=1 enables torch.compile in the real path (faster steady-state,
# minutes of warmup per process). Default off: fast iteration on the live box.
COMPILE = os.environ.get("FISH_COMPILE", "") not in ("", "0")
# CORE_STRICT=1 on the live GPU box: real-mode failures return 502 instead
# of silently falling back to sine (never present fake audio as cloned).
STRICT = os.environ.get("CORE_STRICT", "") not in ("", "0")
os.makedirs(ARTIFACT_DIR, exist_ok=True)
os.makedirs(REF_DIR, exist_ok=True)
_REF_RE = re.compile(r"^[\w][\w\-.]{0,63}$")

_loaded = False
_real_available = False
# Probe real backend without hard dependency (test box has no GPU/weights).
# Live needs: CKPT=checkpoints/openaudio-s1-mini (from download.sh) plus a
# fish-speech checkout at REPO (provides fish_speech.models.* CLIs).
# codec.pth is required: without weights the mode must report stub, never
# real (a bare CKPT dir would otherwise present sine fallback as cloning).
if CKPT and os.path.isfile(os.path.join(CKPT, "codec.pth")):
    try:
        import importlib.util as _ilu  # noqa
        _real_available = _ilu.find_spec("fish_speech") is not None or os.path.isfile(
            os.path.join(REPO, "fish_speech", "models", "dac", "inference.py"))
    except Exception:
        _real_available = False


def _sine_wav(path: str, seconds: float = 2.0, sr: int = 22050, freq: float = 440.0):
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n):
            v = int(16000 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframes(struct.pack("<h", v))


def _run(cmd, cwd, timeout=600):
    import subprocess
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])}… failed: {(p.stderr or p.stdout)[-2000:]}")
    return p


def _try_real_infer(prompt: str, ref_id, seed, out_path: str) -> bool:
    """Fish S1-mini single-call decode (live GPU path). True iff out_path written.

    Uses text2semantic/inference.py which handles ref encode + semantic gen +
    codec decode in one process (verified against fish-speech main):
      python text2semantic/inference.py --text <prompt>
        [--prompt-audio <ref.wav> --prompt-text <ref.lab>]
        --checkpoint-path <ckpt-dir> --output-dir <work> --output <work>/out.wav
        --seed <seed> [--compile] --device cuda
    <ckpt-dir> must exist and contain codec.pth (+ model weights).
    Random voice when ref_id is None (prompt flags omitted).
    Raises on any failure (STRICT mode turns it into a 502, never fake audio).
    """
    import shutil
    import tempfile
    ckpt = CKPT
    if not (os.path.isdir(ckpt) and os.path.isfile(os.path.join(ckpt, "codec.pth"))):
        raise RuntimeError(f"bad FISH_CKPT {ckpt!r}: need dir with codec.pth (see download.sh)")
    sem = os.path.join(REPO, "fish_speech", "models", "text2semantic", "inference.py")
    if not os.path.isfile(sem):
        raise RuntimeError(f"fish-speech checkout missing at {sem!r} (set FISH_REPO)")
    work = tempfile.mkdtemp(prefix="core-fish-")
    try:
        cmd = ["python", sem, "--text", prompt,
               "--checkpoint-path", ckpt,
               "--output-dir", work, "--output", os.path.join(work, "out.wav"),
               "--seed", str(seed if isinstance(seed, int) else 42),
               "--device", "cuda"]
        if COMPILE:
            cmd.append("--compile")
        if ref_id is not None:
            ref_wav = os.path.join(REF_DIR, ref_id, "sample.wav")
            ref_lab = os.path.join(REF_DIR, ref_id, "sample.lab")
            if not os.path.isfile(ref_wav):
                raise RuntimeError(f"missing {ref_wav}")
            with open(ref_lab) as f:
                ref_text = f.read().strip()
            cmd += ["--prompt-audio", ref_wav, "--prompt-text", ref_text]
        _run(cmd, cwd=work, timeout=1200)
        got = os.path.join(work, "out.wav")
        if not os.path.isfile(got) or os.path.getsize(got) < 1000:
            raise RuntimeError("real infer produced no wav (check rev vs flags)")
        shutil.move(got, out_path)
        return True
    finally:
        shutil.rmtree(work, ignore_errors=True)

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
                        "loaded": _loaded, "ckpt": CKPT or None})
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
            _loaded = True
            self._send({"ok": True, "mode": "real" if _real_available else "stub"})
            return
        if self.path == "/unload":
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
            if _real_available:
                try:
                    if _try_real_infer(prompt, ref_id, seed, out_path):
                        mode = "real"
                    else:
                        raise RuntimeError("real infer returned False")
                except Exception as e:
                    if STRICT:
                        self._send({"error": f"real infer failed: {e}"}, 502)
                        return
                    freq = 440.0 + (abs(hash(str(seed))) % 220)
                    _sine_wav(out_path, seconds=seconds, freq=freq)
            else:
                freq = 440.0 + (abs(hash(str(seed))) % 220)
                _sine_wav(out_path, seconds=seconds, freq=freq)
            # STUB: real server runs S1-mini and writes wav, returns ref.
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
