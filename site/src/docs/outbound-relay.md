---
title: Outbound relay
description: Send your mail through Cloudflare Email Service, Resend, Amazon SES, Postmark, Mailgun, Brevo or SMTP2GO when your cloud blocks port 25.
---

# Outbound relay

Most clouds block **outbound** port 25, so a new server can receive mail but cannot deliver it: messages sit in the queue. A relay (a "smarthost") fixes that: your server hands every outgoing message to an SMTP service over port 465 or 587, and that service delivers it. Inbound mail still arrives directly on port 25.

The installer checks port 25 by connecting to three large mail providers. If it is blocked, it names your cloud provider, explains the options and, when you run it in a terminal (also with `curl | sudo bash`), offers a menu.

## Choose a relay

| Relay | `--relay` | Server | Username | Password | SPF include |
|---|---|---|---|---|---|
| Cloudflare Email Service | `cloudflare` | `smtp.mx.cloudflare.net:465` | `api_token` | API token with **Email Sending: Edit** (add **Zone > DNS: Edit** for automatic records) | `_spf.mx.cloudflare.net` |
| Resend | `resend` | `smtp.resend.com:465` | `resend` | API key | `amazonses.com` |
| Amazon SES | `ses` | `email-smtp.<region>.amazonaws.com:587` | SES SMTP username | SES SMTP password | `amazonses.com` |
| Postmark | `postmark` | `smtp.postmarkapp.com:587` | Server API token | Server API token | `spf.mtasv.net` |
| Mailgun | `mailgun` | `smtp.mailgun.org:587` | `postmaster@your-domain` | SMTP password | `mailgun.org` |
| Brevo | `brevo` | `smtp-relay.brevo.com:587` | SMTP login | SMTP key | `spf.brevo.com` |
| SMTP2GO | `smtp2go` | `mail.smtp2go.com:2525` (or 587) | SMTP username | SMTP password | `spf.smtp2go.com` |
| Anything else | `--relay-host` | your choice | | | |

Port `465` uses implicit TLS, every other port STARTTLS. Whichever you choose, verify your sending domain with the relay and set up DKIM there; most relays refuse mail from unverified domains.

## Set it up

During a fresh install the menu appears by itself. On a server that is already installed:

```sh
sudo /opt/5050-mail/install.sh --relay            # menu
sudo /opt/5050-mail/install.sh --relay resend     # asks for the API key without echoing it
```

Without a terminal, pass everything as options (or the environment variables `RELAY_USERNAME`, `RELAY_PASSWORD`, `RELAY_REGION`):

```sh
sudo /opt/5050-mail/install.sh --relay resend --relay-password "$RESEND_API_KEY" --yes
sudo /opt/5050-mail/install.sh --relay ses --relay-region eu-west-1 \
  --relay-user "$SES_SMTP_USER" --relay-password "$SES_SMTP_PASSWORD" --yes
sudo /opt/5050-mail/install.sh --relay-host smtp.example.com --relay-port 587 \
  --relay-user USER --relay-password PASS --yes
```

Before anything is saved, the installer opens a real SMTP connection to the relay and logs in (no message is sent). If the relay refuses, you see its reply and can retry, pick another relay, or save anyway. Non-interactive runs stop with the error; `RELAY_SKIP_VALIDATE=1` skips the test.

On an existing install, `--relay` only rewrites the relay settings in `/opt/5050-mail/.env`, re-runs the Stalwart bootstrap, restarts Stalwart and then asks it to retry the whole queue, so mail that was stuck goes out within seconds. Test the saved login at any time:

```sh
sudo /opt/5050-mail/install.sh --relay-test
```

To go back to direct delivery, empty `RELAY_HOST` in `.env` and run `install.sh --upgrade`.

## Cloudflare Email Service

With the `cloudflare` relay the installer also onboards your domain for sending: it adds it through the API (`zones/{zone}/email/sending/subdomains`), reads the records Cloudflare expects and creates the ones that are missing in your zone. Records that already exist are skipped, and it never creates a second DMARC or SPF record. If the token lacks DNS rights, the installer says so and you finish in the Cloudflare dashboard under Email > Email Sending.

## SPF

The relay's servers send as your domain, so your SPF record must allow them. The installer prints the include for your relay. If the domain's DNS is on Cloudflare and a token is available, it merges the include into the existing root SPF record (`v=spf1 mx include:amazonses.com -all`) instead of adding a second record: two SPF records make both invalid. Elsewhere, edit your single SPF record by hand.

## Or ask the provider to unblock port 25

| Provider | Outbound port 25 |
|---|---|
| Azure | Blocked on most subscriptions, no unblock: use a relay. |
| AWS | Restricted; [request removal](https://aws.amazon.com/forms/ec2-email-limit-rdns-request) (needs reverse DNS), or use SES. |
| Google Cloud | Permanently blocked: use a relay. |
| DigitalOcean | Blocked on new accounts; support can lift it later. |
| Hetzner | Blocked by default; request unblocking after your first paid invoice. |
| Vultr, OVH, Contabo | Open or opened on request. |

With an unblocked IP, mail leaves from your own address and builds its own reputation, but you also need reverse DNS (see [Requirements](/docs/requirements/)).
