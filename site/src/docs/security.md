---
title: Security
description: How 5050 Mail handles secrets, sessions, API keys and webhooks, and what you are responsible for.
---

# Security

Running your own mail server means its security is partly yours. This page lists what the software does and what it leaves to you.

## What the software does

**Secrets live in one file.** The installer generates random secrets (database passwords, the mail server's recovery admin, session secrets) into `/opt/5050-mail/.env`, mode `0600`. Nothing is baked into images.

**Passwords are checked by the mail server.** The webmail and the Send dashboard pass your password to Stalwart at sign-in; it never reaches browser storage. The browser gets an opaque session cookie (`HttpOnly`, `SameSite`, `Secure`), and sessions are stored in Postgres. They expire after 7 days idle and 30 days at most.

**Sign-in is rate-limited** per IP and per account (10 attempts per 15 minutes by default), with a global cap on failures so an attack can't get the server's own IP banned by the mail server.

**API keys are stored as SHA-256 hashes**, compared in constant time, and shown only once. Keys can be limited to sending, and to one domain.

**Webhooks can't be pointed inward.** Endpoint addresses are resolved and checked against private, loopback and link-local ranges, the connection is pinned to the checked address, and redirects aren't followed. Every payload is signed (see [Webhooks](/docs/webhooks/#verify-signatures)).

**Mail is rendered defensively.** Remote images are blocked by default, and HTML mail is sanitized and shown inside a sandboxed frame.

**Containers are locked down.** Services run with `no-new-privileges`, read-only filesystems where possible, and only the mail and web ports are published. Postgres, the mail server's HTTP and admin API, and the internal relay port for 5050 Send stay on the internal Docker network. Caddy serves every site over HTTPS with HSTS.

**Logs redact secrets.** API request logs drop tokens, signing secrets, passwords, `re_…` and `whsec_…` values and attachment contents before they are stored.

**Mail is encrypted in transit** wherever the other side allows: TLS on IMAP, submission, HTTPS, and opportunistic STARTTLS between mail servers. MTA-STS and DANE records are available per domain to make inbound TLS mandatory.

**The Cloudflare token stays on the server.** It is never sent to a browser.

## What you are responsible for

- **Operating system updates.** Turn on unattended security upgrades (`apt install unattended-upgrades` on Ubuntu and Debian).
- **Upgrading 5050 Mail.** Run `install.sh --upgrade` when a release fixes something. Watch the [GitHub releases](https://github.com/musakkka/5050-mail/releases).
- **SSH.** Use keys, not passwords, and keep port 22 closed to the world if your provider offers a firewall.
- **Backups**, kept off the server. See [Backups and upgrades](/docs/backups-upgrades/).
- **Strong passwords** for mailboxes, especially administrators. A mailbox password also signs in to IMAP and SMTP, so a weak one becomes a spam relay.
- **Disk encryption** if your threat model includes the hosting provider. Mail is stored unencrypted at rest on the server's disk.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub's **Security → Report a vulnerability** on the [repository](https://github.com/musakkka/5050-mail/security), as described in `SECURITY.md`.
