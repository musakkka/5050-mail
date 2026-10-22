---
title: Send dashboard
description: Teams, sign-in, domains, API keys, logs, metrics and the rest of the 5050 Send dashboard.
---

# Send dashboard

The dashboard at `https://send.example.com` is where developers manage sending: domains, API keys, webhooks, and everything that was sent.

## Signing in and teams

Sign in with a **mail account** from your 5050 Mail server, with the same address and password as the webmail. There are no separate dashboard passwords.

Work is organised in **teams**. Each team has its own domains, API keys, emails, contacts, webhooks, quotas and rate limit, and nothing is shared between teams. Only members of a team can open it.

Mail server administrators are dashboard administrators. They can create teams, add and remove members, give members the **admin** or **member** role, set each team's quotas and rate limit, and open every team.

## Pages

| Page | What it is for |
|---|---|
| Emails | Every email sent or received, with its status timeline, filters by status, API key and date, the rendered message and the raw MIME source. |
| Templates | Reusable templates with variables, published and versioned, used by `template` in `POST /emails`. |
| Audience | Contacts, segments, topics and contact properties; CSV import. |
| Inboxes | Receiving inboxes with threads, labels and drafts (labs feature, switched on per team in Settings). |
| Broadcasts | Marketing sends to a segment, with unsubscribe handling. |
| Automations | Event-triggered sequences of emails and delays. |
| Metrics | Delivered, opened, clicked, bounced and complained, by day and by domain. |
| Domains | Sending domains, their DKIM, SPF and DMARC records, and verification against public DNS. |
| Logs | Every API request: method, endpoint, status, user agent, duration, and request and response bodies with secrets redacted. Kept 30 days (`LOG_RETENTION_DAYS`). |
| API keys | Create, rename and delete keys; full or sending-only access; optional domain scope. |
| Webhooks | Endpoints, their deliveries and attempts, replay, and secret rotation. |
| Settings | Team name and members, the unsubscribe page's look, labs features. |

## A first send, end to end

1. **Domains → Add domain**, enter `example.com`, and publish the DKIM, SPF and DMARC records shown.
2. **Verify**. The status goes from `pending` to `verified`; unverified domains are re-checked every few minutes for 72 hours.
3. **API keys → Create API key**, copy the token.
4. Run the [curl example](/docs/send-api/#api-keys) with your key. The email appears under **Emails** and the request under **Logs**.
