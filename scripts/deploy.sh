#!/usr/bin/env bash
# Core one-command deploy (stub mode, no GPU needed).
# Usage: bash scripts/deploy.sh [install|build|gate|start|stop|status|all]
#   all (default): preflight -> install -> build -> e2e gate -> start -> status
# Env overrides: PORT (default 3001), FISH_PORT (default 8101),
#   DATA_PATH (default Syrinx/data/jobs.db)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNDIR="$ROOT/.run"; mkdir -p "$RUNDIR"
STUB_PID="$RUNDIR/stub.pid"; CORE_PID="$RUNDIR/core.pid"
PORT="${PORT:-3001}"
FISH_PORT="${FISH_PORT:-8101}"
FISH_URL="${FISH_URL:-http://127.0.0.1:$FISH_PORT}"
DATA_PATH="${DATA_PATH:-$ROOT/data/jobs.db}"
CURL="curl -s --max-time 5"

fail() { echo "DEPLOY FAIL: $*" >&2; exit 1; }
log() { echo "deploy: $*"; }

port_busy() { ss -tln 2>/dev/null | grep -q ":$1 " || return 1; }

preflight() {
  log "preflight"
  command -v node >/dev/null || fail "node not found (need >=24)"
  node -e "process.exit(process.versions.node.split('.')[0] >= 24 ? 0 : 1)" \
    || fail "node $(node -v) < 24"
  command -v python3 >/dev/null || fail "python3 not found"
  command -v ffmpeg >/dev/null || log "WARN: ffmpeg missing (needed for real audio, stub ok)"
  if [ -f "$ROOT/../Optic/core/.optic.pid" ] \
    && kill -0 "$(cat "$ROOT/../Optic/core/.optic.pid")" 2>/dev/null; then
    fail "Optic core appears running (same GPU) — stop Optic first"
  fi
  port_busy "$PORT" && fail "port $PORT busy — stop whatever holds core first"
  port_busy "$FISH_PORT" && fail "port $FISH_PORT busy — stop whatever holds fish sidecar first"
  log "preflight ok (node $(node -v), ports $PORT/$FISH_PORT free)"
}

install() { log "install"; (cd "$ROOT/core" && npm install --no-audit --no-fund); }
build() { log "build"; (cd "$ROOT/core" && npm run build); }

gate() {
  log "e2e gate (isolated ports/db)"
  PORT=3001 FISH_URL=http://127.0.0.1:8101 DATA_PATH=/tmp/core-deploy-gate.db \
    bash "$ROOT/scripts/e2e.sh"
}

start() {
  log "start"
  mkdir -p "$(dirname "$DATA_PATH")"
  FISH_PORT="$FISH_PORT" nohup python3 "$ROOT/tools/tts-fish-s1mini/server.py" \
    > "$RUNDIR/stub.log" 2>&1 &
  echo $! > "$STUB_PID"
  for _ in $(seq 1 10); do
    $CURL "http://127.0.0.1:$FISH_PORT/health" | grep -q '"ok": true' && break
    sleep 1
    [ "$_" = 10 ] && { tail -5 "$RUNDIR/stub.log"; fail "stub did not become healthy"; }
  done
  PORT="$PORT" FISH_URL="$FISH_URL" DATA_PATH="$DATA_PATH" \
    CORE_GPU_WAIT=0 \
    nohup node "$ROOT/core/dist/index.js" > "$RUNDIR/core.log" 2>&1 &
  echo $! > "$CORE_PID"
  for _ in $(seq 1 10); do
    $CURL "http://127.0.0.1:$PORT/v1/health" | grep -q '"service":"core"' && break
    sleep 1
    [ "$_" = 10 ] && { tail -5 "$RUNDIR/core.log"; fail "core did not become healthy"; }
  done
  $CURL -X POST "http://127.0.0.1:$PORT/v1/tools/tts-fish-s1mini/load" \
    | grep -q '"ok":true' || log "WARN: flagship tool did not load (see /v1/gpu)"
  log "started (stub pid $(cat "$STUB_PID"), core pid $(cat "$CORE_PID"))"
}

stop() {
  log "stop"
  for f in "$STUB_PID" "$CORE_PID"; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  log "stopped"
}

status() {
  echo "--- stub :$FISH_PORT"; $CURL "http://127.0.0.1:$FISH_PORT/health" || echo DOWN; echo
  echo "--- core :$PORT"; $CURL "http://127.0.0.1:$PORT/v1/health" || echo DOWN; echo
  echo "--- gpu"; $CURL "http://127.0.0.1:$PORT/v1/gpu" || echo DOWN; echo
  echo "--- player: http://127.0.0.1:$PORT/"
}

case "${1:-all}" in
  install) install ;;
  build) build ;;
  gate) gate ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  preflight) preflight ;;
  all) preflight; install; build; gate; start; status ;;
  *) echo "usage: deploy.sh [install|build|gate|start|stop|status|all]" >&2; exit 1 ;;
esac
