#!/usr/bin/env bash
# Core music/SFX test: load/infer/proxy for the v2 lane + cap interplay.
# Usage: bash scripts/music.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
# Stubs use zero VRAM: bypass the shared-GPU wait gate for plumbing tests.
export CORE_GPU_WAIT=0
CURL="curl -s --max-time 5"
STUB1=0; STUB2=0; COREPID=0
cleanup() { kill "$STUB1" "$STUB2" "$COREPID" 2>/dev/null || true; }
trap cleanup EXIT

MUSIC_PORT=8104 nohup python3 "$ROOT/tools/music-musicgen-small/server.py" > /tmp/core-mu.log 2>&1 &
STUB1=$!
BARK_PORT=8105 nohup python3 "$ROOT/tools/sfx-bark/server.py" > /tmp/core-sfx.log 2>&1 &
STUB2=$!
sleep 2
$CURL http://127.0.0.1:8104/health | grep -q '"ok": true' || { echo "FAIL: music stub"; exit 1; }
$CURL http://127.0.0.1:8105/health | grep -q '"ok": true' || { echo "FAIL: sfx stub"; exit 1; }

(cd "$ROOT/core" && npm run build >/dev/null 2>&1)
rm -f /tmp/core-music.db
DATA_PATH=/tmp/core-music.db PORT=$PORT MUSIC_URL=http://127.0.0.1:8104 SFX_URL=http://127.0.0.1:8105 \
  nohup node "$ROOT/core/dist/index.js" > /tmp/core-mu-core.log 2>&1 &
COREPID=$!
sleep 2
$CURL http://127.0.0.1:$PORT/v1/health | grep -q '"service":"core"' || { echo "FAIL: core"; exit 1; }

# music loads (4GB), job renders a chord take
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/music-musicgen-small/load | grep -q '"ok":true' || { echo "FAIL: music load"; exit 1; }
M1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"music-musicgen-small","prompt":"upbeat synthwave loop 120 BPM","mode":"batch"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
R1=$($CURL http://127.0.0.1:$PORT/v1/jobs/$M1 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$R1" | grep -q "^done music-" || { echo "FAIL: music job: $R1"; exit 1; }
echo "music job: $R1"
# sfx blocked while music resident (4 + 5 > 7)
CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:$PORT/v1/tools/sfx-bark/load)
[ "$CODE" = "409" ] || { echo "FAIL: over-cap want 409 got $CODE"; exit 1; }
echo "over-cap correctly rejected (409)"
# switch to sfx, render a burst take
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/music-musicgen-small/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/sfx-bark/load | grep -q '"ok":true' || { echo "FAIL: sfx load"; exit 1; }
S1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"sfx-bark","prompt":"crowd laughing","mode":"batch"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
R2=$($CURL http://127.0.0.1:$PORT/v1/jobs/$S1 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$R2" | grep -q "^done sfx-" || { echo "FAIL: sfx job: $R2"; exit 1; }
echo "sfx job: $R2"
$CURL http://127.0.0.1:$PORT/v1/audio/$(echo "$R1" | cut -d' ' -f2) -o /tmp/core-mu.wav
$CURL http://127.0.0.1:$PORT/v1/audio/$(echo "$R2" | cut -d' ' -f2) -o /tmp/core-sfx.wav
[ -s /tmp/core-mu.wav ] && [ -s /tmp/core-sfx.wav ] || { echo "FAIL: wav proxy"; exit 1; }
echo "MUSIC PASS"
