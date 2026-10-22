#!/usr/bin/env bash
# Stalwart SMTP ingest + webmail BFF benchmark for one "VM" profile.
#
#   PROFILE=2c4g|4c8g|8c ./webmail/run.sh      (LAYOUTS="single percore" by default)
#
# Stalwart, the BFF and the BFF's Postgres (shared sessions) share the VM cores (--cpuset-cpus)
# and memory caps; k6 and the SMTP client run on the other cores. Needs the BFF compiled
# by webmail/build.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$(cd "${WEB_DIR:-$here/../apps/webmail}" && pwd)"
SEND_DIR="$(cd "${SEND_DIR:-$here/../apps/send}" && pwd)"   # only for nodemailer (SMTP client)
PROFILE="${PROFILE:-2c4g}"
DURATION="${DURATION:-30s}"
INGEST_TOTAL="${INGEST_TOTAL:-6400}"
LAYOUTS="${LAYOUTS:-single percore}"
RES="$here/results/webmail/$PROFILE"
mkdir -p "$RES"
case "$PROFILE" in
  2c4g) NCPU=2; VM_CPUS=0-1; LG_CPUS=4-7; STW_MEM=3g; BFF_MEM=1g ;;
  4c8g) NCPU=4; VM_CPUS=0-3; LG_CPUS=4-7; STW_MEM=6g; BFF_MEM=2g ;;
  8c)   NCPU=8; VM_CPUS=0-7; LG_CPUS=0-7; STW_MEM=5g; BFF_MEM=2g ;;
  *) echo "unknown PROFILE"; exit 1 ;;
esac
SAMPLER_PID=
start_sampler() { "$here/lib/sampler.sh" "$RES/stats-$1.tsv" bench-stw bench-bff bench-wpg & SAMPLER_PID=$!; }
stop_sampler() { if [ -n "$SAMPLER_PID" ]; then kill $SAMPLER_PID 2>/dev/null || true; fi; SAMPLER_PID=; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RES/log.txt"; }
cleanup() { docker rm -f bench-bff bench-stw bench-wpg >/dev/null 2>&1 || true; }
trap 'stop_sampler; cleanup' EXIT
{ echo "profile=$PROFILE vm_cpus=$VM_CPUS lg_cpus=$LG_CPUS"; echo "host load: $(uptime)"; echo "calibration vm: $("$here/lib/calibrate.sh" $VM_CPUS $NCPU)"; } > "$RES/env.txt"

log "stalwart (cpuset $VM_CPUS, mem $STW_MEM)"
VM_CPUS=$VM_CPUS STW_MEM=$STW_MEM "$here/stalwart/setup.sh" | tee -a "$RES/log.txt"

smtp() { # $1 conc $2 total $3 name
  docker run --rm --network bench-net --cpuset-cpus=$LG_CPUS -v "$SEND_DIR/node_modules:/l/node_modules:ro" \
    -v "$here/send/smtp-load.mjs:/l/smtp-load.mjs:ro" -v "$RES:/out" \
    -e HOST=bench-stw -e PORT=25 -e NOAUTH=1 -e NOTLS=1 -e MAX_MSGS=10 -e RCPT_MOD=32 -e 'RCPT=u{n}@bench.test' \
    -e FROM=sender@example.org -e BODY_BYTES=4000 -e CONC=$1 -e TOTAL=$2 -e OUT=/out/$3.json node:22-alpine node /l/smtp-load.mjs | tee -a "$RES/log.txt"
}
log "SMTP ingest into Stalwart (port 25, no auth, 4 KB text, 10 msgs/session)"
start_sampler ingest
smtp 8 $(( INGEST_TOTAL / 4 )) ingest_c8
smtp 32 $(( INGEST_TOTAL * 3 / 4 )) ingest_c32
stop_sampler

log "postgres for BFF sessions (cpuset $VM_CPUS, 512m)"
docker rm -f bench-wpg >/dev/null 2>&1 || true
docker run -d --name bench-wpg --network bench-net --cpuset-cpus=$VM_CPUS --memory=512m \
  -e POSTGRES_USER=web -e POSTGRES_PASSWORD=webpw -e POSTGRES_DB=webmail postgres:16-alpine >/dev/null
until docker exec bench-wpg pg_isready -U web -q 2>/dev/null; do sleep 0.5; done; sleep 2
k6() { local name=$1; shift
  docker run --rm --network bench-net --cpuset-cpus=$LG_CPUS -v "$here/webmail/k6-webmail.js:/k.js:ro" -v "$RES:/out" \
    -e SUMMARY=/out/$name.json -e DURATION=$DURATION "$@" grafana/k6:1.3.0 run -q /k.js 2>&1 | grep '^{' | tee -a "$RES/log.txt"
}
for layout in $LAYOUTS; do
  if [ "$layout" = percore ]; then PROCS=$NCPU; else PROCS=1; fi
  log "webmail BFF: $PROCS process(es) via dist/server/cluster.js, Postgres sessions"
  docker rm -f bench-bff >/dev/null 2>&1 || true
  docker run -d --name bench-bff --network bench-net --cpuset-cpus=$VM_CPUS --memory=$BFF_MEM \
    -v "$here/.bench-out/webmail/dist:/app/dist:ro" -v "$WEB_DIR/node_modules:/app/node_modules:ro" -v "$WEB_DIR/package.json:/app/package.json:ro" \
    -e STALWART_URL=http://bench-stw:8080 -e STATIC_DIR=/nonexistent -e COOKIE_SECURE=false -e WORKER=0 \
    -e DATABASE_URL=postgres://web:webpw@bench-wpg:5432/webmail -e SESSION_SECRET=bench-session-secret-bench-session-secret \
    -e WEB_CONCURRENCY=$PROCS -e LOGIN_RATE_LIMIT=100000000 -e LOGIN_GLOBAL_FAIL_LIMIT=100000000 -e PORT=3000 \
    node:22-alpine node /app/dist/server/cluster.js >/dev/null
  for _ in $(seq 1 120); do [ "$(docker logs bench-bff 2>&1 | grep -c listening)" -ge "$PROCS" ] && break; sleep 0.5; done
  docker logs bench-bff 2>&1 | grep -q listening || { docker logs bench-bff; exit 1; }
  start_sampler bff-$layout
  for sc in mailboxes threads search; do
    for v in 32 128; do log "$sc, $v VUs"; k6 ${layout}_${sc}_v$v -e SCENARIO=$sc -e VUS=$v; done
  done
  log "login, 16 VUs"; k6 ${layout}_login_v16 -e SCENARIO=login -e VUS=16
  stop_sampler
done
log done
