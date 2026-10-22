#!/usr/bin/env bash
# Core switching test: two local tools, one GPU budget.
# Proves select-to-load: fish 5GB resident blocks qwen 2.5GB (7GB cap),
# unload -> load -> infer works, both takes playable via core proxy.
# Usage: bash scripts/switch.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
# Stubs use zero VRAM: bypass the shared-GPU wait gate for plumbing tests.
export CORE_GPU_WAIT=0
export DATA_PATH="${DATA_PATH:-/tmp/core-switch.db}"
rm -f "$DATA_PATH"
CURL="curl -s --max-time 5"
STUB1=0; STUB2=0; COREPID=0
cleanup() { kill "$STUB1" "$STUB2" "$COREPID" 2>/dev/null || true; }
trap cleanup EXIT

FISH_PORT=8101 nohup python3 "$ROOT/tools/tts-fish-s1mini/server.py" > /tmp/core-sw-fish.log 2>&1 &
STUB1=$!
QWEN_PORT=8102 nohup python3 "$ROOT/tools/tts-qwen3/server.py" > /tmp/core-sw-qwen.log 2>&1 &
STUB2=$!
sleep 2
$CURL http://127.0.0.1:8101/health | grep -q '"ok": true' || { echo "FAIL: fish stub"; exit 1; }
$CURL http://127.0.0.1:8102/health | grep -q '"ok": true' || { echo "FAIL: qwen stub"; exit 1; }

(cd "$ROOT/core" && npm run build >/dev/null 2>&1)
DATA_PATH=/tmp/core-switch.db PORT=$PORT FISH_URL=http://127.0.0.1:8101 QWEN_URL=http://127.0.0.1:8102 \
  nohup node "$ROOT/core/dist/index.js" > /tmp/core-sw-core.log 2>&1 &
COREPID=$!
sleep 2
$CURL http://127.0.0.1:$PORT/v1/health | grep -q '"service":"core"' || { echo "FAIL: core"; tail -5 /tmp/core-sw-core.log; exit 1; }

# 1. fish loads (5GB of 7GB)
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/load | grep -q '"ok":true' \
  || { echo "FAIL: fish load"; exit 1; }
# 2. qwen blocked while fish resident (5 + 2.5 > 7)
CODE=$(curl -s --max-time 5 -o /tmp/core-sw-body.txt -w "%{http_code}" -X POST http://127.0.0.1:$PORT/v1/tools/tts-qwen3-0.6B/load)
[ "$CODE" = "409" ] || { echo "FAIL: expected 409 over-cap, got $CODE"; cat /tmp/core-sw-body.txt; exit 1; }
echo "over-cap correctly rejected (409)"
# 3. fish job -> done + wav
J1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"take one fish voice"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
R1=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J1 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "fish job: $R1"
echo "$R1" | grep -q "^done take-" || { echo "FAIL: fish job"; exit 1; }
# 4. switch: unload fish, load qwen
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-qwen3-0.6B/load | grep -q '"ok":true' \
  || { echo "FAIL: qwen load after unload"; exit 1; }
$CURL http://127.0.0.1:$PORT/v1/gpu | grep -q 'tts-qwen3-0.6B' || { echo "FAIL: gpu state"; exit 1; }
# 5. qwen job -> done + wav, proxy serves both takes
J2=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-qwen3-0.6B","prompt":"take two qwen voice"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
R2=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J2 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "qwen job: $R2"
echo "$R2" | grep -q "^done take-" || { echo "FAIL: qwen job"; exit 1; }
REF1=$(echo "$R1" | cut -d' ' -f2); REF2=$(echo "$R2" | cut -d' ' -f2)
[ "$REF1" != "$REF2" ] || { echo "FAIL: takes not distinct"; exit 1; }
$CURL http://127.0.0.1:$PORT/v1/audio/$REF1 -o /tmp/core-sw-1.wav
$CURL http://127.0.0.1:$PORT/v1/audio/$REF2 -o /tmp/core-sw-2.wav
[ -s /tmp/core-sw-1.wav ] && [ -s /tmp/core-sw-2.wav ] || { echo "FAIL: wav proxy"; exit 1; }
echo "SWITCH PASS: fish=$REF1 ($(stat -c%s /tmp/core-sw-1.wav)B) qwen=$REF2 ($(stat -c%s /tmp/core-sw-2.wav)B)"
