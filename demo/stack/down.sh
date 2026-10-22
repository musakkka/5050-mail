#!/usr/bin/env bash
# Stops the demo stack. --servers-only keeps the Stalwart container (faster re-runs).
set -uo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$DEMO/.work}"
STW="${STW_NAME:-demo5050-stw}"
for svc in webmail send; do
  f="$WORK/$svc.pid"
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  # tsx spawns a child node process: stop the whole group gently (send drops its database on SIGTERM)
  pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null
  rm -f "$f"
done
sleep 2
[ "${1:-}" = "--servers-only" ] && exit 0
docker rm -f "$STW" >/dev/null 2>&1 || true
echo "[demo] stack stopped"
