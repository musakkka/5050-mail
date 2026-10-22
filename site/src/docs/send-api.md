---
title: Send API
description: 5050 Send speaks Resend's API. Change the base URL and API key in any official Resend SDK, or call it with curl.
---

# Send API

5050 Send implements Resend's REST API: the same endpoints, request fields, response shapes, error JSON, status codes, `ratelimit-*` headers and pagination. Code written for Resend works after changing two things:

1. the **base URL**, from `https://api.resend.com` to `https://api.example.com`,
2. the **API key**, to a key from your 5050 Send dashboard.

## API keys

Create keys in the [dashboard](/docs/send-dashboard/) under **API Keys**, or with `POST /api-keys`. A key looks like `re_…`, is shown once, and only its SHA-256 hash is stored.

| Permission | Can call |
|---|---|
| `full_access` | every endpoint |
| `sending_access` | only `POST /emails`, `POST /emails/batch`, the inbox reply/forward/draft endpoints, and SMTP. Optionally limited to one domain. |

Send the key as a bearer token, and always send a `User-Agent` (requests without one get `403`, as on Resend):

```sh
curl https://api.example.com/emails \
  -H 'Authorization: Bearer re_xxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "Acme <hello@example.com>",
    "to": ["you@example.org"],
    "subject": "Hello from 5050 Send",
    "html": "<p>It works.</p>"
  }'
```

```json title="200 OK"
{ "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }
```

The `from` domain must be a [verified domain](#domains) of your team.

## SDKs: change the base URL

### Node.js

```ts
import { Resend } from 'resend';

const resend = new Resend('re_xxxxxxxxx', { baseUrl: 'https://api.example.com' });

await resend.emails.send({
  from: 'Acme <hello@example.com>',
  to: 'you@example.org',
  subject: 'Hello',
  html: '<p>It works.</p>',
});
```

Or leave the code alone and set `RESEND_BASE_URL=https://api.example.com` in the environment.

### Python

```python
import resend

resend.api_key = "re_xxxxxxxxx"
resend.api_url = "https://api.example.com"

resend.Emails.send({
    "from": "Acme <hello@example.com>",
    "to": ["you@example.org"],
    "subject": "Hello",
    "html": "<p>It works.</p>",
})
```

The Python SDK reads `RESEND_API_URL` (not `RESEND_BASE_URL`) when it is imported.

### Go

```go
client := resend.NewClient("re_xxxxxxxxx")
client.BaseURL, _ = url.Parse("https://api.example.com/") // keep the trailing slash

sent, err := client.Emails.Send(&resend.SendEmailRequest{
    From:    "Acme <hello@example.com>",
    To:      []string{"you@example.org"},
    Subject: "Hello",
    Html:    "<p>It works.</p>",
})
```

Or set `RESEND_BASE_URL=https://api.example.com/` before the program starts (it is read at package init).

### PHP and Laravel

The PHP SDK has no base URL option in code; set the environment variable:

```env
RESEND_BASE_URL=https://api.example.com
RESEND_API_KEY=re_xxxxxxxxx
```

Laravel's `resend/resend-laravel` uses the PHP SDK underneath, so the same variables apply.

### Ruby

```sh
export RESEND_BASE_URL=https://api.example.com/   # read when the gem loads; keep the trailing slash
```

### Other SDKs

| SDK | Override |
|---|---|
| Rust `resend-rs` | `Resend::with_config(Config::builder(key).base_url(url).build())`, or `RESEND_BASE_URL` |
| Java `resend-java` | `Resend.builder().apiKey(key).baseUrl("https://api.example.com").build()` |
| .NET `Resend` | `ResendClientOptions.ApiUrl = "https://api.example.com"` (must be a host root, not a path) |
| Elixir `resend` | `Resend.client(api_key: key, base_url: "https://api.example.com")` |

The Node.js and Python SDKs are covered by automated contract tests against 5050 Send. The Go and PHP overrides come from those SDKs' source code and have not been smoke-tested yet.

## Endpoints

Every path is relative to the base URL.

| Resource | Endpoints |
|---|---|
| Emails | `POST /emails` · `POST /emails/batch` · `GET /emails` · `GET /emails/:id` · `PATCH /emails/:id` (reschedule) · `POST /emails/:id/cancel` · `POST /emails/:id/share` · `GET /emails/:id/attachments` · `GET /emails/:id/attachments/:aid` · `GET /emails/metrics` |
| Receiving | `GET /emails/receiving` · `GET /emails/receiving/:id` · `GET /emails/receiving/:id/attachments` · `GET /emails/receiving/:id/attachments/:aid` |
| Domains | `POST /domains` · `GET /domains` · `GET /domains/:id` · `PATCH /domains/:id` · `DELETE /domains/:id` · `POST /domains/:id/verify` · `POST /domains/claim` · `GET /domains/:id/claim` · `POST /domains/:id/claim/verify` |
| API keys | `POST /api-keys` · `GET /api-keys` · `PATCH /api-keys/:id` · `DELETE /api-keys/:id` |
| Contacts | `POST /contacts` · `GET /contacts` · `GET/PATCH/DELETE /contacts/:id_or_email` · contact segments and topics · `POST /contacts/imports` (CSV) · `GET /contacts/imports[/:id]` |
| Segments, audiences | `POST/GET /segments` · `GET/PATCH/DELETE /segments/:id` · legacy `/audiences` paths |
| Topics, contact properties | `POST/GET /topics` · `GET/PATCH/DELETE /topics/:id` · same shape for `/contact-properties` |
| Broadcasts | `POST/GET /broadcasts` · `GET/PATCH/DELETE /broadcasts/:id` · `POST /broadcasts/:id/send`, `/cancel`, `/duplicate` · recipients and clicked links |
| Templates | `POST/GET /templates` · `GET/PATCH/DELETE /templates/:id_or_alias` · `POST …/publish` · `POST …/duplicate` |
| Webhooks | `POST/GET /webhooks` · `GET/PATCH/DELETE /webhooks/:id` · `POST /webhooks/:id/signing-secret/rotate` · events, attempts and replay |
| Suppressions | `POST/GET /suppressions` · `GET/DELETE /suppressions/:id_or_email` · `POST /suppressions/batch/add`, `/batch/remove` |
| Events, automations | `POST/GET /events` · `POST /events/send` · `POST/GET /automations` · runs, stop, duplicate |
| Inboxes | inboxes, labels, threads, thread emails (reply, forward), drafts |
| Logs, usage | `GET /logs` · `GET /logs/:id` · `GET /usage` |

Not implemented yet: Resend's OAuth authorization server (`/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`); the grants list exists and is empty.

## Sending details

- `to` takes up to 50 addresses. `cc`, `bcc`, `reply_to`, `headers`, `tags` and `attachments` work as on Resend; attachments can be base64 `content` or a `path` URL fetched at send time, up to 40 MB per email.
- `scheduled_at` accepts ISO 8601 or natural language (`"in 1 hour"`, `"tomorrow at 9am"`), up to 30 days ahead.
- `POST /emails/batch` takes up to 100 emails. Header `x-batch-validation: permissive` creates the valid ones and returns errors for the rest.
- `Idempotency-Key` (1 to 256 characters, 24 hours) makes retries safe: the same key and body replay the original response; a different body returns `409`.
- Test addresses behave as on Resend: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`, `suppressed@resend.dev`.

## Domains

A team can only send from domains it has verified. `POST /domains` (or **Domains → Add domain** in the dashboard) creates the domain with its own DKIM key and returns the records to publish: DKIM (`send5050._domainkey`), SPF and DMARC. `POST /domains/:id/verify` checks them in public DNS. 5050 Send signs each message with the domain's key before handing it to your mail server for delivery. [The records, explained](/docs/dns/#sending-domains-in-5050-send).

Domains are unique across teams. If another team already registered yours, use `POST /domains/claim` and publish the TXT record it returns to move it.

## Errors

Errors use Resend's shape and names:

```json
{ "statusCode": 422, "message": "Missing `from` field.", "name": "missing_required_field" }
```

| Status | `name` | When |
|---|---|---|
| 401 | `missing_api_key`, `restricted_api_key` | No key; a sending-only key on another endpoint |
| 400 / 401 | `validation_error` | Invalid or unknown key |
| 403 | `validation_error` | Domain not verified, or domain-scoped key used for another domain |
| 404 | `not_found` | Unknown resource or endpoint |
| 409 | `invalid_idempotent_request`, `concurrent_idempotent_requests` | Idempotency key reused with another body, or still in flight |
| 422 | `validation_error`, `missing_required_field`, `invalid_parameter`, `invalid_attachment` | Bad input |
| 429 | `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded` | Too fast, or over the team's quota |

## Rate limits and quotas

Every authenticated response carries `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and `ratelimit-policy`; a `429` adds `retry-after`. The default is 10 requests per second per team (`SEND_DEFAULT_RATE_LIMIT` in `.env`), and an administrator can change it per team. The counter is kept per web process, so on a server with several cores the effective limit is higher; see [Scaling](/docs/scaling/).

New teams get a quota of 50,000 emails per month and no daily limit (`SEND_DEFAULT_MONTHLY_QUOTA` in `.env`), which administrators change per team. Send responses report usage in `x-resend-monthly-quota`.

## Email status

`GET /emails/:id` returns `last_event`: `queued` or `scheduled`, then `sent` once your mail server has accepted the message, and after that `delivered`, `delivery_delayed`, `bounced`, `complained`, `opened`, `clicked`, `failed` or `suppressed`, whichever happened last. The mail server reports delivery outcomes itself, so this works with direct delivery and with any relay. See [delivery tracking](/docs/webhooks/#delivery-tracking).

## Differences from Resend

- Mail is delivered by your own mail server (or your relay), so the sending IP's reputation is yours to build. Delivery outcomes come from that server, with any relay or direct delivery.
- Domain records are your own DKIM key, SPF and DMARC instead of Resend's `send` subdomain and Amazon SES records.
- `region`, `tls` and `custom_return_path` on domains are stored and returned but don't change routing.
- Open and click tracking links use your API host (`PUBLIC_TRACKING_BASE`); custom tracking subdomains are verified but not yet served over TLS.
- Some error texts Resend doesn't document use our own wording with Resend's names and status codes.
