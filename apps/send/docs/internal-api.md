# 5050 Send — internal (dashboard) API

Served on `DASHBOARD_HOST` (production `send.example.com`) under `/api/internal`.
Everything the dashboard needs: auth, teams/members, a team-scoped passthrough to
the full public API, and dashboard-only data (logs with bodies, timelines, metrics,
webhook attempt details, Cloudflare state, usage, SMTP/integrations).

Source: `src/internal/app.ts`, `src/internal/routes.ts`. Tests: `test/internal/dashboard.test.ts`.

## Conventions

- **Session**: `POST /api/internal/login` sets an httpOnly, `SameSite=Lax` cookie (`send_sid`, `Secure` over https). Sessions live in Postgres (only a hash of the id is stored), idle timeout 7 days, max 30 days.
- **CSRF**: every `POST`/`PUT`/`PATCH`/`DELETE` must send `X-Requested-With: <anything>`; when the browser sends `Origin` it must match the host. Otherwise `403 {"error":"csrf"}`.
- **Errors** (dashboard routes): `{ "error": "<code>", "message": "<human text>" }` with codes `bad_request` (400), `unauthenticated` (401), `invalid_credentials` (401), `forbidden` (403), `no_team` (403), `csrf` (403), `not_found` (404), `rate_limited` (429, `Retry-After`), `upstream` (502), `internal` (500).
- **Passthrough errors** (`/teams/:teamId/resend/*`): exactly Resend's `{ "statusCode", "message", "name" }`.
- **Roles**: `superadmin` (Stalwart admin; every team), `admin` (team admin), `member`. Members can use everything except team settings, member management and API-key creation/deletion.
- **Timestamps**: dashboard routes return ISO 8601 (`2026-10-22T10:00:00.000Z`); passthrough routes return Resend's format (`2026-10-22 10:00:00.123456+00`).
- All responses carry `Cache-Control: no-store`.

## Auth

### `POST /api/internal/login`
Body `{ "email": "alice@dev.test", "password": "…" }` (mail account credentials, checked against Stalwart `GET /jmap/session`).
→ `200 { "email": "alice@dev.test", "name": "Alice", "isAdmin": true }` and the session cookie.
Errors: `400 bad_request`, `401 invalid_credentials`, `403 no_team` (valid mail account, not a member of any team, not a Stalwart admin), `429 rate_limited` (per IP, per account and global failure limits), `502 upstream`.

### `POST /api/internal/logout`
→ `{ "ok": true }` (clears the cookie).

### `GET /api/internal/me`
```json
{ "email": "bob@dev.test", "name": "Bob", "isAdmin": false,
  "teams": [{ "id": "uuid", "name": "Bob Co", "monthly_quota": 3000, "daily_quota": null, "rate_limit": 2, "created_at": "ISO", "role": "member" }] }
```
For Stalwart admins `teams` lists every team (`role` is their own role, else `superadmin`).

### `GET /api/internal/system`
```json
{ "apiBase": "https://api.example.com", "dashboardBase": "https://send.example.com",
  "transport": "cloudflare", "cloudflareConfigured": true,
  "analytics": { "authorized": false, "scope": "account", "last_error": "not authorized for that account", "last_attempt_at": "ISO", "last_success_at": null, "backoff_until": "ISO", "cursor": null },
  "warnings": [{ "code": "analytics_unauthorized", "message": "Delivery tracking is limited: …" }] }
```
Show `warnings` as a banner. `analytics.authorized` is `null` until the first poll.

## Teams ("developer accounts")

| method | path | who | body → response |
|---|---|---|---|
| GET | `/api/internal/teams` | any | → `{ "data": [Team & { "members": 3, "role"?: string }] }` (admins: all teams) |
| POST | `/api/internal/teams` | Stalwart admin | `{ "name", "monthly_quota"?, "daily_quota"?: number\|null, "rate_limit"?, "members"?: [{ "email", "role": "admin"\|"member" }] }` → `201 Team` |
| GET | `/api/internal/teams/:teamId` | member | → `Team & { "role", "settings": {} }` |
| PATCH | `/api/internal/teams/:teamId` | team admin (name); Stalwart admin (quotas, rate limit) | `{ "name"?, "monthly_quota"?, "daily_quota"?: number\|null, "rate_limit"? }` → `Team` |
| DELETE | `/api/internal/teams/:teamId` | Stalwart admin | → `{ "id", "deleted": true }` |

`Team` = `{ "id", "name", "monthly_quota", "daily_quota": number|null, "rate_limit", "created_at" }`.

### Members

| method | path | who | body → response |
|---|---|---|---|
| GET | `/api/internal/teams/:teamId/members` | member | → `{ "data": [{ "email", "role", "added_by": string\|null, "created_at" }] }` |
| POST | `/api/internal/teams/:teamId/members` | team admin | `{ "email", "role"?: "admin"\|"member" }` → `201 { "email", "role", "created_at" }` (upsert) |
| PATCH | `/api/internal/teams/:teamId/members/:email` | team admin | `{ "role" }` → `{ "email", "role" }` (`409` when demoting the last admin, unless Stalwart admin) |
| DELETE | `/api/internal/teams/:teamId/members/:email` | team admin, or the member themself | → `{ "email", "deleted": true }` |

Members are mail-account addresses; the user can sign in once added.

## Everything the public API does: `/api/internal/teams/:teamId/resend/*`

Any public endpoint, same method, path, body, query and response, run as the team
with full access (the dashboard is not rate limited and does not appear in the
team's API logs, as on Resend). Examples:

| dashboard page | call |
|---|---|
| Emails list / detail | `GET …/resend/emails?limit=50&after=…`, `GET …/resend/emails/:id`, `GET …/resend/emails/:id/attachments` |
| Send test email | `POST …/resend/emails` |
| Reschedule / cancel | `PATCH …/resend/emails/:id`, `POST …/resend/emails/:id/cancel` |
| Share link | `POST …/resend/emails/:id/share` |
| Receiving | `GET …/resend/emails/receiving`, `GET …/resend/emails/receiving/:id` |
| Domains | `GET/POST …/resend/domains`, `GET/PATCH/DELETE …/resend/domains/:id`, `POST …/resend/domains/:id/verify`, claims |
| API keys (admins) | `GET/POST …/resend/api-keys` (token returned once), `PATCH/DELETE …/resend/api-keys/:id` |
| Webhooks | `GET/POST …/resend/webhooks`, `GET/PATCH/DELETE …/resend/webhooks/:id`, `POST …/:id/signing-secret/rotate`, `GET …/:id/events`, `GET …/:id/events/:eventId`, `POST …/:id/events/:eventId/replay` |
| Audience | contacts, segments, topics, contact-properties, contacts/imports (multipart passes through) |
| Broadcasts / Templates / Automations / Events | all their endpoints |
| Inboxes | all `/inboxes/...` endpoints |
| Suppressions | `/suppressions…` |
| Metrics | `GET …/resend/emails/metrics?...` |
| Usage | `GET …/resend/usage` |

Not a team member → `404 {"error":"not_found"}`; members calling API-key mutations → `403 {"error":"forbidden"}`.

## Dashboard-only data

### `GET /api/internal/teams/:teamId/overview`
```json
{ "team": Team & { "role" },
  "counts": { "domains": 2, "verified_domains": 1, "api_keys": 3, "webhooks": 1, "contacts": 120, "emails_30d": 4210 },
  "usage": Usage,
  "warnings": [{ "code": "analytics_unauthorized", "message": "…" }] }
```

### `GET /api/internal/teams/:teamId/usage`
Same shape as public `GET /usage` (`Usage`):
```json
{ "object": "usage",
  "emails": { "daily": { "used": 12, "limit": null, "sent": 12, "received": 0, "resets_at": "ISO" },
              "monthly": { "used": 300, "limit": 3000, "sent": 290, "received": 10, "resets_at": "ISO" } },
  "contacts": { "used": 120, "limit": 1000 }, "segments": { "used": 2, "limit": null }, "broadcasts": { "used": 1, "limit": null },
  "ai_credits": { "used": 0, "limit": 0, "next_increase_at": null },
  "automation_runs": { "used": 0, "limit": 10000, "resets_at": "ISO" }, "domains": { "used": 2, "limit": null },
  "rate_limit": { "limit": 2, "duration": "1000ms" } }
```

### `GET /api/internal/teams/:teamId/metrics`
Metrics page. Accepts every `GET /emails/metrics` query parameter (`start_date`, `end_date`, `timezone`, `granularity` hourly|daily|weekly|monthly, `metrics`, `dimensions` period|domain|email|broadcast, `domain_id`, `email_id`, `broadcast_id`) plus `days=N` (shortcut for `start_date = now − N days`). Default `dimensions=period`.
```json
{ "object": "metrics", "start_date": "ISO", "end_date": "ISO", "metrics": ["sent", "delivered", "bounce_rate", "complaint_rate", "opened", "clicked"],
  "dimensions": ["period", "domain"], "granularity": "daily",
  "totals": { "sent": 1204, "delivered": 1180, "bounce_rate": 0.8, "complaint_rate": 0.1, "opened": 600, "clicked": 90 },
  "data": [{ "period": "2026-10-01", "domain_id": "uuid", "domain_name": "example.com", "sent": 172, "delivered": 169, … }] }
```
Rates are percentages with one decimal (`delivery_rate = delivered/sent`, `open_rate = unique_opened/delivered`, `click_rate = unique_clicked/delivered`, `bounce_rate = bounced/sent`, `complaint_rate = complained/delivered`, `unsubscribe_rate = unsubscribed/delivered`).

### `GET /api/internal/teams/:teamId/stats/daily?days=30`
Worker-maintained rollups (refreshed every 5 minutes), cheap for charts:
```json
{ "data": [{ "day": "2026-10-21", "domain_id": "uuid"|null, "sent": 10, "delivered": 9, "bounced": 1, "complained": 0, "opened": 4, "unique_opened": 3,
             "clicked": 2, "unique_clicked": 2, "failed": 0, "suppressed": 0, "delivery_delayed": 0, "unsubscribed": 0 }] }
```

### `GET /api/internal/teams/:teamId/emails/:emailId/events`
Email timeline (the "Events" panel):
```json
{ "data": [{ "type": "queued"|"scheduled"|"sent"|"delivered"|"delivery_delayed"|"bounced"|"complained"|"opened"|"clicked"|"failed"|"suppressed"|"canceled"|"unsubscribed",
             "recipient": "user@example.com"|null, "data": { "recipients": ["…"], "bounce": {…}, "click": {…}, "failed": { "reason": "…" } }, "created_at": "ISO" }] }
```

### `GET /api/internal/teams/:teamId/logs`
Logs page (30-day retention). Query: `limit` (1–100, default 50), `before=<logId>` (next page), `status` (`200` or `4xx`/`5xx`), `method`, `endpoint` (prefix), `api_key_id`, `source` (`api`|`smtp`).
```json
{ "has_more": true,
  "data": [{ "id": "uuid", "created_at": "ISO", "method": "POST", "endpoint": "/emails", "response_status": 200, "user_agent": "resend-node:6.34.1",
             "api_key_id": "uuid"|null, "source": "api", "duration_ms": 31, "ip": "203.0.113.4"|null }] }
```

### `GET /api/internal/teams/:teamId/logs/:logId`
Full row incl. `request_body` and `response_body` (JSON, secrets redacted: tokens, signing secrets, passwords and attachment `content` are masked).

### `GET /api/internal/teams/:teamId/webhooks/:webhookId/events/:eventId/attempts`
Attempt log with details the public API leaves out:
```json
{ "data": [{ "id": "atmpt_…", "http_status_code": 500|null, "response": "first 2 KB of the body", "error": "Request failed: …"|null,
             "duration_ms": 120, "is_replay": false, "sent_at": "ISO" }] }
```
Replay: `POST …/resend/webhooks/:webhookId/events/:eventId/replay`.

### `GET /api/internal/teams/:teamId/webhooks/:webhookId/health`
```json
{ "status": "enabled"|"disabled", "failing_since": "ISO"|null, "disabled_reason": "Endpoint failed continuously for 5 days"|null,
  "last_7_days": { "success": 120, "failed": 2, "pending": 0 } }
```

### `GET /api/internal/teams/:teamId/domains/:domainId/cloudflare`
```json
{ "zone_id": "…"|null, "zone": "example.com"|null, "managed": true, "sending_enabled": true,
  "last_error": "example.org is not in the connected Cloudflare account yet; …"|null, "last_checked_at": "ISO"|null, "verified_at": "ISO"|null }
```
`managed: true` means one-click (records published in our zone); otherwise show the `records` from `GET …/resend/domains/:id` for the user to add, and a "Verify" button (`POST …/resend/domains/:id/verify`).

### `GET /api/internal/teams/:teamId/smtp`
```json
{ "host": "smtp.example.com", "username": "resend", "password": "YOUR_API_KEY",
  "ports": [{ "port": 2465, "security": "tls", "description": "Implicit TLS (SMTPS)" }, { "port": 587, "security": "starttls", "description": "STARTTLS" }],
  "notes": ["…"] }
```
(The SMTP role may add fields; see `src/services/integrations.ts`.)

### `GET /api/internal/teams/:teamId/integrations`
```json
{ "smtp": SmtpInfo,
  "snippets": [{ "id": "nodemailer", "name": "Nodemailer", "category": "smtp"|"sdk"|"framework"|"platform",
                 "docs_url": "https://…", "language": "typescript", "snippet": "…host/port/username filled in…", "notes": "…" }] }
```

## Public pages the dashboard links to

- `GET /shared?token=…` (dashboard host): read-only view of a shared email (from `POST /emails/:id/share`), body in a sandboxed iframe.
- On the API host (no auth, signed tokens): `/t/o/:token` (open pixel), `/t/c/:token` (click redirect), `/unsubscribe/:token` (GET page, POST one-click), `/attachments/:token`, `/receiving/raw/:token`.

## Dashboard-needs endpoints (docs/dashboard-needs.md)

| # | Endpoint | Notes |
|---|---|---|
| 1 | `GET /api/internal/teams/:teamId/emails` | Query `status` (last_event), `api_key_id`, `q` (to/from/subject/id), `start`, `end` (ISO on created_at), `limit` ≤ 100 (default 40), `after`/`before` (email id). → `{ object: "list", has_more, data: [{ object: "email", id, to, from, created_at, subject, bcc, cc, reply_to, last_event, scheduled_at, api_key_id, source }] }` |
| 2 | `GET /api/internal/teams/:teamId/emails/:emailId/raw` | → `{ raw }`: the MIME as built for the transport (tracking rewrites not applied). `GET …/resend/emails/:id` from the dashboard also returns `api_key_id`, `log_id` (api_logs row that created it) and `source`. |
| 3 | `GET /api/internal/teams/:teamId/api-keys` | → `{ object: "list", has_more: false, data: [{ id, name, created_at, last_used_at, permission, domain_id, token_preview: "re_AbCdEfGh", created_by }] }` |
| 4 | `PATCH /api/internal/teams/:teamId` with `settings` | Shallow-merged into the team's settings (team admins). Response includes `settings`. |
| 5 | `GET /api/internal/system` | Adds `docsBase` (env `DOCS_BASE`, default `${PUBLIC_API_BASE}/docs`). |
| 6 | `POST /api/internal/teams/:teamId/domains/:domainId/cloudflare` | Body `{ "action": "connect" }`: onboard Email Sending (zone in our account), publish records, verify now. → same shape as `GET …/cloudflare`; `409 not_configured` without Cloudflare. |
| 7 | `POST /api/internal/teams/:teamId/resend/contacts/imports` with `Content-Type: application/json` | Body `{ contacts: [{ email, first_name, last_name, unsubscribed }] (≤ 10 000), segment_id? }` → `201 { id, imported, skipped }` (existing or invalid emails are skipped; existing ones are still added to the segment; recorded as a completed contact import; no contact webhooks). Multipart requests still go to Resend's CSV import. |
| 8 | Docker image | The Dockerfile builds `send/web` and serves `web/dist` on the dashboard host. |
| 9 | `GET …/resend/suppressions` (dashboard only) | Extra query `q` (email substring) and `reason` (`bounce`, `complaint`, `manual`; `unsubscribe` → none, unsubscribes are on contacts). Items add `email_id` (source email) and `details` (bounce diagnostic, or "Marked as spam by the recipient"). |
| 10 | `GET /api/internal/teams/:teamId/emails/:emailId/events` | `data` now also carries `message` (bounce/suppression text), `link` (clicks) and `reason` (failed reason / suppression type) when known. |
