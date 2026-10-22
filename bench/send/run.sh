#!/usr/bin/env bash
# 5050 Send benchmark: one "VM" profile x one process layout.
#
#   PROFILE=2c4g|4c8g|8c  LAYOUT=single|percore  ./send/run.sh
#
# The "VM" (Postgres + the app) is pinned with --cpuset-cpus to the same cores and capped
# with --memory, so app and database compete for the same vCPUs like on a real small VM.
# Load generators (k6 / SMTP client / webhook sink) run on the other cores.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
SEND_DIR="$(cd "${SEND_DIR:-$here/../apps/send}" && pwd)"
APP_OUT="${APP_OUT:-$here/.bench-out/sendapp}"
PROFILE="${PROFILE:-2c4g}"
LAYOUT="${LAYOUT:-single}"
DURATION="${DURATION:-30s}"
NET=bench-net
RES="$here/results/send/$PROFILE-$LAYOUT${RUN_TAG:+-$RUN_TAG}"
mkdir -p "$RES"

case "$PROFILE" in
  2c4g) VM_CPUS=0-1; LG_CPUS=4-7; NCPU=2; PG_MEM=1g; APP_MEM=3g; PG_SB=256MB ;;
  4c8g) VM_CPUS=0-3; LG_CPUS=4-7; NCPU=4; PG_MEM=2g; APP_MEM=6g; PG_SB=512MB ;;
  8c)   VM_CPUS=0-7; LG_CPUS=0-7; NCPU=8; PG_MEM=3g; APP_MEM=4g; PG_SB=768MB ;;  # uncapped: load gen shares cores
  *) echo "unknown PROFILE"; exit 1 ;;
esac
if [ "$LAYOUT" = percore ]; then PROCS=$NCPU; else PROCS=1; fi

SAMPLER_PID=
start_sampler() { "$here/lib/sampler.sh" "$RES/stats-$1.tsv" bench-send bench-pg & SAMPLER_PID=$!; }
stop_sampler() { if [ -n "$SAMPLER_PID" ]; then kill $SAMPLER_PID 2>/dev/null || true; fi; SAMPLER_PID=; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$RES/log.txt"; }
cleanup() { docker rm -f bench-send bench-pg bench-sink >/dev/null 2>&1 || true; }
trap 'stop_sampler; cleanup' EXIT
cleanup
docker network create $NET >/dev/null 2>&1 || true
{ echo "profile=$PROFILE layout=$LAYOUT procs=$PROCS vm_cpus=$VM_CPUS lg_cpus=$LG_CPUS"; echo "host load: $(uptime)"; echo "calibration vm: $("$here/lib/calibrate.sh" $VM_CPUS $NCPU)"; } > "$RES/env.txt"

log "start postgres (cpuset $VM_CPUS, mem $PG_MEM)"
docker run -d --name bench-pg --network $NET --cpuset-cpus=$VM_CPUS --memory=$PG_MEM \
  -e POSTGRES_USER=send -e POSTGRES_PASSWORD=sendpw postgres:16-alpine \
  -c shared_buffers=$PG_SB -c max_connections=200 >/dev/null
until docker exec bench-pg pg_isready -U send -q 2>/dev/null; do sleep 0.5; done; sleep 2

start_app() { # $1 web $2 worker $3 smtp $4 seed
  docker rm -f bench-send >/dev/null 2>&1 || true
  docker run -d --name bench-send --network $NET --cpuset-cpus=$VM_CPUS --memory=$APP_MEM \
    -v "$APP_OUT/dist:/app/dist:ro" -v "$SEND_DIR/migrations:/app/migrations:ro" \
    -v "$SEND_DIR/node_modules:/app/node_modules:ro" -v "$SEND_DIR/package.json:/app/package.json:ro" \
    -v "$here/send/server.mjs:/app/bench/server.mjs:ro" -v "$RES:/out" \
    -e WEB_PROCS=$1 -e WORKER_PROCS=$2 -e SMTP_PROCS=$3 -e SEED=$4 -e PG_ADMIN=postgres://send:sendpw@bench-pg:5432/postgres \
    node:22-alpine node /app/bench/server.mjs >/dev/null
  for _ in $(seq 1 240); do docker logs bench-send 2>&1 | grep -q READY && break; sleep 0.5; done
  docker logs bench-send 2>&1 | grep -q READY || { docker logs bench-send; exit 1; }
}
psql() { docker exec bench-pg psql -U send -d send_bench -tAc "$1"; }
k6() { # $1 name, rest env
  local name=$1; shift
  docker run --rm --network $NET --cpuset-cpus=$LG_CPUS -v "$here/send/k6-api.js:/k6-api.js:ro" -v "$RES:/out" \
    -e KEY="$KEY" -e SUMMARY=/out/$name.json -e DURATION=$DURATION "$@" grafana/k6:1.3.0 run -q /k6-api.js 2>&1 | grep '^{' | tee -a "$RES/log.txt"
}
cpu_sample() { docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' bench-send bench-pg | tee -a "$RES/log.txt"; }

# ---- API ingest (worker off so the API is measured alone) ----
log "app: web=$PROCS (seed)"
start_app $PROCS 0 0 1
KEY=$(python3 -c "import json;print(json.load(open('$RES/fixture.json'))['key'])")
k6 warmup -e VUS=16 -e SCENARIO=single -e DURATION=5s >/dev/null
start_sampler api
log "POST /emails, 64 VUs"; k6 single -e VUS=64 -e SCENARIO=single
log "POST /emails/batch x100, 8 VUs"; k6 batch -e VUS=8 -e SCENARIO=batch -e BATCH=100
log "GET /emails/{id}, 64 VUs"; k6 get -e VUS=64 -e SCENARIO=get
stop_sampler
BACKLOG=$(psql "select count(*) from jobs where kind='send_email'")
log "queued send_email jobs: $BACKLOG; emails rows: $(psql 'select count(*) from emails')"

[ "${API_ONLY:-0}" = 1 ] && { log "done (API_ONLY)"; exit 0; }

# ---- worker throughput (drain the backlog) ----
measure_drain() { # $1 name $2 seconds
  local a b sa sb
  a=$(psql "select count(*) from jobs where kind='send_email'"); sa=$(docker exec bench-sink wget -qO- http://127.0.0.1:8080/count 2>/dev/null || echo 0)
  sleep "$2"
  b=$(psql "select count(*) from jobs where kind='send_email'"); sb=$(docker exec bench-sink wget -qO- http://127.0.0.1:8080/count 2>/dev/null || echo 0)
  python3 - "$1" "$a" "$b" "$sa" "$sb" "$2" "$RES" <<'PY' | tee -a "$RES/log.txt"
import json,sys
name,a,b,sa,sb,secs,res=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),int(sys.argv[5]),float(sys.argv[6]),sys.argv[7]
o={"name":name,"emails_sent":a-b,"emails_per_sec":round((a-b)/secs,1),"webhook_deliveries":sb-sa,"webhooks_per_sec":round((sb-sa)/secs,1),"seconds":secs,"backlog_end":b}
print(json.dumps(o)); json.dump(o,open(f"{res}/{name}.json","w"),indent=2)
PY
}
docker run -d --name bench-sink --network $NET --cpuset-cpus=$LG_CPUS -v "$here/send/sink.mjs:/sink.mjs:ro" node:22-alpine node /sink.mjs >/dev/null
log "worker drain: worker=$PROCS, no webhooks"
start_app 0 $PROCS 0 0
start_sampler worker
measure_drain worker 30
stop_sampler
log "worker drain + webhook fan-out to 3 endpoints"
start_app 1 0 0 0
for i in 1 2 3; do
  curl_out=$(docker exec bench-send wget -qO- --header "authorization: Bearer $KEY" --header 'content-type: application/json' \
    --header 'user-agent: bench' --post-data "{\"endpoint\":\"http://bench-sink:8080/hook$i\",\"events\":[\"email.sent\",\"email.delivered\"]}" \
    http://127.0.0.1:3000/v/webhooks 2>&1 || true)
  echo "$curl_out" | grep -q '"id"' || { log "webhook create failed: $curl_out"; exit 1; }
done
start_app 0 $PROCS 0 0
start_sampler worker_webhooks
measure_drain worker_webhooks 30
stop_sampler

# ---- SMTP relay ----
log "smtp relay: smtp=$PROCS"
start_app 0 0 $PROCS 0
start_sampler smtp
for c in 16 64; do
  docker run --rm --network $NET --cpuset-cpus=$LG_CPUS -v "$SEND_DIR/node_modules:/l/node_modules:ro" -v "$here/send/smtp-load.mjs:/l/smtp-load.mjs:ro" -v "$RES:/out" \
    -e HOST=bench-send -e PORT=2587 -e PASS="$KEY" -e CONC=$c -e TOTAL=$(( c * 50 )) -e OUT=/out/smtp_c$c.json \
    node:22-alpine node /l/smtp-load.mjs | tee -a "$RES/log.txt"
done
stop_sampler

# ---- optional: POST /emails vs. rows already sent this month (quota check is a COUNT over them) ----
if [ "${QUOTA_SCAN:-0}" = 1 ]; then
  start_app $PROCS 0 0 0
  TEAM=$(python3 -c "import json;print(json.load(open('$RES/fixture.json'))['teamId'])")
  for target in 100000 500000 1000000; do
    have=$(psql "select count(*) from emails")
    add=$(( target - have )); [ $add -gt 0 ] && psql "insert into emails (team_id, from_addr, to_addrs, subject, last_event, message_id, source)
      select '$TEAM', 'bench@bench.example.com', array['x@example.net'], 'filler', 'delivered', 'filler-'||g, 'api' from generate_series(1,$add) g" >/dev/null
    psql "analyze emails" >/dev/null
    log "POST /emails with $(psql 'select count(*) from emails') emails this month"; k6 quota_$target -e VUS=64 -e SCENARIO=single
  done
fi
log "done"
