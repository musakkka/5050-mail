# 5050 Send integrations

5050 Send speaks the Resend API and Resend's SMTP protocol. Existing Resend code
works after changing two things: the **base URL** (`https://api.example.com`)
and the **API key** (a 5050 Send `re_…` key).

## Official SDKs: base URL override

Verified against each SDK's source (October 2026). "Env" is read when the client
is created unless noted.

| SDK | Package | Override in code | Env variable | Notes |
|---|---|---|---|---|
| Node.js | `resend` (npm) | `new Resend(key, { baseUrl: 'https://api.example.com' })` | `RESEND_BASE_URL` | Tested: contract suite runs every SDK method against the server. |
| Python | `resend` (PyPI) | `resend.api_url = "https://api.example.com"` | `RESEND_API_URL` (read at import) | Tested: `test/sdks/python.test.ts` (resend 2.50.0). Not `RESEND_BASE_URL`. |
| PHP | `resend/resend-php` | none (`Resend::client($key)` only) | `RESEND_BASE_URL` | Value may omit the scheme (`api.example.com` → https). |
| Laravel | `resend/resend-laravel` | — | `RESEND_BASE_URL` | Uses resend-php underneath; set `RESEND_API_KEY` too. |
| Ruby | `resend` (gem) | none | `RESEND_BASE_URL` | Read when the gem loads (constant); must end with `/`. |
| Go | `github.com/resend/resend-go/v4` | `client.BaseURL, _ = url.Parse("https://api.example.com/")` | `RESEND_BASE_URL` | Read at package init; keep the trailing `/` (paths are resolved relative). |
| Rust | `resend-rs` | `Resend::with_config(Config::builder(key).base_url(url).build())` | `RESEND_BASE_URL` | Base path is preserved. Client-side limiter: `RESEND_RATE_LIMIT`. |
| Java | `com.resend:resend-java` | `Resend.builder().apiKey(key).baseUrl("https://api.example.com").build()` | — | |
| .NET | `Resend` (NuGet) | `ResendClientOptions.ApiUrl = "https://api.example.com"` | — | Requests use absolute paths (`/emails`), so the base URL must be a host root, never a path prefix like `/v`. |
| Elixir (community) | `resend` (hex) | `Resend.client(api_key: key, base_url: "https://api.example.com")` | — | Or `config :resend, Resend.Client, base_url: …`. |

Local development: the server also exposes the public API under `/v`
(`http://localhost:3000/v`), which works for every SDK above except .NET.

Go and PHP were not smoke-tested (no toolchain on the build machine); the
override lines above come from their source code.

## SMTP relay (Resend's `smtp.resend.com`)

| Setting | Value |
|---|---|
| Host | `smtp.example.com` |
| Username | `resend` |
| Password | an API key (`full_access` or `sending_access`) |
| Implicit TLS (SMTPS) | `SMTP_PORTS_TLS`, default `465, 2465` |
| STARTTLS | `SMTP_PORTS_STARTTLS`, default `587, 2587` |
| Max message size | 40 MB (`SMTP_MAX_MESSAGE_BYTES`) |

Production plan: run the relay on mail-1 with `SMTP_PORTS_TLS=2465` and
`SMTP_PORTS_STARTTLS=2587,587` because Stalwart owns 25 and 465 there. Resend
also offers 25 for STARTTLS; we don't (Stalwart's inbound MX listens there).

Behaviour (same pipeline as `POST /emails`):

- AUTH (PLAIN/LOGIN) is only offered after TLS; on STARTTLS ports clients must upgrade first (538 otherwise).
- Domain-restricted keys may only send from their domain; the `from` domain must be verified (550 5.7.1 otherwise).
- `Resend-Idempotency-Key` header: same 24 h semantics as the API header. Retries with the same headers and body return the original `250 2.0.0 OK <email id>`; a different body is refused with 550.
- Custom headers pass through (e.g. `X-Entity-Ref-ID` to stop Gmail threading, `List-Unsubscribe`).
- `X-Resend-Tags: name=value, name2=value2` sets tags. This is a 5050 Send extension; Resend does not document tags over SMTP.
- Bcc is taken from the SMTP envelope (recipients not in To/Cc).
- Emails sent over SMTP can't be scheduled (as on Resend). The team's API rate limit applies.
- Successful sends reply `250 2.0.0 OK <email_id>`; the email shows up in `GET /emails`, webhooks fire as usual, and the dashboard's Logs page lists the send (source `smtp`).
- Reply codes: 535 bad credentials, 454 too many failed logins, 550 policy/validation, 553 bad address, 552 too large, 452 quota exceeded or too many recipients, 451 rate limit or temporary error.

TLS certificates: `SMTP_TLS_CERT` / `SMTP_TLS_KEY` (PEM files, reloaded
automatically when replaced), or `ACME_ENABLED=1` to have the relay obtain and
renew a Let's Encrypt certificate for `SMTP_HOSTNAME` itself with DNS-01 through
the Cloudflare API (`CLOUDFLARE_API_TOKEN` needs DNS:Edit on the zone;
`ACME_EMAIL`, `ACME_DIRECTORY`, `ACME_STATE_DIR`). Renewal runs 30 days before
expiry.

## Framework and platform snippets

The dashboard reads ready-to-copy snippets (host, ports and username filled in)
from `GET /api/internal/teams/:teamId/integrations`:

- SMTP: Nodemailer, Django, Laravel, Rails/ActionMailer, Spring Boot, PHPMailer,
  NextAuth.js, Supabase Auth custom SMTP, WordPress (WP Mail SMTP), Strapi,
  Payload CMS, and a generic client.
- Platforms with custom SMTP: Clerk, Auth0, Firebase Authentication, Kinde,
  Appwrite, Customer.io, Metabase, Retool, Liferay, Coolify, Gravity SMTP, Post
  SMTP, Pulsetic.
- API-based integrations from Resend's list (n8n, Zapier, Make, Pipedream,
  Activepieces, Courier, Novu, Knock, Convex, Inngest, Trigger.dev, Medusa,
  PostHog, Vercel/v0, Lovable, Raycast): these call api.resend.com and work with
  5050 Send only if they allow a custom base URL; otherwise use the SMTP settings.
