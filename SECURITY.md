# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
vulnerability reporting instead (repository → Security → Report a vulnerability). If you
can't use that, email the maintainers at the address listed on the GitHub organisation profile.

Include the affected version or commit, the steps to reproduce, and the impact. We aim to
acknowledge reports within 3 working days and to ship a fix or mitigation within 30 days,
sooner for critical issues. We'll credit you in the release notes unless you'd rather stay anonymous.

Vulnerabilities in Stalwart itself should go to the [Stalwart project](https://github.com/stalwartlabs/stalwart/security).

## Supported versions

Only the latest release (and `main`) gets security fixes. Upgrade with
`sudo /opt/5050-mail/install.sh --upgrade`.

## Deployment hardening (defaults)

- Every secret is generated per install into `/opt/5050-mail/.env` (0600). Nothing is shared between installs.
- Only these ports are published: 25, 465, 587, 993 (Stalwart), 80/443 (Caddy) and 2465/2587 (Send SMTP relay).
  Stalwart's HTTP/JMAP and management API, Postgres and the internal relay port 2525 stay on the internal docker network.
- The webmail BFF and Caddy pass the real client IP to Stalwart (`X-Forwarded-For`, trusted only on the internal network),
  so Stalwart's brute-force auto-ban applies per client. No proxy IP is allow-listed.
- Caddy sends HSTS, strips client-supplied `CF-Connecting-IP`/`X-Real-IP`, and sets `X-Forwarded-For` itself.
- Session cookies are `HttpOnly`, `SameSite=Lax` and `Secure`. Sessions in Postgres keep only a hash of the session id,
  and the stored mail credential is encrypted with AES-256-GCM.
- Domains publish SPF, DKIM (Ed25519 + RSA) and DMARC `p=reject`, and inbound mail on port 25 is checked against the
  sender's DMARC policy, so spoofed mail from your own domains is refused.
- Containers run as non-root with read-only filesystems where possible. `send-smtp` runs as root to read Caddy's certificate
  but has every capability dropped.
- Postgres traffic stays on the internal network and is not encrypted. If you move Postgres to another host, enable TLS
  (`sslmode=require` in the URLs and `useTls` in `server/config.json`).

Recommended: enable two-factor authentication for admin mailboxes, keep the VM patched, and back up the Postgres volume
and `.env`.
