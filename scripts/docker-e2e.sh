#!/usr/bin/env bash
# Gate a RUNNING stack (docker compose or manual): API-only assertions.
# Usage: bash scripts/docker-e2e.sh  (expects core :3001, fish :8101, qwen :8102)
set -euo pipefail
PORT="${PORT:-3001}"
CURL="curl -s --max-time 5"

$CURL http://127.0.0.1:$PORT/v1/health | grep -q '"service":"core"' || { echo "FAIL: core :$PORT"; exit 1; }
$CURL http://127.0.0.1:8101/health | grep -q '"ok": true' || { echo "FAIL: fish :8101"; exit 1; }
$CURL http://127.0.0.1:8102/health | grep -q '"ok": true' || { echo "FAIL: qwen :8102"; exit 1; }
$CURL http://127.0.0.1:8106/health | grep -q '"ok": true' || { echo "FAIL: cpm2 :8106"; exit 1; }

# load fish, qwen blocked over-cap, switch, both takes playable
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/load | grep -q '"ok":true' || { echo "FAIL: fish load"; exit 1; }
CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:$PORT/v1/tools/tts-qwen3-0.6B/load)
[ "$CODE" = "409" ] || { echo "FAIL: over-cap want 409 got $CODE"; exit 1; }
J1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-fish-s1mini","prompt":"docker take one"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
R1=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J1 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$R1" | grep -q "^done take-" || { echo "FAIL: fish job: $R1"; exit 1; }
# result shape + retry-as-child on the fish job
$CURL http://127.0.0.1:$PORT/v1/jobs/$J1/result | python3 -c "
import sys,json
r = json.load(sys.stdin)
assert r['transcript'] == 'docker take one', r
assert r['takes'] and r['takes'][0]['url'].startswith('/v1/audio/'), r
print('result ok')
"
DJ=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs/$J1/retry -H 'content-type: application/json' \
  -d '{"seed": 7}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
DS=$($CURL http://127.0.0.1:$PORT/v1/jobs/$DJ | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['parent_id'] == '$J1')")
echo "$DS" | grep -q "^done True" || { echo "FAIL: retry child: $DS"; exit 1; }
echo "retry ok"
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-qwen3-0.6B/load | grep -q '"ok":true' || { echo "FAIL: qwen load"; exit 1; }
J2=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-qwen3-0.6B","prompt":"docker take two"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
R2=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J2 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$R2" | grep -q "^done take-" || { echo "FAIL: qwen job: $R2"; exit 1; }
$CURL http://127.0.0.1:$PORT/v1/audio/$(echo "$R1" | cut -d' ' -f2) -o /tmp/core-dk-1.wav
$CURL http://127.0.0.1:$PORT/v1/audio/$(echo "$R2" | cut -d' ' -f2) -o /tmp/core-dk-2.wav
[ -s /tmp/core-dk-1.wav ] && [ -s /tmp/core-dk-2.wav ] || { echo "FAIL: wav proxy"; exit 1; }

# fx (CPU, in-core): upload take -> tuner reads pitch, gain returns wav
for t in fx-tuner fx-gain; do
  $CURL -X POST http://127.0.0.1:$PORT/v1/tools/$t/load | grep -q '"ok":true' || { echo "FAIL: $t load"; exit 1; }
done
UPREF=$(python3 -c "import base64,sys; print(open('/tmp/core-dk-1.wav','rb').read() and __import__('json').dumps({'name':'take.wav','wav_b64':base64.b64encode(open('/tmp/core-dk-1.wav','rb').read()).decode()}))" \
  | xargs -0 -I{} curl -s --max-time 5 -X POST http://127.0.0.1:$PORT/v1/uploads -H 'content-type: application/json' -d {} \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['ref'])")
[ -n "$UPREF" ] || { echo "FAIL: upload"; exit 1; }
JF=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d "{\"tool_id\":\"fx-tuner\",\"prompt\":\"tune\",\"input_refs\":[\"$UPREF\"]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
SF=$($CURL http://127.0.0.1:$PORT/v1/jobs/$JF | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$SF" = "done" ] || { echo "FAIL: fx-tuner $SF"; exit 1; }
JG=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d "{\"tool_id\":\"fx-gain\",\"prompt\":\"{\\\"db\\\": 6}\",\"input_refs\":[\"$UPREF\"]}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
RG=$($CURL http://127.0.0.1:$PORT/v1/jobs/$JG | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$RG" | grep -q "^done take-.*-fx.wav" || { echo "FAIL: fx-gain: $RG"; exit 1; }
$CURL http://127.0.0.1:$PORT/v1/audio/$(echo "$RG" | cut -d' ' -f2) -o /tmp/core-dk-3.wav
[ -s /tmp/core-dk-3.wav ] || { echo "FAIL: fx wav"; exit 1; }

# refs via core
WAV=$(python3 -c "import base64; print(base64.b64encode(b'RIFF' + bytes(2000)).decode())")
$CURL -X POST http://127.0.0.1:$PORT/v1/refs -H 'content-type: application/json' \
  -d "{\"ref_id\":\"dock\",\"transcript\":\"docker ref voice\",\"wav_b64\":\"$WAV\"}" | grep -q '"ok":true' || { echo "FAIL: refs upload"; exit 1; }
J3=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-qwen3-0.6B","prompt":"clone docker ref","ref_id":"dock"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
S3=$($CURL http://127.0.0.1:$PORT/v1/jobs/$J3 | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
[ "$S3" = "done" ] || { echo "FAIL: clone job $S3"; exit 1; }

# music/sfx lane (unload voice first: 2.5 + 4 > 7)
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-qwen3-0.6B/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/music-musicgen-small/load | grep -q '"ok":true' || { echo "FAIL: music load"; exit 1; }
M1=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"music-musicgen-small","prompt":"lofi loop","mode":"batch"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 3
SM=$($CURL http://127.0.0.1:$PORT/v1/jobs/$M1 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$SM" | grep -q "^done music-" || { echo "FAIL: music job: $SM"; exit 1; }
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/music-musicgen-small/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/sfx-bark/load | grep -q '"ok":true' || { echo "FAIL: sfx load"; exit 1; }
M2=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"sfx-bark","prompt":"rain","mode":"batch"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
SS=$($CURL http://127.0.0.1:$PORT/v1/jobs/$M2 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$SS" | grep -q "^done sfx-" || { echo "FAIL: sfx job: $SS"; exit 1; }
# cpm2 lane (unload sfx first: 5 + 3 > 7)
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/sfx-bark/unload >/dev/null
$CURL -X POST http://127.0.0.1:$PORT/v1/tools/tts-cpm2/load | grep -q '"ok":true' || { echo "FAIL: cpm2 load"; exit 1; }
M3=$($CURL -X POST http://127.0.0.1:$PORT/v1/jobs -H 'content-type: application/json' \
  -d '{"tool_id":"tts-cpm2","prompt":"cpm2 docker take","mode":"stream"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
sleep 2
SC=$($CURL http://127.0.0.1:$PORT/v1/jobs/$M3 | python3 -c "import sys,json; j=json.load(sys.stdin); print(j['status'], j['artifact_refs'][0] if j['artifact_refs'] else '')")
echo "$SC" | grep -q "^done take-" || { echo "FAIL: cpm2 job: $SC"; exit 1; }
echo "DOCKER-E2E PASS"
