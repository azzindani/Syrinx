# tts-cpm2 sidecar — test-ready (local stub).
# Upstream model is VoxCPM2 (OpenBMB, 2B, Apache-2.0): 30 langs, 48kHz,
# controllable cloning. Our identifiers say cpm2 (no syrinx prefix rule).
# Full weights need ~8GB VRAM (over the 7GB cap), so live runs the GGUF
# Q8_0 pair (BaseLM-Q8_0 + Acoustic-F16, ~3GB) via llama.cpp-omni CLI.
# STUB fallback writes a distinct sine WAV so takes are distinguishable.
# REAL: CPM_CKPT=<gguf dir> + voxcpm2-cli on PATH, impl in _try_real_infer().
# Contract:
#   GET  /health -> {ok, mode, loaded, ckpt}
#   POST /load -> {ok, mode} (warmup / mark resident for 3GB budget)
#   POST /unload -> {ok} (free VRAM)
#   POST /infer {prompt, ref_id, seed} -> {audio_ref, transcript, chunks, mode}
# Env: CPM_PORT (default 8106), ARTIFACT_DIR (default ./artifacts),
#      CPM_CKPT (optional), CPM_CLI (default voxcpm2-cli),
#      core side: CPM_URL=http://127.0.0.1:8106.
import json
import math
import os
import struct
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("CPM_PORT", os.environ.get("PORT", "8106")))
BIND = os.environ.get("BIND", "127.0.0.1")
ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", os.path.join(os.path.dirname(__file__), "artifacts"))
REF_DIR = os.environ.get("REF_DIR", os.path.join(os.path.dirname(__file__), "references"))
CKPT = os.environ.get("CPM_CKPT", "")
CLI = os.environ.get("CPM_CLI", "voxcpm2-cli")
os.makedirs(ARTIFACT_DIR, exist_ok=True)
os.makedirs(REF_DIR, exist_ok=True)
import re
_REF_RE = re.compile(r"^[\w][\w\-.]{0,63}$")

_loaded = False
_real_available = False
if CKPT and os.path.isdir(CKPT):
    import shutil
    import glob as _glob
    _real_available = shutil.which(CLI) is not None and len(_glob.glob(os.path.join(CKPT, "*.gguf"))) >= 2


def _sine_wav(path: str, seconds: float = 2.0, sr: int = 22050, freq: float = 520.0):
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n):
            v = int(15000 * math.sin(2 * math.pi * freq * i / sr))
            w.writeframes(struct.pack("<h", v))


def _run(cmd, timeout=1200):
    import subprocess
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {(p.stderr or p.stdout)[-2000:]}")
    return p


def _try_real_infer(prompt: str, ref_id, seed, out_path: str) -> bool:
    """CPM2 GGUF decode (live path). True iff out_path written.

    Uses llama.cpp-omni voxcpm2-cli (CLI shape per tc-mb/llama.cpp-omni):
      voxcpm2-cli -t <text> [-r <ref.wav> |
        --prompt-wav <ref.wav> --prompt-text <ref.lab>] [--seed N]
        -o <out.wav> <baseLM.gguf> <acoustic.gguf>
    Raises on failure (STRICT turns it into a 502, never fake audio).
    """
    import glob
    import shutil
    ggufs = sorted(glob.glob(os.path.join(CKPT, "*.gguf")))
    base = next((g for g in ggufs if "BaseLM" in os.path.basename(g)), None)
    ac = next((g for g in ggufs if "coustic" in os.path.basename(g)), None)
    if not (base and ac):
        raise RuntimeError(f"need BaseLM + Acoustic .gguf in {CKPT!r}")
    cmd = [CLI, "-t", prompt]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    if ref_id is not None:
        ref_wav = os.path.join(REF_DIR, ref_id, "sample.wav")
        ref_lab = os.path.join(REF_DIR, ref_id, "sample.lab")
        if not os.path.isfile(ref_wav):
            raise RuntimeError(f"missing {ref_wav}")
        # Ultimate cloning: same clip as reference + continuation prompt.
        with open(ref_lab) as f:
            ref_text = f.read().strip()
        cmd += ["-r", ref_wav, "--prompt-wav", ref_wav, "--prompt-text", ref_text]
    cmd += ["-o", out_path, base, ac]
    _run(cmd)
    if not os.path.isfile(out_path) or os.path.getsize(out_path) < 1000:
        raise RuntimeError("voxcpm2-cli produced no wav")
    return True


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
            import base64
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
                    freq = 520.0 + (abs(hash(str(seed))) % 180)
                    _sine_wav(out_path, seconds=seconds, freq=freq)
            else:
                freq = 520.0 + (abs(hash(str(seed))) % 180)
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
