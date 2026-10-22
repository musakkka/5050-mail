---
title: SMTP relay
description: Send through 5050 Send over SMTP with an API key, the same way as Resend's smtp.resend.com.
---

# SMTP relay

Apps that can only send over SMTP (auth providers, CMSs, frameworks' mailers) can use 5050 Send as their SMTP server. Messages go through the same pipeline as `POST /emails`: they appear in the dashboard's logs, count towards quotas and fire webhooks.

## Settings

| Setting | Value |
|---|---|
| Host | your mail hostname, for example `mail.example.com` |
| Port, implicit TLS | `2465` |
| Port, STARTTLS | `2587` |
| Username | `resend` |
| Password | an API key with `full_access` or `sending_access` |
| Maximum message size | 40 MB |

Ports 465 and 587 on the same server belong to the mail server, for people's mail apps. The Send relay therefore listens on 2465 and 2587, and these are published by default; open them in your provider's firewall if apps outside the server use them.

```ts title="Nodemailer"
import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({
  host: 'mail.example.com',
  port: 2465,
  secure: true,
  auth: { user: 'resend', pass: process.env.SEND_API_KEY },
});

await transport.sendMail({
  from: 'Acme <hello@example.com>',
  to: 'you@example.org',
  subject: 'Hello over SMTP',
  text: 'It works.',
});
```

The dashboard's **Integrations** page has copy-ready settings for Nodemailer, Django, Laravel, Rails, Spring Boot, PHPMailer, NextAuth.js, Supabase Auth, WordPress, Strapi and Payload, and for platforms with a custom SMTP option such as Clerk, Auth0, Firebase Authentication and Appwrite.

## Behaviour

- Authentication (PLAIN or LOGIN) is only offered over TLS. On the STARTTLS port, clients must upgrade first.
- The `From` domain must be verified for the key's team; a domain-scoped key can only send from its domain.
- `Resend-Idempotency-Key` header: retries with the same headers and body return the original `250 2.0.0 OK <email id>`.
- Custom headers pass through (`List-Unsubscribe`, `X-Entity-Ref-ID`, …).
- `X-Resend-Tags: name=value, name2=value2` sets tags. This is a 5050 Send extension.
- Bcc recipients are taken from the SMTP envelope.
- Emails sent over SMTP can't be scheduled, as on Resend.

| Reply | Meaning |
|---|---|
| `250 2.0.0 OK <id>` | Accepted; the id is the email's id in the API |
| `535` | Bad username or API key |
| `454` | Too many failed logins |
| `550` | Policy or validation failure (for example an unverified domain) |
| `552` | Message too large |
| `452` | Quota exceeded or too many recipients |
| `451` | Rate limit or temporary error; retry |

## Certificates

The relay uses the mail hostname's certificate, which Caddy obtains and renews. Renewed certificates are picked up automatically. On a fresh install the relay waits until that certificate exists before it starts listening.
