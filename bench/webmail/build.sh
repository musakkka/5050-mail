#!/usr/bin/env bash
# Compile the webmail BFF (server only) into $OUT without touching the source tree.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$(cd "${WEB_DIR:-$here/../apps/webmail}" && pwd)"
OUT="${OUT:-$here/.bench-out/webmail}"
[ -d "$WEB_DIR/node_modules" ] || (cd "$WEB_DIR" && npm ci)
rm -rf "$OUT/dist"; mkdir -p "$OUT"
(cd "$WEB_DIR" && npx tsc -p server/tsconfig.json --outDir "$OUT/dist/server" --sourceMap false)
echo "built $WEB_DIR -> $OUT/dist/server"
