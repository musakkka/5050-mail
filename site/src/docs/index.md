---
title: Introduction
description: What 5050 Mail and 5050 Send are, what runs on your server, and where to start.
---

# Introduction

5050 Mail is business email you run yourself. One installer puts three things on a single Linux VM:

- **5050 Mail**, a Gmail-style webmail client with an admin console for your own domains, users, aliases, groups and storage limits.
- **5050 Send**, an email API that speaks Resend's API and SMTP protocol, with its own dashboard, webhooks and logs.
- **Stalwart**, the open-source mail server underneath both (SMTP, IMAP, JMAP), so desktop and phone mail apps work too.

Everything is open source under the AGPL-3.0. Your mail, your accounts and your API logs stay in Postgres on your machine.

## What runs where

```text title="One VM, one docker compose project"
 internet ──25──────────► Stalwart          inbound mail (MX)
          ──465/587─────► Stalwart          mail apps sending (SMTP submission)
          ──993─────────► Stalwart          mail apps reading (IMAP)
          ──2465/2587───► send-smtp         your apps sending through 5050 Send
          ──443─────────► Caddy ─► webmail         mail.example.com
                                 ─► Send dashboard  send.example.com
                                 ─► Send API        api.example.com
 send-worker ──signs, then internal SMTP──► Stalwart ──25 or relay──► the world
 Stalwart, webmail, Send ──► Postgres (databases stalwart, webmail, send)
```

Outgoing mail leaves from your server on port 25, signed with your domain's DKIM keys. If your provider blocks port 25, Stalwart sends through any SMTP relay you name instead (see [Requirements](/docs/requirements/#port-25)).

## Where to start

1. Check the [requirements](/docs/requirements/): a VM with a public IPv4 address, ports 25, 80, 443, 465, 587 and 993 open, and a domain you control.
2. Run the [one-command install](/docs/quickstart/).
3. Publish the [DNS records](/docs/dns/) it prints, or give it a Cloudflare token and it publishes them for you.
4. Sign in to the webmail as the admin and add your people in the [admin console](/docs/admin-console/).
5. If your apps send email through Resend today, point them at [5050 Send](/docs/send-api/) by changing the base URL.

## What it is not

- It is not a hosted service. You are the administrator: you keep the VM patched, watch disk space and keep backups. The [backups page](/docs/backups-upgrades/) shows how.
- It does not migrate your old mailbox for you. Any IMAP copy tool works against it (see the [FAQ](/docs/faq/#can-i-move-my-existing-mail-over)).
- Deliverability is earned, not bought. A fresh IP has no reputation; the [troubleshooting page](/docs/troubleshooting/#mail-lands-in-spam) covers what helps.
