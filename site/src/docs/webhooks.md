---
title: Webhooks
description: Receive email, contact and domain events from 5050 Send, signed with Svix-compatible signatures.
---

# Webhooks

5050 Send posts events to your endpoints as they happen: an email was delivered, bounced, opened, a contact unsubscribed. Payloads, event names and signatures follow Resend, so existing handlers keep working.

## Create an endpoint

In the dashboard open **Webhooks → Add webhook**, or call the API:

```sh
curl https://api.example.com/webhooks \
  -H 'Authorization: Bearer re_xxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{ "endpoint": "https://app.example.org/hooks/email", "events": ["email.delivered", "email.bounced"] }'
```

```json title="201 Created"
{ "object": "webhook", "id": "8f2c…", "signing_secret": "whsec_…" }
```

Endpoints must be `http` or `https` URLs on the public internet; private, loopback and link-local addresses are refused.

## Events

| Group | Events |
|---|---|
| Email | `email.sent`, `email.scheduled`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.received`, `email.failed`, `email.suppressed` |
| Contacts | `contact.created`, `contact.updated`, `contact.deleted`, `contact.topics.updated` |
| Domains | `domain.created`, `domain.updated`, `domain.deleted` |
| Suppressions | `suppression.added`, `suppression.removed` |
| Topics | `topic.created`, `topic.updated`, `topic.deleted` |
| Inboxes | the `inbox.*` events |

```json title="email.delivered"
{
  "type": "email.delivered",
  "created_at": "2026-10-22T09:41:07.000Z",
  "data": {
    "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    "created_at": "2026-10-22T09:41:05.000Z",
    "from": "Acme <hello@example.com>",
    "to": ["you@example.org"],
    "subject": "Hello",
    "message_id": "<4ef9a417-02e9-4d39-ad75-9611e0fcc33c@example.com>"
  }
}
```

Bounces add `bounce { message, type, subType }`, clicks add `click { link, ipAddress, userAgent, timestamp }`, failures add `failed { reason }`.

## Verify signatures

Every request carries three headers, in the [Standard Webhooks](https://www.standardwebhooks.com/) format that Svix uses:

| Header | Content |
|---|---|
| `svix-id` | Message id, `msg_…`. The same for every retry of one event. |
| `svix-timestamp` | Unix seconds when the attempt was signed |
| `svix-signature` | `v1,<base64 HMAC-SHA256>`, space-separated when two secrets are active |

The signature is computed over `{svix-id}.{svix-timestamp}.{raw body}` with the base64-decoded part of your `whsec_` secret. Verify the **raw** request body, before any JSON parsing.

```ts title="Node.js with the svix package"
import { Webhook } from 'svix';

const wh = new Webhook(process.env.SEND_WEBHOOK_SECRET); // whsec_…

export async function POST(req: Request) {
  const body = await req.text();
  const event = wh.verify(body, {
    'svix-id': req.headers.get('svix-id')!,
    'svix-timestamp': req.headers.get('svix-timestamp')!,
    'svix-signature': req.headers.get('svix-signature')!,
  }); // throws if the signature or timestamp is wrong
  // handle event.type …
  return new Response('ok');
}
```

The Resend SDK's `resend.webhooks.verify(...)` works too.

```python title="Python with the svix package"
from svix.webhooks import Webhook

wh = Webhook(os.environ["SEND_WEBHOOK_SECRET"])
event = wh.verify(request.body, dict(request.headers))  # raises on a bad signature
```

### Rotating the secret

`POST /webhooks/:id/signing-secret/rotate` (or **Rotate** in the dashboard) issues a new secret. For the next 24 hours payloads are signed with both, so you can deploy the new secret without dropping events.

## Retries

Answer with any `2xx` within 15 seconds. Otherwise the attempt is retried: immediately, then after 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours and 10 hours (8 attempts in all). An endpoint that fails continuously for 5 days is disabled, with the reason shown in the dashboard.

Redirects are not followed. Each attempt's status code and the first 2 KB of your response are kept, and you can replay any event from the dashboard or with `POST /webhooks/:id/events/:eid/replay`.
