# 5050 Send — Resend API specification and coverage checklist

What Resend's API does, as learned from the docs (`resend.com/docs/llms-full.txt`,
every `api-reference/*` page), the OpenAPI file (`resend/resend-openapi` `resend.yaml`
1.5.1), the `resend` npm SDK 6.34.1 (source, types, unit tests and the recorded
HAR fixtures of real API responses), and how 5050 Send implements it.

Legend: **done** = implemented and covered by a test (official SDK contract test,
raw HTTP test, or the docs-examples runner); **phase 2** = designed, not built.

Test locations: `test/contract/*.test.ts` (official SDK), `test/http/*.test.ts` (raw HTTP:
errors, headers, isolation, tracking, analytics, inbound), `test/smtp/*`, `test/internal/*`
(dashboard), `test/sdks/python.test.ts`, `test/docs-examples.test.ts` (all 140 Node.js and
141 cURL examples of the API reference, `npm run docs:examples`).

---

## 1. Conventions

### Base URL and routing
- Resend: `https://api.resend.com`, all paths at the root, HTTPS only.
- 5050 Send: `https://api.example.com` (Host `API_HOST`). Locally any host with the `/v` prefix (`RESEND_BASE_URL=http://localhost:3000/v`).

### Authentication
- `Authorization: Bearer re_…`. Token format `re_<8 base62>_<24 base62>`.
- Keys are stored as SHA-256 only, compared in constant time after a prefix lookup; the token is returned once by `POST /api-keys`. **done**
- `User-Agent` is required; without it Resend's edge (Cloudflare) answers `403` with body `error code: 1010`. **done** (`REQUIRE_USER_AGENT`)

### Errors
Body `{ "statusCode": <int>, "message": "<text>", "name": "<code>" }` (key order as Resend). The SDK passes it through as `error`.

| name | status | when (Resend docs) | 5050 Send |
|---|---|---|---|
| `missing_api_key` | 401 | no Authorization header | done |
| `validation_error` "API key is invalid" | 400 | malformed header or unknown key on non-sending endpoints | done |
| `validation_error` "API key is invalid" | 401 | unknown/deleted key on sending endpoints (`POST /emails`, `/emails/batch`, inbox sends) | done |
| `restricted_api_key` | 401 | `sending_access` key on a non-sending endpoint ("This API key is restricted to only send emails.") | done |
| `invalid_idempotency_key` | 400 | key not 1–256 chars | done |
| `validation_error` | 400/422 | field errors (422 in practice, e.g. pagination) | done |
| `validation_error` | 403 | unverified domain ("The `x` domain is not verified…"), sandbox recipient not your own, domain already registered | done |
| `not_found` | 404 | unknown resource ("Email not found", "Contact not found", "Audience not found" for segments, "API key not found") or unknown endpoint ("The requested endpoint does not exist.") | done |
| `method_not_allowed` | 405 | known path, wrong method | done |
| `invalid_idempotent_request` | 409 | same key, different body within 24 h | done |
| `concurrent_idempotent_requests` | 409 | same key still in progress | done |
| `resource_locked` | 409 | concurrent update of the same resource | done (name available; used where applicable) |
| `invalid_attachment` | 422 | attachment without `content` or `path` | done |
| `invalid_parameter` | 422 | path id is not a UUID ("The `id` must be a valid UUID.") | done |
| `invalid_region` | 422 | unknown domain region | done |
| `missing_required_field` | 422 | "Missing `email` field." etc. | done |
| `missing_required_parameter` | 422 | required query parameter (e.g. broadcast recipients `type`) | done |
| `daily_quota_exceeded` / `monthly_quota_exceeded` | 429 | email quotas | done |
| `rate_limit_exceeded` | 429 | rate limit | done |
| `application_error` | 500 | unexpected | done |
| `email_above_quota`, `invalid_permission`, `suspended_api_key`, `service_unavailable` | 403/403/403/503 | plan / OAuth scopes / suspension / outage | phase 2 (no plans, OAuth or suspensions here) |

### Rate limits
- Headers on every authenticated response (IETF draft-06): `ratelimit-limit`, `ratelimit-policy: <n>;w=1`, `ratelimit-remaining`, `ratelimit-reset`; on 429 also `retry-after`. **done**
- Per team, across all keys. Resend's docs now say 10 rps; recorded fixtures show `2;w=1` (older default) and `100;w=1`. 5050 Send defaults to **2 rps** (`DEFAULT_RATE_LIMIT`, per-team override by admins). In-memory per web process (scale-out multiplies the effective limit; phase 2: shared counter).
- Dashboard calls are not rate limited.

### Email quotas
- Per team daily (UTC day) and monthly (calendar month) quotas; defaults 3000/month, no daily (configurable per team by Stalwart admins). Sent **and** received emails count; broadcasts don't (marketing). **done**
- Headers on send responses: `x-resend-monthly-quota` (used), `x-resend-daily-quota` (only when a daily limit applies). **done**

### Pagination
- `limit` 1–100, `after` / `before` (IDs, never both), response `{ "object": "list", "has_more": bool, "data": [...] }`, newest first; cursor excluded. **done**
- Errors: 422 `validation_error` "The pagination limit must be a number between 1 and 100. See https://resend.com/docs/pagination for more information.", both cursors, non-ID cursor. **done**
- Older endpoints return everything when `limit` is omitted (domains, API keys, broadcasts, segments, contacts, received emails and their attachments, webhooks, contact properties, sent-email attachments); newer ones default to 20 (emails, templates, topics, inboxes, threads, drafts, logs, suppressions, events, automations, webhook events/attempts). **done**

### Formats
- `created_at` and most timestamps: Postgres text in UTC with microseconds, trailing zeros trimmed: `2025-11-30 20:41:40.84216+00` (seen in Resend's recordings). We return the database's own text rendering, so the format matches exactly. **done**
- ISO 8601 (`2026-08-22T15:28:00.000Z`) where Resend uses it: webhook payloads, webhook events/attempts, received emails, inbox objects, attachment `expires_at`, usage `resets_at`, metrics ranges. **done**
- IDs: UUID v4; webhook messages `msg_<27 base62 KSUID>`, attempts `atmpt_<27>`. **done**
- Status codes: `201` for creates where Resend uses it (domains, API keys, templates, audiences/segments, contacts, contact imports, topics, contact properties, broadcasts, broadcast/automation duplicate, webhooks, automations, events, suppressions, inboxes, labels, drafts), `202` for `POST /events/send`, `200` for `POST /emails` and `/emails/batch`. **done**

### Idempotency
`Idempotency-Key` header on `POST /emails`, `POST /emails/batch` and the inbox send endpoints (SMTP: `Resend-Idempotency-Key` header): 1–256 chars, 24 h, bound to method+endpoint+body. Same body → original response replayed; different body → 409; in flight → 409. Failed requests don't consume the key. **done**

### Team isolation
Every row carries `team_id`; every query filters on it (including cursor lookups). `test/http/isolation.test.ts` proves a second team can't read, list, modify, delete or send from the first team's resources. **done**

---

## 2. Coverage table (every endpoint)

| Resource | Method & path | SDK | Status |
|---|---|---|---|
| Emails | `POST /emails` | `emails.send` | done |
| | `POST /emails/batch` (+ `x-batch-validation: strict\|permissive`) | `batch.send` | done |
| | `GET /emails` | `emails.list` | done |
| | `GET /emails/:id` | `emails.get` | done |
| | `PATCH /emails/:id` (reschedule) | `emails.update` | done |
| | `POST /emails/:id/cancel` | `emails.cancel` | done |
| | `POST /emails/:id/share` | `emails.share` | done |
| | `GET /emails/:id/attachments` | `emails.attachments.list` | done |
| | `GET /emails/:id/attachments/:aid` | `emails.attachments.get` | done |
| | `GET /emails/metrics` | `emails.metrics` | done |
| Receiving | `GET /emails/receiving` | `emails.receiving.list` | done |
| | `GET /emails/receiving/:id` (`html_format`) | `emails.receiving.get` | done |
| | `GET /emails/receiving/:id/attachments` | `emails.receiving.attachments.list` | done |
| | `GET /emails/receiving/:id/attachments/:aid` | `emails.receiving.attachments.get` | done |
| | SDK `emails.receiving.forward` (client-side helper over GET + POST /emails) | `emails.receiving.forward` | done |
| | Inbound delivery (MX → mail-1 → worker) | — | done in code (`POST /inbound`, JMAP poller); MX/Stalwart routing config phase 2 |
| Domains | `POST /domains` | `domains.create` | done |
| | `GET /domains` | `domains.list` | done |
| | `GET /domains/:id` | `domains.get` | done |
| | `PATCH /domains/:id` | `domains.update` | done |
| | `DELETE /domains/:id` | `domains.remove` | done |
| | `POST /domains/:id/verify` | `domains.verify` | done |
| | `POST /domains/claim` | `domains.claims.create` | done |
| | `GET /domains/:id/claim` | `domains.claims.get` | done |
| | `POST /domains/:id/claim/verify` | `domains.claims.verify` | done |
| API keys | `POST /api-keys` | `apiKeys.create` | done |
| | `GET /api-keys` | `apiKeys.list` | done |
| | `PATCH /api-keys/:id` | `apiKeys.update` | done |
| | `DELETE /api-keys/:id` | `apiKeys.remove` | done |
| Audiences (legacy) | `POST/GET /audiences`, `GET/DELETE /audiences/:id` | `audiences.*` (= segments) | done |
| | `POST/GET /audiences/:id/contacts`, `GET/PATCH/DELETE /audiences/:id/contacts/:id_or_email` | `contacts.*({ audienceId })` | done |
| Segments | `POST /segments`, `GET /segments`, `GET/PATCH/DELETE /segments/:id` | `segments.*` | done |
| | `GET /segments/:id/contacts` | `contacts.list({ segmentId })` | done |
| | `GET /segments/metrics` (private beta) | preview SDK only | done |
| Contacts | `POST /contacts`, `GET /contacts`, `GET/PATCH/DELETE /contacts/:id_or_email` | `contacts.*` | done |
| | `GET /contacts/:id/segments`, `POST/DELETE /contacts/:id/segments/:segment_id` | `contacts.segments.*` | done |
| | `GET /contacts/:id/topics`, `PATCH /contacts/:id/topics` | `contacts.topics.*` | done |
| | `POST /contacts/imports` (multipart CSV), `GET /contacts/imports`, `GET /contacts/imports/:id` | `contacts.imports.*` | done |
| Contact properties | `POST/GET /contact-properties`, `GET/PATCH/DELETE /contact-properties/:id` | `contactProperties.*` | done |
| Topics | `POST/GET /topics`, `GET/PATCH/DELETE /topics/:id` | `topics.*` | done |
| Broadcasts | `POST /broadcasts` (`send`, `scheduled_at`), `GET /broadcasts`, `GET/PATCH/DELETE /broadcasts/:id` | `broadcasts.*` | done |
| | `POST /broadcasts/:id/send`, `/cancel`, `/duplicate` | `broadcasts.send/cancel/duplicate` | done |
| | `GET /broadcasts/:id/recipients`, `GET /broadcasts/:id/clicked-links` | `broadcasts.recipients/clickedLinks` | done |
| Templates | `POST/GET /templates`, `GET/PATCH/DELETE /templates/:id_or_alias`, `POST …/publish`, `POST …/duplicate` | `templates.*` (+ chainable `.publish()`) | done |
| Webhooks | `POST/GET /webhooks`, `GET/PATCH/DELETE /webhooks/:id`, `POST /webhooks/:id/signing-secret/rotate` | `webhooks.*` | done |
| | `GET /webhooks/:id/events`, `GET /webhooks/:id/events/:eid`, `POST …/replay`, `GET …/attempts` | `webhooks.events.*` | done |
| | `webhooks.verify` (client-side, standardwebhooks over svix-* values) | `webhooks.verify` | done |
| Suppressions | `POST/GET /suppressions`, `GET/DELETE /suppressions/:id_or_email`, `POST /suppressions/batch/add`, `POST /suppressions/batch/remove` | `suppressions.*` | done |
| Logs | `GET /logs`, `GET /logs/:id` | `logs.*` | done |
| Usage | `GET /usage` | `usage.get` | done |
| Automations | `POST/GET /automations`, `GET/PATCH/DELETE /automations/:id`, `POST …/duplicate`, `POST …/stop`, `GET …/runs`, `GET …/runs/:run_id` | `automations.*` | done (engine runs all 8 step types) |
| Events | `POST/GET /events`, `GET/PATCH/DELETE /events/:id_or_name`, `POST /events/send` | `events.*` | done |
| Inboxes | `POST/GET /inboxes`, `GET/PATCH/DELETE /inboxes/:id_or_email` | `inboxes.*` | done |
| | `GET/PATCH /inboxes/:id/agent` | `inboxes.agent.*` | done (settings); agent actions phase 2 |
| | labels: `GET/POST /inboxes/:id/labels`, `PATCH/DELETE …/labels/:label_id` | `inboxes.labels.*` | done |
| | threads: list, search, get, update, delete | `inboxes.threads.*` | done |
| | thread labels: `POST/PUT …/threads/:tid/labels`, `DELETE …/labels/:label_id` | `inboxes.threads.labels.*` | done |
| | thread emails: list, get, reply, forward | `inboxes.threads.emails.*` | done |
| | drafts: list, create, get, update, delete, send | `inboxes.drafts.*` | done |
| OAuth grants | `GET /oauth/grants`, `DELETE /oauth/grants/:id` | `oauthGrants.*` | done (no OAuth apps exist yet, so lists are empty) |
| OAuth server | `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/register`, `POST /oauth/revoke` | — | **phase 2** (third-party app authorization; docs-examples runner marks `oauth/token` as expected 404) |
| SMTP relay | `smtp.example.com` 2465/465 TLS, 587/2587 STARTTLS, user `resend` / password API key | — | done (see §8) |
| Tracking | open pixel, click redirect, one-click unsubscribe (API host) | — | done |

Every SDK method of `resend` 6.34.1 is exercised by the contract tests.

---

## 3. Emails

### `POST /emails`
Body: `from`* (`email` or `Name <email>`), `to`* (string|string[], ≤ 50), `subject`* (required unless a template supplies it), `cc`, `bcc`, `reply_to` (string|string[]), `html`, `text` (omitted → generated from `html`; `""` opts out), `headers` (object of strings), `tags` (`[{name, value}]`, ASCII letters/digits/`_`/`-`, ≤ 256 chars, ≤ 75 tags), `attachments` (`[{content (base64|Buffer), filename, path (URL fetched at send time), content_type, content_id}]`, ≤ 40 MB per email after base64; `content_id` makes it inline for `cid:` references), `scheduled_at` (ISO 8601 or natural language "in 1 min", "tomorrow at 9am", "Friday at 3pm ET"; ≤ 30 days ahead; not over SMTP), `template` (`{id: id-or-alias of a published template, variables}`; cannot be combined with html/text/react; payload `from`/`subject`/`reply_to` override template defaults; missing variables without fallback → 422), `topic_id` (opted-out contacts are not sent; non-contacts follow the topic default), `react` (SDK renders to `html`; nothing server-side).
Response `200 { "id": "uuid" }` + quota headers. **done**

Validation messages (422): "Missing `from` field.", "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.", "Missing `html` or `text` field." (our wording for a body-less email), size/tag/schedule messages. Unverified sender domain → 403 `validation_error` "The example.com domain is not verified. Please, add and verify your domain on …". Domain-scoped key using another domain → 403. **done**

Sandbox (`resend.dev`): `onboarding@resend.dev` may send to Resend's test addresses `delivered@`, `bounced@`, `complained@`, `suppressed@resend.dev` (with `+label`) — outcomes are simulated exactly — and to team members' own addresses (sent with `SANDBOX_SENDER` as the envelope sender, since we can't send as resend.dev). Anyone else → 403 "You can only send testing emails to your own email address (…)". **done**

### `POST /emails/batch`
Array of ≤ 100 email objects (no `attachments`), each independently schedulable and templatable. Header `x-batch-validation`: `strict` (default; any invalid email fails the whole request, message suffixed "at index N") or `permissive` (valid emails are created; response `{ data: [{id}], errors: [{index, message}] }`). Response `{ "data": [{ "id" }] }` in input order. Idempotency-Key covers the whole batch. **done**

### `GET /emails/:id`
```json
{ "object": "email", "id": "…", "to": ["…"], "from": "Acme <…>", "created_at": "2026-04-03 22:13:42.674981+00",
  "subject": "…", "html": "…"|null, "text": "…"|null, "bcc": [], "cc": [], "reply_to": [], "last_event": "delivered",
  "scheduled_at": null, "tags": [{ "name": "category", "value": "confirm_email" }], "message_id": "<…>" }
```
`last_event`: `queued`, `scheduled`, `sent`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `opened`, `clicked`, `failed`, `suppressed`, `canceled` (the newest event wins). **done**

### `GET /emails`
List items: `id, to, from, created_at, subject, bcc, cc, reply_to, last_event, scheduled_at, message_id` (no html/text/tags; empty cc/bcc/reply_to are `null`, as in the docs). Default limit 20. **done**

### `PATCH /emails/:id`, `POST /emails/:id/cancel`
Only for `scheduled` emails (else 422 `validation_error`). Reschedule accepts ISO or natural language. Responses `{ "object": "email", "id" }`. Canceled emails can't be rescheduled. **done**

### `POST /emails/:id/share`
`{ expires_in: "10m" | "2 hours" | "1 day" }` (default 48 h, max 48 h) → `{ object: "email", id, url }`; the URL opens a read-only page on the dashboard host (`/shared?token=`), works for sent and received emails. **done**

### Attachments
`GET /emails/:id/attachments` (limit optional) and `/:aid` → `{ object: "attachment"?, id, filename, size, content_type, content_disposition: "inline"|"attachment", content_id?, download_url, expires_at }`. `download_url` is a signed link on the API host valid 1 hour, served with `Content-Disposition: attachment`, `CSP: sandbox`, `nosniff`. **done**

### `GET /emails/metrics`
Query: `start_date` (default end − 6 days), `end_date` (default now, future clamped), `timezone` (IANA, default UTC), `granularity` hourly|daily|weekly|monthly (≤ 10,000 periods), `metrics` (any of received, delivered, complained, suppressed, bounced, bounced_transient, bounced_permanent, bounced_undetermined, opened, clicked, unsubscribed, delivery_delayed, failed, sent, unique_opened, unique_clicked, delivery_rate, open_rate, click_rate, bounce_rate, complaint_rate, unsubscribe_rate; default all), `dimensions` (period, domain, email, broadcast; `email` and `broadcast` can't combine), `domain_id`/`email_id`/`broadcast_id` (≤ 100 each). Lists accept comma-separated, repeated or both.
Response `{ object: "metrics", start_date, end_date, metrics, dimensions, granularity, totals, data? }`; rates are percentages with one decimal. Computed from the `email_events` table. **done**

### Sending pipeline (worker)
1. API validates, checks quota, stores the email + attachments, queues a `send_email` job (`run_at = scheduled_at`), records `queued` (or `scheduled` + `email.scheduled` webhook).
2. Worker: domain still verified? → suppression list (→ `email.suppressed`) → topic subscriptions → fetch `path` attachments (SSRF-safe, 40 MB cap) → MIME via nodemailer MailComposer (custom headers, inline CID, `List-Unsubscribe` for broadcasts, open pixel and click rewriting when the domain enables tracking) → `Transport.send`.
3. Transport `cloudflare`: `POST /accounts/{account_id}/email/sending/send_raw` `{ from, recipients, mime_message }` → `{ delivered[], queued[], permanent_bounces[], suppressed_recipients[], message_id }`. `delivered` recipients emit `email.delivered` immediately, `permanent_bounces` emit `email.bounced` (Permanent) and add suppressions; `queued` ones wait for analytics.
4. Retryable transport errors (5xx/429) retry with backoff (6 attempts); permanent ones → `failed` (`email.failed` with `failed.reason`, e.g. `domain_not_verified`, `message_too_large`, `transport_error`, `attachment_fetch_failed`, `recipient_opted_out_of_topic`, `api_key_not_active`).

---

## 4. Domains (Cloudflare Email Sending)

Create body: `name`*, `region` (`us-east-1`|`eu-west-1`|`sa-east-1`|`ap-northeast-1`, stored and echoed; all mail leaves via Cloudflare), `custom_return_path` (stored; Cloudflare's return path is fixed to `cf-bounce`), `open_tracking`, `click_tracking`, `tls` (`opportunistic`|`enforced`, stored), `capabilities` `{sending, receiving}` (≥ 1 enabled), `tracking_subdomain`.
Create response (201): `{ id, name, created_at, status, open_tracking, click_tracking, tracking_subdomain?, capabilities, records, region }`. Get adds `object: "domain"`. List items omit `records`. Update → `{ object: "domain", id }` (tracking subdomain can change, never be removed). Delete → `{ object, id, deleted: true }`. Verify → `{ object, id }`, sets `pending` and verifies asynchronously, emitting `domain.updated` on changes. Names are unique across all teams: 403 "The example.com domain has been registered already." (then use claims). **done**

Records (`{ record, name, type, ttl: "Auto", status, value, priority? }`, names relative to the domain):

| record | type | name | value |
|---|---|---|---|
| `DKIM` | TXT | `cf-bounce._domainkey` | Cloudflare's DKIM public key (`v=DKIM1; h=sha256; k=rsa; p=…`) |
| `SPF` | MX ×3 | `cf-bounce` | `route1/2/3.mx.cloudflare.net` (Cloudflare's priorities) |
| `SPF` | TXT | `cf-bounce` | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `DMARC` | TXT | `_dmarc` | `DMARC_VALUE` (default `v=DMARC1; p=none;`) — extra record Resend doesn't list; an existing DMARC policy satisfies it |
| `Receiving` | MX | `@` | `INBOUND_MX_HOST`, priority 10 (when receiving is enabled) |
| `Tracking` | CNAME | `<tracking_subdomain>` | `TRACKING_CNAME_TARGET` |

Status values exactly as Resend: domain `not_started`, `pending`, `verified`, `failed`, `partially_verified`, `partially_failed`; records `not_started`, `pending`, `verified`, `failed`, `temporary_failure` (DNS lookup error). Pending verification is re-checked every 5 minutes for 72 hours, then `failed`. **done**

Flow:
- **Zone in our Cloudflare account** (one click): find the zone (walking up labels), onboard Email Sending (`POST /zones/{zone}/email/sending/subdomains`), create any missing cf-bounce records and DMARC in the zone, read back DKIM, verify immediately → `verified`. **done** (logic copied from `web/server/src/cloudflare.ts`)
- **Elsewhere**: show the records; `verify` checks public DNS for each record and Cloudflare's sending status. Cloudflare only onboards zones that are in our account, so the DKIM key exists only once the zone is there — either an administrator adds it, or with `CLOUDFLARE_CREATE_ZONES=1` we add it as a pending zone automatically (no NS change needed for sending). Until then `last_error` (dashboard `…/domains/:id/cloudflare`) explains the situation. **done** (zone creation path tested with the fake)

Claims: `POST /domains/claim` (201, or 200 for an identical pending claim) returns `{ object: "domain_claim", id, name, status, domain_id (placeholder), region, record: { type: "TXT", name, value: "5050send-domain-verification=<token>", ttl: "Auto" }, blocked_reason, failure_reason, created_at, expires_at (7 days) }`. `verify` checks the TXT; on success the domain moves to the claiming team as a new domain (fresh Cloudflare onboarding) → `completed`; `blocked` (`pending_scheduled_emails`) when the old team still has scheduled mail; `expired`. **done**

---

## 5. API keys

`POST /api-keys` `{ name* (≤ 50, may be ""), permission: full_access (default) | sending_access, domain_id (sending_access only) }` → 201 `{ id, object: "api_key", token }`. List `{ id, name, created_at, last_used_at }`. `PATCH` `{ name }` → `{ object: "api_key", id }`. `DELETE` → `{ object: "api_key", id, deleted: true }`; unknown → 404 "API key not found". **done**

`sending_access` keys: only `POST /emails`, `POST /emails/batch` and the inbox reply/forward/draft-create/draft-send endpoints (and SMTP); everything else 401 `restricted_api_key`. Domain-scoped keys may only send from their domain (403). **done**

---

## 6. Contacts, segments, topics, properties

- Contacts: `POST /contacts` `{ email*, first_name, last_name, unsubscribed, properties: {key: value}, segments: [{id}], topics: [{id, subscription}] }` → 201 `{ object: "contact", id }`; an existing email is updated (upsert, as Resend's fixtures show). `GET /contacts/:id_or_email` → `{ object, id, email, first_name, last_name, created_at, unsubscribed, properties: { key: { value, type } } }`. `PATCH` (`null` clears names) → `{ object, id }`. `DELETE` → `{ object: "contact", contact: "<id or email as given>", deleted: true }` even if it didn't exist (Resend behaviour). Properties must be defined first and match their type (422). **done**
- Legacy audience paths `/audiences/:id/contacts…` behave like segment-scoped contacts. **done**
- Segments: create → 201 `{ object: "segment", id, name }` (`object: "audience"` on `/audiences`), get `{ object, id, name, created_at }`, unknown → 404 "Audience not found", delete always `{ object, id, deleted: true }`. **done**
- Contact segments: list → paginated segments; add → `{ id: segment_id }`; remove → `{ object: "contact_segment", id: contact_id, audienceId: segment_id, deleted: true }`. **done**
- Topics: create `{ name* ≤ 50, default_subscription* opt_in|opt_out (immutable), description ≤ 200, visibility public|private }` → 201 `{ object: "topic", id }`; get/list with `visibility`; contact topics list `{ id, name, description, subscription }` (default applies when unset); update topics accepts the documented `{ topics: [...] }` and the bare array the Node SDK sends → `{ object: "contact_topics", id }`. **done**
- Contact properties: `{ key* [A-Za-z0-9_]{1,50}, type* string|number, fallback_value }`; only `fallback_value` updates; delete removes the value from contacts. **done**
- Webhooks: `contact.created/updated/deleted` (`{ id, audience_id, segment_ids, created_at, updated_at, email, first_name, last_name, unsubscribed }`), `contact.topics.updated` (`{ email, topics }`), `topic.created/updated/deleted`. **done**

---

## 7. Webhooks

- Create `{ endpoint* (http/https; private, loopback and link-local addresses refused), events* (non-empty list of event types) }` → 201 `{ object: "webhook", id, signing_secret: "whsec_…" }`. Get includes `signing_secret`; list doesn't. Update `{ endpoint?, events?, status: enabled|disabled }`. Rotate → new secret; for 24 h payloads are signed with both secrets. **done**
- Event types: `email.sent`, `email.scheduled`, `email.delivered`, `email.delivery_delayed`, `email.complained`, `email.bounced`, `email.opened`, `email.clicked`, `email.received`, `email.failed`, `email.suppressed`, `contact.created`, `contact.updated`, `contact.deleted`, `contact.topics.updated`, `domain.created`, `domain.updated`, `domain.deleted`, `suppression.added`, `suppression.removed`, `topic.created`, `topic.updated`, `topic.deleted`, and the 14 `inbox.*` events. **done**
- Payload `{ "type", "created_at" (ISO), "data" }`. Email events' data: `{ broadcast_id?, created_at, email_id, from, to (impacted recipients), message_id, subject, template_id?, tags? (object) }` plus `bounce {message, subType, type}`, `click {ipAddress, link, timestamp, userAgent}`, `failed {reason}`, `suppressed {message, type}`. `email.received`: `{ email_id, created_at, from, to, bcc, cc, received_for, message_id, subject, attachments: [{id, filename, content_type, content_disposition, content_id}] }`. Domain events: `{ id, name, status, created_at, region, capabilities, records }`. Suppression events: `{ id, email, origin, source_id, created_at }`. **done**
- Signing (Svix): headers `svix-id` (`msg_…`, same for all retries and all endpoints of one event), `svix-timestamp` (unix seconds), `svix-signature` (`v1,<base64 HMAC-SHA256(secret, "{id}.{timestamp}.{body}")>`, space-separated when two secrets are active). Verified in tests with the official `svix` package and with `resend.webhooks.verify`. **done**
- Retries: immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h after each failure (8 attempts). Statuses `pending`, `attempting`, `success`, `failed`; `next_attempt_at` null when final. Endpoints failing continuously for 5 days are disabled (`disabled_reason`). **done**
- Events API: list `{ id, type, created_at, status }` (limit default 20, `after` only), get adds `next_attempt_at`, `payload`; attempts `{ id: "atmpt_…", http_status_code, response, sent_at }`; replay queues one extra immediate attempt without touching the schedule. Dashboard additionally gets duration, error and replay flag. **done**
- Delivery is SSRF-safe: DNS answers are checked against private/reserved ranges and the connection is pinned to the checked address; redirects aren't followed; 15 s timeout; response body stored up to 2 KB. **done**
- Failure notification email to the team: phase 2 (state is visible in the dashboard: `…/webhooks/:id/health`).

---

## 8. SMTP relay and integrations

See §12 (from `src/smtp/*`). Summary: `smtp.example.com`, username `resend`, password = API key (full or sending access; domain-scoped keys enforced), implicit TLS on `SMTP_PORTS_TLS` (465, 2465) and STARTTLS on `SMTP_PORTS_STARTTLS` (587, 2587); production on mail-1 uses 2465/2587/587 because Stalwart owns 25/465. Messages enter the same pipeline (`source: smtp`): events, quotas, webhooks, logs (dashboard), idempotency (`Resend-Idempotency-Key`), custom headers, `X-Resend-Tags`. Certificates from files with hot reload, or built-in ACME DNS-01 via Cloudflare. **done**

---

## 9. Events, tracking, suppressions, logs, usage

- **Delivery outcomes**: worker polls Cloudflare GraphQL Analytics `viewer.accounts(filter:{accountTag}).emailSendingAdaptive` (falls back to `viewer.zones(...)` per onboarded zone if the account-level dataset isn't available) with `datetime, messageId, status, eventType, errorCause, errorDetail, isSpam, isNDR, to, from, subject, sendingDomain`. Mapping: `delivered` → `email.delivered`; `deliveryFailed` with 5xx → `email.bounced` (Permanent, suppression added) or 4xx → `email.delivery_delayed`; `rejected` → `email.suppressed`; `failed` → `email.failed`; `isSpam` → `email.complained` (suppression added). Events are de-duplicated. If Cloudflare answers "not authorized for that account" the poller records `authorized: false`, logs once, backs off (5 min → 1 h), leaves emails at their last state, and the dashboard shows a warning; it recovers automatically once the token has Account Analytics:Read. **done** (tested with the fake in both states)
- **Opens/clicks**: `GET /t/o/:token` (1×1 GIF, `email.opened`, repeats counted) and `GET /t/c/:token` (302 to the original URL, `email.clicked` with ip/user-agent/timestamp); HMAC-signed tokens so links can't be forged or turned into open redirects; only when the domain enables open/click tracking. Resend applies tracking only with a verified custom tracking subdomain; we use `PUBLIC_TRACKING_BASE` and apply the flags directly (TLS for customer tracking subdomains would need Cloudflare for SaaS — phase 2). **done**
- **Unsubscribe**: broadcast emails get `List-Unsubscribe: <url>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; GET shows a confirmation page, POST unsubscribes (topic opt-out when the broadcast has a topic), records `unsubscribed`, emits `contact.updated` / `contact.topics.updated`. **done**
- **Suppressions**: automatic on hard bounces and complaints (`origin` bounce/complaint, `source_id` = email id) and manual; suppressed recipients aren't sent to (`email.suppressed`, type `OnAccountSuppressionList`); Resend's test addresses never get suppressed. API: add (201, idempotent), batch add (201, ≤ 100), list (`origin` filter), get/delete by id or email, batch remove by `emails` or `ids`. **done**
- **Logs**: every authenticated public API request: method, endpoint (with query), status, user agent, IP, duration, request/response bodies with secrets redacted (`token`, `signing_secret`, passwords, `re_…`/`whsec_…` values, attachment `content`), 30-day retention. `GET /logs` list `{ id, created_at, endpoint, method, response_status, user_agent }`, `GET /logs/:id` adds `object: "log"`, `request_body`, `response_body`. **done**
- **Usage**: `GET /usage` with Resend's full shape (`emails.daily/monthly {used, limit, sent, received, resets_at}`, contacts, segments, broadcasts, ai_credits, automation_runs, domains, `rate_limit {limit, duration: "1000ms"}`). Plan limits that don't exist here are reported as fixed values (contacts 1000, automation runs 10000, AI credits 0). **done**
- **Stats rollups**: `stats_daily` per team/day/domain every 5 minutes (dashboard charts); exact metrics are computed live from `email_events`. **done**

---

## 10. Phase 2 and known deviations

Phase 2:
- OAuth authorization server (`/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`); grants API exists but is empty.
- Inbox AI agent actions (settings are stored); `inbox.thread.assigned/unassigned` (no assignment model yet); `authentication` (SPF/DKIM/DMARC) on received emails; `email_above_quota`.
- Receiving infrastructure: publish receiving MX → mail-1 and route those domains in Stalwart into the catch-all mailbox the worker polls (code and tests exist: `POST /inbound`, JMAP poller).
- Custom tracking subdomains served over TLS (records are shown and verified; links use `PUBLIC_TRACKING_BASE`).
- Contacts quota 403 for broadcasts, plan-based limits, account suspension errors.
- Webhook failure notification emails; shared rate-limit counter across web replicas.
- STARTTLS on SMTP port 25 (Stalwart owns it on mail-1); Go/PHP SDK smoke tests (documented overrides only).

Not exact (by necessity):
- Cloudflare Email Sending limits a message to **5 MiB**; we accept Resend's 40 MB, but larger messages fail at send time with `failed.reason = message_too_large`.
- `region`, `tls` and `custom_return_path` are stored and echoed but don't change routing (Cloudflare decides; return path is always `cf-bounce`).
- Domain records list Cloudflare's names/values (cf-bounce, Cloudflare DKIM) plus a DMARC record instead of Resend's `send` / `resend._domainkey` / amazonses values.
- Delivery status depends on Cloudflare analytics permission; until the token has Account Analytics:Read, only send-time outcomes (`delivered` / `permanent_bounces` returned by `send_raw`) are known.
- Some error message texts that Resend doesn't document (status-transition errors, body-less email) use our own wording with Resend's names and status codes.
- Rate limit counters are per web process; default 2 rps per the brief (Resend's docs now say 10).
- The `resend.dev` sandbox can't send real mail as resend.dev: team-member recipients get it from `SANDBOX_SENDER`.

---
## 11. Broadcasts and contact imports

### Broadcasts

Statuses: `draft`, `scheduled`, `queued`, `sent`, `canceled`. Timestamps are Postgres text (`2026-12-01 19:32:22.98+00`).
Errors use `{ statusCode, message, name }`. Unknown id → 404 `not_found` "Broadcast not found". Non-UUID id → 422 `invalid_parameter`.

| Done | Method | Path | Request | Response |
|---|---|---|---|---|
| [x] | POST | /broadcasts | `segment_id`* (or legacy `audience_id`), `from`*, `subject`*, `name`, `reply_to` (string or string[]), `preview_text`, `html`, `text`, `topic_id`, `send` (bool), `scheduled_at` (ISO or natural language, only with `send: true`, ≤ 30 days) | 201 `{ "object": "broadcast", "id" }` |
| [x] | GET | /broadcasts | `limit` (optional → all), `after`, `before` | `{ object: "list", has_more, data: [{ id, name, audience_id, segment_id, status, created_at, scheduled_at, sent_at, topic_id }] }` |
| [x] | GET | /broadcasts/:id | — | `{ object: "broadcast", id, name, audience_id, segment_id, from, subject, reply_to, preview_text, html, text, status, created_at, scheduled_at, sent_at, topic_id }` |
| [x] | PATCH | /broadcasts/:id | any create field except `send`/`scheduled_at`; draft or scheduled only, otherwise only `name` | `{ "object": "broadcast", "id" }` |
| [x] | DELETE | /broadcasts/:id | draft or scheduled only (scheduled delivery is canceled) | `{ object: "broadcast", id, deleted: true }`; other statuses → 422 `validation_error` |
| [x] | POST | /broadcasts/:id/send | `scheduled_at` (ISO or natural language) | `{ "id" }`; draft only, else 422. Sender domain checked like POST /emails (403 unverified domain) |
| [x] | POST | /broadcasts/:id/cancel | — | `{ object: "broadcast", id }`; scheduled → draft, queued → canceled (queued emails are canceled), else 422 |
| [x] | POST | /broadcasts/:id/duplicate | — | 201 `{ object: "broadcast", id }`; new draft named "<name> (copy)" truncated to 70 chars |
| [x] | GET | /broadcasts/:id/recipients | `type`* (sent, delivered, opened, clicked, bounced, complained, unsubscribed, suppressed), `email` (contains), `bounce_type` (permanent/transient/undetermined, only with `type=bounced`), `limit` (default 20), `after`/`before` (opaque cursors) | `{ object: "list", has_more, data: [{ id (opaque, base64 "offset:N"), contact_id, email, count? (opened/clicked), clicked_links? [{url, clicks}], bounce_type? }] }`; missing `type` → 422 `missing_required_parameter` |
| [x] | GET | /broadcasts/:id/clicked-links | `limit` (default 20), `after`/`before` | `{ object: "list", has_more, data: [{ id (opaque), url, clicks, unique_clicks }] }` ordered by clicks desc |

Sending (worker job `broadcast_fanout`):
- [x] One email per contact in the segment (`source: broadcast`, `broadcast_id`, `contact_id`), batched (500 contacts per job, `BROADCAST_FANOUT_BATCH`), idempotent per contact.
- [x] Skips unsubscribed contacts; with `topic_id`, only contacts opted in (explicitly or through the topic default) receive it; suppressions are applied at delivery.
- [x] Personalization: `{{{contact.first_name|fallback}}}`, `{{{contact.last_name}}}`, `{{{contact.email}}}`, `{{{contact.<property>}}}`, legacy `FIRST_NAME`/`LAST_NAME`/`EMAIL`; values are HTML-escaped in `html`. Subject is personalized too.
- [x] `{{{RESEND_UNSUBSCRIBE_URL}}}` and `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` per recipient; unsubscribing records an `unsubscribed` recipient event.
- [x] `preview_text` is injected as a hidden preheader.
- [x] Events and webhooks per email through the normal pipeline.
- [ ] Phase 2: the contacts-quota 403 ("You have reached your contacts quota…") — there are no marketing plans here.
- [ ] Phase 2: `react` is SDK-side only (rendered to `html` before the request).

### Contact imports

| Done | Method | Path | Request | Response |
|---|---|---|---|---|
| [x] | POST | /contacts/imports | `multipart/form-data`: `file`* (CSV, ≤ 200MB), `column_map` (JSON: `email`, `first_name`, `last_name`, `unsubscribed`, `properties: { key: { column, type: string\|number\|boolean } }`), `on_conflict` (`upsert` default, or `skip`), `segments` (JSON `[{id}]`), `topics` (JSON `[{id, subscription}]`) | 201 `{ object: "contact_import", id }`; missing file → 422 `missing_required_field` "Missing `file` field." |
| [x] | GET | /contacts/imports | `status` (queued, in_progress, completed, failed), `limit` (default 20), `after`, `before` | `{ object: "list", has_more, data: [ContactImport] }` |
| [x] | GET | /contacts/imports/:id | — | `{ object: "contact_import", id, status, created_at, completed_at, counts: { total, created, updated, skipped, failed } }` |

- [x] Worker job `contact_import`; RFC 4180 CSV (quotes, escaped quotes, embedded newlines, BOM). Without `column_map`, columns named email / first_name / last_name / unsubscribed are detected.
- [x] Invalid emails and non-numeric `number` properties count as `failed`; existing contacts are `updated` (upsert) or `skipped`.
- [x] Mapped properties that don't exist yet are created (boolean values stored as "true"/"false" strings, since contact properties are string|number).
- [x] No `contact.*` webhooks for imported contacts (as documented by Resend).

---

## 12. SMTP relay and integrations

Source: https://resend.com/docs/send-with-smtp, the send-with-*-smtp guides,
https://resend.com/docs/dashboard/emails/idempotency-keys, https://resend.com/docs/sdks,
https://resend.com/docs/integrations.

| Item | Resend | 5050 Send | Status |
|---|---|---|---|
| Host | `smtp.resend.com` | `smtp.example.com` (`SMTP_HOSTNAME`) | done |
| Credentials | user `resend`, password API key | same; full_access and sending_access keys | done, tested |
| Domain-restricted keys | only their domain | enforced via `normalize()` | done, tested |
| Ports | SMTPS 465, 2465; STARTTLS 25, 587, 2587 | SMTPS `SMTP_PORTS_TLS` (465,2465), STARTTLS `SMTP_PORTS_STARTTLS` (587,2587); 25 not offered (Stalwart owns it on mail-1) | done (25 deliberately not offered) |
| AUTH before TLS | refused | refused (538) | done, tested |
| `Resend-Idempotency-Key` | 24 h | 24 h, keyed on the parsed message (Date/Message-ID excluded) | done, tested |
| Custom headers | pass through (X-Entity-Ref-ID, List-Unsubscribe) | pass through | done, tested |
| Tags over SMTP | not documented | `X-Resend-Tags: a=b, c=d` (extension) | done, tested |
| Scheduling over SMTP | not supported | rejected | done |
| Rate limit | same as API | same per-team limiter | done |
| Emails table / webhooks | SMTP sends appear like API sends | same pipeline (`source: smtp`) | done, tested |
| Logs | no SMTP logs | api_logs rows with source `smtp` (dashboard only; `GET /logs` lists API calls) | done |
| Max size | 40 MB | 40 MB (`SMTP_MAX_MESSAGE_BYTES`) → 552 | done, tested |
| TLS cert | managed | files with hot reload, or built-in ACME DNS-01 via Cloudflare | done, tested (fake CA) |
| SDK base URL overrides | — | documented for Node, Python, PHP, Laravel, Ruby, Go, Rust, Java, .NET, Elixir in docs/integrations.md | done; Node + Python smoke-tested |
| Integrations page data | dashboard | `GET /api/internal/teams/:teamId/integrations` snippets | done |

Phase 2: STARTTLS on port 25 (needs a host where Stalwart isn't on 25); Go and
PHP SDK smoke tests (toolchains not installed); OAuth-based third-party
integrations that hard-code api.resend.com.

---

## 13. Templates, automations and events

Source of truth: Resend OpenAPI (`resend.yaml` 1.5.1), API reference pages under
`/docs/api-reference/{templates,automations,events}`, dashboard guides
(`/docs/dashboard/templates/*`, `/docs/dashboard/automations/*`) and `resend` 6.34.1.
All errors use `{ statusCode, message, name }`. Timestamps are Postgres text in UTC
(`2026-10-06 23:47:56.678+00`). Pagination: `limit` 1–100, `after`/`before` (not both).

### Coverage

| Endpoint | SDK method | Status |
|---|---|---|
| `POST /templates` (201) | `templates.create` (+ chainable `.publish()`) | done, tested |
| `GET /templates/:id\|alias` | `templates.get` | done, tested |
| `GET /templates` (default limit 20) | `templates.list` | done, tested |
| `PATCH /templates/:id\|alias` | `templates.update` | done, tested |
| `DELETE /templates/:id\|alias` | `templates.remove` | done, tested |
| `POST /templates/:id\|alias/publish` | `templates.publish` | done, tested |
| `POST /templates/:id\|alias/duplicate` (200) | `templates.duplicate` (+ `.publish()`) | done, tested |
| `POST /emails` with `template` | `emails.send({ template })` | done, tested |
| `POST /events` (201) | `events.create` | done, tested |
| `GET /events/:id\|name` | `events.get` | done, tested |
| `GET /events` (default limit 20) | `events.list` | done, tested |
| `PATCH /events/:id\|name` | `events.update` | done, tested |
| `DELETE /events/:id\|name` | `events.remove` | done, tested |
| `POST /events/send` (202) | `events.send` | done, tested |
| `POST /automations` (201) | `automations.create` | done, tested |
| `GET /automations/:id` | `automations.get` | done, tested |
| `GET /automations?status=` (default limit 20) | `automations.list` | done, tested |
| `PATCH /automations/:id` | `automations.update` | done, tested |
| `DELETE /automations/:id` | `automations.remove` | done, tested |
| `POST /automations/:id/duplicate` (201) | `automations.duplicate` | done, tested |
| `POST /automations/:id/stop` | `automations.stop` | done, tested |
| `GET /automations/:id/runs?status=a,b` (limit optional) | `automations.runs.list` | done, tested |
| `GET /automations/:id/runs/:run_id` | `automations.runs.get` | done, tested |
| Template editor / React rendering | – | n/a server-side (the SDK renders `react` to `html`) |
| Template version history UI | – | phase 2 (only current draft + published snapshot kept) |

### Templates

`POST /templates` body: `name`* (string), `html`* (string), `alias`, `from`, `subject`,
`reply_to` (string | string[]), `text` (omitted → generated from HTML at send time; `""` opts
out), `variables` (≤ 50) of `{ key*, type* (string|number|boolean|object|list), fallback_value }`.
Keys: `[A-Za-z0-9_]{1,50}`; reserved: `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `UNSUBSCRIBE_URL`,
`RESEND_UNSUBSCRIBE_URL`, `contact`, `this`. Fallback must match the type.
Response `201 { "id": "…", "object": "template" }`.

`GET` response:
```json
{ "object": "template", "id": "…", "current_version_id": "…", "alias": "reset-password", "name": "reset-password",
  "created_at": "…+00", "updated_at": "…+00", "status": "draft|published", "published_at": null,
  "from": null, "subject": null, "reply_to": null, "html": "<h1>…</h1>", "text": null,
  "variables": [{ "id": "…", "key": "user_name", "type": "string", "fallback_value": "John", "created_at": "…", "updated_at": "…" }],
  "has_unpublished_versions": false }
```
List items: `id, name, status, published_at, created_at, updated_at, alias`.
Update → `{ object: "template", id }`; any change gets a new `current_version_id` and, if the
template is published, `has_unpublished_versions: true` (sending keeps using the published
snapshot until `publish`). Publish/duplicate → `{ object, id }`; the duplicate is a draft named
`"<name> (Copy)"` with no alias. Delete → `{ object, id, deleted: true }`.

Errors: missing `name`/`html` → 422 `missing_required_field`; bad variable/alias/from → 422
`validation_error`; duplicate alias → 409 `validation_error`; unknown id/alias → 404 `not_found`
"Template not found".

Sending with a template (`POST /emails`, `/emails/batch`, automations): `template.id` is id or
alias of a **published** template (draft-only → 404). `from`, `subject`, `reply_to` in the payload
override the template defaults. Variables `{{{KEY}}}`, `{{KEY}}`, `{{{KEY|inline fallback}}}`;
values are HTML-escaped inside `html`. A referenced variable with no value and no fallback →
422 `validation_error` naming the variables. `template` together with `html`/`text`/`react` → 422.

### Events

`POST /events` `{ name*, schema? }`; `name` cannot start with `resend:`; `schema` is a flat map of
`string|number|boolean|date`. 201 `{ object: "event", id }`; duplicate name → 409 `validation_error`.
`GET /events/:id|name` → `{ object, id, name, schema, created_at, updated_at }`.
`PATCH` `{ schema* }` (null clears) → `{ object, id }`. `DELETE` → `{ object, id, deleted: true }`.

`POST /events/send` `{ event*, contact_id | email (exactly one), payload? }` → 202
`{ object: "event", event }`. Payload is coerced to the event's schema (bad value → 422).
Unknown `contact_id` → 404. Effects: runs waiting on this event for this contact resume (if their
`filter_rule` matches); every **enabled** automation whose trigger has this `event_name` starts a
run; for `email` without a contact, the contact is created when a run starts.

### Automations

Body: `name`*, `status` (`enabled|disabled`, default `disabled`), `steps`* (1–150, unique `key`,
≥ 1 `trigger`), `connections`* (`from`/`to` step keys, `type` default `default`).
Step configs (snake_case on the wire; the SDK converts):
`trigger {event_name}`, `delay {duration}` (≤ 30 days), `wait_for_event {event_name, timeout?, filter_rule?}`,
`condition` (rule tree: `{type:"rule", field, operator, value}` or `{type:"and"|"or", rules}`;
fields `event.*`, `contact.*`, `wait_events.<event>.*`; ops eq/neq/gt/gte/lt/lte/contains/
starts_with/ends_with/exists/is_empty; `value` may be `{ "var": "event.x" }`),
`send_email {template:{id, variables?}, from?, subject?, reply_to?}` (template must exist),
`contact_update {first_name?, last_name?, unsubscribed?, properties?}`, `contact_delete {}`,
`add_to_segment {segment_id}` (segment must exist).
Create 201 `{ object: "automation", id }`; GET returns `{ object, id, name, status, created_at,
updated_at, steps, connections }`; list items omit steps/connections. PATCH needs `name`,
`status`, or both `steps` and `connections`; the graph of an enabled automation cannot be changed
(422). Duplicate (201) is a disabled copy `"<name> (Copy)"`. Stop → `{ object, id, status: "disabled" }`
and cancels running runs.

Runs: `{ object: "automation_run", id, status (running|completed|failed|cancelled), started_at,
completed_at, created_at, steps: [{ key, type, status (pending|running|completed|failed|skipped|waiting),
started_at, completed_at, output, error, created_at }] }`. `runs.list` filters `status=a,b`
(invalid value → 422). Step outputs: condition `{result}`, send_email `{email_id}`,
wait_for_event `{event, payload}` or `{timed_out: true}`. A failing step marks the run `failed`
with `error.message`.

Engine (worker job `automation_step`): steps execute in order along connections — `default`
for linear steps, `condition_met|condition_not_met` for conditions, `event_received` (falls back
to `default`) or `timeout` for waits; a wait that times out without a `timeout` connection ends
the run. Delays and timeouts are scheduled jobs. Emails go through the normal send pipeline
(`source: 'automation'`, not counted against the transactional quota); templates can also use
`{{{contact.first_name|fallback}}}`, `contact.email`, `contact.properties.*`.

### Deviations from Resend

- One active path per run: if a step has several connections of the same type only the first is
  followed (Resend's dashboard only builds single-path graphs).
- Template version history is not stored (draft + published snapshot only).
- `email.*` webhook payloads for automation emails don't carry an automation id (none is documented).

---

## 14. Inboxes and receiving

Sources: Resend OpenAPI (`/inboxes/*`, `/emails/receiving/*`, `Inbox*` schemas), the
`api-reference/inboxes/*` and `dashboard/receiving/*` pages, the `webhooks/inboxes/*` event
pages, and resend-node 6.34.1 (`src/inboxes`, `src/emails/receiving`).
Tests: `test/contract/inboxes.test.ts`, `test/contract/receiving.test.ts` (official SDK).

Status: **done** = implemented and covered by a test; **phase 2** = not built yet.

### Common rules

- `:inbox_id` is an Inbox ID or the inbox address (case-insensitive). A value with `@` must be a
  valid email, any other value must be a UUID, else `422 validation_error`. Unknown → `404 not_found`
  `Inbox not found.`
- Key permissions: a `sending_access` key may call only **reply**, **forward**, **create draft**
  and **send draft**; anything else → `401 restricted_api_key`. A domain-restricted key may only
  use inboxes on its domain → `403 validation_error`.
- `Idempotency-Key` (1–256 chars, 24 h, body-bound) on reply, forward, create draft, send draft.
  A replay returns the stored response with `idempotent-replayed: true`. Different body → `409
  invalid_idempotent_request`; in flight → `409 concurrent_idempotent_requests`.
- Timestamps in inbox objects are ISO 8601 (`2026-08-05T14:03:11.229Z`).
- Pagination: `limit` 1–100 (default 20), `after`/`before` are IDs (not both). A date in a thread
  cursor → `422` "The `after` parameter must be a thread ID. To filter by date, use `GET
  /inboxes/:id/threads/search` with `start_date`." Unknown cursor → `404` "The pagination cursor
  references an object that does not exist. …"

### Inboxes

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `POST /inboxes` | `{email_address*, name?≤64, from_name?≤78 (no `:<>`/newlines), forwarding?}` | `201 {object:"inbox", id}` | done |
| `GET /inboxes` | `limit/after/before` | `{object:"list", has_more, data:[{id,name,email_address,from_name,unread,last_received,created_at,updated_at}]}` newest first | done |
| `GET /inboxes/:inbox_id` | | `{object:"inbox", id, name, email_address, domain_id, receiving_address, from_name, unread, drafts, last_received, created_at, updated_at}` | done |
| `PATCH /inboxes/:inbox_id` | `{name?, from_name?}` (≥1; `from_name:""` clears) | `{object:"inbox", id}` | done |
| `DELETE /inboxes/:inbox_id` | | `{object:"inbox", id, deleted:true}` | done |

Create rules: address lower-cased; local part `[a-z0-9._%-]`, ≤64, no leading/trailing/double dot.
Domain must belong to the team with receiving enabled and sending verified (`422` otherwise); with
`forwarding:true` only sending must be verified. Address in use → `409`. Plan limit → `403`
(env `INBOX_LIMIT_PER_TEAM`, default unlimited; Resend includes 3). `forwarding:true` provisions
`receiving_address` only when `INBOX_FORWARDING_DOMAIN` is set (else `null`) — **phase 2** for a
real shared receiving domain. `unread` = threads in `inbox` with an unread message; `drafts` =
unsent drafts; `last_received` = newest inbound message in `inbox`.

### Agent

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `GET /inboxes/:inbox_id/agent` | | `{object:"inbox_agent", instructions\|null, tone\|null, actions:[]}` (actions in enum order) | done |
| `PATCH /inboxes/:inbox_id/agent` | `{instructions? 1–4000\|null, tone? enum\|null, actions? enum[]}` (≥1) | `{object:"inbox_agent", id}` | done |
| Agent actually drafting/labelling/forwarding (`draft_reply`, `forward_thread`, `add_labels`, `assign_thread`, `mark_as_spam`, `archive`, `move_to_trash`) | | | **phase 2** (settings stored only) |

Tones: `concise_professional`, `concise_casual`, `expanded_professional`, `expanded_casual`.

### Labels

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `GET /inboxes/:inbox_id/labels` | | `{object:"list", data:[{id,name,color,created_at}]}` oldest first, no pagination | done |
| `POST /inboxes/:inbox_id/labels` | `{name* ≤64, color? #RRGGBB}` | `201 {object:"inbox_label", id}` | done |
| `PATCH /inboxes/:inbox_id/labels/:label_id` | `{name?, color?}` | `{object:"inbox_label", id}` | done |
| `DELETE /inboxes/:inbox_id/labels/:label_id` | | `{object:"inbox_label", id, deleted:true}` (removed from every thread) | done |

Names unique per inbox ignoring case (`422`), max 100 labels, colors stored uppercase, random palette
color when omitted.

### Threads

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `GET /inboxes/:inbox_id/threads` | `folders` (csv; default `inbox`, or `inbox,archive,sent` with `labels`), `labels` (csv ≤50 UUIDs), `read`, pagination | list of thread (below), most recently active first | done |
| `GET /inboxes/:inbox_id/threads/search` | `query` (≤256 chars, ≤32 words, `"phrases"`, `-exclude`), `from/to/cc/bcc` (csv ≤20), `has_attachment`, `start_date`, `end_date` (date = whole day), + list filters | list of thread + `matched_email_id` | done |
| `GET /inboxes/:inbox_id/threads/:thread_id` | | `{object:"inbox_thread", id, subject, folder, labels, read}` | done |
| `PATCH /inboxes/:inbox_id/threads/:thread_id` | `{read?, folder? inbox\|archive\|spam\|trash}` (≥1) | thread summary | done |
| `DELETE /inboxes/:inbox_id/threads/:thread_id` | | `{object:"inbox_thread", id, deleted}` — moves to `trash` (purged after 30 days); `false` if already there | done |

Thread object: `{id, subject, from, to, cc, bcc, labels:[{id,name,color}], email_count, has_attachment,
has_draft, read, received_at, folder}`; `from/to/cc/bcc/has_attachment` describe the newest message.
Search errors (all `422 validation_error`) use Resend's messages (query length/words, `from` values,
`start_date` format and order, unknown folder, label UUID/count, `read` boolean). Search is SQL
substring matching, not a ranked full-text index: `matched_email_id` is the newest matching email
(Resend returns the most relevant one when `query` has words) — see deviations.

### Thread labels

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `POST /inboxes/:inbox_id/threads/:thread_id/labels` | `{labels: 1–10 IDs}` | `{object:"list", data:[{id,name,color}]}` (all labels after change) | done |
| `PUT /inboxes/:inbox_id/threads/:thread_id/labels` | `{labels: 0–100 IDs}` (atomic replace) | same | done |
| `DELETE /inboxes/:inbox_id/threads/:thread_id/labels/:label_id` | | same | done |

Unknown label → `404` `Label "<id>" not found.` and nothing changes.

### Thread emails

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `GET …/threads/:thread_id/emails` | pagination | list of message, oldest first | done |
| `GET …/threads/:thread_id/emails/:email_id` | | message | done |
| `POST …/emails/:email_id/reply` (sending) | `{html?\|text? (≥1), cc?, bcc? (≤49 combined), subject? (default `Re: <thread>`), reply_all?, attachments?, headers?}` | `{id}` (an `/emails` id) | done |
| `POST …/emails/:email_id/forward` (sending) | `{to*, cc?, bcc? (≤50 total), html?, text?, subject? (default `Fwd: …`), attachments?, headers?}` | `{id}` | done |

Message: `{id, direction inbound|outbound, from, to, cc, bcc, reply_to, subject, message_id, html, text,
attachments:[{id,filename,size}], read, received_at}`. Message IDs are the underlying
`received_emails.id` (inbound) or `emails.id` (outbound), so reply ids work with `GET /emails/:id`.
Reply goes to Reply-To, else the sender; a reply to an outbound message goes to its `to`;
`reply_all` adds the original to/cc minus the inbox. Replies and forwards carry `In-Reply-To` and
`References`; `headers` may not set `In-Reply-To`/`References`/`Reply-To` (`422`). Forwards include
the original attachments (≤10 files, ≤25 MB content; an original `path` attachment → `422`).
Outbound mail is sent from `from_name <inbox address>` through the normal pipeline
(`source: 'inbox'`: quota, suppressions, events, email.* webhooks).

### Drafts

| Endpoint | Request | Response | Status |
|---|---|---|---|
| `GET /inboxes/:inbox_id/drafts` | pagination | `{object:"list", has_more, data:[{id,type,to,cc,bcc,subject,snippet,thread_id,reply_to_email_id,updated_at,attachments}]}` | done |
| `POST /inboxes/:inbox_id/drafts` (sending) | `{to?, cc?, bcc?, subject?, html?, text?, attachments?:[{content,filename,content_type}], thread_id?+reply_to_email_id?}` | `201 {object:"inbox_draft", id}`; existing reply draft → `200` same id (attachments replaced) | done |
| `GET /inboxes/:inbox_id/drafts/:draft_id` | | `{object:"inbox_draft", id, type, to, cc, bcc, subject, html, text, thread_id, reply_to_email_id, email_id, created_at, updated_at, attachments}` | done |
| `PATCH /inboxes/:inbox_id/drafts/:draft_id` | any of the create fields; `html`/`text` replace both; `attachments` replaces all | `{object:"inbox_draft", id}`; sent draft → `409` | done |
| `DELETE /inboxes/:inbox_id/drafts/:draft_id` | | `{object:"inbox_draft", id, deleted:true}` | done |
| `POST /inboxes/:inbox_id/drafts/:draft_id/send` (sending) | `{headers?}` or no body | `{id}`; needs `to` and `html`/`text` (+ `subject` unless reply) → `422`; already sent → `409` | done |

Draft attachments: `content` required (no `path`, no `content_id`), valid MIME type, not empty,
blocked executables `422`, ≤25 MB total. A reply draft without `to` gets the reply recipients.

### Inbox webhooks

`inbox.created`, `inbox.updated` (`{source, inbox_id, inbox}`), `inbox.deleted` (`{source, inbox_id}`),
`inbox.thread.created`, `inbox.email.received`, `inbox.email.sent` (`{source, inbox_id, thread_id,
email_id, thread, email}`; `email` without `html`/`text`), `inbox.thread.folder.updated` (`+from, to`),
`inbox.thread.labels.updated` (`+added, removed`), `inbox.draft.created|updated|deleted|sent`
(`{source, inbox_id, thread_id?, draft_id, thread?, draft?}`; `sent` also has `email_id, email`).
`source` is `api` (API key), `dashboard` (internal API) or `system` (inbound). Keys that don't apply
are omitted. All done. `inbox.thread.assigned` / `inbox.thread.unassigned` — **phase 2** (no
assignment feature yet; the dashboard has no assignees).

### Receiving API

| Endpoint | Response | Status |
|---|---|---|
| `GET /emails/receiving` | `{object:"list", has_more, data:[{id,to,from,created_at,subject,bcc,cc,reply_to,received_for,message_id,attachments:[{id,filename,content_type,content_disposition,content_id,size}]}]}`; `limit` optional (all when omitted) | done |
| `GET /emails/receiving/:email_id?html_format=data_uri\|cid` | `{object:"email", id, to, from, created_at, subject, html, html_format, text, headers, bcc, cc, reply_to, received_for, message_id, raw:{download_url, expires_at}, attachments}`; `data_uri` (default) inlines `cid:` images | done |
| `GET /emails/receiving/:email_id/attachments` | list of `{id, filename, size, content_type, content_disposition, content_id?, download_url, expires_at}` (1 h signed URL) | done |
| `GET /emails/receiving/:email_id/attachments/:attachment_id` | `{object:"attachment", …}` | done |
| SDK `emails.receiving.forward()` (client-side: downloads `raw`, posts `/emails`) | | done (works because `raw.download_url` is served) |
| `email.received` webhook `{email_id, created_at, from, to, bcc, cc, received_for, message_id, subject, attachments}` | | done |
| `authentication` (spf/dkim/dmarc) on GET | | **phase 2** (not parsed yet) |
| `email_above_quota` 403 for over-quota inbound content | | **phase 2** (received mail counts toward quota but content is always readable) |

#### Inbound architecture

```
sender MTA ──25──► MX of <domain or subdomain> = mail-1 (Stalwart)
                    │  Stalwart routes every receiving domain into ONE catch-all mailbox
                    ▼
               catch-all account (e.g. inbound@example.com), mailbox "Inbox"
                    │  worker: JMAP poller every INBOUND_JMAP_INTERVAL_SEC (15 s)
                    ▼  Email/query → download blob (raw MIME) → ingestRaw() → move to "Processed" (or destroy)
               received_emails + received_attachments ─► email.received, inbox threads, inbox.* webhooks

alternative push path: any relay (Cloudflare Email Worker, Stalwart webhook/MTA hook)
   POST https://api.example.com/inbound  (Authorization: Bearer INBOUND_SECRET,
   X-Envelope-To: rcpt1,rcpt2, body = raw message/rfc822)
```

- `ingestRaw()` resolves each envelope recipient to the team whose domain (or parent domain) has
  `capabilities.receiving = enabled`, stores one received email per team, and threads it into any
  inbox whose address (or `receiving_address`) matches. Envelope recipients come from
  `X-Envelope-To` (push) or `Delivered-To`/`X-Original-To`/`Envelope-To`, else `Received … for <…>`
  (poller); falling back to To/Cc/Bcc.
- Threading: `In-Reply-To`/`References` against message IDs in the inbox, else same subject (ignoring
  `Re:`/`Fwd:`) within 30 days when the sender already participates; else a new thread. New inbound
  mail moves `sent`/`archive` threads back to `inbox`.
- Poller env: `INBOUND_JMAP_URL`, `INBOUND_JMAP_USER`, `INBOUND_JMAP_PASSWORD`,
  `INBOUND_JMAP_MODE=move|destroy` (default move), `INBOUND_JMAP_MAILBOX` (default the inbox role),
  `INBOUND_JMAP_INTERVAL_SEC`. Stalwart's advertised `apiUrl`/`downloadUrl` host is rebased onto
  `INBOUND_JMAP_URL`. Tested against the local 5050-dev Stalwart (bob@dev.test, a dedicated test
  mailbox, JMAP Email/import).
- Domain records show `Receiving MX @ → INBOUND_MX_HOST (priority 10)` when receiving is enabled.

**Phase 2 (infra):** point `INBOUND_MX_HOST` at mail-1 and publish it; Stalwart config to accept the
receiving domains and route them (catch-all / alias rules) into the catch-all account; create that
account and set the poller env in the worker; optionally the Cloudflare Email Worker push path for
domains on Cloudflare Email Routing; per-domain spam/auth verdicts into `authentication`.

### Deviations

- Search is substring/AND/NOT matching over subject, bodies, addresses and attachment names (no
  stemming or relevance ranking); the 10,000-thread cap is not enforced.
- Agent automation and thread assignment are not implemented (settings only).
- `forwarding` receiving addresses need `INBOX_FORWARDING_DOMAIN`.
- Inbox plan limit is env-configurable and off by default.

---

