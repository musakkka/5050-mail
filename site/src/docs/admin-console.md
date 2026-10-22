---
title: Admin console
description: Manage domains, users, aliases, groups, mailing lists, roles and storage limits.
---

# Admin console

Administrators see **Admin console** in the webmail's left menu. It manages everything on the mail server: domains, the people who sign in, their addresses, and shared mailboxes. Changes apply immediately; there is nothing to restart.

The first administrator is the mailbox the installer created (`admin@example.com` by default). Make other people administrators from their user page.

## Overview

The landing page shows the counts of domains, users, groups and mailing lists, anything that **needs attention** (for example a domain whose DNS records are missing), and **Outbound mail**: the routes this server can deliver through (direct to each recipient's MX, or your relay) and the delivery queue.

## Domains

**Domains** lists every mail domain on the server with its status.

**Add a domain** asks for:

- **Domain name**, for example `example.org`.
- **Description**, optional.
- **How is this domain's DNS hosted?** Choose **Cloudflare** to have records published automatically (needs a [Cloudflare token](/docs/dns/#with-cloudflare-one-click)), or **manual** to get the exact records to add yourself.
- **Records to publish**: DKIM, MX, TLS reporting, SPF and DMARC by default. **More record types** adds MTA-STS, CAA, TLSA, SRV, Autoconfig and Autodiscover. Leave SPF or DMARC off if the zone already has one.
- **TLS certificate**: requested and renewed by the server (Let's Encrypt through DNS validation), or managed outside 5050 Mail.

A domain's page shows its **DKIM** keys (Ed25519 and RSA, created and rotated automatically), its **TLS certificate**, how its **DNS** is managed, and the full **DNS records** table with a copy button per value and **Copy zone file**. **Check DNS** looks every record up in public DNS and shows which are missing; with Cloudflare configured, **Publish records** writes them to the zone. From there you can **Disable** a domain or **Remove** it.

## Users

**Users** lists the mailboxes and the people who sign in to them, with each one's role, status and storage used. Search by name, address or alias, and filter by domain.

**Add a user** asks for a name, an email address on one of your domains, a password, a role and a storage limit. After saving, the dialog shows the sign-in details once with a copy button: share them with the person. The password isn't shown again.

On a user's page you can:

- change their **name** and **password**,
- add and remove **email aliases** (more addresses that deliver to the same mailbox, on any of your domains),
- set their **role**: **User**, or **Administrator** (can manage domains, users and groups),
- set a **storage limit** in GB, or leave it empty for no limit,
- add them to **groups**,
- **disable** the account and **reactivate** it later; disabling keeps the mailbox and its mail.

### Storage limits

Limits are per user, in GB. When a mailbox reaches its limit, the mail server stops accepting new mail for it until space is freed or the limit is raised. The **Storage used** column on the users list shows who is close.

## Groups and mailing lists

**Groups & lists** has two kinds of shared address:

| | Group | Mailing list |
|---|---|---|
| What it is | A shared mailbox, like `support@` or `sales@` | A distribution address that forwards to everyone on it |
| Members | Users on this server | Any addresses, inside or outside your domains |
| Where mail lands | In the group's own mailbox, which members open from the webmail | A copy in each recipient's own inbox |

**Create a group** asks for the group address and a description; then add members by searching users. **Create a mailing list** asks for the list address and its recipients, separated by commas or new lines. A list with no recipients accepts mail and delivers it nowhere, so add recipients before you publish the address.

## Who can do what

| Action | User | Administrator |
|---|---|---|
| Read and send mail, change own settings and password | yes | yes |
| Open the admin console | no | yes |
| Manage domains, users, groups, lists | no | yes |
| Create teams in 5050 Send, set their quotas | no | yes |

Administrators of the mail server are also administrators of the [5050 Send dashboard](/docs/send-dashboard/).
