#!/usr/bin/env bash
# Unit tests for install.sh's relay logic (validation, port-25 and cloud detection) against a
# local fake SMTP server. No Docker, no root, no network needed. Run: tests/install/relay-test.sh
# shellcheck disable=SC2016,SC2329,SC2034
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; pids=()
trap 'kill "${pids[@]}" 2>/dev/null; rm -rf "$tmp"' EXIT
fail=0
ok() { printf 'PASS %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Load only the relay functions out of install.sh.
warn() { echo "WARNING: $*" >&2; }; info() { echo "==> $*"; }; bold() { echo "$*"; }
sed -n '/^# --- relay:begin/,/^# --- relay:end/p' "$here/../../install.sh" >"$tmp/relay.sh"
ASSUME_YES=1
# shellcheck disable=SC1091
source "$tmp/relay.sh"

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/k.pem" -out "$tmp/c.pem" -days 2 -subj /CN=fake.test 2>/dev/null
python3 -I "$here/fake_smtp.py" 24651 implicit "$tmp/c.pem" "$tmp/k.pem" api_token s3cret & pids+=($!)
python3 -I "$here/fake_smtp.py" 25871 starttls "$tmp/c.pem" "$tmp/k.pem" bob hunter2 & pids+=($!)
python3 -I "$here/fake_smtp.py" 25251 plain "$tmp/c.pem" "$tmp/k.pem" bob hunter2 & pids+=($!)
sleep 1

# Validation: implicit TLS (465 path is by port number, so test 465 through the openssl branch directly).
check "starttls login ok" 'relay_validate 127.0.0.1 25871 bob hunter2'
check "starttls bad password rejected" '! relay_validate 127.0.0.1 25871 bob nope'
check "reply shown on failure" '[[ "$R_REPLY" == 535* ]]'
check "closed port reports an error" '! relay_validate 127.0.0.1 1 bob x && [ -n "$R_REPLY" ]'
check "no-auth connect check" 'relay_validate 127.0.0.1 25871 "" ""'
# Implicit TLS (port 465 in real life; any port via RELAY_IMPLICIT_PORT).
export RELAY_IMPLICIT_PORT=24651
check "implicit TLS login ok" 'relay_validate 127.0.0.1 24651 api_token s3cret'
check "implicit TLS bad token rejected" '! relay_validate 127.0.0.1 24651 api_token bad'
unset RELAY_IMPLICIT_PORT

# curl fallback (hide openssl).
if command -v curl >/dev/null; then
  echo insecure >"$tmp/.curlrc"; export CURL_HOME="$tmp"
  openssl() { return 127; }; command() { if [ "${2:-}" = openssl ]; then return 1; fi; builtin command "$@"; }
  check "curl fallback ok" 'relay_validate 127.0.0.1 25871 bob hunter2'
  check "curl fallback rejects" '! relay_validate 127.0.0.1 25871 bob wrong && [[ "$R_REPLY" == *535* ]]'
  unset -f openssl command
fi

# Port 25 detection against a local banner server and a closed port.
P25_PORT=25251 P25_HOSTS="127.0.0.1" detect_port25; check "port25 open detected" '[ "$P25_STATE" = open ]'
P25_PORT=1 P25_HOSTS="127.0.0.1" P25_NET_HOST=127.0.0.1 P25_NET_PORT=25871 detect_port25; check "port25 closed with network = blocked" '[ "$P25_STATE" = blocked ]'
P25_PORT=1 P25_HOSTS="nonexistent.invalid" detect_port25; check "no DNS = nonet, not blocked" '[ "$P25_STATE" = nonet ]'

# Cloud detection from fake DMI data.
mkdir "$tmp/dmi"; DMI_DIR="$tmp/dmi" CLOUD_MD_HOST=127.0.0.1
for pair in "Amazon EC2:aws" "Google Compute Engine:gcp" "DigitalOcean:digitalocean" "Hetzner:hetzner" "Vultr:vultr"; do
  echo "${pair%%:*}" >"$tmp/dmi/sys_vendor"; detect_cloud; check "cloud ${pair#*:}" "[ \"\$CLOUD\" = ${pair#*:} ]"
done
echo "Microsoft Corporation" >"$tmp/dmi/sys_vendor"; echo 7783-7084-3265-9085-8269-3286-77 >"$tmp/dmi/chassis_asset_tag"
detect_cloud; check "cloud azure" '[ "$CLOUD" = azure ]'
check "explain mentions a way out" 'cloud_explain | grep -qi relay'

# Presets
for p in cloudflare resend ses postmark mailgun brevo smtp2go; do relay_preset "$p"; check "preset $p" '[ -n "$R_HOST" ] && [ -n "$R_PORT" ] && [ -n "$R_SPF" ]'; done
RELAY_REGION=eu-west-1 relay_preset ses; check "ses region host" '[ "$R_HOST" = email-smtp.eu-west-1.amazonaws.com ]'

exit "$fail"
