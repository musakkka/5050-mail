#!/usr/bin/env bash
# 5050 Mail installer: webmail + admin console, 5050 Send and a Stalwart mail
# server on one Linux VM, with automatic HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash
#   sudo ./install.sh --domain example.com --admin-email you@example.com --yes
#
# Re-running is safe: existing secrets in <dir>/.env are kept and the stack is
# reconciled. See ./install.sh --help. No telemetry: nothing is sent to the authors.
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
REPLACE_MX="${REPLACE_MX:-0}"
STEP_N=0 STEP_TOTAL=0 LOG=/dev/null
CF_TOKEN="" CF_ON=0 CF_ZONE_ID="" CF_ZONE_NAME="" CF_HAS_SEND=0 CF_NEED_SEND=0 CF_FROM_FLAG=0
DNS_CHANGES=""
[ -n "$ARG_CF_TOKEN" ] && CF_FROM_FLAG=1

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
                             (needs Zone > DNS > Edit and Zone > Zone > Read; Account > Email Sending > Edit for the relay)
  --replace-mx               with a Cloudflare token: replace existing MX records that would compete
                             with this server (default: keep them and say so)
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
  --yes                      non-interactive; never prompt (also skips the confirmation)
  --skip-port25-check        don't probe outbound port 25
  --upgrade                  update the source, rebuild and restart
  --uninstall [--purge]      stop and remove containers (--purge also deletes all mail and data)
  -h, --help
Environment equivalents: MAIL_DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, TLS_MODE, CLOUDFLARE_API_TOKEN,
RELAY_HOST/RELAY_PORT/RELAY_USERNAME/RELAY_PASSWORD/RELAY_PRESET/RELAY_REGION,
RELAY_SKIP_VALIDATE=1, SEND_TRANSPORT, FIVEFIFTY_DIR, FIVEFIFTY_SRC, ASSUME_YES=1, REPLACE_MX=1, NO_COLOR.
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
    --cloudflare-token) ARG_CF_TOKEN="$2"; CF_FROM_FLAG=1; shift ;;
    --replace-mx) REPLACE_MX=1 ;;
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

# ---------------------------------------------------------------- terminal UI
# Colour only on a real terminal, never with NO_COLOR or TERM=dumb. The animation needs a
# terminal but no colour. ASCII fallbacks when the locale is not UTF-8.
UI_UTF8=0 COLOR=0 ANIM=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) UI_UTF8=1 ;; esac
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  ANIM=1
  [ -z "${NO_COLOR:-}" ] && COLOR=1
fi
B="" D="" RED="" GRN="" YLW="" CYN="" RST=""
if [ "$COLOR" = 1 ]; then B=$'\033[1m' D=$'\033[2m' RED=$'\033[31m' GRN=$'\033[32m' YLW=$'\033[33m' CYN=$'\033[36m' RST=$'\033[0m'; fi
if [ "$UI_UTF8" = 1 ]; then
  S_OK="✓" S_ERR="✗" S_DOT="·"
  FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
else
  S_OK="ok" S_ERR="x" S_DOT="-"
  FRAMES=("|" "/" "-" "\\")
fi
JOB_PID=""
ui_cleanup() { [ -n "$JOB_PID" ] && kill "$JOB_PID" 2>/dev/null || true; }
trap ui_cleanup EXIT
trap 'echo; exit 130' INT TERM

say() { printf '%s\n' "$*"; }
bold() { printf '%s%s%s\n' "$B" "$*" "$RST"; }
info() { printf '  %s%s%s %s\n' "$D" "$S_DOT" "$RST" "$*"; }
good() { printf '  %s%s%s %s\n' "$GRN" "$S_OK" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YLW" "$RST" "$*" >&2; }
# die MESSAGE [HINT...]: what went wrong, then what to do about it.
die() {
  printf '\n  %s%s%s %s\n' "$RED" "$S_ERR" "$RST" "$1" >&2
  shift
  local h; for h in "$@"; do printf '    %s\n' "$h" >&2; done
  [ "$LOG" != /dev/null ] && printf '    Log: %s\n' "$LOG" >&2
  exit 1
}

header() {
  say
  if [ "$UI_UTF8" = 1 ]; then
    printf '  %s┏━━━━━━┓%s\n  %s┃ 5050 ┃%s  %s5050 Mail installer%s\n  %s┗━━━━━━┛%s  %sMail server, webmail and a send API on this machine.%s\n' "$B" "$RST" "$B" "$RST" "$B" "$RST" "$B" "$RST" "$D" "$RST"
  else
    printf '  %s+------+%s\n  %s| 5050 |%s  %s5050 Mail installer%s\n  %s+------+%s  %sMail server, webmail and a send API on this machine.%s\n' "$B" "$RST" "$B" "$RST" "$B" "$RST" "$B" "$RST" "$D" "$RST"
  fi
  say
}

# Prompts read the terminal, not stdin, so they work under `curl | sudo bash`.
have_tty() { [ "$ASSUME_YES" != 1 ] && { : </dev/tty; } 2>/dev/null; }
tty_out() { printf '%s' "$*" >/dev/tty; }
# prompt VAR "Question" [default] [validator] ["what is wrong"]: re-asks until the validator passes.
# Without a terminal (or with --yes) it takes the default; the caller checks the result.
prompt() {
  local __v="$1" q="$2" d="${3:-}" check="${4:-}" hint="${5:-}" a=""
  if have_tty; then
    while :; do
      tty_out "  $B$q$RST${d:+ [$d]}: "
      read -r a </dev/tty || { echo >/dev/tty; die "Input closed before an answer was given." "Re-run with the options on the command line (see --help)."; }
      a="${a:-$d}"
      if [ -z "$check" ] || "$check" "$a"; then break; fi
      tty_out "  $RED${hint:-That value is not valid.}$RST"$'\n'
    done
  else
    a="$d"
  fi
  printf -v "$__v" '%s' "$a"
}
ask() { prompt "$1" "$2" "${3:-}"; } # plain question, any answer
# ask_yn "Question" y|n: returns 0 for yes. Enter takes the default; anything else re-asks.
ask_yn() {
  local q="$1" d="${2:-n}" a hint="[y/N]"
  [ "$d" = y ] && hint="[Y/n]"
  have_tty || { [ "$d" = y ]; return; }
  while :; do
    tty_out "  $B$q$RST $hint "
    read -r a </dev/tty || { echo >/dev/tty; return 1; }
    case "${a:-$d}" in [Yy]|[Yy][Ee][Ss]) return 0 ;; [Nn]|[Nn][Oo]) return 1 ;; esac
    tty_out "  ${RED}Answer y or n.$RST"$'\n'
  done
}
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  { : </dev/tty; } 2>/dev/null || die "$1" "Re-run with --yes to confirm without a terminal."
  ask_yn "$1" n
}
rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "${1:-40}"; }
need_root() { [ "$(id -u)" = 0 ] || [ "${FIVEFIFTY_TEST_NOROOT:-}" = 1 ] || die "This installer must run as root." "Use: curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash"; }
valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]; }
valid_domain_ci() { valid_domain "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; }
valid_email() { [[ "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" =~ ^[a-z0-9._+-]+@([a-z0-9-]+\.)+[a-z]{2,}$ ]]; }

# spin "Label" cmd args...: run in the background with output going to the log, show a spinner,
# then a result line. Returns the command's status; on failure shows the end of the log.
spin() {
  local label="$1" pid rc=0 i=0 t0=$SECONDS n=${#FRAMES[@]} el
  shift
  printf '\n### %s\n' "$label" >>"$LOG"
  ( "$@" ) >>"$LOG" 2>&1 </dev/null &
  pid=$!; JOB_PID=$pid
  if [ "$ANIM" = 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s' "$CYN" "${FRAMES[i % n]}" "$RST" "$label"
      i=$((i + 1)); sleep 0.1
    done
  else
    printf '  %s ...\n' "$label"
  fi
  if wait "$pid"; then rc=0; else rc=$?; fi
  JOB_PID=""
  el=$((SECONDS - t0))
  if [ "$rc" = 0 ]; then
    if [ "$ANIM" = 1 ]; then printf '\r  %s%s%s %s %s(%ss)%s        \n' "$GRN" "$S_OK" "$RST" "$label" "$D" "$el" "$RST"
    else printf '  %s %s (%ss)\n' "$S_OK" "$label" "$el"; fi
  else
    if [ "$ANIM" = 1 ]; then printf '\r  %s%s%s %s        \n' "$RED" "$S_ERR" "$RST" "$label"
    else printf '  %s %s\n' "$S_ERR" "$label"; fi
    if [ "$LOG" != /dev/null ] && [ -s "$LOG" ]; then
      printf '\n    %sLast lines of the log:%s\n' "$D" "$RST" >&2
      tail -n 12 "$LOG" | sed 's/^/    | /' >&2
    fi
  fi
  return "$rc"
}
# run_step "Title" fn args...: a numbered step that stops the install when it fails.
STEP_HINT=""
run_step() {
  local title="$1"; shift
  STEP_N=$((STEP_N + 1))
  local label="$title"
  [ "$STEP_TOTAL" -gt 0 ] && label="[$STEP_N/$STEP_TOTAL] $title"
  if ! spin "$label" "$@"; then
    die "Step failed: $title" "${STEP_HINT:-Fix the problem above, then run the installer again. It is safe to re-run.}"
  fi
  STEP_HINT=""
}
step_head() { STEP_N=$((STEP_N + 1)); printf '\n  %s[%s/%s] %s%s\n' "$B" "$STEP_N" "$STEP_TOTAL" "$1" "$RST"; }
section() { printf '\n%s%s%s\n' "$B" "$1" "$RST"; }

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
  compose logs --tail 50 "$svc" || true
  echo "$svc did not become healthy within ${t}s"
  return 1
}

# ---------------------------------------------------------------- outbound relay
# Everything between the relay:begin/end markers is unit-tested by tests/install/relay-test.sh.
# --- relay:begin
RELAY_PRESETS="cloudflare resend ses postmark mailgun brevo smtp2go custom"
R_PRESET="" R_HOST="" R_PORT="" R_USER="" R_PASS="" R_SPF="" R_LABEL="" R_USER_FIXED="" R_USER_LABEL="" R_PASS_LABEL="" R_REPLY="" R_CF_TOKEN=""
CLOUD="" P25_STATE=""

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
  tty_out "  $B$2$RST (hidden): "
  read -r -s a </dev/tty || true
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
    cloudflare) R_LABEL="Cloudflare Email Sending"; R_HOST=smtp.mx.cloudflare.net; R_PORT=465; R_USER_FIXED=api_token
      R_PASS_LABEL="Cloudflare API token (Account > Email Sending > Edit; add Zone > DNS > Edit for automatic records)"; R_SPF=_spf.mx.cloudflare.net ;;
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
  say
  bold "  Outbound mail relay"
  cat <<'M'
    1) Cloudflare Email Sending  (needs a token with Account > Email Sending > Edit)
    2) Resend                    (SMTP, API key)
    3) Amazon SES                (pick a region)
    4) Postmark
    5) Mailgun
    6) Brevo
    7) SMTP2GO
    8) Another SMTP server
    9) Skip for now              (outgoing mail waits in the queue until port 25 works)
M
  while :; do
    tty_out "  ${B}Choose 1-9$RST [9]: "
    read -r c </dev/tty || return 1
    case "$c" in
      1) R_PRESET=cloudflare ;; 2) R_PRESET=resend ;; 3) R_PRESET=ses ;; 4) R_PRESET=postmark ;;
      5) R_PRESET=mailgun ;; 6) R_PRESET=brevo ;; 7) R_PRESET=smtp2go ;; 8) R_PRESET=custom ;;
      9|"") return 1 ;;
      *) tty_out "  ${RED}Enter a number from 1 to 9.$RST"$'\n'; continue ;;
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
      good "Relay accepted the login: ${R_LABEL:-$R_HOST}"
      return 0
    fi
    warn "The relay refused the login. It said: ${R_REPLY:-nothing}"
    [ "$interactive" = 1 ] || die "Fix the relay settings, or set RELAY_SKIP_VALIDATE=1 to save them anyway."
    tty_out "  ${B}[r]$RST retry the login, ${B}[c]$RST choose another relay, save ${B}[a]$RST as is, ${B}[s]$RST skip? [r] "
    read -r c </dev/tty || c=s
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
  local sub="$1" o rc=0; shift
  o="$(env "$@" docker compose --project-directory "$DIR/deploy" --env-file "$DIR/.env" -f "$DIR/deploy/docker-compose.yml" \
    --profile tools run --rm -T --entrypoint node bootstrap /relay.mjs "$sub" </dev/null 2>&1)" || rc=$?
  printf '%s\n' "$o" >>"$LOG"
  # Show the tool's own one-line messages; the full output is in the log.
  grep -E '^relay: ' <<<"$o" | sed 's/^relay: /    /' || true
  return "$rc"
}
spf_hint() {
  [ -n "$R_SPF" ] || return 0
  info "SPF: add include:$R_SPF to the SPF record of $DOMAIN (keep a single SPF record), e.g."
  say "      $DOMAIN  TXT  \"v=spf1 mx include:$R_SPF ~all\""
}
# After Stalwart is up and the DNS records exist: Cloudflare onboarding and the SPF include.
relay_post() {
  local cft; cft="$(env_get CLOUDFLARE_API_TOKEN)"
  if [ "$R_PRESET" = cloudflare ]; then
    info "Setting up $DOMAIN in Cloudflare Email Sending"
    relay_tool cf-onboard CLOUDFLARE_API_TOKEN="$R_CF_TOKEN" || warn "Could not set up $DOMAIN in Cloudflare Email Sending. The token needs Account > Email Sending > Edit and Zone > DNS > Edit. Or add the domain by hand in the dashboard under Email Sending."
    cft="${cft:-$R_CF_TOKEN}"
  fi
  [ -n "$R_SPF" ] || return 0
  if [ -n "$cft" ] && relay_tool spf CLOUDFLARE_API_TOKEN="$cft" RELAY_SPF_INCLUDE="$R_SPF"; then :; else spf_hint; fi
}
relay_retry() {
  info "Retrying the queued mail"
  relay_tool retry || warn "Stalwart did not accept the retry request. Queued mail will be retried on its normal schedule (within the hour)."
}
# Configure Stalwart on an existing install and flush the queue.
relay_apply_core() {
  compose --profile tools run --rm -T bootstrap </dev/null
  compose restart stalwart >/dev/null
  wait_healthy stalwart 300
}
relay_apply() {
  STEP_HINT="Check the log, then run: sudo $DIR/install.sh --relay"
  run_step "Apply the relay to the mail server" relay_apply_core
  relay_retry
  relay_post
}
# --- relay:end

# ---------------------------------------------------------------- Cloudflare token
CF_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
CF_BODY="" CF_HTTP="" CF_MSG="" CF_MISSING="" CF_ZONES="" CF_KIND="user"
TOKEN_URL='https://dash.cloudflare.com/profile/api-tokens'
TOKEN_TEMPLATE_URL="$TOKEN_URL?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=5050%20Mail"

# cf_api METHOD PATH [JSON]: the token goes in on stdin (curl -K -), never on the command line.
# Sets CF_BODY and CF_HTTP; returns 0 only for an HTTP 2xx with "success": true.
cf_api() {
  local m="$1" p="$2" d="${3:-}"
  local -a args=(-sS -m 25 -X "$m" -K - -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$d" ] && args+=(--data "$d")
  CF_BODY="$(printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN" | curl "${args[@]}" "$CF_BASE$p" 2>/dev/null)" || CF_BODY=$'\n000'
  CF_HTTP="${CF_BODY##*$'\n'}"
  CF_BODY="${CF_BODY%$'\n'*}"
  [[ "$CF_HTTP" =~ ^2 ]] && grep -q '"success": *true' <<<"$CF_BODY"
}
cf_msg() { sed -n 's/.*"message": *"\([^"]*\)".*/\1/p' <<<"$CF_BODY" | head -n 1; }
cf_denied() { [ "$CF_HTTP" = 401 ] || [ "$CF_HTTP" = 403 ]; }

# Checks that Cloudflare accepts the token: /user/tokens/verify, or for an account-owned token
# /accounts/{id}/tokens/verify (the account id comes from a zone). Sets CF_KIND and CF_MSG.
cf_verify() {
  local acct="" first=""
  CF_MSG="" CF_KIND=user
  if cf_api GET /user/tokens/verify; then
    grep -q '"status": *"active"' <<<"$CF_BODY" && return 0
    CF_MSG="the token is not active ($(grep -o '"status": *"[a-z]*"' <<<"$CF_BODY" | head -n 1 | sed 's/.*: *"//; s/"//'))"
    return 1
  fi
  if [ "$CF_HTTP" = 000 ]; then CF_MSG="could not reach api.cloudflare.com from this server"; return 1; fi
  first="$(cf_msg)"
  if cf_api GET "/zones?per_page=1"; then
    acct="$(grep -o '"account": *{[^}]*}' <<<"$CF_BODY" | head -n 1 | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p')"
  fi
  if [ -n "$acct" ] && cf_api GET "/accounts/$acct/tokens/verify" && grep -q '"status": *"active"' <<<"$CF_BODY"; then
    CF_KIND=account; return 0
  fi
  CF_MSG="Cloudflare rejected the token${first:+ ($first)}. Check that you copied all of it"
  return 1
}

# Lists the zones this token can see into CF_ZONES ("id name" lines).
cf_list_zones() {
  CF_ZONES=""
  cf_api GET "/zones?per_page=50" || return 1
  CF_ZONES="$(grep -o '"id": *"[A-Za-z0-9_]*", *"name": *"[^"]*"' <<<"$CF_BODY" | sed 's/"id": *"\([^"]*\)", *"name": *"\([^"]*\)"/\1 \2/' | grep -E ' [a-z0-9.-]+\.[a-z]{2,}$' || true)"
  return 0
}
# The zone that holds $DOMAIN: the longest zone name that is the domain or a parent of it.
cf_pick_zone() {
  local id name best=0 want; want="$(env_get CLOUDFLARE_ZONE)"
  CF_ZONE_ID="" CF_ZONE_NAME=""
  while read -r id name; do
    [ -n "$name" ] || continue
    [ -n "$want" ] && [ "$name" != "$want" ] && continue
    if [ "$DOMAIN" = "$name" ] || [[ "$DOMAIN" == *".$name" ]]; then
      if [ "${#name}" -gt "$best" ]; then best=${#name}; CF_ZONE_ID="$id"; CF_ZONE_NAME="$name"; fi
    fi
  done <<<"$CF_ZONES"
  [ -n "$CF_ZONE_ID" ]
}
cf_choose_zone() { # no automatic match: ask
  local n id name i=0 pick
  local -a ids names
  while read -r id name; do [ -n "$name" ] && { ids+=("$id"); names+=("$name"); }; done <<<"$CF_ZONES"
  n=${#ids[@]}
  [ "$n" -gt 0 ] || return 1
  have_tty || return 1
  say "    None of these zones matches $DOMAIN:"
  for ((i = 0; i < n; i++)); do printf '      %d) %s\n' $((i + 1)) "${names[i]}"; done
  cf_zone_ok() { [ -z "$1" ] || { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le "$n" ]; }; }
  prompt pick "Which zone holds $DOMAIN? Number, or Enter to skip" "" cf_zone_ok "Enter a number from 1 to $n, or press Enter to skip Cloudflare."
  [ -n "$pick" ] || return 1
  CF_ZONE_ID="${ids[pick - 1]}" CF_ZONE_NAME="${names[pick - 1]}"
}

# Probes the permissions the installer needs. Fills CF_MISSING (one name per line) and CF_HAS_SEND.
cf_probe() {
  local rid=""
  CF_MISSING="" CF_HAS_SEND=0
  # Zone > DNS > Edit: create one TXT record and delete it again.
  if cf_api POST "/zones/$CF_ZONE_ID/dns_records" "{\"type\":\"TXT\",\"name\":\"_5050-token-check.$CF_ZONE_NAME\",\"content\":\"5050 Mail permission check, safe to delete\",\"ttl\":120,\"comment\":\"5050 Mail\"}"; then
    rid="$(grep -o '"id": *"[^"]*"' <<<"$CF_BODY" | head -n 1 | sed 's/.*: *"//; s/"//')"
    if [ -n "$rid" ]; then
      cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$rid" || warn "Could not delete the test record _5050-token-check.$CF_ZONE_NAME; delete it in the dashboard."
    fi
  elif cf_denied; then CF_MISSING+="Zone > DNS > Edit"$'\n'
  else CF_MISSING+="Zone > DNS > Edit (Cloudflare said: $(cf_msg))"$'\n'; fi
  # Account > Email Sending > Edit: list the zone's sending subdomains.
  if cf_api GET "/zones/$CF_ZONE_ID/email/sending/subdomains"; then CF_HAS_SEND=1
  elif [ "$CF_NEED_SEND" = 1 ]; then
    if cf_denied; then CF_MISSING+="Account > Email Sending > Edit"$'\n'
    else CF_MISSING+="Email Sending is not available for this account (Cloudflare said: $(cf_msg))"$'\n'; fi
  fi
}

token_help() {
  local sending
  if [ "$CF_NEED_SEND" = 1 ]; then sending="needed: outbound port 25 is blocked on this server"; else sending="optional: only for sending through Cloudflare later"; fi
  section "  Create a Cloudflare API token (about a minute)"
  cat <<HELP
    1. Open ${B}$TOKEN_URL${RST}
       Or use this pre-filled link (DNS and Zone are set; add Email Sending by hand):
       $TOKEN_TEMPLATE_URL
    2. Create Token, then "Create Custom Token" > Get started. Add these permissions:
         Zone     DNS            Edit
         Zone     Zone           Read
         Account  Email Sending  Edit    ($sending)
    3. Zone Resources: Include > Specific zone > $DOMAIN
       (the zone, not a subdomain; this keeps the token to one zone)
    4. Continue to summary, Create Token, and copy the secret. Cloudflare shows it once.

    The installer checks the token by creating and deleting one TXT record
    (_5050-token-check). The token is stored only in $DIR/.env on this server,
    and you can revoke it at $TOKEN_URL.

HELP
}

# Cloudflare questions and checks. Returns 0 with CF_TOKEN and CF_ZONE_* set when the token works.
cf_wizard() {
  local k interactive=0
  have_tty && interactive=1
  CF_TOKEN="${ARG_CF_TOKEN:-$(env_get CLOUDFLARE_API_TOKEN)}"
  if [ -n "$CF_TOKEN" ]; then
    info "Using the Cloudflare token from $([ "$CF_FROM_FLAG" = 1 ] && echo "the command line" || echo "$DIR/.env")."
  else
    [ "$interactive" = 1 ] || return 1
    [ "$INSTALLED" = 1 ] && return 1
    section "  DNS"
    if ! ask_yn "Is the DNS for $DOMAIN on Cloudflare?" n; then
      info "No problem. You will get the records to add at your DNS provider."
      return 1
    fi
    token_help
    ask_secret CF_TOKEN "Paste the token (Enter to skip)"
    [ -n "$CF_TOKEN" ] || { info "Skipped. You will get the records to add by hand."; return 1; }
  fi
  while :; do
    if ! cf_verify; then
      warn "Cloudflare token: $CF_MSG."
      if [ "$interactive" = 1 ]; then
        ask_secret CF_TOKEN "Paste the token again (Enter to skip Cloudflare)"
        [ -n "$CF_TOKEN" ] && continue
      fi
      CF_TOKEN=""; return 1
    fi
    good "Token is valid ($CF_KIND-owned)"
    CF_MISSING=""
    if ! cf_list_zones; then
      if cf_denied; then CF_MISSING="Zone > Zone > Read"$'\n'; else CF_MISSING="could not list zones ($(cf_msg))"$'\n'; fi
    elif [ -z "$CF_ZONES" ]; then
      CF_MISSING="Zone Resources: the token cannot see any zone (include $DOMAIN or all zones)"$'\n'
    elif cf_pick_zone; then
      good "Zone $CF_ZONE_NAME holds $DOMAIN"
      if [ "$(grep -c . <<<"$CF_ZONES")" -gt 1 ]; then info "This token can see $(grep -c . <<<"$CF_ZONES") zones. Limiting it to $CF_ZONE_NAME (Zone Resources) is safer."; fi
    elif cf_choose_zone; then
      good "Using zone $CF_ZONE_NAME"
    else
      CF_MISSING="Zone Resources: no zone that matches $DOMAIN (the token sees: $(awk '{printf "%s ", $2}' <<<"$CF_ZONES"))"$'\n'
    fi
    [ -n "$CF_MISSING" ] || cf_probe
    if [ -z "$CF_MISSING" ]; then
      good "Can edit DNS in $CF_ZONE_NAME"
      if [ "$CF_HAS_SEND" = 1 ]; then good "Email Sending is available"
      else info "Email Sending is not enabled for this token (only needed to send through Cloudflare)."; fi
      return 0
    fi
    warn "The token is missing something:"
    while read -r k; do [ -n "$k" ] && say "      - $k"; done <<<"$CF_MISSING"
    say "    Edit the token at $TOKEN_URL (changes apply at once)."
    if [ "$interactive" = 0 ]; then CF_TOKEN=""; return 1; fi
    tty_out "  ${B}Enter$RST re-check, ${B}p$RST paste another token, ${B}s$RST skip Cloudflare [Enter]: "
    read -r k </dev/tty || k=s
    case "$k" in
      s|S) CF_TOKEN=""; info "Skipped. You will get the records to add by hand."; return 1 ;;
      p|P) ask_secret CF_TOKEN "Paste the new token (Enter to skip)"; [ -n "$CF_TOKEN" ] || return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- DNS records
dns_label() { # TYPE NAME CONTENT: short name for the summary line
  case "$1:$2:$3" in
    MX:*) echo "MX" ;; A:*|AAAA:*) echo "$1 ${2%%.*}" ;;
    TXT:*_domainkey*) echo "DKIM" ;; TXT:_dmarc*) echo "DMARC" ;; TXT:_smtp._tls*) echo "TLS-RPT" ;;
    TXT:*:v=spf1*) echo "SPF" ;; *) echo "$1" ;;
  esac
}
# cfdns plan|apply TSV: server/cfdns.mjs in the bootstrap container.
cfdns() {
  compose --profile tools run --rm -T -e "CF_REPLACE_MX=${CF_MX:-0}" -e CLOUDFLARE_API_BASE --entrypoint node bootstrap /cfdns.mjs "$1" <"$2" 2>>"$LOG"
}
# Prints a cfdns result and collects DNS_CHANGES from created, merged and replaced records.
cf_show() { # reads cfdns lines on stdin
  local act type name content note sym
  while IFS=$'\t' read -r act type name content note; do
    case "$act" in create|merge|replace|keep|skip|conflict|error) ;; *) continue ;; esac
    case "$act" in
      create) sym="${GRN}+${RST}"; DNS_CHANGES+="+$(dns_label "$type" "$name" "$content"), " ;;
      merge|replace) sym="${CYN}~${RST}"; DNS_CHANGES+="~$(dns_label "$type" "$name" "$content"), " ;;
      keep) sym="${D}=${RST}" ;;
      *) sym="${YLW}!${RST}" ;;
    esac
    if [ "$act" = error ]; then printf '    %s %s\n' "$sym" "$note"; continue; fi
    printf '    %s %-5s %-46.46s %s\n' "$sym" "$type" "$name" "${note:-${content:0:48}}"
  done
}

dns_lookup() { # TYPE NAME: raw answer text
  if [ -n "${FIVEFIFTY_DNS_RESOLVER:-}" ]; then "$FIVEFIFTY_DNS_RESOLVER" "$1" "$2"; return; fi
  if command -v dig >/dev/null 2>&1; then dig +short +time=3 +tries=1 "$2" "$1" 2>/dev/null
  elif command -v host >/dev/null 2>&1; then host -W 3 -t "$1" "$2" 2>/dev/null
  elif [ "$1" = A ] && command -v getent >/dev/null 2>&1; then getent ahostsv4 "$2" | awk '{print $1}' | sort -u
  else return 1; fi
}
dns_norm() { tr -d '" \t' | tr '[:upper:]' '[:lower:]' | sed 's/\.$//'; }
dns_has() { # TYPE NAME VALUE: does public DNS show it?
  local t="$1" n="$2" v="$3" out want
  out="$(dns_lookup "$t" "$n" 2>/dev/null | dns_norm)" || return 2
  case "$t" in
    A|AAAA) want="$(dns_norm <<<"$v")" ;;
    MX) want="$(dns_norm <<<"${v#* }")" ;;
    *) if [[ "$v" == v=spf1* ]]; then want="v=spf1"; else want="$(dns_norm <<<"${v:0:60}")"; fi ;;
  esac
  [ -n "$out" ] && grep -qF -- "$want" <<<"$out"
}
dns_table() { # TSV file
  local type name value
  printf '    %s%-5s %-40s %s%s\n' "$D" "Type" "Name" "Value" "$RST"
  while IFS=$'\t' read -r type name value; do
    [ -n "$type" ] || continue
    [ "${#value}" -gt 70 ] && value="${value:0:67}... (${#value} chars)"
    printf '    %-5s %-40.40s %s\n' "$type" "$name" "$value"
  done <"$1"
}
dns_wait() { # TSV file: re-check until every record resolves, or the user skips
  local type name value bad k n=0 tool=1 i seen=""
  command -v dig >/dev/null 2>&1 || command -v host >/dev/null 2>&1 || [ -n "${FIVEFIFTY_DNS_RESOLVER:-}" ] || tool=0
  if [ "$tool" = 0 ]; then info "Install dnsutils (or bind-utils) and the installer can check DNS for you. For now use Domains > Check DNS in the admin console."; return 0; fi
  while :; do
    bad=0; n=$((n + 1)); i=0
    while IFS=$'\t' read -r type name value; do
      [ -n "$type" ] || continue
      i=$((i + 1))
      if dns_has "$type" "$name" "$value"; then
        # Print a record once: on the first pass, or when it starts to resolve.
        case " $seen " in *" $i "*) ;; *) seen="$seen $i"; printf '    %s%s%s %-5s %s\n' "$GRN" "$S_OK" "$RST" "$type" "$name" ;; esac
      else
        bad=$((bad + 1))
        [ "$n" = 1 ] && printf '    %s%s%s %-5s %s\n' "$RED" "$S_ERR" "$RST" "$type" "$name"
      fi
    done <"$1"
    if [ "$bad" = 0 ]; then good "Every record resolves."; return 0; fi
    have_tty || { info "$bad record(s) do not resolve yet. DNS changes can take a few minutes."; return 0; }
    tty_out "  $bad not visible yet. Checking again in 20 seconds. ${B}Enter${RST} check now, ${B}s${RST} skip: "
    k=""; read -r -t 20 -n 1 k </dev/tty || true
    echo >/dev/tty
    case "$k" in s|S) info "Skipped. Domains > Check DNS in the admin console checks again."; return 0 ;; esac
  done
}

# ---------------------------------------------------------------- screens
disclosure() {
  section "  Before we start"
  cat <<TXT
    Installs    Docker (only if it is missing), then the 5050 Mail containers:
                mail server, webmail, 5050 Send, Postgres and Caddy, in $DIR
    Ports       The containers listen on 25, 465, 587, 993 (mail), 2465, 2587
                (5050 Send SMTP), 80 and 443 (web). Your firewall is not changed.
    Secrets     Generated here and kept only in $DIR/.env (mode 0600).
    Telemetry   None. Nothing is sent to us.
    Network     Downloads from GitHub, Docker Hub and get.docker.com. Let's Encrypt
                gets your hostnames to issue certificates. api.ipify.org is asked for
                this server's public IP. A port 25 test opens a connection to Gmail's
                mail server and sends no mail.
    Cloudflare  Optional. A token is used only for your zone's DNS and Email Sending,
                is stored only in $DIR/.env, and you can revoke it any time.
    Undo        sudo $DIR/install.sh --uninstall   (add --purge to delete all data)

TXT
}

BOX_V="│" BOX_TL="┌" BOX_BL="└" BOX_H="─"
if [ "$UI_UTF8" != 1 ]; then BOX_V="|" BOX_TL="+" BOX_BL="+" BOX_H="-"; fi
box_rule() { printf '  %s%s%s' "$D" "$1" "$RST"; local i; for ((i = 0; i < 70; i++)); do printf '%s' "$BOX_H"; done; printf '\n'; }
box_text() { printf '  %s%s%s  %s\n' "$D" "$BOX_V" "$RST" "$*"; }
box_kv() { printf '  %s%s%s  %s%-15s%s %s\n' "$D" "$BOX_V" "$RST" "$B" "$1" "$RST" "$2"; }

# "+MX, +A mail, +DKIM, +DKIM" becomes "+MX, +A mail, +DKIM x2".
dns_changes_line() {
  printf '%s' "$DNS_CHANGES" | tr ',' '\n' | sed 's/^ *//' |
    awk 'NF { if (!($0 in c)) o[++n] = $0; c[$0]++ } END { for (i = 1; i <= n; i++) printf "%s%s%s", (i > 1 ? ", " : ""), o[i], (c[o[i]] > 1 ? " x" c[o[i]] : "") }'
}

summary() {
  say
  box_rule "$BOX_TL"
  box_text "${B}5050 Mail is running${RST}"
  box_text ""
  box_kv "Webmail" "https://$MAIL_HOST"
  box_kv "Admin console" "https://$MAIL_HOST/admin"
  box_kv "Send dashboard" "https://$SEND_HOST"
  box_kv "Send API" "https://$API_HOST   (Resend-compatible)"
  box_text ""
  box_kv "Admin mailbox" "$ADMIN_EMAIL_V"
  if [ -n "$NEW_ADMIN_PASSWORD" ]; then
    if [ -n "$ARG_ADMIN_PASSWORD" ]; then box_kv "Password" "the one you passed with --admin-password"
    else
      box_kv "Password" "${YLW}${B}$NEW_ADMIN_PASSWORD${RST}"
      box_text "                 ${YLW}Shown once. Store it now and change it in the webmail settings.${RST}"
    fi
  else
    box_kv "Password" "unchanged (set on first install)"
  fi
  box_text ""
  box_kv "Mail apps" "IMAP $MAIL_HOST:993 (SSL)   SMTP $MAIL_HOST:465 (SSL) or :587 (STARTTLS)"
  box_kv "" "User name: the full address. Send SMTP relay: :2465 / :2587, user resend."
  [ "$RELAY_CONFIGURED" = 1 ] && box_kv "Outbound" "via ${R_LABEL:-$R_HOST} ($R_HOST:$R_PORT). Test: sudo $DIR/install.sh --relay-test"
  if [ -n "$DNS_CHANGES" ]; then box_text ""; box_kv "DNS changed" "$(dns_changes_line)"; fi
  box_text ""
  box_text "${B}Next${RST}"
  box_text "  1. Sign in at https://$MAIL_HOST/admin and add your users."
  box_text "  2. More domains: Admin console > Domains > Add a domain."
  box_text "  3. Create a Send API key: https://$SEND_HOST > API keys."
  box_text "  4. Ask your VPS provider to set reverse DNS (PTR) of ${PUBLIC_IPV4:-the server IP} to $MAIL_HOST."
  box_text ""
  box_kv "Logs" "$LOG"
  box_kv "Settings" "$DIR/.env  (secrets, mode 0600: back it up)"
  box_kv "Upgrade" "sudo $DIR/install.sh --upgrade"
  box_kv "Uninstall" "sudo $DIR/install.sh --uninstall [--purge]"
  box_rule "$BOX_BL"
  if [ "$TLS" = internal ]; then warn "TLS is self-signed (--tls internal): browsers and mail clients will warn. Use --tls acme for a real domain."; fi
  say
}

# ---------------------------------------------------------------- install steps (each runs in the spinner)
step_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Docker with get.docker.com"
    command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; } || { echo "curl is required"; exit 1; }
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker compose version || { echo "Docker Compose v2 is missing (install the docker-compose-plugin package)."; exit 1; }
  docker info >/dev/null || { echo "The Docker daemon is not running (try: sudo systemctl start docker)."; exit 1; }
}

sync_source() {
  mkdir -p "$DIR"
  if [ -n "$SRC" ]; then
    SRC="$(cd "$SRC" && pwd)"
    if [ "$SRC" != "$DIR" ]; then
      echo "Copying source from $SRC to $DIR"
      tar -C "$SRC" --exclude=./.env --exclude='./.git' --exclude='*/node_modules' --exclude='*/dist' -cf - . | tar -C "$DIR" -xf -
    fi
  elif [ -d "$DIR/.git" ]; then
    echo "Updating $DIR from $REPO_URL ($REPO_REF)"
    git -C "$DIR" fetch -q origin "$REPO_REF" && git -C "$DIR" checkout -q "$REPO_REF" && git -C "$DIR" reset -q --hard "origin/$REPO_REF"
  elif [ ! -f "$DIR/deploy/docker-compose.yml" ]; then
    command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; } || { echo "git is required"; exit 1; }
    echo "Cloning $REPO_URL into $DIR"
    local tmp; tmp="$(mktemp -d)"
    git clone -q --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp/src"
    cp -a "$tmp/src/." "$DIR/"; rm -rf "$tmp"
  fi
  [ -f "$DIR/deploy/docker-compose.yml" ] || { echo "$DIR does not contain deploy/docker-compose.yml"; exit 1; }
}

step_build() {
  compose build --pull webmail send-web
  compose --profile tools pull --quiet postgres stalwart caddy bootstrap 2>/dev/null || compose --profile tools pull postgres stalwart caddy bootstrap
}
step_core() {
  compose up -d postgres stalwart
  wait_healthy postgres 120
  wait_healthy stalwart 300
}
step_configure() {
  ADMIN_PASSWORD="$NEW_ADMIN_PASSWORD" compose --profile tools run --rm -T bootstrap </dev/null
  # New listeners (submission 587, internal relay for 5050 Send) need a restart.
  compose restart stalwart >/dev/null
  wait_healthy stalwart 300
  [ "$FIRST_RUN" = 1 ] && env_set BOOTSTRAPPED "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  return 0
}
step_web() {
  compose up -d --remove-orphans
  wait_healthy webmail 180
  wait_healthy send-web 180
  compose ps
}

cf_conflicts() { awk -F'\t' '$1 == "conflict" { sub(/^existing MX would compete: /, "", $5); print "      " $5 }'; }
dns_fetch() { # TSV file
  compose --profile tools run --rm -T bootstrap --print-dns --tsv </dev/null | awk -F'\t' '$1 ~ /^(A|AAAA|MX|TXT)$/ && NF >= 3' >"$1"
  [ -s "$1" ]
}

step_dns() {
  local tsv plan rc=0 conflicts
  step_head "DNS records"
  tsv="$(mktemp)"
  if ! spin "Read the records from the mail server" dns_fetch "$tsv"; then
    warn "Could not read the DNS records. Open the admin console > Domains > $DOMAIN to see them."
    rm -f "$tsv"; return 0
  fi
  cp "$tsv" "$DIR/dns-records.tsv"; chmod 644 "$DIR/dns-records.tsv"
  if [ "$CF_ON" = 1 ]; then
    CF_MX=0; [ "$REPLACE_MX" = 1 ] && CF_MX=1
    plan="$(cfdns plan "$tsv")" || rc=$?
    if [ "$rc" != 0 ]; then
      cf_show <<<"$plan"
      warn "Cloudflare did not accept the changes. The records are listed below to add by hand."
      CF_ON=0
    else
      conflicts="$(cf_conflicts <<<"$plan")"
      if [ -n "$conflicts" ] && [ "$CF_MX" != 1 ]; then
        warn "$DOMAIN already has MX records that would compete with this server:"
        say "$conflicts"
        say "    Replacing them sends all new mail for $DOMAIN to this server."
        if ask_yn "Replace them?" n; then CF_MX=1; else info "Keeping them. Mail for $DOMAIN will still go to the old MX until you change it."; fi
      fi
      say
      plan="$(cfdns apply "$tsv")" || rc=$?
      cf_show <<<"$plan"
      if [ "$rc" != 0 ]; then warn "Not every change was made. Add the missing records by hand, listed below."; CF_ON=0; fi
    fi
    [ "$CF_ON" = 1 ] && good "Cloudflare zone $CF_ZONE_NAME is up to date. Records are DNS only."
  fi
  if [ "$CF_ON" != 1 ]; then
    say
    say "    Add these records at your DNS provider (TTL 300 to 3600):"
    say
    dns_table "$tsv"
    say
    info "Full values are saved in $DIR/dns-records.tsv and under Admin console > Domains > $DOMAIN."
    info "On Cloudflare? Set the A records to DNS only (grey cloud), not Proxied."
    say
    dns_wait "$tsv"
  fi
  rm -f "$tsv"
}

# ---------------------------------------------------------------- questions
p25_job() { detect_port25; printf '%s' "$P25_STATE" >"$1"; }
p25_check() {
  local f; f="$(mktemp)"
  spin "Check outbound port 25" p25_job "$f" || true
  P25_STATE="$(cat "$f")"; rm -f "$f"
  case "$P25_STATE" in
    open) good "Outbound port 25 is open: mail is delivered directly." ;;
    nonet) warn "Could not test port 25 (no network or DNS from this server). Re-check later: sudo $DIR/install.sh --relay-test" ;;
    *)
      detect_cloud
      warn "Outbound port 25 is blocked. Mail would queue and never leave this server."
      say "    $(cloud_explain)"
      ;;
  esac
}

# Decide how outgoing mail leaves: direct, Cloudflare Email Sending, or another relay.
wizard_relay() {
  if [ "$RELAY_FLAG" = 1 ] || [ -n "$ARG_RELAY_HOST" ]; then
    if relay_setup; then relay_save; RELAY_CONFIGURED=1; else warn "No relay configured: outgoing mail will queue unless port 25 works."; fi
    return 0
  fi
  [ "$P25_STATE" = blocked ] || return 0
  if [ "$CF_ON" = 1 ] && [ "$CF_HAS_SEND" = 1 ]; then
    if ask_yn "Send through Cloudflare Email Sending? (sets up $DOMAIN and the relay for you)" y; then
      ARG_RELAY_PRESET=cloudflare; RELAY_FLAG=1; ARG_CF_TOKEN="$CF_TOKEN"
      if relay_setup; then relay_save; RELAY_CONFIGURED=1; else warn "Skipped the relay: mail will queue until port 25 works."; fi
      return 0
    fi
  fi
  if [ "$MODE" = install ] && have_tty; then
    say "    Pick an outbound relay now, or later with: sudo $DIR/install.sh --relay"
    if relay_setup; then relay_save; RELAY_CONFIGURED=1; else warn "Skipped: mail will queue until port 25 is open or a relay is set up (install.sh --relay)."; fi
  else
    warn "Set up a relay with: install.sh --relay <cloudflare|resend|ses|postmark|mailgun|brevo|smtp2go> --relay-user USER --relay-password PASS"
    warn "or interactively: sudo $DIR/install.sh --relay"
  fi
}

wizard() {
  DOMAIN="${ARG_DOMAIN:-$(env_get MAIL_DOMAIN)}"
  if [ -z "$DOMAIN" ]; then
    [ "$MODE" = upgrade ] && die "No MAIL_DOMAIN in $DIR/.env." "Install first, or pass --domain."
    section "  Your domain"
    have_tty || die "No domain given." "Pass --domain example.com (and --yes to skip questions)."
    prompt DOMAIN "Mail domain, for example example.com" "" valid_domain_ci "That is not a domain name. Use a name like example.com."
  fi
  DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
  valid_domain "$DOMAIN" || die "'$DOMAIN' is not a valid domain." "Pass --domain example.com."

  ADMIN_EMAIL_V="${ARG_ADMIN_EMAIL:-$(env_get ADMIN_EMAIL)}"
  [ -n "$ADMIN_EMAIL_V" ] || prompt ADMIN_EMAIL_V "Admin mailbox to create" "admin@$DOMAIN" valid_email "That is not an email address. Use a form like admin@$DOMAIN."
  ADMIN_EMAIL_V="$(printf '%s' "$ADMIN_EMAIL_V" | tr '[:upper:]' '[:lower:]')"
  valid_email "$ADMIN_EMAIL_V" || die "'$ADMIN_EMAIL_V' is not a valid admin email." "Pass --admin-email you@$DOMAIN."

  MAIL_HOST="${ARG_MAIL_HOST:-$(env_get MAIL_HOSTNAME)}"; MAIL_HOST="${MAIL_HOST:-mail.$DOMAIN}"
  SEND_HOST="${ARG_SEND_HOST:-$(env_get SEND_HOST)}"; SEND_HOST="${SEND_HOST:-send.$DOMAIN}"
  API_HOST="${ARG_API_HOST:-$(env_get API_HOST)}"; API_HOST="${API_HOST:-api.$DOMAIN}"

  TLS="${TLS:-$(env_get TLS_MODE)}"; TLS="${TLS:-acme}"
  case "$TLS" in acme|internal) ;; manual) TLS=internal ;; *) die "--tls must be acme or internal." ;; esac

  # Public address (DNS records and port 25 advice).
  PUBLIC_IPV4="$(env_get PUBLIC_IPV4)"
  if [ -z "$PUBLIC_IPV4" ]; then
    PUBLIC_IPV4="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
    [[ "$PUBLIC_IPV4" =~ ^[0-9.]+$ ]] || PUBLIC_IPV4=""
  fi

  # Port 25 first: it decides whether the Cloudflare token also needs Email Sending.
  P25_STATE=""
  if [ "$RELAY_FLAG" != 1 ] && [ -z "$ARG_RELAY_HOST" ] && [ "$SKIP_PORT25" = 0 ] && [ -z "$(env_get RELAY_HOST)" ] && [ "$TLS" = acme ]; then
    section "  Outbound mail"
    p25_check
    [ "$P25_STATE" = blocked ] && CF_NEED_SEND=1
  fi
  [ "$ARG_RELAY_PRESET" = cloudflare ] && CF_NEED_SEND=1

  CF_ON=0
  if cf_wizard; then CF_ON=1; else
    if [ "$CF_FROM_FLAG" = 1 ] && ! have_tty; then
      die "The Cloudflare token from --cloudflare-token cannot be used." "${CF_MISSING:+Missing: ${CF_MISSING//$'\n'/; }}" "Fix the token (see the permissions at $TOKEN_URL) or drop --cloudflare-token to get the records to add by hand."
    fi
    CF_TOKEN=""
  fi
  if [ "$CF_ON" = 1 ]; then
    ARG_CF_TOKEN="$CF_TOKEN"
  fi

  if [ "$RELAY_FLAG" = 1 ] || [ -n "$ARG_RELAY_HOST" ] || [ "$P25_STATE" = blocked ]; then
    [ "$P25_STATE" = blocked ] || section "  Outbound mail"
    wizard_relay
  fi
}

write_settings() {
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
  [ -n "$PUBLIC_IPV4" ] && env_set PUBLIC_IPV4 "$PUBLIC_IPV4"
  if [ "$CF_ON" = 1 ]; then
    env_set CLOUDFLARE_API_TOKEN "$CF_TOKEN"
    env_set CLOUDFLARE_ZONE "$CF_ZONE_NAME"
  elif [ -n "$ARG_CF_TOKEN" ]; then
    env_set CLOUDFLARE_API_TOKEN "$ARG_CF_TOKEN"
  fi
}

# ---------------------------------------------------------------- uninstall
uninstall_purge() {
  compose --profile tools down -v --remove-orphans
  # Volumes orphaned by an earlier plain --uninstall.
  docker volume ls -q --filter label=com.docker.compose.project=5050-mail | xargs -r docker volume rm >/dev/null 2>&1 || true
}
if [ "$MODE" = uninstall ]; then
  need_root
  header
  [ -f "$DIR/deploy/docker-compose.yml" ] || die "No installation found in $DIR."
  LOG="$(mktemp)"
  if [ "$PURGE" = 1 ]; then
    confirm "Remove 5050 Mail and DELETE ALL MAIL, accounts and data in $DIR?" || { say "  Nothing changed."; exit 1; }
    run_step "Remove containers and volumes" uninstall_purge
    rm -rf "$DIR"
    good "Removed containers, volumes and $DIR."
  else
    confirm "Stop and remove the 5050 Mail containers? (data volumes are kept)" || { say "  Nothing changed."; exit 1; }
    run_step "Remove containers" compose --profile tools down --remove-orphans
    good "Containers removed. Data volumes and $DIR/.env are kept. To delete everything: --uninstall --purge"
  fi
  exit 0
fi

need_root

if [ -n "$ARG_RELAY_PRESET" ]; then
  case " $RELAY_PRESETS " in *" $ARG_RELAY_PRESET "*) ;; *) die "Unknown relay '$ARG_RELAY_PRESET'." "Use one of: $RELAY_PRESETS" ;; esac
  RELAY_FLAG=1
fi
INSTALLED=0
[ -n "$(env_get BOOTSTRAPPED)" ] && INSTALLED=1
[ -d "$DIR" ] && [ -f "$DIR/.env" ] && { LOG="$DIR/install.log"; touch "$LOG"; chmod 600 "$LOG"; }

if [ "$RELAY_TEST" = 1 ]; then
  [ -n "$(env_get RELAY_HOST)" ] || [ -n "$ARG_RELAY_HOST" ] || die "No relay is configured in $DIR/.env." "Set one up with: sudo $DIR/install.sh --relay"
  R_HOST="${ARG_RELAY_HOST:-$(env_get RELAY_HOST)}" R_PORT="${ARG_RELAY_PORT:-$(env_get RELAY_PORT)}"
  R_USER="${ARG_RELAY_USER:-$(env_get RELAY_USERNAME)}" R_PASS="${ARG_RELAY_PASS:-$(env_get RELAY_PASSWORD)}"
  info "Testing the login at $R_HOST:${R_PORT:-587} (no mail is sent)"
  if relay_validate "$R_HOST" "${R_PORT:-587}" "$R_USER" "$R_PASS"; then good "Relay accepted the login."; exit 0; fi
  die "The relay refused the login: ${R_REPLY:-no reply}" "Check the user name and password, then run: sudo $DIR/install.sh --relay"
fi

# Existing install: only (re)configure the relay, re-run the bootstrap and restart Stalwart.
if [ "$RELAY_FLAG" = 1 ] && [ "$INSTALLED" = 1 ] && [ "$MODE" = install ]; then
  header
  [ -f "$DIR/server/relay.mjs" ] || die "This installation predates relay support." "Run $DIR/install.sh --upgrade first."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
  DOMAIN="$(env_get MAIL_DOMAIN)"
  relay_setup || { info "No relay configured; nothing changed."; exit 0; }
  relay_save
  relay_apply
  say
  good "Outbound relay: ${R_LABEL:-$R_HOST} ($R_HOST:$R_PORT)"
  info "Test again: sudo $DIR/install.sh --relay-test"
  exit 0
fi

# ---------------------------------------------------------------- install / upgrade
header
if [ "$MODE" = install ]; then
  disclosure
  if [ "$INSTALLED" = 1 ]; then info "Found an existing install in $DIR. Your secrets and data are kept."; fi
  if [ "$ASSUME_YES" != 1 ]; then
    { : </dev/tty; } 2>/dev/null || die "No terminal to ask for confirmation." "Re-run with --yes to continue without questions (see --help)."
    ask_yn "Continue?" y || { say "  Nothing was changed."; exit 1; }
  fi
else
  info "Upgrading the install in $DIR."
fi

mkdir -p "$DIR"
touch "$DIR/.env"; chmod 600 "$DIR/.env"
LOG="$DIR/install.log"; touch "$LOG"; chmod 600 "$LOG"
printf '\n=== %s install.sh (%s) ===\n' "$(date -u +%FT%TZ)" "$MODE" >>"$LOG"

wizard
write_settings

NEW_ADMIN_PASSWORD="" FIRST_RUN=0
[ -z "$(env_get BOOTSTRAPPED)" ] && FIRST_RUN=1
if [ "$FIRST_RUN" = 1 ]; then
  NEW_ADMIN_PASSWORD="${ARG_ADMIN_PASSWORD:-$(rand 20)}"
  [ "${#NEW_ADMIN_PASSWORD}" -ge 8 ] || die "--admin-password must be at least 8 characters."
fi

# Running from a checkout other than the install dir: install from it. Running the installed
# copy (/opt/5050-mail/install.sh --upgrade) updates from git instead.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$SRC" ] && [ -n "$here" ] && [ -f "$here/deploy/docker-compose.yml" ] && [ "$here" != "$(cd "$DIR" 2>/dev/null && pwd || echo "$DIR")" ]; then SRC="$here"; fi

section "  Installing"
STEP_TOTAL=7
STEP_HINT="Check that this is a Linux server with internet access, then run the installer again."
run_step "Check Docker" step_docker
STEP_HINT="Check the network and that $DIR is writable, then run the installer again."
run_step "Get the 5050 Mail source" sync_source
cd "$DIR"
STEP_HINT="See the log lines above. Low disk space or memory is the usual cause (4 GB RAM is recommended)."
run_step "Build the images (a few minutes the first time)" step_build
STEP_HINT="See the log. Port 25, 465, 587 or 993 may be taken by another program (check: ss -ltnp)."
run_step "Start the database and mail server" step_core
STEP_HINT="See the log. Fix the cause, then run the installer again: it continues where it stopped."
run_step "Set up $DOMAIN and the admin mailbox" step_configure
STEP_HINT="Ports 80 and 443 may be in use by another web server (check: ss -ltnp)."
run_step "Start webmail, 5050 Send and Caddy" step_web
step_dns

if [ "$RELAY_CONFIGURED" = 1 ]; then
  section "  Outbound relay"
  relay_post
  relay_retry
fi

summary
}

main "$@"
