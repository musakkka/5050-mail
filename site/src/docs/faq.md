---
title: FAQ
description: Answers to the questions people ask before and after installing 5050 Mail.
---

# FAQ

## Do I need Cloudflare?

No. Cloudflare is optional. With an API token, 5050 Mail publishes DNS records, sets up DKIM and gets certificates by itself. Without one, it shows you the exact records and you add them at any DNS provider. See [DNS and custom domains](/docs/dns/).

## How many mailboxes can I have?

The software has no limit and no per-user licence. The practical limits are your server's disk (mail is stored on it) and memory. Set [storage limits](/docs/admin-console/#storage-limits) per user so one mailbox can't fill the disk.

## Can I host several domains?

Yes. Add as many as you like in **Admin console → Domains**. Users can have addresses on several domains through aliases.

## My provider blocks port 25. Can I still use it?

Yes. Receiving works regardless. For sending, either ask the provider to unblock port 25, or set an SMTP relay in `.env`. See [Requirements: port 25](/docs/requirements/#port-25).

## Can I move my existing mail over?

5050 Mail doesn't include a migration tool yet. Any IMAP-to-IMAP copy tool works, because both sides speak IMAP: for example `imapsync`, run once per mailbox from your old provider to `mail.example.com:993`. Copy first, then switch your `MX` record, then copy again to pick up the mail that arrived in between. Contacts and calendars are not migrated.

## Will my mail reach the inbox?

If SPF, DKIM, DMARC and PTR are right and the IP isn't blocklisted, mail from a small business server usually lands in the inbox. A brand-new IP has no reputation yet, so start with normal person-to-person mail before bulk sends. [Troubleshooting](/docs/troubleshooting/#mail-lands-in-spam) has the checklist.

## Is 5050 Send a full replacement for Resend?

For the API surface, almost: emails, batch, scheduling, domains, API keys, contacts, segments, topics, broadcasts, templates, webhooks, suppressions, logs, metrics, automations and inboxes are implemented and tested against the official Node.js SDK. Resend's OAuth app authorization is not implemented yet. The big difference is delivery: you send from your own IP, so its reputation is yours to build. See [Differences from Resend](/docs/send-api/#differences-from-resend).

## Can I use only 5050 Send, or only the webmail?

The installer sets up both, because Send signs its users in through the mail server and delivers through it. If you don't need Send, don't create any teams or API keys; it then sits idle.

## Does it work with Outlook, Apple Mail and phones?

Yes. Every mailbox is a normal IMAP and SMTP account. See [Mail apps](/docs/webmail/#mail-apps-on-desktop-and-phone).

## What does AGPL-3.0 mean for me?

You can use, modify and host it for any purpose, including commercially. If you modify it and let people use your modified version over a network, you must offer them its source code under the same licence. Using it unmodified for your own company's mail asks nothing of you.

## Is it affiliated with Google or Resend?

No. 5050 Mail's webmail follows Gmail's layout so it is familiar, and 5050 Send implements Resend's public API so existing code works. Neither company is involved.
