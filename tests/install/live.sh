#!/usr/bin/env bash
# Live, interactive install on a throwaway Azure VM, driven through a pty over ssh -tt like a first-time user.
#
#   tests/install/live.sh manual       # answer "no" to Cloudflare, domain on a provider we do not control
#   tests/install/live.sh cloudflare   # needs CLOUDFLARE_API_TOKEN in the environment and LIVE_DOMAIN
#
# Creates oss-install-test-<ts>-live-<pass> in eastus, copies the working tree, runs install.sh the way
# `curl | sudo bash` does, and saves the whole screen (colours kept) to tests/install/results/<run>/screen.log.
# The VM is LEFT RUNNING so you can test mail by hand: delete it with the az command printed at the end.
# The token is read from the environment only and is never written to a file.
set -euo pipefail
PASS_NAME="${1:?manual|cloudflare}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TS="$(date +%Y%m%d%H%M%S)"
RG="oss-install-test-$TS-live-$PASS_NAME"
OUT="$HERE/results/$TS-live-$PASS_NAME"; mkdir -p "$OUT"
WORK="$(mktemp -d)"; KEY="$WORK/id_rsa"; SSH_USER=tester
DOMAIN="${LIVE_DOMAIN:-manual$TS.example.com}"
LOCATION="${LOCATION:-eastus}"
VM_SIZES="${VM_SIZES:-Standard_D2als_v7 Standard_D2als_v6 Standard_B2s Standard_D2as_v5 Standard_D2s_v5}"
echo "$RG" >"$OUT/rg.txt"; echo "$DOMAIN" >"$OUT/domain.txt"
trap 'rm -rf "$WORK"' EXIT

ssh-keygen -q -t rsa -b 3072 -N '' -f "$KEY"
az group create -n "$RG" -l "$LOCATION" --tags purpose=5050-install-test ephemeral=true -o none
SIZE=""
for s in $VM_SIZES; do
  if az vm create -g "$RG" -n vm --image Canonical:ubuntu-24_04-lts:server:latest --size "$s" --admin-username "$SSH_USER" \
      --ssh-key-values "$KEY.pub" --public-ip-sku Standard --nsg-rule NONE --os-disk-size-gb 40 -o none 2>"$OUT/vm-create.err"; then SIZE="$s"; break; fi
  az vm delete -g "$RG" -n vm --yes -o none 2>/dev/null || true
done
[ -n "$SIZE" ] || { echo "no VM size could be created"; exit 1; }
IP="$(az vm show -d -g "$RG" -n vm --query publicIps -o tsv)"
NSG="$(az network nsg list -g "$RG" --query '[0].name' -o tsv)"
MYIP="$(curl -fsS4 https://ifconfig.me || curl -fsS4 https://api.ipify.org)"
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-tester --priority 100 --access Allow --protocol Tcp \
  --direction Inbound --source-address-prefixes "$MYIP/32" --destination-port-ranges 22 25 80 443 465 587 993 2465 2587 -o none
# Let's Encrypt must reach 80/443 (HTTP-01), like on any real server.
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-web --priority 110 --access Allow --protocol Tcp \
  --direction Inbound --source-address-prefixes '*' --destination-port-ranges 80 443 -o none
echo "$IP" >"$OUT/ip.txt"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o LogLevel=ERROR -o ConnectTimeout=15 -o ServerAliveInterval=30)
for _ in $(seq 1 40); do ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" true 2>/dev/null && break; sleep 5; done
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'cloud-init status --wait >/dev/null 2>&1 || true'
cp "$KEY" "$OUT/ssh_key"; chmod 600 "$OUT/ssh_key"   # results/ is gitignored; needed for the follow-up tests

( cd "$REPO" && git ls-files -co --exclude-standard -z | grep -zv '^tests/install/results/' \
  | COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --null -T - -czf "$WORK/src.tgz" )
scp "${SSH_OPTS[@]}" -q "$WORK/src.tgz" "$SSH_USER@$IP:/tmp/src.tgz"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'mkdir ~/5050-mail && tar -xzf /tmp/src.tgz -C ~/5050-mail 2>&1 | grep -v "Ignoring unknown" || true
  command -v git >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; }
  sudo cp -a ~/5050-mail /srv/5050-mail && sudo chown -R root:root /srv/5050-mail && sudo git -C /srv/5050-mail init -q -b main &&
  sudo git -C /srv/5050-mail add -A && sudo git -C /srv/5050-mail -c user.name=t -c user.email=t@example.com commit -qm snapshot'

case "$PASS_NAME" in
  manual) STEPS=(--step 'Continue\?::y' --step 'Mail domain::'"$DOMAIN" --step 'Admin mailbox::'
                 --step 'on Cloudflare\?::n' --step 'Choose 1-9::9' --step 'skip: ::s^') ;;
  cloudflare) : "${CLOUDFLARE_API_TOKEN:?}"
              STEPS=(--step 'Continue\?::y' --step 'Mail domain::'"$DOMAIN" --step 'Admin mailbox::'
                     --step 'on Cloudflare\?::y' --step 'Paste the token::@env:CLOUDFLARE_API_TOKEN'
                     --step 'Send through Cloudflare Email Sending\?::y') ;;
esac
START=$SECONDS
set +e
python3 -I "$HERE/pty_drive.py" "$OUT/screen.log" --timeout 1500 "${STEPS[@]}" -- \
  ssh -tt "${SSH_OPTS[@]}" "$SSH_USER@$IP" "cd / && cat ~/5050-mail/install.sh | sudo env FIVEFIFTY_REPO=file:///srv/5050-mail bash"
RC=$?
set -e
echo "install rc=$RC elapsed=$((SECONDS - START))s" | tee "$OUT/timing.txt"
echo "VM left running: ssh -i $OUT/ssh_key $SSH_USER@$IP"
echo "delete with: az group delete -n $RG --yes --no-wait"
echo "OUT=$OUT"
