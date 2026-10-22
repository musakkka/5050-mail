---
title: Troubleshooting
description: Mail not arriving, landing in spam, blocked port 25, DKIM failures, certificate problems, and how to read the logs.
---

# Troubleshooting

Start with the logs. Every service runs in one Docker Compose project. Define a short alias as root:

```sh
alias dc='docker compose --env-file /opt/5050-mail/.env -f /opt/5050-mail/deploy/docker-compose.yml'
dc ps                       # is everything up and healthy?
dc logs -f --tail 100       # all services
dc logs -f stalwart         # the mail server
dc logs -f send-worker      # 5050 Send's queue and webhooks
```

The services are `caddy`, `stalwart`, `webmail`, `send-web`, `send-worker`, `send-smtp` and `postgres`.

## Outgoing mail doesn't arrive

1. **Is port 25 open outbound?** From the server:
   ```sh
   nc -vz -w 5 gmail-smtp-in.l.google.com 25
   ```
   A timeout means your provider blocks it. Ask them to lift the block, or [send through a relay](/docs/requirements/#send-through-a-relay).
2. **Is the message stuck in the queue?** The admin console's **Overview → Outbound mail** shows queued messages and the last error for each. A `4xx` error is retried automatically; a `5xx` is final and comes back to the sender as a bounce.
3. **Does the receiver reject you?** Read the bounce message. `550 5.7.1` and similar usually name the reason: missing PTR, SPF fail, a blocklisted IP.

## Mail lands in spam

Work through these in order; each one matters more than the next.

- **PTR**: the reverse DNS of your IP is your mail hostname, and that hostname resolves back to the IP. See [Requirements](/docs/requirements/#reverse-dns-ptr).
- **SPF, DKIM and DMARC all pass.** Send to a Gmail address, open the message, choose **Show original**. All three should say `PASS`.
- **The IP is not on a blocklist.** Check your IP at a multi-blocklist lookup such as MXToolbox or the Spamhaus IP check. New cloud IPs sometimes inherit a previous tenant's listing; most lists have a removal form.
- **The IP has a little history.** A brand-new IP sending hundreds of messages on day one looks like spam. Start with normal person-to-person mail, and grow bulk sending over weeks.
- **The content looks like mail people want.** A real `From` name, a plain subject, a text part, no link shorteners, and for bulk mail a working `List-Unsubscribe` header (5050 Send adds one to broadcasts).
- **Recipients engage.** Ask a few contacts to move your messages out of spam and reply; it teaches their provider.

For Gmail, register your domain in Google Postmaster Tools to see your domain's reputation and spam rate. Outlook has the equivalent in its Smart Network Data Services (SNDS) program for IPs.

## Incoming mail doesn't arrive

- `dig example.com MX +short` must print your mail hostname, and that hostname must resolve to the server.
- Port 25 must be open **inbound** in your provider's firewall. Test from another machine: `nc -vz mail.example.com 25`.
- If the domain moved from another provider, senders may cache the old `MX` for up to its TTL.
- Check the stalwart logs for the sender's address: rejected messages are logged with the reason.

## Port 25 is blocked

See [Requirements: port 25](/docs/requirements/#port-25). Receiving is not affected; only delivery to other servers. Set `RELAY_HOST` and friends in `.env` and re-run the installer.

## Checking DKIM

Find the selectors your server publishes on the domain's page in the admin console (`v1-ed25519-…` and `v1-rsa-…`), then:

```sh
dig v1-rsa-20261022._domainkey.example.com TXT +short
```

The answer must match the admin console's value exactly. **Check DNS** on the domain's page does this comparison for every record. Common causes of `dkim=fail`:

- the record was pasted with extra quotes or line breaks; most DNS providers handle long TXT values themselves,
- the record was published under the full name twice (`…_domainkey.example.com.example.com`),
- a relay rewrote the message. If you use a relay, set up DKIM there for your domain too.

## Certificate errors

The certificate is requested from Let's Encrypt when the server starts. It fails when:

- `mail.example.com`, `send.example.com` or `api.example.com` doesn't resolve to the server yet: fix DNS and re-run the installer;
- port 80 is closed: HTTP validation needs it;
- you hit Let's Encrypt's rate limits after many attempts: wait an hour.

With a Cloudflare token, certificates use DNS validation instead and port 80 doesn't matter.

## Can't sign in

- Use the full email address as the username.
- After repeated failures the login is rate-limited for a few minutes (10 attempts per 15 minutes per address and per IP by default). Wait, then try again.
- An administrator can reset any password from the user's page in the admin console. If you lost the only admin password, the recovery admin in `.env` (`STALWART_ADMIN`) can still manage the mail server through its management API on the internal network.

## Send API problems

| Symptom | Cause |
|---|---|
| `403` with body `error code: 1010` | No `User-Agent` header. Every SDK sends one; add one to raw HTTP calls. |
| `403 validation_error` "domain is not verified" | Add and verify the `from` domain in the dashboard for this team. |
| `401 restricted_api_key` | A sending-only key was used on a non-sending endpoint. |
| `429 rate_limit_exceeded` | More than the team's requests per second. Respect `retry-after`, or ask an admin to raise the limit. |
| Email stays `queued` | Check `dc logs send-worker` and the outbound queue in the admin console. |
