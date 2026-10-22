#!/usr/bin/env bash
# Core e2e check (stub mode, no GPU needed). Fails fast with actionable output.
# Usage: bash scripts/e2e.sh
# NOTE: servers run via nohup with logs redirected so CI shells don't hang.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/core"
export PORT="${PORT:-3001}"
export FISH_URL="${FISH_URL:-http://127.0.0.1:8101}"
export DATA_PATH="${DATA_PATH:-/tmp/core-e2e-check.db}"
# Stubs use zero VRAM: bypass the shared-GPU wait gate for plumbing tests.
export CORE_GPU_WAIT=0
rm -f "$DATA_PATH" /tmp/core-e2e-stub.log /tmp/core-e2e-core.log

CURL="curl -s --max-time 5"
STUB=0; COREPID=0
# NOTE: server.py reads PORT too, so pin it explicitly for the stub.
PORT=8101 nohup python3 "$ROOT/tools/tts-fish-s1mini/server.py" > /tmp/core-e2e-stub.log 2>&1 &
STUB=$!
cleanup() { kill "$STUB" "$COREPID" 2>/dev/null || true; }
trap cleanup EXIT

sleep 2
$CURL "$FISH_URL/health" | grep -q '"ok": true' || { echo "FAIL: sidecar health"; exit 1; }

(cd "$CORE" && npm run build >/dev/null 2>&1)
nohup node "$CORE/dist/index.js" > /tmp/core-e2e-core.log 2>&1 &
COREPID=$!
sleep 2
$CURL "http://127.0.0.1:$PORT/v1/health" | grep -q '"service":"core"' || { echo "FAIL: core health"; tail -5 /tmp/core-e2e-core.log; exit 1; }
$CURL -X POST "http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/load" | grep -q '"ok":true' || { echo "FAIL: load"; exit 1; }

JID=$($CURL -X POST "http://127.0.0.1:$PORT/v1/jobs" -H 'content-type: application/json' \
  -d "$(python3 -c "import json,sys; print(json.dumps({'tool_id':'tts-fish-s1mini','prompt':open(sys.argv[1]).read().strip()}))" "$ROOT/samples/prompt-1.txt")" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
STATUS=$($CURL "http://127.0.0.1:$PORT/v1/jobs/$JID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$STATUS" = "done" ] || { echo "FAIL: job status=$STATUS"; exit 1; }
REF=$($CURL "http://127.0.0.1:$PORT/v1/jobs/$JID" | python3 -c "import sys,json; a=json.load(sys.stdin)['artifact_refs']; print(a[0] if a else '')")
[ -n "$REF" ] || { echo "FAIL: empty artifact_refs"; exit 1; }
$CURL "http://127.0.0.1:$PORT/v1/audio/$REF" -o /tmp/core-check.wav
[ -s /tmp/core-check.wav ] || { echo "FAIL: empty wav"; exit 1; }
# result shape: transcript + playable take
$CURL "http://127.0.0.1:$PORT/v1/jobs/$JID/result" | python3 -c "
import sys,json
r = json.load(sys.stdin)
assert r['transcript'], 'empty transcript'
assert r['takes'] and r['takes'][0]['url'].startswith('/v1/audio/'), 'bad takes'
print('result ok:', r['transcript'][:40], '| takes:', len(r['takes']))
"
# retry as child take with a new seed
CID=$($CURL -X POST "http://127.0.0.1:$PORT/v1/jobs/$JID/retry" -H 'content-type: application/json' \
  -d '{"seed": 99}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
CS=$($CURL "http://127.0.0.1:$PORT/v1/jobs/$CID" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['parent_id'] == '$JID')")
echo "$CS" | grep -q "^done True" || { echo "FAIL: retry child: $CS"; exit 1; }
CR=$($CURL "http://127.0.0.1:$PORT/v1/jobs/$JID/result" | python3 -c "import sys,json; print(json.load(sys.stdin)['children'])")
echo "$CR" | grep -q "$CID" || { echo "FAIL: child missing from parent result"; exit 1; }
echo "retry ok: child=$CID"
echo "E2E PASS: job=$JID ref=$REF wav=$(stat -c%s /tmp/core-check.wav)B"
