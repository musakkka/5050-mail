# Contributing

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Ground rules

- Open an issue before a large change so we can agree on the approach.
- Keep pull requests small and focused, and add tests for behaviour you change.
- Contributions are licensed under AGPL-3.0, the license of this repository.
- Never commit secrets, real mailboxes or customer data. Use `example.com`, `acme.test` and `dev.test` in fixtures. CI runs gitleaks.

## Development setup

Requirements: Node 22+, Docker.

```sh
# A dev mail server (Stalwart, recovery admin admin:devpass123) on :18090 / SMTP :2525
docker run -d --name mail-dev -e STALWART_RECOVERY_ADMIN=admin:devpass123 \
  -p 18090:8080 -p 2525:25 stalwartlabs/stalwart:v0.16.27
# first start: pick the default domain dev.test, then restart the container
curl -s -u admin:devpass123 -H 'Content-Type: application/json' http://localhost:18090/jmap/ \
  -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Bootstrap/set",{"update":{"singleton":{"serverHostname":"mail.dev.test","defaultDomain":"dev.test","requestTlsCertificate":false,"generateDkimKeys":true}}},"0"]]}'
docker restart mail-dev

# Webmail (BFF on :3000, Vite on :5173)
cd apps/webmail && npm ci
npm run seed -- --users-only     # alice@dev.test (admin), bob, carol
npm run seed                     # plus realistic sample mail for alice
STALWART_URL=http://localhost:18090 CLOUDFLARE_FAKE=1 npm run dev

# 5050 Send (needs Postgres on :55432)
docker run -d --name send-pg -e POSTGRES_USER=send -e POSTGRES_PASSWORD=sendpw -e POSTGRES_DB=send -p 55432:5432 postgres:16-alpine
cd apps/send && npm ci
CLOUDFLARE_FAKE=1 WORKER_INLINE=1 npm run dev     # API at http://localhost:3000/v, dashboard at :3000
cd web && npm ci && npm run dev                   # dashboard SPA with hot reload
```

`CLOUDFLARE_FAKE=1` swaps the Cloudflare API for an in-memory fake, and `TRANSPORT=fake` (the default outside production) keeps mail in memory. Both are refused when `NODE_ENV=production`.

## Tests

```sh
cd apps/webmail && npm run typecheck && npm test
cd apps/send && npm run typecheck && npm test           # Postgres on :55432; Stalwart tests run if STALWART_TEST_URL is up
cd apps/send/web && npm run typecheck && npm test
npm run e2e                                              # Playwright, in each app (needs the dev servers)
```

For changes to the stack, also run `docker compose -f deploy/docker-compose.yml config` and `shellcheck install.sh`. Bring the stack up with `sudo ./install.sh --source . --domain acme.test --tls internal --yes` on a throwaway VM.

## Style

- TypeScript strict, Prettier settings in each app.
- Comments explain why the code does something, not what it does.
- User-facing text is short and plain, and every error says what to do next.
