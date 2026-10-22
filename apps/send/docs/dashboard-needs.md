# Dashboard needs (send/web → backend)

Endpoints the dashboard (send/web) calls that are not in `internal-api.md` yet.
All are under `/api/internal` with the session cookie and `X-Requested-With`
on unsafe methods. Until they exist the dashboard falls back where it can
(noted per item) and the mock (`send/web/src/api/mock`) implements them.
Append-only: add new items at the end.

## 1. Filtered email list — `GET /teams/:teamId/emails`
Query: `status` (Resend last_event), `api_key_id`, `q` (matches to/from/subject/id),
`start`, `end` (ISO, on created_at), `limit` (≤100, default 40), `after`/`before` (email id cursor).
```json
{ "object": "list", "has_more": true, "data": [ { "object": "email", "id": "…", "to": ["a@b.com"], "from": "…", "created_at": "…", "subject": "…", "bcc": null, "cc": null, "reply_to": null, "last_event": "delivered", "scheduled_at": null, "api_key_id": "…|null" } ] }
```
Fallback: plain `resend/emails` (no filters applied server-side).

## 2. Raw MIME — `GET /teams/:teamId/emails/:emailId/raw`
```json
{ "raw": "Received: …\r\nFrom: …\r\n\r\n…" }
```
Also useful on `GET resend/emails/:id` (dashboard only): `log_id` (api_logs row that created it) and `api_key_id`.

## 3. API keys with dashboard fields — `GET /teams/:teamId/api-keys`
```json
{ "object": "list", "has_more": false, "data": [ { "id": "…", "name": "Production", "created_at": "…", "last_used_at": "…|null", "permission": "full_access|sending_access", "domain_id": "…|null", "token_preview": "re_AbCdEfGh", "created_by": "ada@northwind.dev|null" } ] }
```
Fallback: `resend/api-keys` (no permission/token preview columns).

## 4. Team settings — `PATCH /teams/:teamId` accepts `settings`
Body `{ "settings": { "unsubscribe_page": { "title": "…", "description": "…", "accent_color": "#111111", "background_color": "#f6f6f4", "logo_url": null, "show_topics": true }, "labs": { "inboxes": true } } }`
(shallow-merged into `teams.settings`; admins only). Response: the team, including `settings`.

## 5. Docs base URL in `GET /system`
Add `"docsBase": "https://…/docs"` so the bottom-bar docs link and ⌘K docs results point at our docs. Default in the SPA: `https://api.example.com/docs` (`VITE_DOCS_BASE`).

## 6. One-click Cloudflare DNS — `POST /teams/:teamId/domains/:domainId/cloudflare`
Body `{ "action": "connect" }`: onboard the zone (if it is in our Cloudflare account), publish the records, verify. Response: same shape as the existing `GET …/cloudflare`.

## 7. Contact CSV import — `POST resend/contacts/imports`
Body `{ "contacts": [ { "email": "…", "first_name": "…", "last_name": "…", "unsubscribed": false } ], "segment_id": "…|null" }` (rows parsed client-side, ≤ 10 000).
Response `{ "id": "…", "imported": 120, "skipped": 3 }`. Fallback: one `POST resend/contacts` per row.

## 8. Docker image serves the SPA
`send/src/internal/spa.ts` serves `send/web/dist` (or `DASHBOARD_DIST`). The Dockerfile needs a stage that runs `npm ci && npm run build` in `web/` and copies `web/dist` to `/app/web/dist` (the default path resolves to `../../web/dist` from `dist/internal`).

## 9. Suppressions: filters and details — `GET resend/suppressions`
Query `q` (substring of the email) and `reason` (`bounce|complaint|unsubscribe|manual`); `limit` up to 100 with `after` cursor.
Each suppression may include `"details": "smtp; 550 5.1.1 … User unknown"` (the bounce/complaint diagnostic) and `email_id`.
Fallback: the dashboard filters client-side and, when `email_id` is set, reads the message from that email's `bounced`/`complained` event `data.message`.

## 10. Email events carry diagnostics — `GET /teams/:teamId/emails/:emailId/events`
`data` should include `message` (bounce/delay/failure text), `link` (clicked) and `reason` (suppressed/failed) where known; the event timeline shows them in tooltips.

## 11. Logs: date range, user agent, total, headers — `GET /teams/:teamId/logs`, `GET /teams/:teamId/logs/:logId`
The Logs page filters like the reference ("Last 15 days", "All user agents", "All sources") and shows "Page 1 – 2 of 49 logs".
- New query params on the list: `start` / `end` (ISO, inclusive range on `created_at`), `user_agent` (case-insensitive substring, e.g. `resend-node`, `curl`). `source` may also be `dashboard`.
- New field on the list response: `"total": 49` (count of rows matching the filters, capped is fine, e.g. at 10 000). Without it the footer shows only "Page N".
- On the detail row: `"request_headers": { "content-type": "application/json", "user-agent": "…", "authorization": "Bearer re_…redacted" } | null` and `"response_headers": { … } | null` for the "Request headers" tab (the api_logs table has no headers columns yet).
```json
{ "has_more": true, "total": 49, "data": [{ "id": "uuid", "created_at": "ISO", "method": "POST", "endpoint": "/emails", "response_status": 200, "user_agent": "resend-node:6.34.1", "api_key_id": "uuid", "source": "api", "duration_ms": 31, "ip": "203.0.113.4" }] }
```

## 12. Webhook deliveries: status filter and attempt count — `GET resend/webhooks/:id/events`
The webhook detail page filters deliveries (All / Succeeded / Failed / Pending) and shows attempts per row.
- Query param `status=success|failed|pending|attempting` on the list.
- Fields per item: `"attempts": 2` (attempt_count) and `"last_attempt_at": "ISO" | null`.

## 13. Metrics breakdowns per domain — `GET /teams/:teamId/metrics?dimensions=period&dimensions=domain`
Already supported; the dashboard relies on `domain_name` on each row and on `bounced_transient`, `bounced_permanent`, `bounced_undetermined`, `unsubscribed`, `received` counts being present (0 when none) so the Bounce rate breakdown and the "All Events" series render.
