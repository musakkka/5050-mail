---
title: Configuration reference
description: Every installer flag and every setting in /opt/5050-mail/.env.
---

# Configuration reference

All configuration lives in one file, `/opt/5050-mail/.env` (mode `0600`), written by the installer. The repository's `.env.example` documents every key. To change a setting, edit the file and re-run the installer:

```sh
sudo nano /opt/5050-mail/.env
sudo /opt/5050-mail/install.sh
```

Re-running keeps every existing value and generated secret, and reconciles the stack. Keep a copy of `.env` somewhere safe: it holds every secret.

## Installer flags

| Flag | Meaning |
|---|---|
| `--domain DOMAIN` | Primary mail domain, for example `example.com` |
| `--admin-email EMAIL` | First admin mailbox (default `admin@DOMAIN`) |
| `--admin-password PASS` | Its password, at least 8 characters (default: generated and printed once) |
| `--mail-host HOST` | Webmail, SMTP and IMAP hostname (default `mail.DOMAIN`) |
| `--send-host HOST` | 5050 Send dashboard (default `send.DOMAIN`) |
| `--api-host HOST` | 5050 Send API (default `api.DOMAIN`) |
| `--tls acme\|internal` | `acme`: Let's Encrypt (default). `internal`: self-signed, for test domains |
| `--cloudflare-token TOKEN` | Create DNS records and get certificates through Cloudflare |
| `--relay-host HOST` `--relay-port PORT` `--relay-user USER` `--relay-password PASS` | Outbound smarthost, for when port 25 is blocked |
| `--send-transport smtp\|log` | 5050 Send delivery: `smtp` through the mail server (default), or `log` to drop mail (testing) |
| `--dir DIR` | Install directory (default `/opt/5050-mail`) |
| `--source DIR` | Install from a local checkout instead of GitHub |
| `--yes` | Never prompt |
| `--skip-port25-check` | Don't probe outbound port 25 |
| `--upgrade` | Update the source, rebuild and restart |
| `--uninstall [--purge]` | Stop and remove the containers; `--purge` also deletes all mail and data |

Environment equivalents: `MAIL_DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TLS_MODE`, `CLOUDFLARE_API_TOKEN`, `RELAY_HOST`, `RELAY_PORT`, `RELAY_USERNAME`, `RELAY_PASSWORD`, `SEND_TRANSPORT`, `FIVEFIFTY_DIR`, `FIVEFIFTY_SRC` and `ASSUME_YES=1`.

## Domains and hostnames

| Key | Example | Meaning |
|---|---|---|
| `MAIL_DOMAIN` | `example.com` | Primary mail domain. More are added in the admin console. |
| `MAIL_HOSTNAME` | `mail.example.com` | Webmail and SMTP/IMAP host, and the `MX` target. Needs an `A` record. |
| `SEND_HOST` | `send.example.com` | 5050 Send dashboard |
| `API_HOST` | `api.example.com` | 5050 Send API |
| `ADMIN_EMAIL` | `admin@example.com` | First admin mailbox, created on the first install |
| `ACME_EMAIL` | `admin@example.com` | Let's Encrypt contact |
| `SUPPORT_EMAIL` | `postmaster@example.com` | Shown in the Send dashboard's help links |
| `PUBLIC_IPV4`, `PUBLIC_IPV6` | | Detected by the installer; used in the printed DNS records |

## TLS

| Key | Default | Meaning |
|---|---|---|
| `TLS_MODE` | `acme` | `acme`, or `internal` for self-signed certificates on test domains |
| `STALWART_TLS_MODE` | `acme` | The mail server's certificates: HTTP-01 through Caddy, or DNS-01 with Cloudflare. Set by the installer from `TLS_MODE`. |
| `CADDY_GLOBAL_OPTIONS`, `CADDY_CERT_ISSUER` | | Set by the installer from `TLS_MODE` |

## Secrets

Generated once by the installer, never overwritten.

| Key | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser |
| `STALWART_DB_PASSWORD`, `SEND_DB_PASSWORD`, `WEBMAIL_DB_PASSWORD` | One database user each for the mail server, 5050 Send and the webmail |
| `STALWART_ADMIN` | Mail server recovery admin, `user:password`. Only reachable on the internal network. |
| `WEBMAIL_SESSION_SECRET`, `SEND_SESSION_SECRET` | Session and signing keys |
| `STALWART_EVENTS_SECRET` | Shared secret the mail server presents when it reports delivery outcomes to 5050 Send. If it is empty, [delivery tracking](/docs/webhooks/#delivery-tracking) is off and emails stay at `sent`. |

## Outbound delivery

By default the mail server delivers directly to each recipient's `MX` on port 25. Set a relay if your provider blocks it ([details](/docs/requirements/#send-through-a-relay)).

| Key | Default | Meaning |
|---|---|---|
| `RELAY_HOST` | empty | Smarthost hostname. Empty means direct delivery. |
| `RELAY_PORT` | `587` | `465` uses implicit TLS, `587` STARTTLS |
| `RELAY_USERNAME`, `RELAY_PASSWORD` | | Smarthost credentials |

## Cloudflare (optional)

| Key | Meaning |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with Zone: Read and DNS: Edit. The installer creates the DNS records, the mail server gets certificates with DNS-01 and keeps MX, SPF, DKIM and DMARC published, and the admin console offers one-click setup for new domains. |
| `CLOUDFLARE_ACCOUNT_ID` | Limits zone lookups to one account |
| `CLOUDFLARE_ZONE` | Only if the zone is not `MAIL_DOMAIN` itself |
| `CLOUDFLARE_EMAIL_SENDING` | `1` only when `RELAY_HOST` is Cloudflare Email Service |

## 5050 Send

| Key | Default | Meaning |
|---|---|---|
| `SEND_TRANSPORT` | `smtp` | `smtp`: deliver through the mail server. `log`: drop mail (testing). |
| `SEND_DOMAIN_RECORDS` | `local` | Sending domains get their own DKIM keys and are verified in public DNS |
| `SEND_DEFAULT_RATE_LIMIT` | `10` | API requests per second per team, per process |
| `SEND_DEFAULT_MONTHLY_QUOTA` | `50000` | Emails per month for new teams |
| `SEND_WORKER_CONCURRENCY` | `1` | Worker processes for the send queue |
| `SEND_SMTP_CONCURRENCY` | `1` | Processes for the SMTP relay |
| `SEND_PG_POOL_MAX` | `5` | Postgres connections per Send process |
| `DOCS_BASE` | GitHub repository | Where the dashboard's docs links point |

## Scaling and images

| Key | Default | Meaning |
|---|---|---|
| `WEB_CONCURRENCY` | `auto` | Processes per Node service (webmail, Send web). `auto` = one per CPU core. |
| `INTERNAL_SUBNET` | `172.30.50.0/24` | Docker network for the stack |
| `IMAGE_PREFIX` | `ghcr.io/musakkka/5050-mail` | Image name prefix |
| `VERSION` | `latest` | Image tag |
| `DNS_SERVERS` | system resolvers | Resolvers for the admin console's **Check DNS** |
