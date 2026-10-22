#!/usr/bin/env bash
# Core refs test: reference-voice upload/list/use for cloning, via core.
# Usage: bash scripts/refs.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
# Stubs use zero VRAM: bypass the shared-GPU wait gate for plumbing tests.
export CORE_GPU_WAIT=0
CURL="curl -s --max-time 5"
STUB=0; COREPID=0
cleanup() { kill "$STUB" "$COREPID" 2>/dev/null || true; }
trap cleanup EXIT

export REFDIR=/tmp/core-refs-r; export ARTDIR=/tmp/core-refs-a
rm -rf "$REFDIR" "$ARTDIR"; mkdir -p "$REFDIR" "$ARTDIR"
rm -f /tmp/core-refs.db
FISH_PORT=8101 ARTIFACT_DIR="$ARTDIR" REF_DIR="$REFDIR" nohup python3 "$ROOT/tools/tts-fish-s1mini/server.py" > /tmp/core-refs-stub.log 2>&1 &
STUB=$!
sleep 2
$CURL http://127.0.0.1:8101/health | grep -q '"ok": true' || { echo "FAIL: stub"; exit 1; }

(cd "$ROOT/core" && npm run build >/dev/null 2>&1)
DATA_PATH=/tmp/core-refs.db PORT=$PORT FISH_URL=http://127.0.0.1:8101 nohup node "$ROOT/core/dist/index.js" > /tmp/core-refs-core.log 2>&1 &
COREPID=$!
sleep 2
$CURL http://127.0.0.1:$PORT/v1/health | grep -q '"service":"core"' || { echo "FAIL: core"; exit 1; }
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/load | grep -q '"ok":true' || { echo "FAIL: load"; exit 1; }

# 1. upload ref voice via core (2KB dummy wav bytes + transcript)
WAV=$(python3 -c "import base64; print(base64.b64encode(b'RIFF' + bytes(2000)).decode())")
$CURL -X POST http://127.0.0.1:$PORT/v1/refs -H 'content-type: application/json' \
  -d "{\"ref_id\":\"alice\",\"transcript\":\"hello i am alice\",\"wav_b64\":\"$WAV\"}" | grep -q '"ok":true' \
  || { echo "FAIL: refs upload"; exit 1; }
# 2. list contains alice
$CURL http://127.0.0.1:$PORT/v1/refs | grep -q alice || { echo "FAIL: refs list"; exit 1; }
echo "refs upload+list ok"
# 3. clone job with ref_id -> done, take carries ref_used
J1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"speak as alice","ref_id":"alice"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
$CURL http://127.0.0.1:$PORT/v1/jobs/$J1/events --max-time 8 2>/dev/null | grep -q ref_used \
  || { echo "FAIL: ref_used event"; exit 1; }
S1=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J1 | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$S1" = "done" ] || { echo "FAIL: clone job status=$S1"; exit 1; }
echo "clone job done with ref_used=alice"
# 4. unknown ref -> job errors honestly (sidecar 400, no fake audio)
J2=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"speak as nobody","ref_id":"nobody"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
S2=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J2 | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$S2" = "error" ] || { echo "FAIL: unknown-ref job status=$S2 (want error)"; exit 1; }
echo "unknown ref correctly errors"
echo "REFS PASS"
