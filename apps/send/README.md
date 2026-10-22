# 5050 Send

A Resend-compatible email API. Point any official Resend SDK at it by changing
the base URL and the API key; endpoints, request fields, response shapes, error
JSON, status codes, `ratelimit-*` headers and pagination follow Resend.

```
 SDK / curl ──https──► api.example.com ─┐
 browser ──https──► send.example.com ───────┤  web role (Hono): public API · dashboard · /api/internal
 SMTP clients ──► smtp.example.com:2465/2587 ─► smtp role ─┐
                                                              ├─► Postgres send (core-1)
                         worker role ◄── jobs / LISTEN ───────┘
                              │  MIME (nodemailer) ─► Stalwart :2525 (self-hosted) or Cloudflare Email Sending (send_raw)
                              │  delivery outcomes ◄─ Stalwart webhook POST /internal/stalwart-events (self-hosted)
                              │                    or Cloudflare GraphQL analytics (emailSendingAdaptive)
                              └► webhooks (Svix signatures) → customer endpoints
```

- Spec and coverage checklist: [`docs/resend-api-spec.md`](docs/resend-api-spec.md)
- Dashboard JSON API: [`docs/internal-api.md`](docs/internal-api.md)
- SDK base-URL overrides and SMTP snippets: [`docs/integrations.md`](docs/integrations.md)

## Using it

```ts
import { Resend } from 'resend';
// RESEND_BASE_URL=https://api.example.com works too.
const resend = new Resend('re_xxxxxxxxx', { baseUrl: 'https://api.example.com' });
await resend.emails.send({ from: 'Acme <hi@yourdomain.com>', to: 'you@example.com', subject: 'Hi', html: '<p>Hi</p>' });
```

API keys are created in the dashboard (or with `POST /api-keys`); the token is
shown once and only its SHA-256 is stored. `onboarding@resend.dev` and the
`delivered@` / `bounced@` / `complained@` / `suppressed@resend.dev` test addresses
behave like on Resend.

## Layout

| path | what |
|---|---|
| `src/index.ts` | web role: public API (Host = `API_HOST`, or `/v/*` locally) and dashboard (Host = `DASHBOARD_HOST`) |
| `src/worker.ts` | worker role: job queue (sends, scheduled sends, broadcast fan-out, imports, automations, domain verification), webhook delivery with retries, analytics polling, stats rollups, retention |
| `src/smtp.ts` | SMTP relay role (username `resend`, password = API key) |
| `src/api/` | Resend-compatible routes (`routes/*.ts`, one file per resource) |
| `src/internal/` | dashboard login (Stalwart credentials), sessions, `/api/internal/*` |
| `src/services/` | send pipeline, domains/Cloudflare, webhooks, metrics, analytics, inbound, … |
| `src/cloudflare/` | Cloudflare API client (copied from `web/server/src/cloudflare.ts`) and its in-memory fake |
| `src/transport/` | `Transport` interface: Cloudflare `send_raw`, fake (tests/dev), log |
| `migrations/*.sql` | schema, applied in order (`npm run migrate`, or automatically on start) |
| `test/` | vitest: official-SDK contract tests, raw HTTP, isolation, SMTP, dashboard, docs examples, Python SDK |

## Run locally

```sh
docker run -d --name send-pg -e POSTGRES_USER=send -e POSTGRES_PASSWORD=sendpw -e POSTGRES_DB=send -p 55432:5432 postgres:16-alpine
npm ci
CLOUDFLARE_FAKE=1 WORKER_INLINE=1 npm run dev     # API at http://localhost:3000/v, dashboard at http://localhost:3000
npm run dev:smtp                                    # optional SMTP relay (needs SMTP_TLS_CERT/KEY)
npm test                                            # needs the Postgres container; dashboard tests use 5050-dev Stalwart on :18090
```

Nothing in tests or local dev talks to the real Cloudflare API: `TRANSPORT=fake`
(the default outside production) and `CLOUDFLARE_FAKE=1` keep everything in memory.

## Deploy

One image, three roles (see `Dockerfile`; non-root, `HEALTHCHECK` via `dist/healthcheck.js`):

| role | command | env | health |
|---|---|---|---|
| web | `node dist/index.js` | `ROLE=web` | `GET /health` (checks Postgres) |
| worker | `node dist/worker.js` | `ROLE=worker` | heartbeat file < 2 min old |
| smtp | `node dist/smtp.js` | `ROLE=smtp` | TCP connect to the first SMTP port |

Migrations run on start (`MIGRATE_ON_START=0` to disable; they are serialised with an advisory lock).

## Environment

| env | default | |
|---|---|---|
| `DATABASE_URL` | `postgres://send:sendpw@localhost:55432/send` | Production: `send` on core-1 |
| `STALWART_URL` | `http://localhost:18090` | Dashboard login: `GET {STALWART_URL}/jmap/session` with the user's mail credentials |
| `CLOUDFLARE_API_TOKEN` | — | Email Sending send + subdomains, Zone:Read, DNS:Edit; add **Account Analytics:Read** for delivery events |
| `CLOUDFLARE_ACCOUNT_ID` | — | Account for `send_raw` and analytics |
| `CLOUDFLARE_CREATE_ZONES` | off | Opt-in: add external domains to the account as pending zones so Email Sending can onboard them (needs Zone:Edit) |
| `API_HOST` | `api.example.com` | Host that serves the public API at `/` |
| `DASHBOARD_HOST` | `send.example.com` | Host that serves the dashboard and `/api/internal/*` |
| `PUBLIC_API_BASE` | `https://$API_HOST` | Absolute base used in generated links (attachment downloads, raw emails) |
| `PUBLIC_TRACKING_BASE` | `PUBLIC_API_BASE` | Base for the open pixel, click redirect and unsubscribe links |
| `DASHBOARD_BASE` | `https://$DASHBOARD_HOST` | Base for share links (`/shared?token=`) |
| `SESSION_SECRET` | dev value | **Required in production (≥ 32 chars).** HMAC key for tracking/share/unsubscribe/download tokens; encrypts the stored Stalwart credential |
| `TRANSPORT` | `cloudflare` in production, else `fake` | `cloudflare`, `fake` (refused in production) or `log` |
| `TRUST_PROXY` | off | Honour `CF-Connecting-IP` / `X-Forwarded-*` (set behind the tunnel) |
| `DEFAULT_RATE_LIMIT` | `2` | Requests per second per team (admins can change per team) |
| `DEFAULT_MONTHLY_QUOTA` / `DEFAULT_DAILY_QUOTA` | `3000` / none | Per-team email quotas for new teams |
| `SANDBOX_DOMAIN` | `resend.dev` | The shared test sender domain |
| `SANDBOX_SENDER` | — | Real sender used when a `resend.dev` email goes to a team member (we can't send as resend.dev) |
| `SMTP_HOSTNAME` | `smtp.example.com` | SMTP banner / certificate name |
| `SMTP_PORTS_TLS` | `465,2465` | Implicit-TLS ports (mail-1: `2465`, Stalwart owns 465) |
| `SMTP_PORTS_STARTTLS` | `587,2587` | STARTTLS ports (mail-1: `587,2587`) |
| `SMTP_TLS_CERT` / `SMTP_TLS_KEY` | — | PEM files, hot-reloaded on change |
| `ACME_ENABLED`, `ACME_EMAIL`, `ACME_DIRECTORY`, `ACME_STATE_DIR` | off | Built-in ACME DNS-01 issuer for the SMTP certificate via Cloudflare DNS |
| `INBOUND_SECRET` | — | Bearer secret for `POST /inbound` (raw MIME push from the receiving relay) |
| `INBOUND_JMAP_URL`, `INBOUND_JMAP_USER`, `INBOUND_JMAP_PASSWORD` | — | Receiving via a Stalwart catch-all mailbox (worker polls JMAP); also `INBOUND_JMAP_MODE`, `INBOUND_JMAP_MAILBOX`, `INBOUND_JMAP_INTERVAL_SEC` |
| `INBOUND_MX_HOST` | `inbound.example.com` | MX shown in a receiving domain's records |
| `INBOX_LIMIT_PER_TEAM`, `INBOX_FORWARDING_DOMAIN` | unlimited / — | Inboxes plan limit; domain for inbox forwarding addresses |
| `TRACKING_CNAME_TARGET` | `$API_HOST` | CNAME target shown for a domain's tracking subdomain |
| `DMARC_VALUE` | `v=DMARC1; p=none;` | DMARC policy published/suggested for new domains |
| `ANALYTICS_POLL_INTERVAL_SEC` | `60` | Cloudflare analytics poll interval |
| `LOG_RETENTION_DAYS` | `30` | API request logs, finished webhook events |
| `WORKER_INLINE` | off | Run the worker loops inside the web process (dev) |
| `REQUIRE_USER_AGENT` | on | Reject requests without `User-Agent` (403 `error code: 1010`, like Resend's edge) |
| `COOKIE_SECURE`, `COOKIE_NAME`, `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS`, `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_SEC`, `LOGIN_GLOBAL_FAIL_LIMIT` | | Dashboard session and login limits (same posture as the webmail BFF) |
| `PORT`, `HOST`, `MIGRATE_ON_START`, `MAX_BODY_BYTES`, `DNS_SERVERS`, `BROADCAST_FANOUT_BATCH`, `WORKER_POLL_MS` | | Tuning |
| `CLOUDFLARE_FAKE`, `ALLOW_PRIVATE_WEBHOOKS`, `DEFAULT_SURFACE` | | Test/dev only (`CLOUDFLARE_FAKE` and `ALLOW_PRIVATE_WEBHOOKS` are refused in production) |

## Access model

Dashboard users sign in with their **mail account** (verified against Stalwart).
Only members of a team get in; Stalwart admins (detected via `x:Account/query`,
as the webmail `/api/me` does) can create teams, manage members and roles
(`admin` / `member`), set quotas and rate limits, and reach every team.
