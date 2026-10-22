/**
 * A throw-away 5050 Send stack for the demo video: API + dashboard + inline worker, on a fresh
 * Postgres database, with the fake transport (nothing leaves the machine) and the fake Cloudflare API.
 * Seeds one fictional team ("Acme", maya@acme.test), the verified domain acme.test and two weeks of
 * synthetic sending history so the Emails and Metrics pages have something to show.
 *
 *   SEND_DIR=../apps/send PORT=3200 PG_URL=postgres://send:sendpw@localhost:55432/postgres \
 *   STALWART_URL=http://localhost:18190 npx tsx demo/stack/serve-send.ts
 *
 * Webhook endpoints on *.acme.test are answered by a local receiver (no DNS, no network).
 * Prints READY <json> once listening. The database is dropped on SIGINT/SIGTERM.
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SEND_DIR = path.resolve(process.env.SEND_DIR ?? '../apps/send');
const PORT = Number(process.env.PORT ?? 3200);
const HOOK_PORT = Number(process.env.HOOK_PORT ?? PORT + 99);
const PG = process.env.PG_URL ?? 'postgres://send:sendpw@localhost:55432/postgres';
const STALWART = process.env.STALWART_URL ?? 'http://localhost:18190';
const imp = (rel: string) => import(pathToFileURL(path.join(SEND_DIR, rel)).href);

const { default: postgres } = await import(pathToFileURL(path.join(SEND_DIR, 'node_modules/postgres/src/index.js')).href);
const { loadConfig } = await imp('src/config.ts');
const { createContext } = await imp('src/context.ts');
const { createSql, migrate } = await imp('src/db.ts');
const { createServerApp } = await imp('src/server.ts');
const { startWorker } = await imp('src/worker/runner.ts');
const { createApiKey } = await imp('src/services/apiKeys.ts');
await imp('src/features.ts').catch(() => undefined);
const { serve } = await import(pathToFileURL(path.join(SEND_DIR, 'node_modules/@hono/node-server/dist/index.mjs')).href);

// ---- webhook receiver for *.acme.test (the worker's https requests are redirected here)
const hooks: { at: string; body: string }[] = [];
http
  .createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      hooks.push({ at: new Date().toISOString(), body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"received":true}');
    });
  })
  .listen(HOOK_PORT, '127.0.0.1');
const origHttps = https.request.bind(https);
(https as unknown as { request: unknown }).request = (u: unknown, o?: unknown, cb?: unknown) => {
  const url = u instanceof URL ? u : typeof u === 'string' ? new URL(u) : null;
  if (url && url.hostname.endsWith('.acme.test')) {
    const local = new URL(`http://127.0.0.1:${HOOK_PORT}${url.pathname}${url.search}`);
    const { lookup: _l, ...rest } = (o ?? {}) as Record<string, unknown>;
    return http.request(local, rest, cb as never);
  }
  return (origHttps as (...a: unknown[]) => unknown)(u, o, cb);
};

// ---- fresh database
const dbName = `demo_send_${Date.now()}_${randomBytes(2).toString('hex')}`;
{
  const admin = postgres(PG, { max: 1, onnotice: () => {} });
  // drop leftovers from earlier runs that were not shut down cleanly
  for (const r of await admin`select datname from pg_database where datname like 'demo\_send\_%'`)
    await admin.unsafe(`drop database if exists "${r.datname}" with (force)`).catch(() => undefined);
  await admin.unsafe(`create database "${dbName}"`);
  await admin.end();
}
const dbUrl = PG.replace(/\/[^/]*$/, `/${dbName}`);
{
  const m = createSql(dbUrl, { max: 1 });
  await migrate(m);
  await m.end();
}

const config = loadConfig({
  NODE_ENV: 'development',
  DATABASE_URL: dbUrl,
  API_HOST: 'api.send.acme.test',
  DASHBOARD_HOST: 'send.acme.test',
  DEFAULT_SURFACE: 'dashboard',
  PUBLIC_API_BASE: 'https://api.send.acme.test',
  DASHBOARD_BASE: `http://localhost:${PORT}`,
  TRANSPORT: 'fake',
  CLOUDFLARE_FAKE: '1',
  CLOUDFLARE_FAKE_ZONES: 'acme.test,example.com',
  CLOUDFLARE_ACCOUNT_ID: 'demo-account',
  SESSION_SECRET: 'demo-only-session-secret-demo-only-session-secret',
  STALWART_URL: STALWART,
  ALLOW_PRIVATE_WEBHOOKS: '1',
  DEFAULT_RATE_LIMIT: '50',
  WORKER_POLL_MS: '150',
  SMTP_HOSTNAME: 'smtp.send.acme.test',
  INBOUND_MX_HOST: 'inbound.send.acme.test',
});
const ctx = createContext(config, { sql: createSql(dbUrl, { max: 8 }), log: () => {} });
const { app } = createServerApp(ctx);
const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
const worker = startWorker(ctx);
const sql = ctx.sql;

// ---- seed
const [team] = await sql`insert into teams (name, monthly_quota, rate_limit) values ('Acme', 50000, 50) returning id`;
const teamId = team.id as string;
await sql`insert into team_members (team_id, email, role) values (${teamId}, 'maya@acme.test', 'admin'), (${teamId}, 'jordan@acme.test', 'member')`;
const records = [
  { record: 'MX', name: 'cf-bounce', type: 'MX', ttl: 'Auto', status: 'verified', value: 'route1.mx.cloudflare.net', priority: 10 },
  { record: 'SPF', name: 'cf-bounce', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
  { record: 'DKIM', name: 'cf2024-1._domainkey', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' },
  { record: 'DMARC', name: '_dmarc', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'v=DMARC1; p=none;' },
];
const ago = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const [dom] = await sql`insert into domains (team_id, name, status, cf_enabled, cf_zone_name, open_tracking, click_tracking, records, verified_at, created_at)
  values (${teamId}, 'acme.test', 'verified', true, 'acme.test', true, true, ${sql.json(records)}, ${ago(20)}, ${ago(21)}) returning id`;
const domainId = dom.id as string;
const prod = await createApiKey(sql, teamId, 'Production', 'full_access', null, 'maya@acme.test');
await sql`update api_keys set created_at = ${ago(18)}, last_used_at = ${ago(0.02)} where id = ${prod.id}`;
const stg = await createApiKey(sql, teamId, 'Staging', 'sending_access', domainId, 'jordan@acme.test');
await sql`update api_keys set created_at = ${ago(9)}, last_used_at = ${ago(1.3)} where id = ${stg.id}`;

// Two weeks of synthetic history: transactional mail with a gentle upward trend.
let seed = 0x5050;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const SUBJECTS = ['Your receipt from Acme', 'Reset your password', 'Welcome to Acme', 'Your order has shipped', 'Your weekly summary', 'Confirm your email address', 'New sign-in to your account', 'Your invoice is ready'];
const NAMES = ['olivia', 'liam', 'emma', 'noah', 'ava', 'mason', 'sofia', 'lucas', 'mia', 'ethan', 'zoe', 'leo', 'aria', 'kai', 'nora'];
const DOMS = ['example.com', 'example.org', 'example.net'];
const emails: Record<string, unknown>[] = [];
const events: Record<string, unknown>[] = [];
const now = Date.now();
for (let d = 13; d >= 0; d--) {
  const n = Math.round(28 + (13 - d) * 3.2 + rand() * 10);
  for (let i = 0; i < n; i++) {
    const at = new Date(now - d * 86400_000 - rand() * (d === 0 ? 6 : 24) * 3600_000 - 20 * 60_000);
    const id = randomUUID();
    const to = `${NAMES[Math.floor(rand() * NAMES.length)]}${Math.floor(rand() * 90 + 10)}@${DOMS[Math.floor(rand() * DOMS.length)]}`;
    const subject = SUBJECTS[Math.floor(rand() * SUBJECTS.length)]!;
    const r = rand();
    const fate = r < 0.015 ? 'bounced' : r < 0.02 ? 'complained' : 'delivered';
    const opened = fate === 'delivered' && rand() < 0.46;
    const clicked = opened && rand() < 0.3;
    const last = clicked ? 'clicked' : opened ? 'opened' : fate;
    const t = (s: number) => new Date(at.getTime() + s * 1000).toISOString();
    emails.push({
      id, team_id: teamId, api_key_id: prod.id, domain_id: domainId, from_addr: 'Acme <hello@acme.test>', to_addrs: [to], subject,
      html: `<p>${subject}</p>`, text: subject, last_event: last, last_event_at: t(clicked ? 900 : opened ? 600 : 3),
      message_id: `<${id}@acme.test>`, provider_message_id: `<fake-${id}@fake.transport>`, size_bytes: 4200 + Math.floor(rand() * 9000),
      sent_at: t(1), created_at: at.toISOString(), updated_at: t(3),
    });
    const ev = (type: string, s: number) => events.push({ email_id: id, team_id: teamId, domain_id: domainId, type, recipient: to, data: sql.json({}), created_at: t(s) });
    ev('sent', 1);
    ev(fate, 3);
    if (opened) ev('opened', 600);
    if (clicked) ev('clicked', 900);
  }
}
for (let i = 0; i < emails.length; i += 500) await sql`insert into emails ${sql(emails.slice(i, i + 500))}`;
for (let i = 0; i < events.length; i += 1000) await sql`insert into email_events ${sql(events.slice(i, i + 1000))}`;

console.log('READY ' + JSON.stringify({ dashboard: `http://localhost:${PORT}`, api: `http://localhost:${PORT}/v`, teamId, domainId, key: prod.token, emails: emails.length }));

const stop = async () => {
  await worker.stop();
  server.close();
  await sql.end({ timeout: 2 });
  const a = postgres(PG, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => {});
  await a.end();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
