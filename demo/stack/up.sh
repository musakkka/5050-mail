#!/usr/bin/env bash
# Boots the throw-away local stack the demo is recorded against. Nothing here touches real mail,
# DNS or Cloudflare: Stalwart runs in a disposable container, Send uses the fake transport and the
# fake Cloudflare API, and every mailbox/domain is fictional (acme.test, example.com).
#
#   demo/stack/up.sh        # then: demo/record.ts …   and finally demo/stack/down.sh
#
# Env: WEBMAIL_DIR / SEND_DIR (app sources, default ../apps/*), WORK (default demo/.work),
#      STW_PORT (18190), MAIL_PORT (3100), SEND_PORT (3200), PG_URL (send-pg on :55432).
set -euo pipefail
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$DEMO/.." && pwd)"
WEBMAIL_SRC="${WEBMAIL_DIR:-$ROOT/apps/webmail}"
SEND_SRC="${SEND_DIR:-$ROOT/apps/send}"
WORK="${WORK:-$DEMO/.work}"
STW="${STW_NAME:-demo5050-stw}"
STW_PORT="${STW_PORT:-18190}"
STW_IMAGE="${STW_IMAGE:-stalwartlabs/stalwart:v0.16.27}"
PG="${PG_NAME:-send-pg}"
PG_URL="${PG_URL:-postgres://send:sendpw@localhost:55432/postgres}"
MAIL_PORT="${MAIL_PORT:-3100}"
SEND_PORT="${SEND_PORT:-3200}"
ADMIN="admin:devpass123"
TSX="$DEMO/node_modules/.bin/tsx"
mkdir -p "$WORK/apps" "$WORK/logs"

say() { printf '\033[1m[demo]\033[0m %s\n' "$*"; }
wait_http() { for _ in $(seq 1 90); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }
jmap() { curl -fsS -u "$ADMIN" -H 'content-type: application/json' "http://localhost:$STW_PORT/jmap/" -d "$1"; }

# ---------------------------------------------------------------- local app copies (brand names applied)
copy_app() { # src dst
  rsync -a --delete --exclude node_modules --exclude dist --exclude dist-mock --exclude test-results --exclude screenshots "$1/" "$2/"
  for nm in "" "/web"; do
    [ -d "$1$nm" ] || continue
    if [ -d "$1$nm/node_modules" ]; then ln -sfn "$1$nm/node_modules" "$2$nm/node_modules"
    else (cd "$2$nm" && npm ci --no-audit --no-fund >/dev/null); fi
  done
}
say "preparing app copies in $WORK/apps"
copy_app "$WEBMAIL_SRC" "$WORK/apps/webmail"
copy_app "$SEND_SRC" "$WORK/apps/send"
# Product names on screen: "5050 Mail" / "5050 Send" (a no-op once the sources already say so).
grep -rl "5050 Cloud Mail" "$WORK/apps/webmail/client" "$WORK/apps/webmail/server" 2>/dev/null | while read -r f; do perl -pi -e 's/5050 Cloud Mail/5050 Mail/g' "$f"; done || true
# Demo pacing only: the one-click checklist polls every 4–6 s; poll faster so the recording stays short.
perl -pi -e 's/done \? false : [46]000/done ? false : 1200/g' "$WORK/apps/webmail/client/src/pages/admin/CloudflareConnect.tsx"
(cd "$WORK/apps/webmail" && npx vite build >"$WORK/logs/webmail-build.log" 2>&1)
(cd "$WORK/apps/send/web" && npx vite build >"$WORK/logs/send-build.log" 2>&1)

# ---------------------------------------------------------------- Postgres for Send
if ! docker ps --format '{{.Names}}' | grep -qx "$PG"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG"; then docker start "$PG" >/dev/null
  else docker run -d --name "$PG" -e POSTGRES_USER=send -e POSTGRES_PASSWORD=sendpw -p 55432:5432 postgres:16-alpine >/dev/null; fi
  sleep 3
fi

# ---------------------------------------------------------------- Stalwart (fresh, bootstrapped for acme.test)
if ! docker ps -a --format '{{.Names}}' | grep -qx "$STW"; then
  say "starting Stalwart ($STW_IMAGE) on :$STW_PORT"
  docker run -d --name "$STW" -e STALWART_RECOVERY_ADMIN="$ADMIN" -p "$STW_PORT:8080" "$STW_IMAGE" >/dev/null
  wait_http "http://localhost:$STW_PORT/.well-known/jmap" || true
  sleep 3
  jmap '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Bootstrap/set",{"update":{"singleton":{"serverHostname":"mail.acme.test","defaultDomain":"acme.test","requestTlsCertificate":false}}},"0"]]}' >/dev/null
  docker restart "$STW" >/dev/null
  sleep 6
else
  docker start "$STW" >/dev/null
  sleep 4
fi
for _ in $(seq 1 60); do jmap '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Domain/query",{},"0"]]}' >/dev/null 2>&1 && break; sleep 1; done

say "seeding mailboxes"
STALWART_URL="http://localhost:$STW_PORT" STALWART_ADMIN="$ADMIN" "$TSX" "$DEMO/stack/seed-mail.ts"

# ---------------------------------------------------------------- servers
"$DEMO/stack/down.sh" --servers-only >/dev/null 2>&1 || true
say "starting webmail on :$MAIL_PORT"
(cd "$WORK/apps/webmail" && exec env PORT="$MAIL_PORT" STALWART_URL="http://localhost:$STW_PORT" CLOUDFLARE_FAKE=1 CLOUDFLARE_FAKE_ZONES=example.com \
  STATIC_DIR="$WORK/apps/webmail/dist/client" nohup ./node_modules/.bin/tsx server/src/index.ts) >"$WORK/logs/webmail.log" 2>&1 </dev/null &
echo $! >"$WORK/webmail.pid"
say "starting send on :$SEND_PORT"
(cd "$WORK/apps/send" && exec env SEND_DIR="$WORK/apps/send" PORT="$SEND_PORT" PG_URL="$PG_URL" STALWART_URL="http://localhost:$STW_PORT" \
  nohup ./node_modules/.bin/tsx "$DEMO/stack/serve-send.ts") >"$WORK/logs/send.log" 2>&1 </dev/null &
echo $! >"$WORK/send.pid"
wait_http "http://localhost:$MAIL_PORT/login"
for _ in $(seq 1 60); do grep -q '^READY' "$WORK/logs/send.log" 2>/dev/null && break; sleep 1; done
grep -q '^READY' "$WORK/logs/send.log" || { cat "$WORK/logs/send.log"; exit 1; }
say "ready: webmail http://localhost:$MAIL_PORT  send http://localhost:$SEND_PORT  (maya@acme.test)"
