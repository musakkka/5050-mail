---
title: DNS and custom domains
description: Every DNS record 5050 Mail needs, what each one does, and how to publish them with or without Cloudflare.
---

# DNS and custom domains

A mail domain needs a handful of DNS records: one to receive mail (`MX`), three to prove that mail from your server is really yours (SPF, DKIM, DMARC), and a few optional ones that help mail apps and other servers. 5050 Mail generates all of them. You either let it publish them through Cloudflare, or you copy them to your DNS provider.

## The records

Examples use `example.com` and the server `mail.example.com` at `203.0.113.10`. Your real values, including the DKIM keys, are printed by the installer and shown on each domain's page in the [admin console](/docs/admin-console/#domains), where every value has a copy button and **Copy zone file** copies all of them at once.

| Type | Name | Value | Required |
|---|---|---|---|
| A | `mail` | `203.0.113.10` | yes |
| MX | `@` | `10 mail.example.com.` | yes |
| TXT | `@` | `v=spf1 mx -all` | yes |
| TXT | `v1-ed25519-20261022._domainkey` | `v=DKIM1; k=ed25519; h=sha256; p=…` | yes |
| TXT | `v1-rsa-20261022._domainkey` | `v=DKIM1; k=rsa; h=sha256; p=…` | yes |
| TXT | `_dmarc` | `v=DMARC1; p=reject; rua=mailto:postmaster@example.com` | strongly recommended |
| TXT | `_smtp._tls` | `v=TLSRPTv1; rua=mailto:postmaster@example.com` | optional |
| A | `send`, `api` | `203.0.113.10` | if you use 5050 Send |

### A: the mail hostname

`mail.example.com` points at your server. It is the name in your `MX` record, the name on the TLS certificate, the server name for mail apps, and what your IP's reverse DNS (PTR) should say. See [Requirements](/docs/requirements/#reverse-dns-ptr).

### MX: where mail for the domain goes

Tells other servers to deliver `anyone@example.com` to `mail.example.com`. The number is a priority; with one server it doesn't matter. Changing the `MX` record is the moment mail starts arriving at 5050 Mail, so if the domain receives mail somewhere else today, do this last.

### SPF

Lists the servers allowed to send mail for the domain. `v=spf1 mx -all` means "the servers in my `MX` record, nobody else". A domain can have only **one** SPF record: if you already have one (for example for a newsletter tool), merge the two, `v=spf1 mx include:spf.newsletter.example -all`, instead of adding a second.

If you send through a [relay](/docs/requirements/#send-through-a-relay), add the relay's include, for example `v=spf1 mx include:amazonses.com -all`.

### DKIM

The mail server signs every outgoing message with a private key; the public half lives in DNS. 5050 Mail creates two keys per domain, Ed25519 and RSA, signs with both, and rotates them automatically. The record names contain the key's creation date (`v1-ed25519-20261022._domainkey`), so copy them exactly from your server rather than from this page.

### DMARC

Tells receivers what to do with mail that fails SPF and DKIM, and where to send reports. `p=reject` is the strict setting and the right one for a domain whose only sender is this server. If other services also send as your domain and you haven't set up their DKIM yet, start with `p=none` and tighten later. Reports go to `postmaster@`, which the installer creates as an alias of the admin mailbox.

Leave DMARC off in the domain settings if your zone already publishes a DMARC policy.

### TLS reporting (TLS-RPT)

Asks other servers to report TLS failures when they deliver to you. Harmless and useful; on by default.

### Optional records

The domain page in the admin console can also publish:

| Record | What it does |
|---|---|
| MTA-STS | Tells senders to require TLS when delivering to you (`mta-sts` CNAME plus `_mta-sts` TXT). |
| CAA | Restricts which certificate authorities may issue certificates for the domain. |
| TLSA (DANE) | Pins your certificate for servers that validate DNSSEC. Only useful on a DNSSEC-signed zone. |
| SRV | Lets mail apps find your IMAP and SMTP servers. |
| Autoconfig, Autodiscover | Lets Thunderbird and Outlook set themselves up from just an email address. |

These are off by default; switch on **More record types** when you add or edit a domain.

## With Cloudflare: one click

If the domain's DNS is on Cloudflare, give 5050 Mail an API token and it creates the records itself, gets certificates through DNS validation, and keeps MX, SPF, DKIM and DMARC published. The installer asks "Is the DNS for your domain on Cloudflare?" and walks you through the token. To use a token later, set `CLOUDFLARE_API_TOKEN` in `/opt/5050-mail/.env` (and `CLOUDFLARE_ZONE` if your mail domain is not the zone itself, for example `mail.corp.example.com` in the zone `example.com`) and re-run the installer.

In the admin console, **Add a domain** then offers the Cloudflare zones the token can see: one click publishes DNS, sets up DKIM signing and requests the certificate. For a domain added by hand, **Publish records** on its page does the same. The token never reaches the browser.

### Cloudflare token

Create the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens): **Create Token**, then **Create Custom Token**. Give it these permissions:

| Scope | Permission | Access | Needed for |
|---|---|---|---|
| Zone | DNS | Edit | Creating records and DNS validation for certificates. Required. |
| Zone | Zone | Read | Finding your zone. Required. |
| Account | Email Sending | Edit | Sending through Cloudflare when your host blocks port 25. Optional otherwise. |

Under **Zone Resources** choose **Include > Specific zone** and pick your domain. That keeps the token to one zone. Under **Account Resources** (only if you add Email Sending) choose your account. Then **Continue to summary** and **Create Token**, and copy the secret. Cloudflare shows it once.

This link opens the form with DNS Edit and Zone Read filled in. It only pre-fills the form; you still review and create the token, and add Email Sending by hand:

```text
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=5050%20Mail
```

User tokens and account-owned tokens both work. The installer verifies a user token at `/user/tokens/verify` and an account-owned one at `/accounts/{id}/tokens/verify`.

**What the installer checks.** It confirms the token is active, lists the zones it can see and picks the one that holds your domain. It tests `Zone > DNS > Edit` by creating and deleting one TXT record named `_5050-token-check`, and tests Email Sending by listing the zone's sending domains. If a permission is missing it names it, for example `Zone > DNS > Edit`, and waits while you fix the token. Edits to a token apply at once, so pressing Enter re-checks without a new token. If the dashboard also lists an Email Sending entry under **Zone** and the installer still reports it missing, add that one too.

**Where the token lives.** In `/opt/5050-mail/.env` on your server, mode 0600, and nowhere else. It is sent only to Cloudflare. To revoke it, delete it on the API tokens page; the installer's DNS and certificate renewal then stop working until you give it a new one.

**What it does to your zone.** Records are created as **DNS only** (never proxied). It never adds a second SPF or DMARC record:

| Record | If one already exists |
|---|---|
| SPF (`v=spf1`) | This server is added to it (`a:mail.example.com`, before the final `all`), and the installer shows the old and new value. More than one SPF record is left alone with a warning. |
| DMARC | Kept as it is. |
| MX | The installer lists the existing MX records and asks before replacing any that would compete (same or lower priority number). With `--replace-mx` it replaces them without asking. If you say no, mail keeps going to the old servers. |
| `A` for mail, send, api | Left alone if it points elsewhere, with a warning. |
| DKIM, TLS reporting | Left alone if a record with the same name already holds a value. |

Everything it changed is listed in the summary at the end ("DNS changed").

> [!NOTE]
> Cloudflare's orange-cloud proxy only carries web traffic. Keep `mail.example.com` **DNS only** (grey cloud), or mail apps and other mail servers can't reach it.

## Without Cloudflare

Any DNS provider works. After the install, and whenever you add a domain:

1. Open **Admin console → Domains →** your domain. The **DNS records** table lists every record with a copy button.
2. Add each one at your DNS provider. Most providers want the name without the domain (`_dmarc`, not `_dmarc.example.com`).
3. Click **Check DNS**. It looks the records up in public DNS and shows which are still missing or different.

To print the primary domain's records again from the server:

```sh
sudo docker compose --env-file /opt/5050-mail/.env -f /opt/5050-mail/deploy/docker-compose.yml \
  --profile tools run --rm bootstrap --print-dns
```

## Adding more domains

One server can host any number of domains. In the admin console, open **Domains → Add a domain**, enter the name, choose how its DNS is managed, publish the records, then [create users or aliases](/docs/admin-console/#users) on it. Each domain gets its own DKIM keys. New domains use `mail.<your primary domain>` as their `MX`, so they need no new `A` record or certificate.

## Sending domains in 5050 Send

Domains you send from with [5050 Send](/docs/send-api/#domains) are separate from mail domains. Each team adds its own in the Send dashboard or with the API, and they are never added to the mail server, so a team can't capture mail for a domain it doesn't control. Each one gets its own DKIM key, and 5050 Send signs messages before handing them to the mail server for delivery.

| Type | Name | Value |
|---|---|---|
| TXT | `send5050._domainkey` | `v=DKIM1; k=rsa; p=…` (shown in the dashboard) |
| TXT | `@` | `v=spf1 a:mail.example.com ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none;` |

If the domain already has an SPF record, don't add a second one: any SPF record that includes `a:mail.example.com`, or `mx` when its `MX` points at your server, passes. The same goes for an existing DMARC policy. Verification checks public DNS and is retried automatically.

## Checking your records

```sh title="Check from any machine"
dig example.com MX +short
dig example.com TXT +short                     # look for v=spf1
dig _dmarc.example.com TXT +short
dig v1-ed25519-20261022._domainkey.example.com TXT +short
```

The quickest end-to-end check is to send a message to a Gmail address and choose **Show original**: SPF, DKIM and DMARC should each say `PASS`. More in [Troubleshooting](/docs/troubleshooting/#checking-dkim).

## Cloudflare: use "DNS only"

If your DNS is on Cloudflare and you add the records by hand, set the `A` records for the mail, send and API hosts to **DNS only** (grey cloud). The orange-cloud proxy only carries web traffic, so it breaks SMTP and IMAP on the mail host, and it stops Caddy from getting its HTTPS certificate (Cloudflare shows error 525). When you give the installer a Cloudflare token it creates them as DNS only for you.

Already using `api.<domain>` or `send.<domain>` for something else? Set `API_HOST` / `SEND_HOST` (and `MAIL_HOSTNAME`) in `/opt/5050-mail/.env` and run `sudo /opt/5050-mail/install.sh --upgrade`.

Keep one `MX` record for the domain. A second MX at the same priority (for example an old provider's) sends part of your inbound mail there.
