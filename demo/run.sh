#!/usr/bin/env bash
# One command, start to finish: boot the fake-data stack, record, render overlays, composite, encode.
#
#   cd demo && npm install && ./run.sh
#
# Needs: Node 22+, Docker, ffmpeg (libx264 + libvpx-vp9), Python 3.10+.
# Output: site/public/demo/{demo.mp4,demo.webm,poster.jpg,hero.mp4,hero.webm,hero-poster.jpg}
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$DEMO/.work}"
export WORK
cd "$DEMO"
[ -x node_modules/.bin/tsx ] || npm install --no-audit --no-fund
npx playwright install chromium >/dev/null
if [ ! -x "$WORK/venv/bin/python" ]; then
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q -r requirements.txt
fi

stack/up.sh
trap 'stack/down.sh' EXIT
MAIL_URL="http://localhost:${MAIL_PORT:-3100}" SEND_URL="http://localhost:${SEND_PORT:-3200}" OUT="$WORK/capture" node_modules/.bin/tsx record.ts
CAPTURE="$WORK/capture" OUT="$WORK/assets" node_modules/.bin/tsx render-assets.ts
"$WORK/venv/bin/python" compose.py --capture "$WORK/capture" --assets "$WORK/assets" --work "$WORK/compose" --out "$DEMO/../site/public/demo"
