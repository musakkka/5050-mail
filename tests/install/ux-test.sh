#!/usr/bin/env bash
# Drives install.sh's interactive flow through a pseudo-terminal against a fake Cloudflare API and a
# fake docker. No Docker, root, network or Cloudflare account needed. Run: tests/install/ux-test.sh
# shellcheck disable=SC2016,SC2034,SC2206,SC2329
set -u
ESC=$(printf '\033') CR=$(printf '\r')
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
root="$(mktemp -d)"; pids=(); fail=0; port=18700
trap 'kill "${pids[@]}" 2>/dev/null; [ -n "${KEEP:-}" ] || rm -rf "$root"' EXIT
ok() { printf 'PASS %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }
check() { if eval "$2" >/dev/null; then ok "$1"; else bad "$1"; fi; }

# An "open" port 25: any server that sends a 220 banner.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/k.pem" -out "$root/c.pem" -days 2 -subj /CN=fake.test 2>/dev/null
python3 -I "$here/fake_smtp.py" 25291 plain "$root/c.pem" "$root/k.pem" u p 2>/dev/null & pids+=($!)
python3 -I "$here/fake_smtp.py" 25292 plain "$root/c.pem" "$root/k.pem" u p 2>/dev/null & pids+=($!)  # "internet reachable" for the blocked case
sleep 1

# new_case NAME [SEED_JSON]: a fresh install dir, a fresh fake Cloudflare, variables C (dir) CF (url) OUT (output file)
new_case() {
  C="$root/$1"; mkdir -p "$C/opt/deploy" "$C/opt/server"
  : >"$C/opt/deploy/docker-compose.yml"
  printf 'PUBLIC_IPV4=203.0.113.10\n' >"$C/opt/.env"
  cp "$repo/install.sh" "$C/install.sh"
  port=$((port + 1))
  local seed="${2:-}"
  python3 -I "$here/fake_cloudflare.py" "$port" ${seed:+"$seed"} & CFPID=$!; pids+=($CFPID)
  CF="http://127.0.0.1:$port/client/v4"; STATE="http://127.0.0.1:$port/__state"
  OUT="$C/out.txt"
  sleep 0.4
}
# run_pty [env VAR=val ...] -- steps and args are passed through pty_drive.py
run_pty() {
  env PATH="$here/bin:$PATH" FIVEFIFTY_DIR="$C/opt" FIVEFIFTY_TEST_NOROOT=1 CLOUDFLARE_API_BASE="$CF" \
    RELAY_SKIP_VALIDATE=1 FIVEFIFTY_DNS_RESOLVER="$here/bin/fake-resolver" CLOUD_MD_HOST=127.0.0.1 \
    P25_HOSTS=127.0.0.1 P25_PORT=25291 TERM=xterm LANG=en_US.UTF-8 "$@"
}
drive() { # drive ENV... -- [steps] -- args   (everything before the first -- is env)
  local -a e=() s=()
  while [ "$1" != -- ]; do e+=("$1"); shift; done; shift
  while [ "$1" != -- ]; do s+=(--step "$1"); shift; done; shift
  run_pty ${e[@]+"${e[@]}"} python3 -I "$here/pty_drive.py" "$OUT" --timeout 120 ${s[@]+"${s[@]}"} -- bash "$C/install.sh" "$@"
}
cfs() { python3 -I "$here/cfstate.py" "$STATE" "$1"; }
has() { sed "s/$ESC\[[0-9;]*m//g" "$1" | tr -d '\r' | grep -Eq -- "$2"; }

DOMAIN_STEPS=('Continue\?::y' 'Mail domain::example.com' 'Admin mailbox::')

# 1. Token OK, zone auto-pick, fresh zone: everything is created and nothing is left behind.
new_case happy
drive -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_full' -- --skip-port25-check
rc=$?
check "happy: exits 0" '[ $rc = 0 ]'
check "happy: disclosure says no telemetry" 'has "$OUT" "Nothing is sent to us"'
check "happy: disclosure names .env 0600" 'has "$OUT" "mode 0600"'
check "happy: disclosure explains uninstall" 'has "$OUT" "install.sh --uninstall"'
check "happy: token instructions list the permissions" 'has "$OUT" "Zone +DNS +Edit" && has "$OUT" "Zone +Zone +Read" && has "$OUT" "Account +Email Sending +Edit" && has "$OUT" "dash.cloudflare.com/profile/api-tokens"'
check "happy: zone auto-picked" 'has "$OUT" "Zone example.com holds example.com"'
check "happy: token verified" 'has "$OUT" "Token is valid"'
check "happy: numbered steps" 'has "$OUT" "\[3/7\] Build the images" && has "$OUT" "\[7/7\] DNS records"'
check "happy: colour on a terminal" 'grep -q "$ESC\[" "$OUT"'
check "happy: summary has admin URL" 'has "$OUT" "https://mail.example.com/admin"'
check "happy: summary has Send URLs" 'has "$OUT" "https://send.example.com" && has "$OUT" "https://api.example.com"'
check "happy: one-time password shown with warning" 'has "$OUT" "Password +[a-f0-9]{20}" && has "$OUT" "Shown once"'
check "happy: DNS changed line" 'has "$OUT" "DNS changed.*\+MX.*\+A mail.*\+SPF.*\+DKIM x2.*\+DMARC"'
check "happy: Caddy restarted after the DNS records exist" 'has "$OUT" "Request the HTTPS certificates"'
check "happy: logs location" 'has "$OUT" "install.log"'
check "happy: log file written" '[ -s "$C/opt/install.log" ]'
check "happy: token not printed" '! grep -q tok_full "$OUT" && ! grep -q tok_full "$C/opt/install.log"'
check "happy: .env is 0600 with token and zone" '[ "$(stat -f %Lp "$C/opt/.env" 2>/dev/null || stat -c %a "$C/opt/.env")" = 600 ] && grep -q "^CLOUDFLARE_API_TOKEN=tok_full" "$C/opt/.env" && grep -q "^CLOUDFLARE_ZONE=example.com" "$C/opt/.env"'
check "happy: records are DNS only" 'cfs "any(x[\"type\"]==\"A\" for x in r) and all(x.get(\"proxied\") is False for x in r if x[\"type\"]==\"A\")"'
check "happy: temporary check record removed" '! cfs "any(\"_5050-token-check\" in x[\"name\"] for x in r)"'
check "happy: exactly one SPF and one DMARC" 'cfs "sum(x[\"content\"].startswith(\"v=spf1\") for x in r)==1 and sum(x[\"content\"].startswith(\"v=DMARC1\") for x in r)==1"'
n1=$(cfs 'len(r)')

# 1b. Re-run is idempotent: same flags, nothing new in the zone, secrets kept.
secret_before="$(grep '^POSTGRES_PASSWORD=' "$C/opt/.env")"
first_out="$OUT"; OUT="$C/out-rerun.txt"
drive -- 'Continue\?::y' -- --skip-port25-check
rc=$?
n2=$(cfs 'len(r)')
check "rerun: exits 0" '[ $rc = 0 ]'
check "rerun: no new records" '[ "$n1" = "$n2" ]'
check "rerun: secrets kept" '[ "$(grep ^POSTGRES_PASSWORD= "$C/opt/.env")" = "$secret_before" ]'
check "rerun: password not shown again" '! has "$OUT" "Shown once" && has "$OUT" "unchanged"'
kill $CFPID

# 2. Token without DNS edit: names the permission, then falls back to the manual table and the Check DNS loop.
new_case nodns
drive -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_nodns' 'Enter re-check::s' 'Checking again in 20 seconds::s^' -- --skip-port25-check
rc=$?
check "nodns: exits 0" '[ $rc = 0 ]'
check "nodns: names the missing permission" 'has "$OUT" "Zone > DNS > Edit"'
check "nodns: manual table" 'has "$OUT" "Add these records at your DNS provider" && has "$OUT" "v1-ed25519-20261023._domainkey.example.com"'
check "nodns: Check DNS loop is skippable" 'has "$OUT" "not visible yet" && has "$OUT" "Skipped"'
check "nodns: no Cloudflare token stored" '! grep -q "^CLOUDFLARE_API_TOKEN=" "$C/opt/.env"'
kill $CFPID

# 3. Bad token, then the right one (invalid domain re-asked first); account-owned token path.
new_case badtok
drive -- 'Continue\?::y' 'Mail domain::not a domain' 'not a domain name.*\n?.*Mail domain::example.com' 'Admin mailbox::nope' 'not an email address.*\n?.*Admin mailbox::' 'on Cloudflare\?::y' 'Paste the token::nonsense' 'Paste the token again::tok_account' -- --skip-port25-check
rc=$?
check "badtok: invalid domain is re-asked" 'has "$OUT" "That is not a domain name"'
check "badtok: invalid email is re-asked" 'has "$OUT" "That is not an email address"'
check "badtok: rejected token explained" 'has "$OUT" "Cloudflare rejected the token"'
check "badtok: account token accepted" 'has "$OUT" "Token is valid \(account-owned\)" && [ $rc = 0 ]'
kill $CFPID

# 4. Existing SPF, DMARC and MX: SPF merged, DMARC kept, MX kept when you say no.
cat >"$root/seed.json" <<'JSON'
{"records": [
 {"type": "TXT", "name": "example.com", "content": "v=spf1 include:_spf.google.com ~all"},
 {"type": "TXT", "name": "_dmarc.example.com", "content": "v=DMARC1; p=none"},
 {"type": "MX", "name": "example.com", "content": "mx.old-provider.test", "priority": 10}
]}
JSON
new_case conflict "$root/seed.json"
drive -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_full' 'Replace them\?::n' -- --skip-port25-check
rc=$?
check "conflict: exits 0" '[ $rc = 0 ]'
check "conflict: MX conflict shown with the old record" 'has "$OUT" "already has MX records that would compete" && has "$OUT" "mx.old-provider.test"'
check "conflict: old MX kept after no" 'cfs "[x[\"content\"] for x in r if x[\"type\"]==\"MX\"]==[\"mx.old-provider.test\"]"'
check "conflict: SPF merged, still one record" 'cfs "len([x for x in r if x[\"content\"].startswith(\"v=spf1\")])==1 and all(t in [x for x in r if x[\"content\"].startswith(\"v=spf1\")][0][\"content\"] for t in (\"include:_spf.google.com\",\"a:mail.example.com\",\"~all\"))"'
check "conflict: DMARC kept, no second one" 'cfs "[x[\"content\"] for x in r if x[\"content\"].startswith(\"v=DMARC1\")]==[\"v=DMARC1; p=none\"]"'
check "conflict: summary says what changed" 'has "$OUT" "~SPF"'
kill $CFPID
new_case replace "$root/seed.json"
drive -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_full' 'Replace them\?::y' -- --skip-port25-check
check "replace: old MX replaced after yes" 'cfs "[x[\"content\"] for x in r if x[\"type\"]==\"MX\"]==[\"mail.example.com\"]"'
kill $CFPID

# 5. Port 25 blocked: token without Email Sending is told exactly what to add; with it, the relay is set up for you.
new_case nosend
drive P25_PORT=1 P25_NET_HOST=127.0.0.1 P25_NET_PORT=25292 -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_nosend' 'Enter re-check::s' 'Choose 1-9::9' 'Checking again in 20 seconds::s^' -- 
rc=$?
check "blocked: port 25 reported" 'has "$OUT" "Outbound port 25 is blocked"'
check "blocked: token help marks Email Sending as needed" 'has "$OUT" "needed: outbound port 25 is blocked"'
check "blocked: names Account > Email Sending > Edit" 'has "$OUT" "Account > Email Sending > Edit"'
check "blocked: relay menu offered after skipping" 'has "$OUT" "Outbound mail relay" && [ $rc = 0 ]'
kill $CFPID
new_case relay
drive P25_PORT=1 P25_NET_HOST=127.0.0.1 P25_NET_PORT=25292 -- "${DOMAIN_STEPS[@]}" 'on Cloudflare\?::y' 'Paste the token::tok_full' 'Send through Cloudflare Email Sending::y' -- 
rc=$?
check "relay: exits 0" '[ $rc = 0 ]'
check "relay: Cloudflare Email Sending set up" 'has "$OUT" "Setting up example.com in Cloudflare Email Sending" && cfs "len(subs)==1"'
check "relay: saved to .env" 'grep -q "^RELAY_PRESET=cloudflare" "$C/opt/.env" && grep -q "^RELAY_HOST=smtp.mx.cloudflare.net" "$C/opt/.env"'
check "relay: summary names the relay" 'has "$OUT" "via Cloudflare Email Sending"'
kill $CFPID

# 6. Zone auto-pick for a subdomain, with flags only (no prompts), and no colour with NO_COLOR.
new_case flags
drive NO_COLOR=1 -- -- --domain mail.example.com --admin-email me@example.com --cloudflare-token tok_full --yes --skip-port25-check
rc=$?
check "flags: exits 0 with no prompts" '[ $rc = 0 ] && ! has "$OUT" "Continue\?"'
check "flags: subdomain matched to its zone" 'has "$OUT" "Zone example.com holds mail.example.com"'
check "NO_COLOR: no escape codes at all" '! grep -q "$ESC" "$OUT"'
check "NO_COLOR: still has the steps" 'has "$OUT" "\[7/7\] DNS records"'
kill $CFPID

# 7. Flags with a token missing a permission fail before changing anything.
new_case flagbad
drive -- -- --domain example.com --cloudflare-token tok_nodns --yes --skip-port25-check
rc=$?
check "flags: token missing DNS edit stops the install" '[ $rc != 0 ] && has "$OUT" "Zone > DNS > Edit" && ! grep -q "BOOTSTRAPPED" "$C/opt/.env"'
kill $CFPID

# 8. No terminal at all: no colour, no spinner, defaults only, and a clear message without --yes.
new_case notty
(cd "$C" && env PATH="$here/bin:$PATH" FIVEFIFTY_DIR="$C/opt" FIVEFIFTY_TEST_NOROOT=1 CLOUDFLARE_API_BASE="$CF" RELAY_SKIP_VALIDATE=1 \
  FIVEFIFTY_DNS_RESOLVER="$here/bin/fake-resolver" TERM=xterm "$here/bin/nosession" bash "$C/install.sh" --domain example.com --yes --skip-port25-check </dev/null >"$C/notty.txt" 2>&1)
rc=$?
check "non-TTY: exits 0" '[ $rc = 0 ]'
check "non-TTY: no escape codes or carriage returns" '! grep -q "$ESC" "$C/notty.txt" && ! grep -q "$CR" "$C/notty.txt"'
check "non-TTY: prints the manual records and summary" 'has "$C/notty.txt" "Add these records" && has "$C/notty.txt" "https://mail.example.com/admin"'
(cd "$C" && env PATH="$here/bin:$PATH" FIVEFIFTY_DIR="$C/opt2" FIVEFIFTY_TEST_NOROOT=1 TERM=dumb "$here/bin/nosession" bash "$C/install.sh" --domain example.com </dev/null >"$C/notty2.txt" 2>&1)
rc=$?
check "non-TTY without --yes: says how to continue, changes nothing" '[ $rc != 0 ] && has "$C/notty2.txt" "Re-run with --yes" && [ ! -e "$C/opt2/.env" ]'
check "TERM=dumb: no escape codes" '! grep -q "$ESC" "$C/notty2.txt"'
kill $CFPID

printf '\n%s failed\n' "$fail"
[ "$fail" = 0 ]
