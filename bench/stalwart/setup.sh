#!/usr/bin/env bash
# Start a throw-away Stalwart (same image as production) for the webmail + ingest benchmarks,
# pinned to the "VM" cores, with a bench.test domain and USERS mailboxes u01..uNN.
#
#   VM_CPUS=0-1 STW_MEM=2g USERS=32 ./stalwart/setup.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${STALWART_IMAGE:-stalwartlabs/stalwart:v0.16.27}"
VM_CPUS="${VM_CPUS:-0-1}"; STW_MEM="${STW_MEM:-2g}"; USERS="${USERS:-32}"
ADMIN="admin:benchpass123"; PASS="Bench-Mailbox-Pass-2026"
STW_HTTP="${STW_HTTP:-18490}"; STW_SMTP="${STW_SMTP:-2925}"
mkdir -p "$here/.bench-out/stw"
echo '{"@type":"RocksDb","path":"/var/lib/stalwart/","blobSize":16834,"bufferSize":134217728,"poolWorkers":null,"cacheSize":134217728}' > "$here/.bench-out/stw/config.json"
docker network create bench-net >/dev/null 2>&1 || true
docker rm -f bench-stw >/dev/null 2>&1 || true
docker run -d --name bench-stw --network bench-net --cpuset-cpus="$VM_CPUS" --memory="$STW_MEM" \
  -p "$STW_HTTP:8080" -p "$STW_SMTP:25" -e STALWART_RECOVERY_ADMIN=$ADMIN \
  -v "$here/.bench-out/stw/config.json:/etc/stalwart/config.json:ro" "$IMAGE" --config /etc/stalwart/config.json >/dev/null
until curl -sf -o /dev/null -u $ADMIN "http://localhost:$STW_HTTP/.well-known/jmap" -L; do sleep 1; done
J() { curl -sf -u $ADMIN "http://localhost:$STW_HTTP/jmap/" -H 'content-type: application/json' -d "$1"; }
DID=$(J '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Domain/set",{"create":{"d":{"name":"bench.test"}}},"0"]]}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["methodResponses"][0][1]["created"]["d"]["id"])')
CREATE=$(python3 - "$DID" "$USERS" "$PASS" <<'PY'
import json,sys
did,n,pw=sys.argv[1],int(sys.argv[2]),sys.argv[3]
c={f"u{i:02d}":{"@type":"User","name":f"u{i:02d}","domainId":did,"description":f"Bench user {i}","credentials":{"0":{"@type":"Password","secret":pw}}} for i in range(1,n+1)}
print(json.dumps({"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Account/set",{"create":c},"0"]]}))
PY
)
J "$CREATE" | python3 -c 'import json,sys;r=json.load(sys.stdin)["methodResponses"][0][1];print("created",len(r.get("created",{})),"users; notCreated:",r.get("notCreated"))'
if [ "${UNTHROTTLE:-1}" = 1 ]; then
  # Production defaults throttle a single client: 1000 authenticated HTTP requests/min per account,
  # 5 SMTP connections/s per sender IP, 25 msgs/hour per sender-domain+recipient. A load test comes
  # from ONE IP and a handful of accounts, so lift these to measure server capacity (see RESULTS.md).
  J '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Http/set",{"update":{"singleton":{"rateLimitAuthenticated":{"count":1000000,"period":1000}}}},"0"]]}' >/dev/null
  IDS=$(J '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:MtaInboundThrottle/get",{},"0"]]}' | python3 -c 'import json,sys;print(" ".join(x["id"] for x in json.load(sys.stdin)["methodResponses"][0][1]["list"]))')
  for id in $IDS; do J "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:MtaInboundThrottle/set\",{\"update\":{\"$id\":{\"enable\":false}}},\"0\"]]}" >/dev/null; done
  J '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Http/get",{"ids":["singleton"]},"0"],["x:MtaInboundThrottle/get",{},"1"]]}' \
    | python3 -c 'import json,sys;r=json.load(sys.stdin)["methodResponses"];print("http rate:",r[0][1]["list"][0]["rateLimitAuthenticated"],"| smtp throttles enabled:",[t["enable"] for t in r[1][1]["list"]])'
  docker restart bench-stw >/dev/null   # settings apply on restart
  until curl -sf -o /dev/null -u $ADMIN "http://localhost:$STW_HTTP/.well-known/jmap" -L; do sleep 1; done
fi
echo "bench-stw up: http :$STW_HTTP smtp :$STW_SMTP cpus $VM_CPUS mem $STW_MEM"
