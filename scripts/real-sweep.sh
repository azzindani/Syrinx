#!/usr/bin/env bash
# Real-model sweep: every Syrinx tool end-to-end through the live core.
# Mirrors Optic dev_tools/sweep.sh: one TSV row per take + saved wavs.
# Usage: bash scripts/real-sweep.sh [core-base] [out-dir]
# Env: FISH_URL QWEN_URL KOKORO_URL CPM_URL MUSIC_URL SFX_URL
#   (defaults = live-box layout :8101/:8102/:8103/:8106/:8104/:8105).
# Requires the live stack up (core + sidecars). Loads/unloads each GPU
# tool sequentially so the 7GB cap is never exceeded. Fish is attempted
# honestly (SKIP row if the gated weights are absent). Leaves all GPU
# tools unloaded. Exit nonzero iff any row FAILs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://127.0.0.1:3001}"
OUT="${2:-$ROOT/tmp/real-sweep}"
TAKES="$OUT/takes"
TSV="$OUT/sweep.tsv"
FISH_URL="${FISH_URL:-http://127.0.0.1:8101}"
QWEN_URL="${QWEN_URL:-http://127.0.0.1:8102}"
KOKORO_URL="${KOKORO_URL:-http://127.0.0.1:8103}"
CPM_URL="${CPM_URL:-http://127.0.0.1:8106}"
MUSIC_URL="${MUSIC_URL:-http://127.0.0.1:8104}"
SFX_URL="${SFX_URL:-http://127.0.0.1:8105}"
CURL="curl -s --max-time 10"
mkdir -p "$TAKES"
rm -f "$TAKES"/*.wav
printf 'tool\tprompt\tstatus\tms\ttake_ref\tseconds\tpeak\tnote\n' > "$TSV"
FAIL=0

row() { # tool prompt status ms take seconds peak note
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" | tee -a "$TSV"
}

coreload() { $CURL -X POST "$BASE/v1/tools/$1/load" | grep -q '"ok":true'; }
coreunload() { $CURL -X POST "$BASE/v1/tools/$1/unload" >/dev/null 2>&1 || true; }
sideunload() { $CURL -X POST "$1/unload" >/dev/null 2>&1 || true; }

# Sidecar /load with a long budget (cold bark preload takes minutes).
sideload() { # name url timeout
  CODE=$(curl -s -o /tmp/sweep-load.json -w "%{http_code}" --max-time "$3" -X POST "$2/load" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ] && grep -q '"ok": *true' /tmp/sweep-load.json 2>/dev/null; then
    return 0
  fi
  echo "  sideload $1 -> http=$CODE $(head -c 200 /tmp/sweep-load.json 2>/dev/null)"
  return 1
}

# Submit a job, poll to done/error. Echoes: status ms take_ref
run_job() { # tool prompt deadline_s
  local tool="$1" prompt="$2" deadline="$3"
  local id now_ms end_ms st ref
  id=$($CURL -X POST "$BASE/v1/jobs" -H 'content-type: application/json' \
    -d "{\"tool_id\":\"$tool\",\"prompt\":\"$prompt\",\"mode\":\"batch\",\"seed\":7}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
  [ -n "$id" ] || { echo "submit-fail 0 -"; return 0; }
  local start end
  start=$(date +%s); end=$((start + deadline)); st="timeout"; ref="-"
  while [ "$(date +%s)" -lt "$end" ]; do
    sleep 10
    R=$($CURL "$BASE/v1/jobs/$id/result" 2>/dev/null || true)
    st=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
    if [ "$st" = "done" ] || [ "$st" = "error" ]; then
      ref=$(echo "$R" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['takes'][0]['ref'] if r.get('takes') else '-')" 2>/dev/null || echo "-")
      [ "$st" = "error" ] && ref=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','')[:120])" 2>/dev/null || echo "?")
      break
    fi
  done
  echo "$st $(( ($(date +%s) - start) * 1000 )) $ref"
}

# Verify a wav with stdlib only. Echoes: seconds peak sr  (or WAV-FAIL)
verify_wav() {
  python3 - "$1" 2>/dev/null <<'EOF' || echo "WAV-FAIL"
import sys, wave, struct, math
w = wave.open(sys.argv[1])
n, sr = w.getnframes(), w.getframerate()
s = [x / 32768 for x in struct.unpack('<' + 'h' * n, w.readframes(n))]
peak = max([abs(x) for x in s] + [0.0])
dur = n / sr if sr else 0
print(f"{dur:.2f} {peak:.3f} {sr}")
EOF
}

GPU_TOOLS="tts-qwen3-0.6B tts-cpm2 music-musicgen-small sfx-bark"

echo "== prologue: unload all (clean 7GB cap)"
for t in $GPU_TOOLS; do coreunload "$t"; done
$CURL "$BASE/v1/gpu"; echo

# tool | sidecar-url | sidecar-load-budget | prompt | job-deadline
gen_tool() { # tool sidecar load_budget prompt deadline
  local tool="$1" side="$2" budget="$3" prompt="$4" deadline="$5"
  echo "== $tool"
  if ! sideload "$tool" "$side" "$budget"; then
    row "$tool" "$prompt" "FAIL" 0 "-" "-" "-" "sidecar-load-failed"; FAIL=1
    return 0
  fi
  if ! coreload "$tool"; then
    row "$tool" "$prompt" "FAIL" 0 "-" "-" "-" "core-load-rejected"; FAIL=1
    return 0
  fi
  # shellcheck disable=SC2086
  read -r st ms ref <<<"$(run_job "$tool" "$prompt" "$deadline")"
  local secs="-" peak="-" note="ok"
  if [ "$st" = "done" ] && [ "$ref" != "-" ]; then
    if $CURL "$BASE/v1/audio/$ref" -o "$TAKES/$ref" 2>/dev/null && [ -s "$TAKES/$ref" ]; then
      read -r secs peak sr <<<"$(verify_wav "$TAKES/$ref")"
      if [ "$secs" = "WAV-FAIL" ]; then
        st="FAIL"; note="take-not-valid-wav"; FAIL=1; secs="-"; peak="-"
      else
        slow=$(python3 -c "print('low-peak' if float('$peak') < 0.01 else 'ok')")
        [ "$slow" = "ok" ] || { st="FAIL"; note="silent-take"; FAIL=1; }
      fi
    else
      st="FAIL"; note="take-download-failed"; FAIL=1
    fi
  else
    note="$ref"; ref="-"; FAIL=1
  fi
  row "$tool" "$prompt" "$st" "$ms" "$ref" "$secs" "$peak" "$note"
  coreunload "$tool"; sideunload "$side"
}

gen_tool "tts-qwen3-0.6B" "$QWEN_URL" 600 "The quick brown fox jumps over the lazy dog." 300
gen_tool "tts-kokoro-82M" "$KOKORO_URL" 600 "Syrinx narration channel, sweep check." 300
gen_tool "tts-cpm2" "$CPM_URL" 600 "Sweep check, voice systems nominal." 600
gen_tool "music-musicgen-small" "$MUSIC_URL" 900 "Mellow lo-fi loop, eighty beats per minute." 900
gen_tool "sfx-bark" "$SFX_URL" 1500 "Rain on a tin roof, distant thunder." 900

echo "== tts-fish-s1mini (honest attempt, SKIP if gated)"
FMODE=$($CURL "$FISH_URL/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo "?")
if [ "$FMODE" = "real" ] && sideload "tts-fish-s1mini" "$FISH_URL" 900 && coreload "tts-fish-s1mini"; then
  read -r st ms ref <<<"$(run_job "tts-fish-s1mini" "Sweep check, flagship voice." 600)"
  row "tts-fish-s1mini" "flagship" "$st" "$ms" "$ref" "-" "-" "real"
  [ "$st" = "done" ] || FAIL=1
  coreunload "tts-fish-s1mini"; sideunload "$FISH_URL"
else
  row "tts-fish-s1mini" "flagship" "SKIP" 0 "-" "-" "-" "gated-weights-mode=$FMODE"
fi

echo "== fx-spectrum (analysis lane, on the qwen take)"
QWAV=$(ls "$TAKES"/take-*.wav 2>/dev/null | head -1 || true)
if [ -n "$QWAV" ]; then
  # Body via file: inline base64 exceeds the 128K single-arg exec limit.
  BODY=/tmp/sweep-upload.json
  python3 - "$QWAV" "$BODY" <<'EOF'
import base64, json, sys
raw = open(sys.argv[1], 'rb').read()
json.dump({"name": "sweep.wav", "wav_b64": base64.b64encode(raw).decode()},
          open(sys.argv[2], 'w'))
EOF
  UP=$($CURL -X POST "$BASE/v1/uploads" -H 'content-type: application/json' \
    -d @"$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ref',''))" 2>/dev/null || true)
  if [ -n "$UP" ] && coreload "fx-spectrum"; then
    FID=$($CURL -X POST "$BASE/v1/jobs" -H 'content-type: application/json' \
      -d "{\"tool_id\":\"fx-spectrum\",\"prompt\":\"sweep\",\"mode\":\"batch\",\"input_refs\":[\"$UP\"]}" \
      | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
    sleep 5
    FXST="?" FXT=""
    for _ in $(seq 1 12); do
      FXR=$($CURL "$BASE/v1/jobs/$FID/result" 2>/dev/null || echo '{}')
      FXST=$(echo "$FXR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
      if [ "$FXST" = "done" ] || [ "$FXST" = "error" ]; then break; fi
      sleep 10
    done
    FXT=$(echo "$FXR" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('transcript',''))[:80])" 2>/dev/null || echo "")
    if [ "$FXST" = "error" ]; then
      FXT=$(echo "$FXR" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('error',''))[:120])" 2>/dev/null || echo "?")
    fi
    [ "$FXST" = "done" ] || FAIL=1
    row "fx-spectrum" "qwen-take" "$FXST" "-" "-" "-" "-" "$FXT"
    coreunload "fx-spectrum"
  else
    [ -n "$UP" ] && row "fx-spectrum" "qwen-take" "FAIL" 0 "-" "-" "-" "fx-load-rejected" \
      || row "fx-spectrum" "qwen-take" "FAIL" 0 "-" "-" "-" "upload-failed"
    FAIL=1
  fi
else
  row "fx-spectrum" "qwen-take" "SKIP" 0 "-" "-" "-" "no-take-to-analyze"
fi

echo "== epilogue: unload all"
for t in $GPU_TOOLS; do coreunload "$t"; done
$CURL "$BASE/v1/gpu"; echo
echo "--- $TSV"
cat "$TSV"
if [ "$FAIL" = "0" ]; then echo "REAL-SWEEP-DONE"; else echo "REAL-SWEEP-FAIL"; exit 1; fi
