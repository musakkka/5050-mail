#!/usr/bin/env bash
# 5050 Mail: end-to-end install test on a throwaway cloud VM.
#
#   tests/install/run.sh                 # Ubuntu 24.04
#   tests/install/run.sh --os debian     # Debian 12
#   tests/install/run.sh --keep          # leave the VM up for debugging (prints the delete command)
#
# What it does
#   1. creates a NEW Azure resource group oss-install-test-<timestamp>-<os> (deleted on exit, always)
#      with one small VM, an SSH key generated for this run, and ports open to *your* IP only
#   2. copies the current working tree (tracked + untracked, minus .gitignore'd files) to the VM;
#      SOURCE_MODE=git (default) commits it to a repo on the VM and installs like `curl | sudo bash`
#      with FIVEFIFTY_REPO=file:///srv/5050-mail; SOURCE_MODE=tree runs install.sh from the copy
#   3. runs install.sh non-interactively for a fake domain (acme.test, --tls internal, --send-transport log)
#   4. checks: containers healthy, HTTPS on every hostname (via the VM IP, like curl --resolve),
#      webmail login, admin creates a second domain + mailbox through the admin JMAP API,
#      SMTP 587 STARTTLS+AUTH, IMAP 993, Send dashboard login, team + API key, POST /emails
#   5. re-runs install.sh (idempotent: .env unchanged, data kept), then --upgrade, then
#      --uninstall (data volumes kept) and --uninstall --purge (everything gone)
#
# Requirements on the machine running this: az (logged in), ssh, scp, git, python3, curl.
# Results: tests/install/results/<run-id>/ (summary.txt, install logs, container logs).
#
# Env overrides: LOCATION (eastus), VM_SIZES ("Standard_D2als_v7 Standard_D2als_v6 Standard_B2s Standard_D2as_v5"),
#                TEST_DOMAIN (acme.test), ADMIN_PASSWORD (random), INSTALL_DIR (/opt/5050-mail),
#                EXTRA_INSTALL_ARGS (appended to every install.sh call)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

OS=ubuntu
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$OS" in
  ubuntu) IMAGE="Canonical:ubuntu-24_04-lts:server:latest" ;;
  debian) IMAGE="Debian:debian-12:12-gen2:latest" ;;
  *) echo "--os must be ubuntu or debian" >&2; exit 2 ;;
esac

LOCATION="${LOCATION:-eastus}"
VM_SIZES="${VM_SIZES:-Standard_D2als_v7 Standard_D2als_v6 Standard_B2s Standard_D2as_v5 Standard_D2s_v5}"
DOMAIN="${TEST_DOMAIN:-acme.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Adm1n-$(openssl rand -hex 10)}"
INSTALL_DIR="${INSTALL_DIR:-/opt/5050-mail}"
EXTRA_INSTALL_ARGS="${EXTRA_INSTALL_ARGS:-}"
RUN_ID="$(date +%Y%m%d%H%M%S)-$OS"
RG="oss-install-test-$RUN_ID"
OUT="$HERE/results/$RUN_ID"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
KEY="$WORK/id_rsa"
SSH_USER=tester
IP=""

for bin in az ssh scp git python3 curl; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }; done

# ------------------------------------------------------------------ results
declare -a RESULTS=()
FAILED=0
log() { printf '\n\033[1m== %s\033[0m\n' "$*" | tee -a "$OUT/run.log"; }
record() { # record <PASS|FAIL> <step> [detail]
  RESULTS+=("$(printf '%-5s %-40s %s' "$1" "$2" "${3:-}")")
  [ "$1" = PASS ] || FAILED=$((FAILED + 1))
  printf '%s %s %s\n' "$1" "$2" "${3:-}" | tee -a "$OUT/run.log"
}

summary() {
  {
    echo "5050 Mail install test  run=$RUN_ID  os=$OS  source=${SOURCE_MODE:-?}  image=$IMAGE  size=${SIZE:-?}  ip=${IP:-?}"
    echo "commit: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null) (+ working tree)"
    printf '%s\n' "${RESULTS[@]+"${RESULTS[@]}"}"
    echo "failed steps: $FAILED"
  } | tee "$OUT/summary.txt"
}

cleanup() {
  local code=$?
  set +e
  [ "$code" != 0 ] && [ "$code" != 130 ] && record FAIL "harness aborted" "exit $code at line ${ABORT_LINE:-?} (see $OUT/run.log)"
  [ -n "$IP" ] && collect_logs final >/dev/null 2>&1
  summary
  if [ "$KEEP" = 1 ]; then
    echo "KEEP=1: VM left running. ssh -i $KEY $SSH_USER@$IP   delete with: az group delete -n $RG --yes --no-wait"
  else
    case "$RG" in
      oss-install-test-*)
        echo "deleting resource group $RG (no-wait)"
        az group delete -n "$RG" --yes --no-wait >/dev/null 2>&1 || echo "WARNING: could not delete $RG, delete it manually" >&2
        ;;
    esac
    rm -rf "$WORK"
  fi
  [ "$FAILED" -gt 0 ] && code=1
  exit "$code"
}
trap cleanup EXIT
trap 'ABORT_LINE=$LINENO' ERR
trap 'exit 130' INT TERM

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=30)
vm() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "$@"; }

collect_logs() { # collect_logs <label>
  local d="$OUT/logs-$1"
  mkdir -p "$d"
  vm "sudo docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'" >"$d/ps.txt" 2>&1 || true
  for c in $(vm "sudo docker ps -a --format '{{.Names}}'" 2>/dev/null); do
    vm "sudo docker logs --tail 300 $c" >"$d/$c.log" 2>&1 || true
  done
}

# ------------------------------------------------------------------ VM
log "creating resource group $RG in $LOCATION"
ssh-keygen -q -t rsa -b 3072 -N '' -C "5050-install-test" -f "$KEY"
az group create -n "$RG" -l "$LOCATION" --tags purpose=5050-install-test ephemeral=true -o none

MYIP="$(curl -fsS4 https://ifconfig.me || curl -fsS4 https://api.ipify.org)"
SIZE=""
for s in $VM_SIZES; do
  log "creating VM ($s, $IMAGE)"
  if az vm create -g "$RG" -n vm --image "$IMAGE" --size "$s" --admin-username "$SSH_USER" \
      --ssh-key-values "$KEY.pub" --public-ip-sku Standard --nsg-rule NONE --os-disk-size-gb 40 \
      -o none 2>"$OUT/vm-create-$s.err"; then
    SIZE="$s"; break
  fi
  tail -3 "$OUT/vm-create-$s.err"
  az vm delete -g "$RG" -n vm --yes -o none 2>/dev/null || true
done
[ -n "$SIZE" ] || { record FAIL "create VM" "no size in [$VM_SIZES] could be created"; exit 1; }
IP="$(az vm show -d -g "$RG" -n vm --query publicIps -o tsv)"
NSG="$(az network nsg list -g "$RG" --query '[0].name' -o tsv)"
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-tester --priority 100 --access Allow --protocol Tcp \
  --direction Inbound --source-address-prefixes "$MYIP/32" --destination-port-ranges 22 25 80 443 465 587 993 2465 2587 -o none
record PASS "create VM" "$SIZE $IP"

for i in $(seq 1 40); do vm true 2>/dev/null && break; sleep 5; done
vm 'cloud-init status --wait >/dev/null 2>&1 || true; . /etc/os-release; echo "$PRETTY_NAME"; nproc; free -m | awk "/Mem/{print \$2\" MB\"}"' | tee "$OUT/vm.txt"

# ------------------------------------------------------------------ copy tree
log "copying working tree"
( cd "$REPO" && git ls-files -co --exclude-standard -z \
    | grep -zv '^tests/install/results/' \
    | COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --null -T - -czf "$WORK/src.tgz" )
echo "tarball: $(du -h "$WORK/src.tgz" | cut -f1)"
scp "${SSH_OPTS[@]}" -q "$WORK/src.tgz" "$SSH_USER@$IP:/tmp/src.tgz"
vm 'rm -rf ~/5050-mail && mkdir ~/5050-mail && tar -xzf /tmp/src.tgz -C ~/5050-mail 2>&1 | grep -v "Ignoring unknown extended" || true'
[ "$(vm 'test -f ~/5050-mail/install.sh && echo y')" = y ] || { record FAIL "install.sh present" "not in working tree"; exit 1; }

# SOURCE_MODE=git (default): the copied tree becomes a git repo on the VM (/srv/5050-mail,
# standing in for GitHub) and install.sh is piped to bash exactly like the documented
# `curl ... | sudo bash`, with FIVEFIFTY_REPO pointing at it. Later steps run the installed
# $INSTALL_DIR/install.sh, and --upgrade must pick up a new commit.
# SOURCE_MODE=tree: run ~/5050-mail/install.sh from the copied tree for every step.
SOURCE_MODE="${SOURCE_MODE:-git}"
if [ "$SOURCE_MODE" = git ]; then
  vm 'command -v git >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; }
      sudo rm -rf /srv/5050-mail && sudo cp -a ~/5050-mail /srv/5050-mail && sudo chown -R root:root /srv/5050-mail &&
      sudo git -C /srv/5050-mail init -q -b main && sudo git -C /srv/5050-mail add -A &&
      sudo git -C /srv/5050-mail -c user.name=test -c user.email=test@example.com commit -qm "install test snapshot" && echo "git source ready"'
fi

# SEND_TRANSPORT=smtp (default, like production): Send -> Stalwart internal relay -> local delivery.
SEND_TRANSPORT="${SEND_TRANSPORT:-smtp}"
INSTALL_ARGS="--domain $DOMAIN --admin-password '$ADMIN_PASSWORD' --tls internal --send-transport $SEND_TRANSPORT --skip-port25-check --dir $INSTALL_DIR --yes $EXTRA_INSTALL_ARGS"

run_install() { # run_install <label> [extra args]
  local label="$1"; shift
  local start=$SECONDS rc=0
  if [ "$SOURCE_MODE" = git ] && [ "$label" = fresh ]; then
    vm "cd / && sudo env FIVEFIFTY_REPO=file:///srv/5050-mail bash -s -- $INSTALL_ARGS $* <~/5050-mail/install.sh" >"$OUT/install-$label.log" 2>&1 || rc=$?
  elif [ "$SOURCE_MODE" = git ]; then
    vm "cd / && sudo bash $INSTALL_DIR/install.sh $INSTALL_ARGS $* </dev/null" >"$OUT/install-$label.log" 2>&1 || rc=$?
  else
    vm "cd ~/5050-mail && sudo bash ./install.sh $INSTALL_ARGS $* </dev/null" >"$OUT/install-$label.log" 2>&1 || rc=$?
  fi
  echo "install.sh $label: exit $rc in $((SECONDS - start))s (log: $OUT/install-$label.log)"
  return $rc
}

wait_healthy() { # wait_healthy <label>  -> 0 when every running container is healthy/up and none crashed
  local deadline=$((SECONDS + 420)) ps bad starting
  while :; do
    ps="$(vm "sudo docker ps -a --format '{{.Names}}|{{.Status}}'" 2>/dev/null || true)"
    starting="$(grep -E 'health: starting|Restarting|Created' <<<"$ps" || true)"
    bad="$(grep -E 'unhealthy|Restarting|Exited \([1-9]' <<<"$ps" || true)"
    if [ -n "$ps" ] && [ -z "$starting" ] && [ -z "$bad" ]; then
      echo "$ps" >"$OUT/ps-$1.txt"; return 0
    fi
    if [ $SECONDS -gt $deadline ]; then
      echo "$ps" >"$OUT/ps-$1.txt"; echo "$ps"; return 1
    fi
    sleep 10
  done
}

env_value() { { vm "sudo cat $INSTALL_DIR/.env" 2>/dev/null | grep -E "^$1=" | tail -1 | cut -d= -f2- | tr -d "\"'"; } || true; }

E2E_ARGS=()
e2e() { # e2e <label> <phase>
  python3 -I "$HERE/e2e.py" --ip "$IP" --domain "$DOMAIN" --admin-password "$ADMIN_PASSWORD" \
    --state "$OUT/state.json" --phase "$2" "${E2E_ARGS[@]+"${E2E_ARGS[@]}"}" 2>&1 | tee "$OUT/e2e-$1.log"
  return "${PIPESTATUS[0]}"
}
e2e_record() { # e2e_record <label>
  local n
  n=$(grep -c '^FAIL' "$OUT/e2e-$1.log" || true)
  if [ "$n" = 0 ]; then record PASS "e2e $1" "$(grep -c '^PASS' "$OUT/e2e-$1.log") checks"
  else record FAIL "e2e $1" "$(grep '^FAIL' "$OUT/e2e-$1.log" | sed 's/^FAIL *//; s/ *::.*//' | paste -sd ';' -)"; fi
}

# ------------------------------------------------------------------ 1. fresh install
log "install.sh (fresh)"
T0=$SECONDS
if run_install fresh; then record PASS "install.sh fresh" "$((SECONDS - T0))s"
else record FAIL "install.sh fresh" "$(tail -3 "$OUT/install-fresh.log" | tr '\n' ' ' | cut -c1-300)"; collect_logs fresh; exit 1; fi

if wait_healthy fresh; then record PASS "containers healthy (fresh)" "$(wc -l <"$OUT/ps-fresh.txt" | tr -d ' ') containers"
else record FAIL "containers healthy (fresh)" "$(grep -E 'unhealthy|Restarting|Exited|starting' "$OUT/ps-fresh.txt" | tr '\n' ' ')"; fi
collect_logs fresh
# Idle resource usage (README sizing numbers).
vm "sleep 60; sudo docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'; free -m" >"$OUT/docker-stats-idle.txt" 2>&1 || true
cat "$OUT/docker-stats-idle.txt"

vm "sudo stat -c '%a %U' $INSTALL_DIR/.env" >"$OUT/env-perms.txt" 2>&1 || true
if grep -q '^600 root' "$OUT/env-perms.txt"; then record PASS ".env mode 0600 root"; else record FAIL ".env mode 0600 root" "$(cat "$OUT/env-perms.txt")"; fi

# Hostnames from the generated .env (fall back to the documented defaults).
for pair in "--mail-host MAIL_HOSTNAME" "--send-host SEND_HOST" "--api-host API_HOST" "--sandbox-domain SEND_SANDBOX_DOMAIN"; do
  set -- $pair; v="$(env_value "$2")"; [ -n "$v" ] && E2E_ARGS+=("$1" "$v")
done
# acme.test has no public DNS: after Send shows the DKIM/SPF records, mark the domain verified in its DB.
vm "cat >/tmp/verify-send-domain.sql" <<'SQL'
\set ON_ERROR_STOP 1
update domains set status = 'verified', verified_at = now(), updated_at = now(),
       records = (select coalesce(jsonb_agg(r || '{"status":"verified"}'::jsonb), '[]'::jsonb) from jsonb_array_elements(records) r)
 where lower(name) = lower(:'domain');
delete from jobs where unique_key like 'domain_verify:%';
SQL
VERIFY_CMD="ssh ${SSH_OPTS[*]} $SSH_USER@$IP \"sudo docker exec -i \\\$(sudo docker ps -qf label=com.docker.compose.service=postgres) psql -U postgres -d send -v domain={domain} -q </tmp/verify-send-domain.sql\""
E2E_ARGS+=(--verify-cmd "$VERIFY_CMD")
echo "e2e args: ${E2E_ARGS[*]-}"

log "e2e checks (fresh)"
e2e fresh full || true
e2e_record fresh

# ------------------------------------------------------------------ 2. idempotent re-run
log "install.sh re-run (idempotency)"
ENV_BEFORE="$(vm "sudo grep -v '^BOOTSTRAPPED=' $INSTALL_DIR/.env | sort | sha256sum" | cut -d' ' -f1)"
if run_install rerun; then record PASS "install.sh re-run exit 0"; else record FAIL "install.sh re-run exit 0" "$(tail -3 "$OUT/install-rerun.log" | tr '\n' ' ' | cut -c1-300)"; fi
ENV_AFTER="$(vm "sudo grep -v '^BOOTSTRAPPED=' $INSTALL_DIR/.env | sort | sha256sum" | cut -d' ' -f1)"
if [ "$ENV_BEFORE" = "$ENV_AFTER" ]; then record PASS "re-run keeps .env (secrets unchanged)" "ignoring BOOTSTRAPPED timestamp"
else
  vm "sudo cat $INSTALL_DIR/.env" | sed -E 's/(PASSWORD|SECRET|TOKEN|KEY|ADMIN)([A-Z_]*)=.*/\1\2=<redacted>/' >"$OUT/env-after-rerun.redacted" || true
  record FAIL "re-run keeps .env (secrets unchanged)" "sha changed"
fi
if wait_healthy rerun; then record PASS "containers healthy (re-run)"; else record FAIL "containers healthy (re-run)" "$(grep -E 'unhealthy|Restarting|Exited|starting' "$OUT/ps-rerun.txt" | tr '\n' ' ')"; fi
e2e rerun smoke || true
e2e_record rerun

# ------------------------------------------------------------------ 3. upgrade
log "install.sh --upgrade"
MARKER="upgrade-marker-$RUN_ID"
if [ "$SOURCE_MODE" = git ]; then
  vm "echo $MARKER | sudo tee /srv/5050-mail/UPGRADE_MARKER >/dev/null && sudo git -C /srv/5050-mail add -A && sudo git -C /srv/5050-mail -c user.name=test -c user.email=test@example.com commit -qm 'upgrade marker'"
fi
if run_install upgrade --upgrade; then record PASS "install.sh --upgrade exit 0"; else record FAIL "install.sh --upgrade exit 0" "$(tail -3 "$OUT/install-upgrade.log" | tr '\n' ' ' | cut -c1-300)"; fi
if wait_healthy upgrade; then record PASS "containers healthy (upgrade)"; else record FAIL "containers healthy (upgrade)" "$(grep -E 'unhealthy|Restarting|Exited|starting' "$OUT/ps-upgrade.txt" | tr '\n' ' ')"; fi
if [ "$SOURCE_MODE" = git ]; then
  if [ "$(vm "sudo cat $INSTALL_DIR/UPGRADE_MARKER 2>/dev/null" || true)" = "$MARKER" ]; then record PASS "--upgrade pulls new source commit"
  else record FAIL "--upgrade pulls new source commit" "$INSTALL_DIR/UPGRADE_MARKER missing after 'sudo $INSTALL_DIR/install.sh --upgrade' (new commit in FIVEFIFTY_REPO not fetched)"; fi
fi
e2e upgrade smoke || true
e2e_record upgrade
collect_logs upgrade

# ------------------------------------------------------------------ 4. uninstall
log "install.sh --uninstall (keep data)"
rc=0; vm "cd / && sudo bash \$( [ $SOURCE_MODE = git ] && echo $INSTALL_DIR || echo ~/5050-mail )/install.sh --uninstall --dir $INSTALL_DIR --yes </dev/null" >"$OUT/install-uninstall.log" 2>&1 || rc=$?
CONTAINERS="$(vm "sudo docker ps -aq | wc -l" | tr -d ' ')"
VOLS="$(vm "sudo docker volume ls -q | wc -l" | tr -d ' ')"
vm "sudo docker volume ls --format '{{.Name}}'" >"$OUT/volumes-after-uninstall.txt" 2>&1 || true
if [ $rc = 0 ] && [ "$CONTAINERS" = 0 ]; then record PASS "--uninstall removes containers" "volumes kept: $VOLS ($(paste -sd' ' "$OUT/volumes-after-uninstall.txt"))"
else record FAIL "--uninstall removes containers" "exit $rc, $CONTAINERS containers left: $(vm "sudo docker ps -a --format '{{.Names}}'" | tr '\n' ' ')"; fi
if curl -sk --max-time 5 --resolve "mail.$DOMAIN:443:$IP" "https://mail.$DOMAIN/" >/dev/null 2>&1; then
  record FAIL "--uninstall closes 443" "still answering"
else record PASS "--uninstall closes 443"; fi

log "install.sh --uninstall --purge"
rc=0; vm "cd / && sudo bash \$( [ $SOURCE_MODE = git ] && echo $INSTALL_DIR || echo ~/5050-mail )/install.sh --uninstall --purge --dir $INSTALL_DIR --yes </dev/null" >"$OUT/install-purge.log" 2>&1 || rc=$?
LEFT="$(vm "sudo docker ps -aq | wc -l; sudo docker volume ls -q | wc -l; sudo docker network ls --format '{{.Name}}' | grep -vcE '^(bridge|host|none)$'; sudo test -e $INSTALL_DIR && echo dir-present || echo dir-gone" | tr '\n' ' ')"
read -r C V N D <<<"$LEFT"
if [ $rc = 0 ] && [ "$C" = 0 ] && [ "$V" = 0 ] && [ "$N" = 0 ] && [ "$D" = dir-gone ]; then record PASS "--uninstall --purge cleans up"
else record FAIL "--uninstall --purge cleans up" "exit $rc containers=$C volumes=$V networks=$N $D; left: $(vm "sudo docker volume ls --format '{{.Name}} {{.Labels}}'; sudo docker ps -a --format '{{.Names}}'" | tr '\n' ' ' | cut -c1-400)"; fi

log "done"
