# 5050 Mail

Self-hosted business email on your own domains, set up with one command on a Linux VM.

- **5050 Mail**: Gmail-style webmail plus an admin console for domains, users, aliases, groups and quotas.
- **5050 Send**: a Resend-compatible email API with an SMTP relay and a dashboard. Point any official Resend SDK at it.
- **Mail server**: [Stalwart](https://github.com/stalwartlabs/stalwart) (SMTP, IMAP, JMAP). The upstream image is used unmodified and pinned.

AGPL-3.0. No telemetry, no external service required. Cloudflare is optional.

```sh
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash
```

## Quickstart

You need:

- A Linux VM with a public IPv4 address. 2 vCPU / 4 GB RAM is enough to start.
- A domain where you can edit DNS.
- Ideally, outbound port 25 open. Many clouds block it; see [Outbound mail](#outbound-mail).

```sh
# Interactive: explains what it will do, then asks for the domain and the admin mailbox
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash

# Non-interactive
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash -s -- \
  --domain example.com --admin-email you@example.com --yes

# DNS records and certificates through Cloudflare
... | sudo bash -s -- --domain example.com --cloudflare-token "$CF_TOKEN" --yes
```

Before it changes anything, the installer says what it will install, which ports the containers use, where the secrets are kept (`/opt/5050-mail/.env`, mode 0600), that nothing is sent to us, and how to uninstall. It asks once whether to continue (`--yes` skips the question).

Then it:

1. Installs Docker if it's missing.
2. Asks whether your domain's DNS is on Cloudflare. If yes, it shows how to create the token and does the DNS for you. If no, it prints the records and checks them once you've added them.
3. Builds the images and starts the stack, as numbered steps with a spinner. The full output is in `/opt/5050-mail/install.log`.
4. Creates the first domain and the admin mailbox.
5. Ends with a summary: webmail, admin console, 5050 Send, the admin mailbox and its one-time password, mail-app settings, and what it changed in your DNS.

The Cloudflare token needs **Zone > DNS > Edit** and **Zone > Zone > Read**, ideally limited to your zone, plus **Account > Email Sending > Edit** if you send through Cloudflare. It is used only for your zone's DNS and Email Sending, stored only in `.env`, and you can revoke it any time. Details: [Cloudflare token](site/src/docs/dns.md#cloudflare-token).

Re-running it is safe. Once your DNS records are in place:

| | |
|---|---|
| Webmail | `https://mail.example.com` |
| Admin console | `https://mail.example.com/admin` |
| Send dashboard | `https://send.example.com` (sign in with your mailbox) |
| Send API | `https://api.example.com` (Resend-compatible) |
| IMAP / SMTP | `mail.example.com`, 993 / 465 / 587 |
| Send SMTP relay | `mail.example.com`, 2465 (TLS) / 2587 (STARTTLS), user `resend`, password = API key |

Outbound port 25 is blocked on most clouds. The installer detects it, names your provider and offers a relay (it tests the login before saving, and flushes the queue afterwards):

| Relay | `--relay` | Server |
|---|---|---|
| Cloudflare Email Service | `cloudflare` | `smtp.mx.cloudflare.net:465`, user `api_token`, an API token with Email Sending: Edit |
| Resend | `resend` | `smtp.resend.com:465`, user `resend`, API key |
| Amazon SES | `ses` (`--relay-region`) | `email-smtp.<region>.amazonaws.com:587` |
| Postmark | `postmark` | `smtp.postmarkapp.com:587` |
| Mailgun | `mailgun` | `smtp.mailgun.org:587` |
| Brevo | `brevo` | `smtp-relay.brevo.com:587` |
| SMTP2GO | `smtp2go` | `mail.smtp2go.com:2525` |

```sh
sudo /opt/5050-mail/install.sh --relay                # menu, on an existing install
sudo /opt/5050-mail/install.sh --relay resend --relay-password "$KEY" --yes
sudo /opt/5050-mail/install.sh --relay-host smtp.example.com --relay-port 587 --relay-user U --relay-password P --yes
sudo /opt/5050-mail/install.sh --relay-test           # re-validate the saved relay login
```

Other commands:

```sh
sudo /opt/5050-mail/install.sh --upgrade              # pull the new version, rebuild, restart
sudo /opt/5050-mail/install.sh --uninstall            # remove containers, keep data
sudo /opt/5050-mail/install.sh --uninstall --purge    # delete everything, including mail
sudo /opt/5050-mail/install.sh --help
```

To try it with a fake domain on a laptop or test VM, add `--tls internal`. Caddy and Stalwart then use self-signed certificates.

### DNS records

The installer prints the records you need:

- `A` records for `mail.`, `send.` and `api.`
- `MX` → `mail.<domain>`
- SPF (`v=spf1 mx -all`)
- Two DKIM keys (Ed25519 + RSA)
- DMARC (`p=reject`)
- TLS-RPT

Also ask your VPS provider to set the **reverse DNS (PTR)** of the server IP to `mail.<domain>`. Without it, big receivers spam-folder or reject direct mail.

## Features

**Webmail**
- Gmail-style layout and keyboard shortcuts: threads, labels, categories, snooze, search operators, drag and drop.
- Rich-text compose with signatures, inline images and attachments.
- Remote images are blocked by default, and HTML mail is sanitized inside a sandboxed frame.
- Light and dark themes, three density settings, installable as a PWA.
- Talks JMAP to Stalwart through a small backend-for-frontend: the password never reaches browser storage, and sessions are stored in Postgres.

**Admin console** (for Stalwart admins, in the same app)
- Domains: create a domain and see its DNS records. **Check DNS** verifies them against public DNS.
- With a Cloudflare token, one click publishes the records to the zone, and Stalwart can keep them in sync and get certificates by DNS-01.
- Users, aliases, groups and mailing lists, quotas and password resets.
- DKIM key, certificate and background-task health for each domain.

**5050 Send**
- Resend-compatible REST API: the official SDKs work after changing the base URL. Covers emails (including batch and scheduled), domains, API keys, contacts, audiences, broadcasts, templates, webhooks, inbound and more. See [apps/send/docs](apps/send/docs).
- SMTP relay: username `resend`, password = an API key.
- Every sending domain gets its own DKIM key, and Send signs mail before handing it to Stalwart for delivery. Domains are verified against public DNS.
- Delivery tracking: Stalwart reports every outcome (delivered, bounced, deferred) to Send, so emails move from `sent` to `delivered` / `bounced` / `delivery_delayed` and hard bounces are suppressed, whether mail goes out directly on port 25 or through a relay. No Cloudflare needed.
- Open and click tracking, unsubscribe links, suppressions, webhooks with Svix-style signatures.
- Multi-team dashboard: sign in with your mailbox, and Stalwart admins manage teams, quotas and rate limits.

**Operations**
- Single `docker compose` stack.
- Healthchecks and restart policies on every service.
- Read-only containers where possible.
- Node services run one process per CPU core.
- Postgres stores everything: mail, blobs, sessions and Send data.

## Architecture

```
                 :443 / :80                         :25 :465 :587 :993            :2465 :2587
 browsers ───────────► Caddy ───────────┐     MTAs / mail apps ──► Stalwart    apps ──► send-smtp
                (automatic HTTPS, HSTS) │                            ▲    │                 │
            mail.<d>  → webmail (BFF) ──┼── JMAP (X-Forwarded-For) ──┘    │                 │
            send.<d>  → send-web ───────┤                                 │                 │
            api.<d>   → send-web ───────┘        send-worker ── SMTP :2525 (internal) ──────┘
                                                      │                   │
                                                      └──── Postgres ◄────┘  (stalwart, send, webmail databases)
```

| Service | Image | What it does |
|---|---|---|
| `caddy` | `caddy:2.10` | TLS termination and routing, HSTS. Forwards Stalwart's HTTP-01 challenges for the mail host. |
| `stalwart` | `stalwartlabs/stalwart:v0.16.27` (pinned by digest) | SMTP in and out, IMAP, JMAP, DKIM, DMARC, queues. Its HTTP API is reachable only on the internal network. |
| `webmail` | `apps/webmail` | React SPA plus a Hono BFF that proxies JMAP and serves the admin APIs (DNS check, Cloudflare). |
| `send-web` | `apps/send` | Public API on `api.<d>`, dashboard and internal API on `send.<d>`. |
| `send-worker` | `apps/send` | Job queue (sends, broadcasts, imports, domain verification), webhooks, rollups. |
| `send-smtp` | `apps/send` | SMTP relay for apps, using the mail host's certificate. |
| `postgres` | `postgres:16` | One database each for Stalwart, Send and webmail sessions. |

Stalwart is configured from the environment by [`server/bootstrap.mjs`](server/bootstrap.mjs), which uses its management API and is idempotent. Only the data store is set in [`server/config.json`](server/config.json).

### Outbound mail

By default Stalwart delivers directly to recipients' MX servers on port 25. If your provider blocks outbound 25, the installer detects it. In that case, either ask the provider to open it or use any SMTP relay:

```sh
sudo /opt/5050-mail/install.sh --relay-host email-smtp.us-east-1.amazonaws.com --relay-port 587 \
  --relay-user AKIA... --relay-password '...'
```

Amazon SES, Postmark, Mailgun and Cloudflare Email Service all work. With Cloudflare Email Service as the relay, also set `CLOUDFLARE_EMAIL_SENDING=1` so one-click domain setup onboards new domains for sending.

### Resources and scaling

Measured idle, 60 s after a fresh install on a 2 vCPU / 4 GB VM (Ubuntu 24.04, `WEB_CONCURRENCY=auto`):

| Service | Memory |
|---|---|
| Postgres | 64 MB |
| Stalwart | 61 MB |
| send-web | 60 MB |
| webmail | 42 MB |
| send-smtp | 31 MB |
| send-worker | 25 MB |
| Caddy | 12 MB |

The host used about 1.2 GB in total, with 2.7 GB available and CPU near 0%. Memory grows with mailbox count, search indexes and traffic: Stalwart and Postgres caches are the first to expand. Bench results comparing a single process with one process per core are in [bench/](bench/).

Scaling up:

- **More cores**: `WEB_CONCURRENCY` (default `auto` = one process per core) applies to webmail, send-web and send-smtp. Keep total Postgres connections, roughly processes × `PG_POOL_MAX`, below `max_connections` (200).
- **More send throughput**: raise `SEND_WORKER_CONCURRENCY`. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so workers never double-process. Periodic tasks run in one process only.
- **More machines**: everything stateful is in Postgres, so you can run more webmail and send-web containers on other hosts behind any load balancer, pointed at the same database. Use a managed Postgres for HA. Stalwart supports clustering on its own; see its docs.
- **Per-process limits**: login throttles and per-team API rate limits are held in memory, so they apply per process. With N processes a team can reach about N × its configured rate.

## Configuration

Everything lives in `/opt/5050-mail/.env`; [`.env.example`](.env.example) documents every key. After editing it, re-run `install.sh` (or `docker compose ... up -d`).

### Custom domains

1. Admin console → **Domains** → **Add domain**.
2. Add the records shown on the domain page at your DNS provider, then click **Check DNS**.
3. If the domain's zone is in your Cloudflare account and you configured a token, **Publish records** does step 2 for you. Alternatively, choose automatic DNS management when creating the domain.

New domains use `mail.<primary domain>` as their MX, so they need no new A record or certificate.

Sending domains in 5050 Send are separate: each team adds its own domains in the Send dashboard or with the API. Those domains are never added to the mail server, so a team can't capture mail for a domain it doesn't control.

## Comparison

| | 5050 Mail | Mailcow | Mail-in-a-Box | Stalwart alone | Google Workspace / M365 |
|---|---|---|---|---|---|
| One-command install | yes | yes | yes (whole box) | partly | n/a |
| Modern webmail | Gmail-style, JMAP | SOGo | Roundcube | basic web UI | yes |
| Admin console for domains/users | yes | yes | yes | yes | yes |
| Transactional email API | Resend-compatible | no | no | no | no |
| Storage | Postgres | MariaDB + files | files | many backends | n/a |
| Footprint | ~1.2 GB RAM at idle | 6 GB+ recommended | dedicated box | small | n/a |
| Cost | your VM | your VM | your VM | your VM | per user per month |
| Calendars/contacts UI | not yet | yes | yes | CalDAV/CardDAV only | yes |

Be honest with yourself about email: running your own server means watching deliverability, IP reputation and blocklists. A relay helps when your VM's IP has a poor reputation.

## Repository layout

```
apps/webmail/   webmail + admin console (React, Hono BFF)
apps/send/      5050 Send (API, worker, SMTP relay; web/ = dashboard)
server/         Stalwart config.json + bootstrap.mjs
deploy/         docker-compose.yml, Caddyfile, Postgres init
install.sh      one-command installer
site/           landing page and docs
```

Development: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its source to its users. Stalwart is AGPL-3.0 too, and is used unmodified from its upstream image.
