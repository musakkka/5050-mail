#!/usr/bin/env bash
# Compile 5050 Send (TypeScript) into $OUT without touching the source tree.
#   SEND_DIR=../apps/send OUT=.bench-out/sendapp ./send/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
SEND_DIR="$(cd "${SEND_DIR:-$here/../apps/send}" && pwd)"
OUT="${OUT:-$here/.bench-out/sendapp}"
[ -d "$SEND_DIR/node_modules" ] || (cd "$SEND_DIR" && npm ci)
rm -rf "$OUT/dist"; mkdir -p "$OUT"
(cd "$SEND_DIR" && npx tsc -p tsconfig.build.json --outDir "$OUT/dist")
echo "built $SEND_DIR -> $OUT/dist"
