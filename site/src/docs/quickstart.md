---
title: Quickstart
description: Install 5050 Mail and 5050 Send on a fresh Linux VM with one command.
---

# Quickstart

You need a fresh Linux VM with a public IPv4 address and root access, and a domain where you can add DNS records. 2 vCPU and 4 GB of RAM is enough to start. The [requirements page](/docs/requirements/) has the details, including the ports to open.

## 1. Run the installer

SSH into the server and run:

```sh
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash
```

Before it changes anything, the installer says what it will do, and asks once whether to continue:

- It installs Docker if it is missing, then the containers (mail server, webmail, 5050 Send, Postgres, Caddy) in `/opt/5050-mail`.
- The containers listen on ports 25, 465, 587, 993, 2465, 2587, 80 and 443. It does not touch your firewall.
- Every secret is generated on the server and kept only in `/opt/5050-mail/.env` (mode 0600).
- There is no telemetry. Nothing is sent to us.
- A Cloudflare token, if you give one, is used only for your zone's DNS and Email Sending. It is stored only in `.env`, and you can revoke it at any time.
- To remove everything: `sudo /opt/5050-mail/install.sh --uninstall` (add `--purge` to delete mail and data).

Then it asks:

1. Your **mail domain** (`example.com`). A wrong value is explained and asked again.
2. The **admin mailbox** to create (Enter accepts `admin@example.com`).
3. **Is your domain's DNS on Cloudflare?** If yes, it shows how to create a token and does the DNS for you (below). If no, it prints the records for you to add.

The rest runs as seven numbered steps with a spinner on the slow ones. The full output goes to `/opt/5050-mail/install.log`, so the screen stays short. If a step fails, the installer shows the last lines of the log and says what to check. Running it again is safe.

At the end it shows a summary with your URLs, the admin mailbox, and its one-time password. **Store the password before you close the terminal**, then change it in the webmail settings.

To run without questions, pass the answers as flags:

```sh title="Unattended install"
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash -s -- \
  --domain example.com \
  --admin-email you@example.com \
  --yes
```

```sh title="Unattended, with DNS and certificates through Cloudflare"
curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash -s -- \
  --domain example.com \
  --cloudflare-token "$CF_TOKEN" \
  --yes
```

Every flag is listed in the [configuration reference](/docs/configuration/#installer-flags). Without a terminal and without `--yes` the installer stops before changing anything and says so.

> [!TIP]
> To try it on a laptop or a test VM with a made-up domain, add `--tls internal`. Caddy and the mail server then use self-signed certificates, and browsers will warn.

## 2. Publish the DNS records

### DNS on Cloudflare

Answer **y** to the Cloudflare question and the installer shows the exact token to create (the same steps are in [Cloudflare token](/docs/dns/#cloudflare-token)). You paste it once; the input is hidden. It then:

- checks the token with Cloudflare and lists the zones it can see,
- picks the zone that holds your domain (or asks, if none matches),
- checks it can edit DNS by creating and deleting one temporary TXT record,
- creates the A, MX, SPF, DKIM, DMARC and TLS reporting records as **DNS only**,
- never adds a second SPF or DMARC record: an existing SPF record gets this server added to it, an existing DMARC record is kept, and it lists each change,
- asks before replacing MX records that would compete with this server,
- if outbound port 25 is blocked, sets up Cloudflare Email Sending as your outbound relay.

If the token is missing a permission, the installer names it (for example `Zone > DNS > Edit`). Add it to the token, press Enter, and it checks again.

### DNS anywhere else

Answer **n** and the installer prints the records at the end as a table. Add each one at your DNS provider, then press Enter to run **Check DNS**: it looks the records up in public DNS and waits until they all resolve. Press `s` to skip; the admin console's **Domains > Check DNS** does the same later. [DNS and custom domains](/docs/dns/) explains every record. The web certificates are issued as soon as the `A` records resolve; Caddy retries by itself.

Ask your VM provider to set the **reverse DNS (PTR)** of the server's IP to `mail.example.com`. Without it, big receivers send your mail to spam or reject it.

## A sample session

This is an install on a server where the DNS is on Cloudflare (colours and the spinner left out):

```text title="Terminal session"
  ┏━━━━━━┓
  ┃ 5050 ┃  5050 Mail installer
  ┗━━━━━━┛  Mail server, webmail and a send API on this machine.

  Before we start
    Installs    Docker (only if it is missing), then the 5050 Mail containers:
                mail server, webmail, 5050 Send, Postgres and Caddy, in /opt/5050-mail
    Ports       The containers listen on 25, 465, 587, 993 (mail), 2465, 2587
                (5050 Send SMTP), 80 and 443 (web). Your firewall is not changed.
    Secrets     Generated here and kept only in /opt/5050-mail/.env (mode 0600).
    Telemetry   None. Nothing is sent to us.
    ...
    Undo        sudo /opt/5050-mail/install.sh --uninstall   (add --purge to delete all data)

  Continue? [Y/n] y

  Your domain
  Mail domain, for example example.com: example.com
  Admin mailbox to create [admin@example.com]:

  Outbound mail
  ✓ Check outbound port 25 (3s)
  · Outbound port 25 is open: mail is delivered directly.

  DNS
  Is the DNS for example.com on Cloudflare? [y/N] y
  ...
  Paste the token (Enter to skip) (hidden):
  ✓ Token is valid (user-owned)
  ✓ Zone example.com holds example.com
  ✓ Can edit DNS in example.com

  Installing
  ✓ [1/7] Check Docker (1s)
  ✓ [2/7] Get the 5050 Mail source (6s)
  ✓ [3/7] Build the images (a few minutes the first time) (214s)
  ✓ [4/7] Start the database and mail server (38s)
  ✓ [5/7] Set up example.com and the admin mailbox (21s)
  ✓ [6/7] Start webmail, 5050 Send and Caddy (19s)
  [7/7] DNS records
  ✓ Read the records from the mail server (4s)
    + MX    example.com                                    10 mail.example.com
    + A     mail.example.com                               DNS only
    + A     send.example.com                               DNS only
    + A     api.example.com                                DNS only
    ~ TXT   example.com                                    SPF: added a:mail.example.com to your existing record
    + TXT   v1-ed25519-20261023._domainkey.example.com     v=DKIM1; k=ed25519; h=sha256; p=AAAAC3Nz
    + TXT   v1-rsa-20261023._domainkey.example.com         v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkq
    = TXT   _dmarc.example.com                             existing DMARC policy kept
    + TXT   _smtp._tls.example.com                         v=TLSRPTv1; rua=mailto:postmaster@exampl
  ✓ Cloudflare zone example.com is up to date. Records are DNS only.

  ┌──────────────────────────────────────────────────────────────────────
  │  5050 Mail is running
  │
  │  Webmail         https://mail.example.com
  │  Admin console   https://mail.example.com/admin
  │  Send dashboard  https://send.example.com
  │  Send API        https://api.example.com   (Resend-compatible)
  │
  │  Admin mailbox   admin@example.com
  │  Password        4f0c9a7e51d83b62a1c7
  │                  Shown once. Store it now and change it in the webmail settings.
  │
  │  Mail apps       IMAP mail.example.com:993 (SSL)   SMTP mail.example.com:465 (SSL) or :587 (STARTTLS)
  │                  User name: the full address. Send SMTP relay: :2465 / :2587, user resend.
  │
  │  DNS changed     +MX, +A mail, +A send, +A api, ~SPF, +DKIM x2, +TLS-RPT
  │
  │  Next
  │    1. Sign in at https://mail.example.com/admin and add your users.
  │    2. More domains: Admin console > Domains > Add a domain.
  │    3. Create a Send API key: https://send.example.com > API keys.
  │    4. Ask your VPS provider to set reverse DNS (PTR) of 203.0.113.10 to mail.example.com.
  │
  │  Logs            /opt/5050-mail/install.log
  │  Settings        /opt/5050-mail/.env  (secrets, mode 0600: back it up)
  │  Upgrade         sudo /opt/5050-mail/install.sh --upgrade
  │  Uninstall       sudo /opt/5050-mail/install.sh --uninstall [--purge]
  └──────────────────────────────────────────────────────────────────────
```

## 3. Sign in

| What | Where | Sign in with |
|---|---|---|
| Webmail | `https://mail.example.com` | your admin mailbox and its password |
| Admin console | `https://mail.example.com/admin` | the same account |
| 5050 Send dashboard | `https://send.example.com` | the same mail account |
| Send API | `https://api.example.com` | an API key from the dashboard |
| Mail apps | `mail.example.com`: IMAP 993, SMTP 465 or 587 | any mailbox and its password |
| Send SMTP relay | `mail.example.com`: 2465 (TLS) or 2587 (STARTTLS) | user `resend`, an API key as the password |

Open the admin console and [add your users](/docs/admin-console/#users).

## 4. Send a test message

From the webmail, send a message to an address you own at Gmail or Outlook, and reply to it. If it lands in spam or never arrives, go through [troubleshooting](/docs/troubleshooting/).

## Later

```sh
sudo /opt/5050-mail/install.sh --upgrade              # pull the new version, rebuild, restart
sudo /opt/5050-mail/install.sh --uninstall            # remove containers, keep data
sudo /opt/5050-mail/install.sh --uninstall --purge    # delete everything, including mail
sudo /opt/5050-mail/install.sh --help
```

Re-running the installer is safe: it keeps the secrets in `.env` and your data, and reconciles the configuration. See [Backups and upgrades](/docs/backups-upgrades/).
