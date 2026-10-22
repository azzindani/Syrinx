#!/usr/bin/env bash
# Core daemon: refuse dual-run with Optic (same 8GB GPU, v1 rule).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/core/.core.pid"
PORT="${PORT:-3001}"

if [ -f "$ROOT/../Optic/core/.optic.pid" ] && kill -0 "$(cat "$ROOT/../Optic/core/.optic.pid")" 2>/dev/null; then
  echo "Refusing: Optic core appears running (same GPU). Stop Optic first." >&2
  exit 1
fi

cd "$ROOT/core"
if [ "${1:-start}" = "stop" ]; then
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "core stopped"
  exit 0
fi

PORT="$PORT" nohup node dist/index.js > "$ROOT/core/.core.log" 2>&1 &
echo $! > "$PIDFILE"
echo "core started on :$PORT (pid $(cat "$PIDFILE"))"
