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
  --relay-host HOST --relay-port PORT --relay-user USER --relay-password PASS
                             optional outbound smarthost (when port 25 is blocked)
  --send-transport smtp|log  5050 Send delivery (default smtp = via the mail server; log = drop)
  --dir DIR                  install directory (default /opt/5050-mail)
  --source DIR               install from a local checkout instead of GitHub
  --yes                      non-interactive; never prompt
  --skip-port25-check        don't probe outbound port 25
  --upgrade                  update the source, rebuild and restart
  --uninstall [--purge]      stop and remove containers (--purge also deletes all mail and data)
  -h, --help
Environment equivalents: MAIL_DOMAIN, ADMIN_EMAIL, ADMIN_PASSWORD, TLS_MODE, CLOUDFLARE_API_TOKEN,
RELAY_HOST/RELAY_PORT/RELAY_USERNAME/RELAY_PASSWORD, SEND_TRANSPORT, FIVEFIFTY_DIR, FIVEFIFTY_SRC, ASSUME_YES=1.
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
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
valid_domain "$DOMAIN" || die "'$DOMAIN' is not a valid domain (pass --domain example.com)"

ADMIN_EMAIL_V="${ARG_ADMIN_EMAIL:-$(env_get ADMIN_EMAIL)}"
[ -n "$ADMIN_EMAIL_V" ] || ask ADMIN_EMAIL_V "Admin mailbox to create" "admin@$DOMAIN"
ADMIN_EMAIL_V="$(printf '%s' "$ADMIN_EMAIL_V" | tr 'A-Z' 'a-z')"
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
env_default WEB_CONCURRENCY "auto"

[ -n "$ARG_SEND_TRANSPORT" ] && env_set SEND_TRANSPORT "$ARG_SEND_TRANSPORT"
env_default SEND_TRANSPORT "smtp"
[ -n "$ARG_CF_TOKEN" ] && env_set CLOUDFLARE_API_TOKEN "$ARG_CF_TOKEN"
if [ -n "$ARG_RELAY_HOST" ]; then
  env_set RELAY_HOST "$ARG_RELAY_HOST"
  env_set RELAY_PORT "${ARG_RELAY_PORT:-587}"
  env_set RELAY_USERNAME "$ARG_RELAY_USER"
  env_set RELAY_PASSWORD "$ARG_RELAY_PASS"
fi

# Public address (DNS records + port 25 advice).
PUBLIC_IPV4="$(env_get PUBLIC_IPV4)"
if [ -z "$PUBLIC_IPV4" ]; then
  PUBLIC_IPV4="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  [[ "$PUBLIC_IPV4" =~ ^[0-9.]+$ ]] && env_set PUBLIC_IPV4 "$PUBLIC_IPV4" || PUBLIC_IPV4=""
fi

# ---------------------------------------------------------------- port 25
if [ "$SKIP_PORT25" = 0 ] && [ -z "$(env_get RELAY_HOST)" ] && [ "$TLS" = acme ]; then
  info "Checking outbound port 25"
  if timeout 8 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25 && head -c 3 <&3' 2>/dev/null | grep -q 220; then
    info "Outbound port 25 is open: mail is delivered directly."
  else
    warn "Outbound port 25 looks BLOCKED (common on AWS, Azure, GCP, DigitalOcean by default)."
    warn "Mail will queue and never leave this server until you either ask your provider to unblock"
    warn "port 25 or configure a relay, e.g. re-run with:"
    warn "  --relay-host smtp.example-relay.com --relay-port 587 --relay-user USER --relay-password PASS"
    warn "(Any SMTP relay works: Amazon SES, Postmark, Mailgun, Cloudflare Email Service, ...)"
  fi
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

# ---------------------------------------------------------------- summary
echo
bold "5050 Mail is running."
echo "  Install dir:  $DIR"
echo "  Settings:     $DIR/.env (mode 0600; keep a backup, it holds every secret)"
echo "  Webmail:      https://$MAIL_HOST"
echo "  Send:         https://$SEND_HOST   (dashboard, sign in with your mailbox)"
echo "  Send API:     https://$API_HOST    (Resend-compatible)"
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
