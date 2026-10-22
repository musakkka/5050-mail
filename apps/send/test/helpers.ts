import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import postgres from 'postgres';
import { Resend } from 'resend';
import { loadConfig, type Config } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { createSql } from '../src/db.js';
import { FakeDns } from '../src/lib/dns.js';
import { createServerApp } from '../src/server.js';
import { FakeTransport } from '../src/transport/index.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { drain } from '../src/worker/runner.js';
import { ADMIN_URL } from './globalSetup.js';
import '../src/features.js';

export interface TestServer {
  ctx: AppContext;
  config: Config;
  /** Public API base for the SDK (path-prefix mode). */
  apiBase: string;
  /** Root URL (dashboard surface by default in tests). */
  root: string;
  transport: FakeTransport;
  dns: FakeDns;
  clock: { now: Date | null; advance(ms: number): void };
  drain(): Promise<number>;
  createTeam(name?: string, opts?: { monthly_quota?: number; daily_quota?: number | null; rate_limit?: number; members?: { email: string; role: 'admin' | 'member' }[] }): Promise<string>;
  createKey(teamId: string, permission?: 'full_access' | 'sending_access', domainId?: string | null): Promise<string>;
  resend(key: string): Resend;
  /** Insert a verified domain directly (skips the Cloudflare flow). */
  verifiedDomain(teamId: string, name: string, opts?: { open_tracking?: boolean; click_tracking?: boolean }): Promise<string>;
  fetch(path: string, init?: RequestInit & { key?: string }): Promise<Response>;
  close(): Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const run = process.env.SEND_TEST_RUN!;
  const TEMPLATE_DB = `${run}_tpl`;
  const dbName = `${run}_${randomBytes(4).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${dbName}" template "${TEMPLATE_DB}"`);
  await admin.end();
  const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    API_HOST: 'sendapi.test',
    DASHBOARD_HOST: 'send.test',
    DEFAULT_SURFACE: 'dashboard',
    TRANSPORT: 'fake',
    CLOUDFLARE_FAKE: '1',
    CLOUDFLARE_ACCOUNT_ID: 'acct-test',
    ALLOW_PRIVATE_WEBHOOKS: '1',
    DEFAULT_RATE_LIMIT: '1000',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    STALWART_URL: process.env.STALWART_TEST_URL ?? 'http://localhost:18090',
    INBOUND_SECRET: 'inbound-test-secret',
    ...env,
  });
  const transport = new FakeTransport();
  const dns = new FakeDns();
  const clock = {
    now: null as Date | null,
    advance(ms: number) {
      this.now = new Date((this.now ?? new Date()).getTime() + ms);
    },
  };
  const ctx = createContext(config, {
    sql: createSql(dbUrl, { max: 5 }),
    transport,
    dns,
    now: () => clock.now ?? new Date(),
    log: process.env.TEST_LOG ? undefined : () => {},
  });
  const { app } = createServerApp(ctx);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const root = `http://127.0.0.1:${port}`;
  const apiBase = `${root}/v`;
  config.publicApiBase = apiBase;
  config.publicTrackingBase = apiBase;
  config.dashboardBase = root;

  const t: TestServer = {
    ctx,
    config,
    apiBase,
    root,
    transport,
    dns,
    clock,
    drain: () => drain(ctx),
    async createTeam(name = 'Test team', opts = {}) {
      const [row] = await ctx.sql`insert into teams (name, monthly_quota, daily_quota, rate_limit)
        values (${name}, ${opts.monthly_quota ?? 3000}, ${opts.daily_quota ?? null}, ${opts.rate_limit ?? 1000}) returning id`;
      for (const m of opts.members ?? [{ email: 'owner@dev.test', role: 'admin' as const }]) {
        await ctx.sql`insert into team_members (team_id, email, role) values (${row!.id as string}, ${m.email}, ${m.role})`;
      }
      return row!.id as string;
    },
    async createKey(teamId, permission = 'full_access', domainId = null) {
      return (await createApiKey(ctx.sql, teamId, 'test', permission, domainId, null)).token;
    },
    resend: (key) => new Resend(key, { baseUrl: apiBase }),
    async verifiedDomain(teamId, name, opts = {}) {
      const [d] = await ctx.sql`insert into domains (team_id, name, status, cf_enabled, open_tracking, click_tracking, records)
        values (${teamId}, ${name}, 'verified', true, ${opts.open_tracking ?? false}, ${opts.click_tracking ?? false}, '[]') returning id`;
      return d!.id as string;
    },
    fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.key) headers.set('authorization', `Bearer ${init.key}`);
      if (!headers.has('user-agent')) headers.set('user-agent', 'send-tests/1.0');
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return fetch(path.startsWith('http') ? path : `${apiBase}${path}`, { ...init, headers });
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await ctx.sql.end({ timeout: 2 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await a.end();
    },
  };
  return t;
}

/** A local HTTP endpoint that records webhook deliveries. */
export async function webhookReceiver(status: (n: number) => number = () => 200) {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      const s = status(received.length);
      res.writeHead(s, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: s < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  return { url, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}
