---
title: Quickstart
description: Install 5050 Mail and 5050 Send on a fresh Linux VM with one command.
---

# Quickstart

You need a fresh Linux VM with a public IPv4 address and root access, and a domain where you can add DNS records. 2 vCPU and 4 GB of RAM is enough to start. The [requirements page](/docs/requirements/) has the details, including the ports to open.

## 1. Point the hostnames at the server

Create three `A` records at your DNS provider so the installer can get TLS certificates:

| Type | Name | Value |
|---|---|---|
| A | `mail.example.com` | your server's IPv4 address |
| A | `send.example.com` | the same address |
| A | `api.example.com` | the same address |

Replace `example.com` with your domain everywhere on this page. `mail.` serves the webmail and is your mail server's name; `send.` and `api.` are the 5050 Send dashboard and API. With a Cloudflare token (step 2) you can skip this: the installer creates the records itself.

## 2. Run the installer

SSH into the server and run:

```sh
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash
```

It asks for two things:

- your **mail domain** (`example.com`),
- the **admin mailbox** to create (default `admin@example.com`).

Then it installs Docker if it's missing, writes every secret into `/opt/5050-mail/.env` (readable by root only), builds the images and starts the stack (the first run takes a few minutes), checks that outbound port 25 works, creates your domain and the admin mailbox, and prints the DNS records to add.

The admin password is generated and **printed once** at the end. Copy it, then change it in the webmail.

To run without questions, pass the answers as flags:

```sh title="Unattended install"
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash -s -- \
  --domain example.com \
  --admin-email you@example.com \
  --yes
```

```sh title="DNS records and certificates through Cloudflare"
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash -s -- \
  --domain example.com \
  --cloudflare-token "$CF_TOKEN" \
  --yes
```

Every flag is listed in the [configuration reference](/docs/configuration/#installer-flags).

> [!TIP]
> To try it on a laptop or a test VM with a made-up domain, add `--tls internal`. Caddy and the mail server then use self-signed certificates, and browsers will warn.

## 3. Publish the DNS records

At the end the installer prints the records to add: the `A` records, `MX`, SPF, two DKIM keys, DMARC and TLS reporting. Add each one at your DNS provider. If you passed a Cloudflare token, they are already there. [DNS and custom domains](/docs/dns/) explains every record.

Ask your VM provider to set the **reverse DNS (PTR)** of the server's IP to `mail.example.com`. Without it, big receivers send your mail to spam or reject it.

## 4. Sign in

| What | Where | Sign in with |
|---|---|---|
| Webmail and admin console | `https://mail.example.com` | your admin mailbox and its password |
| 5050 Send dashboard | `https://send.example.com` | the same mail account |
| Send API | `https://api.example.com` | an API key from the dashboard |
| Mail apps | `mail.example.com`: IMAP 993, SMTP 465 or 587 | any mailbox and its password |
| Send SMTP relay | `mail.example.com`: 2465 (TLS) or 2587 (STARTTLS) | user `resend`, an API key as the password |

Open **Admin console** from the webmail's menu and [add your users](/docs/admin-console/#users).

## 5. Send a test message

From the webmail, send a message to an address you own at Gmail or Outlook, and reply to it. If it lands in spam or never arrives, go through [troubleshooting](/docs/troubleshooting/).

## Later

```sh
sudo /opt/5050-mail/install.sh --upgrade              # pull the new version, rebuild, restart
sudo /opt/5050-mail/install.sh --uninstall            # remove containers, keep data
sudo /opt/5050-mail/install.sh --uninstall --purge    # delete everything, including mail
sudo /opt/5050-mail/install.sh --help
```

Re-running the installer is safe: it keeps the secrets in `.env` and your data, and reconciles the configuration. See [Backups and upgrades](/docs/backups-upgrades/).
