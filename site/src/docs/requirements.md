---
title: Requirements
description: Server size, operating system, open ports, reverse DNS, and what to do when your provider blocks port 25.
---

# Requirements

## Server

| | Minimum | Comfortable |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| Memory | 4 GB | 8 GB |
| Disk | 40 GB SSD | sized for your mail: total mailbox storage plus 20 GB |
| OS | Ubuntu 24.04 LTS or Debian 12, 64-bit | same |
| Network | one public IPv4 address, IPv6 optional | same |

The disk is what grows. Everything, mail and attachments included, is stored in Postgres on the VM's disk, so plan for the mailboxes you have plus their growth, and leave room for backups. Storage limits per user are set in the [admin console](/docs/admin-console/#storage-limits).

At rest the whole stack uses about 1 to 1.5 GB of memory on a 2 vCPU / 4 GB VM. The Node services start one process per CPU core, so a bigger VM is used without any tuning. See [Scaling](/docs/scaling/).

Use a fresh VM. The installer installs Docker (from get.docker.com) if it is missing and binds ports 25, 80, 443, 465, 587, 993, 2465 and 2587, so nothing else on the machine may be listening on them.

## Ports

Open these inbound in your provider's firewall or security group:

| Port | Protocol | Used for |
|---|---|---|
| 25 | SMTP | Receiving mail from other servers (your MX). Also used **outbound** to deliver your mail. |
| 80 | HTTP | Certificate issuance (ACME HTTP-01) and redirect to HTTPS |
| 443 | HTTPS | Webmail, admin console, Send dashboard, Send API |
| 465 | SMTPS | Mail apps sending mail (implicit TLS) |
| 587 | SMTP submission | Mail apps sending mail (STARTTLS) |
| 993 | IMAPS | Mail apps reading mail |
| 2465, 2587 | SMTP | 5050 Send's SMTP relay for your apps (TLS and STARTTLS). Only needed if apps outside the server use it. |

## Reverse DNS (PTR)

The reverse DNS of your server's IPv4 address should be your mail hostname, for example `mail.example.com`, and that hostname's `A` record should point back to the same IP. Gmail, Outlook and most spam filters check this. You set PTR at your VM provider (usually in the server's networking settings, or by support ticket), not at your DNS provider.

Check it from any machine:

```sh
dig -x 203.0.113.10 +short      # should print mail.example.com.
dig mail.example.com A +short   # should print 203.0.113.10
```

## Port 25

Many cloud providers block **outbound** connections to port 25 to stop spam from new accounts. Without it your server can receive mail but cannot deliver to other servers. As of October 2026:

| Provider | Outbound port 25 |
|---|---|
| Google Cloud | Blocked to destinations outside your VPC. No exceptions. ([docs](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail)) |
| Microsoft Azure | Blocked for VMs on most subscription types; open on Enterprise Agreement and MCA-E subscriptions. ([docs](https://learn.microsoft.com/en-us/troubleshoot/azure/virtual-network/troubleshoot-outbound-smtp-connectivity)) |
| Hetzner Cloud | Ports 25 and 465 blocked by default. After your first paid invoice you can request unblocking, decided case by case. ([docs](https://docs.hetzner.com/cloud/servers/faq/)) |
| AWS EC2 | Restricted by default; you can ask AWS to remove the restriction for an instance. |
| DigitalOcean | Blocked on new accounts; support may lift it later. |

The installer tests outbound port 25 by connecting to three large mail providers with short timeouts. It tells a blocked port apart from a server without network, recognises your cloud provider (from DMI data or the instance-metadata service) and prints what to do. You then have two choices.

### Ask your provider to unblock it

Best for deliverability over time: your own IP builds its own reputation. Set PTR first, explain that you run a mail server for your own domain, and mention that you publish SPF, DKIM and DMARC.

### Send through a relay

Any SMTP service that accepts authenticated mail on port 465 or 587 works: Cloudflare Email Service, Resend, Amazon SES, Postmark, Mailgun, Brevo, SMTP2GO or your own. Inbound mail still arrives directly on port 25.

```sh
sudo /opt/5050-mail/install.sh --relay            # menu, tests the login, flushes the queue
sudo /opt/5050-mail/install.sh --relay resend --relay-password "$RESEND_API_KEY" --yes
```

See [Outbound relay](/docs/outbound-relay/) for every provider's settings, validation, SPF and the Cloudflare Email Service setup.

> [!IMPORTANT]
> Most relays only send for domains you have verified with them. Add the relay's SPF `include:` to your single SPF record (see [DNS](/docs/dns/#spf)); with Cloudflare DNS the installer merges it for you.

## A domain

You need a domain where you can create `A`, `MX`, `TXT` and (optionally) `CNAME` records. It can be the domain you already use for a website. If the domain already has mail at another provider, moving its `MX` record moves its mail: plan the switch (see the [FAQ](/docs/faq/)).
