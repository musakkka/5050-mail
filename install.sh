#!/usr/bin/env bash
# 5050 Mail installer: webmail + admin console, 5050 Send and a Stalwart mail
# server on one Linux VM, with automatic HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash
#   sudo ./install.sh --domain example.com --admin-email you@example.com --yes
#
# Re-running is safe: existing secrets in <dir>/.env are kept and the stack is
# reconciled. See ./install.sh --help.
set -euo pipefail

# Everything runs inside main(), so bash has read the whole script before anything
# executes (safe with `curl | bash`: commands that read stdin can't eat the script).
main() {

REPO_URL="${FIVEFIFTY_REPO:-https://github.com/musakkka/5050-mail.git}"
REPO_REF="${FIVEFIFTY_REF:-main}"
DIR="${FIVEFIFTY_DIR:-/opt/5050-mail}"
SRC="${FIVEFIFTY_SRC:-}"
MODE=install
ASSUME_YES="${ASSUME_YES:-0}"
PURGE=0
SKIP_PORT25=0
TLS="${TLS_MODE:-}"
ARG_DOMAIN="${MAIL_DOMAIN:-}"
ARG_ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ARG_ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ARG_CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ARG_RELAY_HOST="${RELAY_HOST:-}" ARG_RELAY_PORT="${RELAY_PORT:-}" ARG_RELAY_USER="${RELAY_USERNAME:-}" ARG_RELAY_PASS="${RELAY_PASSWORD:-}"
ARG_RELAY_PRESET="${RELAY_PRESET:-}" RELAY_REGION="${RELAY_REGION:-}" RELAY_FLAG=0 RELAY_TEST=0 RELAY_CONFIGURED=0
ARG_SEND_TRANSPORT="${SEND_TRANSPORT:-}"
ARG_MAIL_HOST="" ARG_SEND_HOST="" ARG_API_HOST=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain DOMAIN            primary mail domain (example.com)
  --admin-email EMAIL        first admin mailbox (default admin@DOMAIN)
  --admin-password PASS      its password (default: generated and printed once)
  --mail-host HOST           webmail + SMTP/IMAP hostname (default mail.DOMAIN)
  --send-host HOST           5050 Send dashboard (default send.DOMAIN)
  --api-host HOST            5050 Send API (default api.DOMAIN)
  --tls acme|internal        acme: Let's Encrypt (default); internal: self-signed, for test domains
  --cloudflare-token TOKEN   optional: create DNS records + DNS-01 certificates via Cloudflare
  --relay [PRESET]           outbound relay for when port 25 is blocked. PRESET is one of
                             cloudflare resend ses postmark mailgun brevo smtp2go; without it a menu is shown.
                             On an existing install this only reconfigures the relay and flushes the queue.
  --relay-host HOST --relay-port PORT --relay-user USER --relay-password PASS
                             a custom relay (or overrides for a preset); the login is tested before saving
  --relay-region REGION      Amazon SES region (default us-east-1)
  --relay-test               test the saved relay login (SMTP connect + AUTH, nothing is sent) and exit
  --send-transport smtp|log  5050 Send delivery (default smtp = via the mail server; log = drop)
  --dir DIR                  install directory (default /opt/5050-mail)
  --source DIR               install from a local checkout instead of GitHub
  --yes                      non-interactive; never prompt
  --skip-port25-check        don't probe outbound port 25
  --upgrade                  update the source, rebuild and restart
  --uninstall [--purge]      stop and remove containers (--purge also deletes all mail and data)
  -h, --help
Environment equivalents: MAIL_DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, TLS_MODE, CLOUDFLARE_API_TOKEN,
RELAY_HOST/RELAY_PORT/RELAY_USERNAME/RELAY_PASSWORD/RELAY_PRESET/RELAY_REGION,
RELAY_SKIP_VALIDATE=1, SEND_TRANSPORT, FIVEFIFTY_DIR, FIVEFIFTY_SRC, ASSUME_YES=1.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) ARG_DOMAIN="$2"; shift ;;
    --admin-email) ARG_ADMIN_EMAIL="$2"; shift ;;
    --admin-password) ARG_ADMIN_PASSWORD="$2"; shift ;;
    --mail-host) ARG_MAIL_HOST="$2"; shift ;;
    --send-host) ARG_SEND_HOST="$2"; shift ;;
    --api-host) ARG_API_HOST="$2"; shift ;;
    --tls) TLS="$2"; shift ;;
    --cloudflare-token) ARG_CF_TOKEN="$2"; shift ;;
    --relay) RELAY_FLAG=1; if [ $# -gt 1 ] && [[ "$2" != -* ]]; then ARG_RELAY_PRESET="$2"; shift; fi ;;
    --relay-region) RELAY_REGION="$2"; shift ;;
    --relay-test) RELAY_TEST=1 ;;
    --relay-host) ARG_RELAY_HOST="$2"; shift ;;
    --relay-port) ARG_RELAY_PORT="$2"; shift ;;
    --relay-user) ARG_RELAY_USER="$2"; shift ;;
    --relay-password) ARG_RELAY_PASS="$2"; shift ;;
    --send-transport) ARG_SEND_TRANSPORT="$2"; shift ;;
    --dir) DIR="$2"; shift ;;
    --source) SRC="$2"; shift ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-port25-check) SKIP_PORT25=1 ;;
    --upgrade) MODE=upgrade ;;
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- helpers
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
# Prompts read from the terminal even when the script itself comes from a pipe.
ask() { # ask VAR "Question" default
  local __v="$1" q="$2" d="${3:-}" a=""
  if [ "$ASSUME_YES" = 1 ] || ! { : </dev/tty; } 2>/dev/null; then printf -v "$__v" '%s' "$d"; return; fi
  read -r -p "$q${d:+ [$d]}: " a </dev/tty || true
  printf -v "$__v" '%s' "${a:-$d}"
}
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  { : </dev/tty; } 2>/dev/null || die "$1 Re-run with --yes to confirm non-interactively."
  local a; read -r -p "$1 [y/N] " a </dev/tty || true
  [[ "$a" =~ ^[Yy] ]]
}
rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "${1:-40}"; }
need_root() { [ "$(id -u)" = 0 ] || die "Run as root (sudo bash install.sh ...)."; }
valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]; }

compose() { docker compose --project-directory "$DIR/deploy" --env-file "$DIR/.env" -f "$DIR/deploy/docker-compose.yml" "$@"; }

env_get() { [ -f "$DIR/.env" ] && grep -E "^$1=" "$DIR/.env" | tail -1 | cut -d= -f2- || true; }
# Set KEY=VALUE in .env (keeps every other line; values are written verbatim).
env_set() {
  local k="$1" v="$2" tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")"
  { grep -v -E "^$k=" "$DIR/.env" 2>/dev/null || true; printf '%s=%s\n' "$k" "$v"; } >"$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$DIR/.env"
}
env_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }

wait_healthy() { # wait_healthy service [timeout_s]
  local svc="$1" t="${2:-300}" i=0 id st
  while [ "$i" -lt "$t" ]; do
    id="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [ "$st" = healthy ] && return 0
    fi
    sleep 3; i=$((i + 3))
  done
  compose logs --tail 50 "$svc" >&2 || true
  die "$svc did not become healthy within ${t}s"
}

# ---------------------------------------------------------------- outbound relay
# Everything between the relay:begin/end markers is unit-tested by tests/install/relay-test.sh.
# --- relay:begin
RELAY_PRESETS="cloudflare resend ses postmark mailgun brevo smtp2go custom"
R_PRESET="" R_HOST="" R_PORT="" R_USER="" R_PASS="" R_SPF="" R_LABEL="" R_USER_FIXED="" R_USER_LABEL="" R_PASS_LABEL="" R_REPLY="" R_CF_TOKEN=""
CLOUD="" P25_STATE=""

have_tty() { [ "$ASSUME_YES" != 1 ] && { : </dev/tty; } 2>/dev/null; }
# Run a command with a time limit when timeout(1) exists (it does on every supported Linux).
tmo() {
  local t="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$t" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$t" "$@"
  else "$@"; fi
}
ask_secret() { # ask_secret VAR "Prompt"
  local __v="$1" a=""
  have_tty || { printf -v "$__v" '%s' ""; return; }
  read -r -s -p "$2: " a </dev/tty || true
  echo >/dev/tty
  printf -v "$__v" '%s' "$a"
}

# First 3 bytes the server at host:port sends (empty on refused, filtered or silent).
# shellcheck disable=SC2016  # $0/$1 belong to the inner bash
tcp_banner() { tmo "${3:-6}" bash -c 'exec 3<>"/dev/tcp/$0/$1" && head -c 3 <&3' "$1" "$2" 2>/dev/null || true; }

# Sets P25_STATE to open, blocked or nonet (no usable network or DNS, so the result says nothing about port 25).
detect_port25() {
  local -a hosts
  local h resolved=0 port="${P25_PORT:-25}"
  read -r -a hosts <<<"${P25_HOSTS:-gmail-smtp-in.l.google.com outlook-com.olc.protection.outlook.com mta5.am0.yahoodns.net}"
  for h in "${hosts[@]}"; do
    if [ "$(tcp_banner "$h" "$port" 6)" = 220 ]; then P25_STATE=open; return 0; fi
    if getent hosts "$h" >/dev/null 2>&1 || [[ "$h" =~ ^[0-9.]+$ ]]; then resolved=1; fi
  done
  # Nothing answered. Blocked only if the network itself works (HTTPS to a well-known host).
  # shellcheck disable=SC2016
  if [ "$resolved" = 1 ] && tmo 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "${P25_NET_HOST:-1.1.1.1}" "${P25_NET_PORT:-443}" 2>/dev/null; then P25_STATE=blocked
  else P25_STATE=nonet; fi
}

dmi_text() {
  local d="${DMI_DIR:-/sys/class/dmi/id}" f
  for f in sys_vendor product_name board_vendor chassis_asset_tag bios_vendor; do
    [ -r "$d/$f" ] && tr '[:upper:]' '[:lower:]' <"$d/$f" || true
  done 2>/dev/null
}
# Sets CLOUD to azure, aws, gcp, digitalocean, hetzner, vultr, ovh, oracle, linode, contabo or empty.
detect_cloud() {
  local d md="${CLOUD_MD_HOST:-169.254.169.254}" t=""
  CLOUD=""
  d="$(dmi_text)"
  case "$d" in
    *7783-7084-3265-9085-8269-3286-77*) CLOUD=azure ;;
    *amazon*) CLOUD=aws ;;
    *google*) CLOUD=gcp ;;
    *digitalocean*) CLOUD=digitalocean ;;
    *hetzner*) CLOUD=hetzner ;;
    *vultr*) CLOUD=vultr ;;
    *ovh*) CLOUD=ovh ;;
    *oraclecloud*) CLOUD=oracle ;;
    *linode*|*akamai*) CLOUD=linode ;;
    *contabo*) CLOUD=contabo ;;
  esac
  [ -n "$CLOUD" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  if curl -fsS -m 1 -H 'Metadata:true' "http://$md/metadata/instance?api-version=2021-02-01" 2>/dev/null | grep -q azEnvironment; then CLOUD=azure
  elif curl -fsS -m 1 -H 'Metadata-Flavor: Google' "http://$md/computeMetadata/v1/instance/id" >/dev/null 2>&1; then CLOUD=gcp
  elif t="$(curl -fsS -m 1 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "http://$md/latest/api/token" 2>/dev/null)" && [ -n "$t" ] \
    && curl -fsS -m 1 -H "X-aws-ec2-metadata-token: $t" "http://$md/latest/meta-data/instance-id" 2>/dev/null | grep -q '^i-'; then CLOUD=aws
  elif curl -fsS -m 1 "http://$md/hetzner/v1/metadata" >/dev/null 2>&1; then CLOUD=hetzner
  elif curl -fsS -m 1 "http://$md/metadata/v1/id" 2>/dev/null | grep -q '^[0-9]'; then CLOUD=digitalocean
  fi
}
cloud_explain() {
  case "$CLOUD" in
    azure) echo "Azure blocks outbound port 25 on most subscriptions (only Enterprise Agreement / MCA-E are exempt) and offers no unblock for the rest: use a relay." ;;
    aws) echo "AWS EC2 throttles outbound port 25 by default. You can request removal (needs reverse DNS): https://aws.amazon.com/forms/ec2-email-limit-rdns-request  Or use a relay (Amazon SES)." ;;
    gcp) echo "Google Cloud permanently blocks outbound port 25 (no exceptions): use a relay. https://cloud.google.com/compute/docs/tutorials/sending-mail" ;;
    digitalocean) echo "DigitalOcean blocks port 25 on new accounts; support can lift it once the account has billing history (open a ticket), or use a relay." ;;
    hetzner) echo "Hetzner Cloud blocks ports 25 and 465 by default; after your first paid invoice you can request unblocking (Cloud console > Limits), or use a relay." ;;
    vultr) echo "Vultr blocks port 25 on new accounts; open a support ticket to request unblocking, or use a relay." ;;
    ovh) echo "OVH normally allows port 25: check any firewall in front of the server, then ask OVH support, or use a relay." ;;
    contabo) echo "Contabo may block port 25 on new VPS; request unblocking from support, or use a relay." ;;
    oracle) echo "Oracle Cloud blocks outbound port 25 for most tenancies: use a relay." ;;
    linode) echo "Linode (Akamai) blocks port 25 on new accounts until you ask support, or use a relay." ;;
    *) echo "Your hosting provider (or a firewall) blocks outbound port 25. Ask them to unblock it, or use a relay." ;;
  esac
}

# relay_preset NAME: sets R_LABEL R_HOST R_PORT R_USER_FIXED R_USER_LABEL R_PASS_LABEL R_SPF.
relay_preset() {
  R_SPF="" R_USER_FIXED="" R_USER_LABEL="SMTP username" R_PASS_LABEL="SMTP password"
  case "$1" in
    cloudflare) R_LABEL="Cloudflare Email Service"; R_HOST=smtp.mx.cloudflare.net; R_PORT=465; R_USER_FIXED=api_token
      R_PASS_LABEL="Cloudflare API token (Email Sending: Edit; add Zone > DNS: Edit for automatic records)"; R_SPF=_spf.mx.cloudflare.net ;;
    resend) R_LABEL="Resend"; R_HOST=smtp.resend.com; R_PORT=465; R_USER_FIXED=resend; R_PASS_LABEL="Resend API key"; R_SPF=amazonses.com ;;
    ses) R_LABEL="Amazon SES (${RELAY_REGION:-us-east-1})"; R_HOST="email-smtp.${RELAY_REGION:-us-east-1}.amazonaws.com"; R_PORT=587
      R_USER_LABEL="SES SMTP username"; R_PASS_LABEL="SES SMTP password"; R_SPF=amazonses.com ;;
    postmark) R_LABEL="Postmark"; R_HOST=smtp.postmarkapp.com; R_PORT=587; R_USER_LABEL="Postmark Server API token"; R_PASS_LABEL="Postmark Server API token (again)"; R_SPF=spf.mtasv.net ;;
    mailgun) R_LABEL="Mailgun"; R_HOST=smtp.mailgun.org; R_PORT=587; R_USER_LABEL="Mailgun SMTP login (postmaster@your-domain)"; R_SPF=mailgun.org ;;
    brevo) R_LABEL="Brevo"; R_HOST=smtp-relay.brevo.com; R_PORT=587; R_USER_LABEL="Brevo SMTP login"; R_PASS_LABEL="Brevo SMTP key"; R_SPF=spf.brevo.com ;;
    smtp2go) R_LABEL="SMTP2GO"; R_HOST=mail.smtp2go.com; R_PORT=2525; R_USER_LABEL="SMTP2GO username"; R_SPF=spf.smtp2go.com ;;
    custom) R_LABEL="custom relay"; R_SPF="" ;;
    *) return 1 ;;
  esac
}

# relay_validate HOST PORT USER PASS: real SMTP connection + AUTH, no message sent.
# Returns 0 when the server accepted the login; R_REPLY holds the server's refusal or the error.
relay_validate() {
  local host="$1" port="$2" user="$3" pass="$4" out="" b64 scheme
  local -a args
  R_REPLY=""
  [ "${RELAY_SKIP_VALIDATE:-0}" = 1 ] && return 0
  if command -v openssl >/dev/null 2>&1; then
    if [ "$port" = 465 ] || [ "$port" = "${RELAY_IMPLICIT_PORT:-465}" ]; then args=(-connect "$host:$port"); else args=(-starttls smtp -connect "$host:$port"); fi
    b64="$(printf '\0%s\0%s' "$user" "$pass" | base64 | tr -d '\n')"
    out="$({ sleep 1; printf 'EHLO 5050-mail.local\r\n'; sleep 1
      if [ -n "$user" ]; then printf 'AUTH PLAIN %s\r\n' "$b64"; sleep 2; fi
      printf 'QUIT\r\n'; sleep 1; } | tmo 40 openssl s_client "${args[@]}" -servername "$host" -quiet 2>&1 | tr -d '\r' || true)"
    if [ -n "$user" ]; then grep -q '^235' <<<"$out" && return 0; else grep -q '^250' <<<"$out" && return 0; fi
    R_REPLY="$(grep -E '^[45][0-9][0-9]([ -]|$)' <<<"$out" | tail -n 1 || true)"
  elif command -v curl >/dev/null 2>&1; then
    scheme=smtp; [ "$port" = 465 ] && scheme=smtps
    args=(-sS -v --max-time 30 --ssl-reqd)
    [ -n "$user" ] && args+=(--user "$user:$pass")
    if out="$(curl "${args[@]}" -X NOOP "$scheme://$host:$port" </dev/null 2>&1)"; then return 0; fi
    out="$(tr -d '\r' <<<"$out")"
    R_REPLY="$(grep -E '^< [45][0-9][0-9]' <<<"$out" | tail -n 1 | sed 's/^< //' || true)"
  else
    warn "Neither openssl nor curl found: cannot test the relay login; saving it unverified."
    return 0
  fi
  [ -n "$R_REPLY" ] || R_REPLY="$(grep -iE 'errno|refused|timed out|timeout|unable|could not|failed' <<<"$out" | head -n 1 || true)"
  [ -n "$R_REPLY" ] || R_REPLY="no SMTP response from $host:$port (is the port reachable from this server?)"
  return 1
}

relay_menu() { # sets R_PRESET; returns 1 for "skip"
  local c
  echo
  bold "Outbound mail relay"
  cat <<'M'
  1) Cloudflare Email Service  (API token with Email Sending: Edit; sets up the domain for you)
  2) Resend                    (smtp.resend.com, API key)
  3) Amazon SES                (pick a region)
  4) Postmark
  5) Mailgun
  6) Brevo
  7) SMTP2GO
  8) Custom SMTP server
  9) Skip (outgoing mail will queue until port 25 works)
M
  while :; do
    read -r -p "Choose [1-9]: " c </dev/tty || return 1
    case "$c" in
      1) R_PRESET=cloudflare ;; 2) R_PRESET=resend ;; 3) R_PRESET=ses ;; 4) R_PRESET=postmark ;;
      5) R_PRESET=mailgun ;; 6) R_PRESET=brevo ;; 7) R_PRESET=smtp2go ;; 8) R_PRESET=custom ;;
      9|"") return 1 ;;
      *) echo "Enter a number from 1 to 9."; continue ;;
    esac
    return 0
  done
}

# relay_setup: choose (menu or flags), collect credentials, validate. Returns 0 configured, 1 skipped.
relay_setup() {
  local interactive=0 c
  have_tty && interactive=1
  R_PRESET="${ARG_RELAY_PRESET:-}"
  [ -z "$R_PRESET" ] && [ -n "$ARG_RELAY_HOST" ] && R_PRESET=custom
  while :; do
    if [ -z "$R_PRESET" ]; then
      [ "$interactive" = 1 ] || return 1
      relay_menu || return 1
    fi
    if [ "$R_PRESET" = ses ] && [ -z "${RELAY_REGION:-}" ] && [ "$interactive" = 1 ]; then ask RELAY_REGION "AWS region of your SES account" "us-east-1"; fi
    relay_preset "$R_PRESET" || die "Unknown relay '$R_PRESET' (use: $RELAY_PRESETS)"
    R_USER="${ARG_RELAY_USER:-$R_USER_FIXED}" R_PASS="${ARG_RELAY_PASS:-}"
    if [ "$R_PRESET" = custom ]; then
      R_HOST="${ARG_RELAY_HOST:-}" R_PORT="${ARG_RELAY_PORT:-}"
      [ -n "$R_HOST" ] || ask R_HOST "Relay host (e.g. smtp.example.com)" ""
      [ -n "$R_PORT" ] || ask R_PORT "Relay port" "587"
      [ -n "$R_HOST" ] || die "No relay host given."
      [ -n "$R_USER" ] || ask R_USER "SMTP username (empty for none)" ""
    else
      [ -n "$ARG_RELAY_HOST" ] && R_HOST="$ARG_RELAY_HOST"
      [ -n "$ARG_RELAY_PORT" ] && R_PORT="$ARG_RELAY_PORT"
      [ -z "$R_USER" ] && [ "$interactive" = 1 ] && ask R_USER "$R_USER_LABEL" ""
    fi
    [ "$R_PRESET" = cloudflare ] && [ -z "$R_PASS" ] && R_PASS="${ARG_CF_TOKEN:-$(env_get CLOUDFLARE_API_TOKEN)}"
    if [ -z "$R_PASS" ] && { [ -n "$R_USER" ] || [ "$R_PRESET" != custom ]; }; then
      if [ "$interactive" = 1 ]; then ask_secret R_PASS "$R_PASS_LABEL"; fi
    fi
    [ "$R_PRESET" = postmark ] && [ -z "$R_USER" ] && R_USER="$R_PASS"
    [[ "$R_PORT" =~ ^[0-9]+$ ]] || die "Relay port '$R_PORT' is not a number."
    if [ "$R_PRESET" != custom ] || [ -n "$R_USER" ]; then
      if [ -z "$R_USER" ] || [ -z "$R_PASS" ]; then
        [ "$interactive" = 1 ] || die "Relay '$R_PRESET' needs credentials: --relay-user/--relay-password (or RELAY_USERNAME/RELAY_PASSWORD)."
        warn "Both a username and a password/key are required."
        ARG_RELAY_USER="" ARG_RELAY_PASS=""; continue
      fi
    fi
    [ "$R_PRESET" = cloudflare ] && R_CF_TOKEN="$R_PASS"
    info "Testing the login at $R_HOST:$R_PORT (no mail is sent)"
    if relay_validate "$R_HOST" "$R_PORT" "$R_USER" "$R_PASS"; then
      info "Relay accepted the login: ${R_LABEL:-$R_HOST}"
      return 0
    fi
    warn "The relay did not accept the login. Server said: $R_REPLY"
    [ "$interactive" = 1 ] || die "Fix the relay settings, or set RELAY_SKIP_VALIDATE=1 to save them anyway."
    read -r -p "[r]etry credentials, [c]hoose another relay, save [a]nyway, [s]kip? [r] " c </dev/tty || c=s
    ARG_RELAY_USER="" ARG_RELAY_PASS="" ARG_RELAY_HOST="$R_HOST" ARG_RELAY_PORT="$R_PORT"
    case "$c" in
      c|C) R_PRESET="" ARG_RELAY_HOST="" ARG_RELAY_PORT="" ;;
      a|A) return 0 ;;
      s|S) return 1 ;;
    esac
  done
}

relay_save() {
  env_set RELAY_HOST "$R_HOST"
  env_set RELAY_PORT "$R_PORT"
  env_set RELAY_USERNAME "$R_USER"
  env_set RELAY_PASSWORD "$R_PASS"
  env_set RELAY_PRESET "$R_PRESET"
  env_set RELAY_SPF_INCLUDE "$R_SPF"
  if [ "$R_PRESET" = cloudflare ]; then env_set CLOUDFLARE_EMAIL_SENDING 1; fi
}

# relay_tool SUBCOMMAND [VAR=value ...]: server/relay.mjs inside the bootstrap container.
relay_tool() {
  local sub="$1"; shift
  env "$@" docker compose --project-directory "$DIR/deploy" --env-file "$DIR/.env" -f "$DIR/deploy/docker-compose.yml" \
    --profile tools run --rm -T --entrypoint node bootstrap /relay.mjs "$sub" </dev/null
}
spf_hint() {
  [ -n "$R_SPF" ] || return 0
  echo "  SPF: add include:$R_SPF to the SPF record of $DOMAIN (keep a single SPF record), e.g."
  echo "       $DOMAIN  TXT  \"v=spf1 mx include:$R_SPF ~all\""
}
# After Stalwart is up and the DNS records exist: Cloudflare onboarding and the SPF include.
relay_post() {
  local cft; cft="$(env_get CLOUDFLARE_API_TOKEN)"
  if [ "$R_PRESET" = cloudflare ]; then
    relay_tool cf-onboard CLOUDFLARE_API_TOKEN="$R_CF_TOKEN" || warn "Could not set up $DOMAIN in Cloudflare Email Service automatically (the token needs Email Sending: Edit and Zone > DNS: Edit). Add the sending domain in the Cloudflare dashboard: Email > Email Sending."
    cft="${cft:-$R_CF_TOKEN}"
  fi
  [ -n "$R_SPF" ] || return 0
  if [ -n "$cft" ] && relay_tool spf CLOUDFLARE_API_TOKEN="$cft" RELAY_SPF_INCLUDE="$R_SPF"; then :; else spf_hint; fi
}
relay_retry() {
  info "Retrying the queued mail"
  relay_tool retry || warn "Stalwart's queue API did not accept the retry. Stalwart was restarted with the relay; queued mail is retried on its normal schedule (within the hour). See: docker compose ... logs stalwart"
}
# Configure Stalwart on an existing install and flush the queue.
relay_apply() {
  info "Applying the relay to Stalwart"
  compose --profile tools run --rm -T bootstrap </dev/null
  compose restart stalwart >/dev/null
  wait_healthy stalwart 300
  relay_retry
  relay_post
}
# --- relay:end

# ---------------------------------------------------------------- uninstall
if [ "$MODE" = uninstall ]; then
  need_root
  [ -f "$DIR/deploy/docker-compose.yml" ] || die "No installation found in $DIR"
  if [ "$PURGE" = 1 ]; then
    confirm "Remove 5050 Mail AND DELETE ALL MAIL, accounts and data in $DIR?" || exit 1
    compose --profile tools down -v --remove-orphans
    # Volumes orphaned by an earlier plain --uninstall.
    docker volume ls -q --filter label=com.docker.compose.project=5050-mail | xargs -r docker volume rm >/dev/null 2>&1 || true
    rm -rf "$DIR"
    info "Removed containers, volumes and $DIR."
  else
    confirm "Stop and remove the 5050 Mail containers (data volumes are kept)?" || exit 1
    compose --profile tools down --remove-orphans
    info "Containers removed. Data volumes and $DIR/.env are kept; run with --uninstall --purge to delete everything."
  fi
  exit 0
fi

need_root

if [ -n "$ARG_RELAY_PRESET" ]; then
  case " $RELAY_PRESETS " in *" $ARG_RELAY_PRESET "*) ;; *) die "Unknown relay '$ARG_RELAY_PRESET' (use: $RELAY_PRESETS)" ;; esac
  RELAY_FLAG=1
fi
INSTALLED=0
[ -n "$(env_get BOOTSTRAPPED)" ] && INSTALLED=1

if [ "$RELAY_TEST" = 1 ]; then
  [ -n "$(env_get RELAY_HOST)" ] || [ -n "$ARG_RELAY_HOST" ] || die "No relay is configured in $DIR/.env."
  R_HOST="${ARG_RELAY_HOST:-$(env_get RELAY_HOST)}" R_PORT="${ARG_RELAY_PORT:-$(env_get RELAY_PORT)}"
  R_USER="${ARG_RELAY_USER:-$(env_get RELAY_USERNAME)}" R_PASS="${ARG_RELAY_PASS:-$(env_get RELAY_PASSWORD)}"
  info "Testing the login at $R_HOST:${R_PORT:-587} (no mail is sent)"
  if relay_validate "$R_HOST" "${R_PORT:-587}" "$R_USER" "$R_PASS"; then info "Relay accepted the login."; exit 0; fi
  die "Relay refused: $R_REPLY"
fi

# Existing install: only (re)configure the relay, re-run the bootstrap and restart Stalwart.
if [ "$RELAY_FLAG" = 1 ] && [ "$INSTALLED" = 1 ] && [ "$MODE" = install ]; then
  [ -f "$DIR/server/relay.mjs" ] || die "This installation predates relay support: run $DIR/install.sh --upgrade first."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
  DOMAIN="$(env_get MAIL_DOMAIN)"
  relay_setup || { info "No relay configured; nothing changed."; exit 0; }
  relay_save
  relay_apply
  echo
  bold "Outbound relay: ${R_LABEL:-$R_HOST} ($R_HOST:$R_PORT)"
  echo "  Test again: sudo $DIR/install.sh --relay-test"
  exit 0
fi

# ---------------------------------------------------------------- Docker
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker (get.docker.com)"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null; } || die "curl is required"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose). Install the docker-compose-plugin package."
docker info >/dev/null 2>&1 || die "The Docker daemon is not running."

# ---------------------------------------------------------------- source
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
# Running from a checkout other than the install dir: install from it. Running the installed
# copy (/opt/5050-mail/install.sh --upgrade) updates from git instead.
if [ -z "$SRC" ] && [ -n "$here" ] && [ -f "$here/deploy/docker-compose.yml" ] && [ "$here" != "$(cd "$DIR" 2>/dev/null && pwd || echo "$DIR")" ]; then SRC="$here"; fi

sync_source() {
  mkdir -p "$DIR"
  if [ -n "$SRC" ]; then
    SRC="$(cd "$SRC" && pwd)"
    if [ "$SRC" != "$DIR" ]; then
      info "Copying source from $SRC to $DIR"
      tar -C "$SRC" --exclude=./.env --exclude='./.git' --exclude='*/node_modules' --exclude='*/dist' -cf - . | tar -C "$DIR" -xf -
    fi
  elif [ -d "$DIR/.git" ]; then
    info "Updating $DIR from $REPO_URL ($REPO_REF)"
    git -C "$DIR" fetch -q origin "$REPO_REF" && git -C "$DIR" checkout -q "$REPO_REF" && git -C "$DIR" reset -q --hard "origin/$REPO_REF"
  elif [ ! -f "$DIR/deploy/docker-compose.yml" ]; then
    command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git >/dev/null; } || die "git is required"
    info "Cloning $REPO_URL into $DIR"
    tmp="$(mktemp -d)"; git clone -q --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp/src"
    cp -a "$tmp/src/." "$DIR/"; rm -rf "$tmp"
  fi
  [ -f "$DIR/deploy/docker-compose.yml" ] || die "$DIR doesn't contain deploy/docker-compose.yml"
}
sync_source
touch "$DIR/.env"; chmod 600 "$DIR/.env"

# ---------------------------------------------------------------- settings
DOMAIN="${ARG_DOMAIN:-$(env_get MAIL_DOMAIN)}"
if [ -z "$DOMAIN" ]; then
  [ "$MODE" = upgrade ] && die "No MAIL_DOMAIN in $DIR/.env; install first."
  ask DOMAIN "Primary mail domain (e.g. example.com)" ""
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
valid_domain "$DOMAIN" || die "'$DOMAIN' is not a valid domain (pass --domain example.com)"

ADMIN_EMAIL_V="${ARG_ADMIN_EMAIL:-$(env_get ADMIN_EMAIL)}"
[ -n "$ADMIN_EMAIL_V" ] || ask ADMIN_EMAIL_V "Admin mailbox to create" "admin@$DOMAIN"
ADMIN_EMAIL_V="$(printf '%s' "$ADMIN_EMAIL_V" | tr '[:upper:]' '[:lower:]')"
[[ "$ADMIN_EMAIL_V" =~ ^[a-z0-9._+-]+@[a-z0-9.-]+$ ]] || die "Invalid admin email '$ADMIN_EMAIL_V'"

MAIL_HOST="${ARG_MAIL_HOST:-$(env_get MAIL_HOSTNAME)}"; MAIL_HOST="${MAIL_HOST:-mail.$DOMAIN}"
SEND_HOST="${ARG_SEND_HOST:-$(env_get SEND_HOST)}"; SEND_HOST="${SEND_HOST:-send.$DOMAIN}"
API_HOST="${ARG_API_HOST:-$(env_get API_HOST)}"; API_HOST="${API_HOST:-api.$DOMAIN}"

TLS="${TLS:-$(env_get TLS_MODE)}"; TLS="${TLS:-acme}"
case "$TLS" in acme|internal) ;; manual) TLS=internal ;; *) die "--tls must be acme or internal" ;; esac

env_set MAIL_DOMAIN "$DOMAIN"
env_set MAIL_HOSTNAME "$MAIL_HOST"
env_set SEND_HOST "$SEND_HOST"
env_set API_HOST "$API_HOST"
env_set ADMIN_EMAIL "$ADMIN_EMAIL_V"
env_default ACME_EMAIL "$ADMIN_EMAIL_V"
env_default SUPPORT_EMAIL "postmaster@$DOMAIN"
env_set TLS_MODE "$TLS"
if [ "$TLS" = internal ]; then
  env_set CADDY_GLOBAL_OPTIONS "local_certs"
  env_set CADDY_CERT_ISSUER "local"
  env_set STALWART_TLS_MODE "manual"
else
  env_set CADDY_GLOBAL_OPTIONS ""
  env_set CADDY_CERT_ISSUER "acme-v02.api.letsencrypt.org-directory"
  env_set STALWART_TLS_MODE "acme"
fi

# Secrets: generated once, never overwritten.
env_default POSTGRES_PASSWORD "$(rand 40)"
env_default STALWART_DB_PASSWORD "$(rand 40)"
env_default SEND_DB_PASSWORD "$(rand 40)"
env_default WEBMAIL_DB_PASSWORD "$(rand 40)"
env_default STALWART_ADMIN "recovery:$(rand 32)"
env_default WEBMAIL_SESSION_SECRET "$(rand 64)"
env_default SEND_SESSION_SECRET "$(rand 64)"
env_default STALWART_EVENTS_SECRET "$(rand 64)"
env_default WEB_CONCURRENCY "auto"

[ -n "$ARG_SEND_TRANSPORT" ] && env_set SEND_TRANSPORT "$ARG_SEND_TRANSPORT"
env_default SEND_TRANSPORT "smtp"
[ -n "$ARG_CF_TOKEN" ] && env_set CLOUDFLARE_API_TOKEN "$ARG_CF_TOKEN"

# Public address (DNS records + port 25 advice).
PUBLIC_IPV4="$(env_get PUBLIC_IPV4)"
if [ -z "$PUBLIC_IPV4" ]; then
  PUBLIC_IPV4="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  [[ "$PUBLIC_IPV4" =~ ^[0-9.]+$ ]] && env_set PUBLIC_IPV4 "$PUBLIC_IPV4" || PUBLIC_IPV4=""
fi

# ---------------------------------------------------------------- port 25 / relay
if [ "$RELAY_FLAG" = 1 ] || [ -n "$ARG_RELAY_HOST" ]; then
  if relay_setup; then relay_save; RELAY_CONFIGURED=1; else warn "No relay configured: outgoing mail will queue unless port 25 works."; fi
elif [ "$SKIP_PORT25" = 0 ] && [ -z "$(env_get RELAY_HOST)" ] && [ "$TLS" = acme ]; then
  info "Checking outbound port 25"
  detect_port25
  case "$P25_STATE" in
    open) info "Outbound port 25 is open: mail is delivered directly." ;;
    nonet) warn "Could not test outbound port 25 (no network or DNS from this server). Re-check later with: $DIR/install.sh --relay-test" ;;
    *)
      detect_cloud
      warn "Outbound port 25 is BLOCKED. Mail would queue and never leave this server."
      warn "$(cloud_explain)"
      if [ "$MODE" = install ] && have_tty; then
        echo "Pick an outbound relay now (you can also do this later with: sudo $DIR/install.sh --relay)."
        if relay_setup; then relay_save; RELAY_CONFIGURED=1; else warn "Skipped: mail will queue until port 25 is open or a relay is set up (install.sh --relay)."; fi
      else
        warn "Set up a relay with: install.sh --relay <cloudflare|resend|ses|postmark|mailgun|brevo|smtp2go> --relay-user USER --relay-password PASS"
        warn "or interactively: sudo $DIR/install.sh --relay"
      fi ;;
  esac
fi

# ---------------------------------------------------------------- build + start
cd "$DIR"
info "Building images (first run takes a few minutes)"
compose build --pull webmail send-web
compose --profile tools pull --quiet postgres stalwart caddy bootstrap 2>/dev/null || compose --profile tools pull postgres stalwart caddy bootstrap

info "Starting Postgres and Stalwart"
compose up -d postgres stalwart
wait_healthy postgres 120
wait_healthy stalwart 300

NEW_ADMIN_PASSWORD=""
FIRST_RUN=0
[ -z "$(env_get BOOTSTRAPPED)" ] && FIRST_RUN=1
if [ "$FIRST_RUN" = 1 ]; then
  NEW_ADMIN_PASSWORD="${ARG_ADMIN_PASSWORD:-$(rand 20)}"
  [ "${#NEW_ADMIN_PASSWORD}" -ge 8 ] || die "--admin-password must be at least 8 characters"
fi

info "Configuring Stalwart (domain, TLS, listeners, admin mailbox)"
ADMIN_PASSWORD="$NEW_ADMIN_PASSWORD" compose --profile tools run --rm -T bootstrap </dev/null
# New listeners (submission 587, internal relay for 5050 Send) need a restart.
compose restart stalwart >/dev/null
wait_healthy stalwart 300
[ "$FIRST_RUN" = 1 ] && env_set BOOTSTRAPPED "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

info "Starting webmail, 5050 Send and Caddy"
compose up -d --remove-orphans
wait_healthy webmail 180
wait_healthy send-web 180
compose ps

# ---------------------------------------------------------------- DNS
dns_args=(--print-dns)
[ -n "$(env_get CLOUDFLARE_API_TOKEN)" ] && dns_args+=(--cloudflare)
compose --profile tools run --rm -T bootstrap "${dns_args[@]}" </dev/null || warn "Could not print the DNS records; run: docker compose --env-file $DIR/.env -f $DIR/deploy/docker-compose.yml --profile tools run --rm bootstrap --print-dns"

if [ "$RELAY_CONFIGURED" = 1 ]; then
  relay_post
  relay_retry
fi

# ---------------------------------------------------------------- summary
echo
bold "5050 Mail is running."
echo "  Install dir:  $DIR"
echo "  Settings:     $DIR/.env (mode 0600; keep a backup, it holds every secret)"
echo "  Webmail:      https://$MAIL_HOST"
echo "  Send:         https://$SEND_HOST   (dashboard, sign in with your mailbox)"
echo "  Send API:     https://$API_HOST    (Resend-compatible)"
[ "$RELAY_CONFIGURED" = 1 ] && echo "  Outbound:     via relay ${R_LABEL:-$R_HOST} ($R_HOST:$R_PORT); re-test: sudo $DIR/install.sh --relay-test"
echo "  IMAP/SMTP:    $MAIL_HOST  993 (IMAPS), 465/587 (submission); Send SMTP relay on 2465/2587"
if [ -n "$NEW_ADMIN_PASSWORD" ]; then
  echo
  bold "  Admin mailbox: $ADMIN_EMAIL_V"
  if [ -n "$ARG_ADMIN_PASSWORD" ]; then echo "  Password:      (the one you passed with --admin-password)"
  else bold "  Password:      $NEW_ADMIN_PASSWORD"; echo "  (shown once; change it in the webmail settings)"; fi
fi
[ "$TLS" = internal ] && warn "TLS is self-signed (--tls internal): browsers and mail clients will warn. Use --tls acme for a real domain."
echo
echo "  Upgrade:   sudo $DIR/install.sh --upgrade"
echo "  Uninstall: sudo $DIR/install.sh --uninstall [--purge]"
}

main "$@"
