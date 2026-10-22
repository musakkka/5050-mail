/**
 * Independent verification harness (not the builder's test helpers).
 * Spins up the real server app in-process against a throw-away database in the
 * local `send-pg` container, with the fake transport and the fake Cloudflare API.
 * Nothing here talks to production or to the real Cloudflare API.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import postgres from 'postgres';
import { loadConfig, type Config } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import { createSql, migrate } from '../../src/db.js';
import { FakeDns } from '../../src/lib/dns.js';
import { createServerApp } from '../../src/server.js';
import { FakeTransport } from '../../src/transport/index.js';
import { createApiKey } from '../../src/services/apiKeys.js';
import { drain } from '../../src/worker/runner.js';
import '../../src/features.js';

export const ADMIN_URL = process.env.VERIFY_PG ?? 'postgres://send:sendpw@localhost:55432/postgres';

export interface Srv {
  ctx: AppContext;
  config: Config;
  api: string; // public API base (path-prefix mode, /v)
  root: string; // dashboard surface
  port: number;
  dbUrl: string;
  transport: FakeTransport;
  clock: { now: Date | null; set(d: Date): void; advance(ms: number): void };
  drain(): Promise<number>;
  team(name?: string, o?: { monthly_quota?: number; daily_quota?: number | null; rate_limit?: number; members?: { email: string; role: 'admin' | 'member' }[] }): Promise<string>;
  key(teamId: string, perm?: 'full_access' | 'sending_access', domainId?: string | null): Promise<{ id: string; token: string }>;
  domain(teamId: string, name: string, o?: { open?: boolean; click?: boolean }): Promise<string>;
  req(method: string, path: string, o?: { key?: string; body?: unknown; raw?: string; headers?: Record<string, string>; noUA?: boolean }): Promise<{ status: number; headers: Headers; json: any; text: string }>;
  close(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}, over: Partial<AppContext> = {}): Promise<Srv> {
  const dbName = `verify_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${dbName}"`);
  await admin.end();
  const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const mig = createSql(dbUrl, { max: 1 });
  await migrate(mig);
  await mig.end();
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: dbUrl,
    API_HOST: 'sendapi.verify',
    DASHBOARD_HOST: 'send.verify',
    DEFAULT_SURFACE: 'dashboard',
    TRANSPORT: 'fake',
    CLOUDFLARE_FAKE: '1',
    CLOUDFLARE_ACCOUNT_ID: 'acct-verify',
    SESSION_SECRET: 'verify-secret-verify-secret-verify-secret-0001',
    STALWART_URL: 'http://localhost:18090',
    INBOUND_SECRET: 'verify-inbound-secret',
    ...env,
  });
  const transport = new FakeTransport();
  const clock = {
    now: null as Date | null,
    set(d: Date) { this.now = d; },
    advance(ms: number) { this.now = new Date((this.now ?? new Date()).getTime() + ms); },
  };
  const logs: string[] = [];
  const ctx = createContext(config, {
    sql: createSql(dbUrl, { max: 8 }),
    transport,
    dns: new FakeDns(),
    now: () => clock.now ?? new Date(),
    log: (scope, msg, extra) => { logs.push(JSON.stringify({ scope, msg, ...(extra ?? {}) })); if (process.env.VLOG) console.error(scope, msg, extra ?? ''); },
    ...over,
  });
  (ctx as any).__logs = logs;
  const { app } = createServerApp(ctx);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const root = `http://127.0.0.1:${port}`;
  const api = `${root}/v`;
  config.publicApiBase = api;
  config.publicTrackingBase = api;
  config.dashboardBase = root;

  const srv: Srv = {
    ctx, config, api, root, port, dbUrl, transport, clock,
    drain: () => drain(ctx),
    async team(name = 'Team', o = {}) {
      const [row] = await ctx.sql`insert into teams (name, monthly_quota, daily_quota, rate_limit)
        values (${name}, ${o.monthly_quota ?? 3000}, ${o.daily_quota ?? null}, ${o.rate_limit ?? 1000}) returning id`;
      for (const m of o.members ?? [{ email: `owner-${randomBytes(3).toString('hex')}@dev.test`, role: 'admin' as const }]) {
        await ctx.sql`insert into team_members (team_id, email, role) values (${row!.id as string}, ${m.email}, ${m.role})`;
      }
      return row!.id as string;
    },
    async key(teamId, perm = 'full_access', domainId = null) {
      return createApiKey(ctx.sql, teamId, 'verify', perm, domainId, null);
    },
    async domain(teamId, name, o = {}) {
      const [d] = await ctx.sql`insert into domains (team_id, name, status, cf_enabled, open_tracking, click_tracking, records)
        values (${teamId}, ${name}, 'verified', true, ${o.open ?? false}, ${o.click ?? false}, '[]') returning id`;
      return d!.id as string;
    },
    async req(method, path, o = {}) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.key !== undefined) headers.authorization = `Bearer ${o.key}`;
      if (!o.noUA && !Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['user-agent'] = 'verify/1.0';
      let body: string | undefined;
      if (o.raw !== undefined) body = o.raw;
      else if (o.body !== undefined) body = JSON.stringify(o.body);
      if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      const r = await fetch(path.startsWith('http') ? path : `${api}${path}`, { method, headers, body });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, headers: r.headers, json, text };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await ctx.sql.end({ timeout: 2 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      await a.end();
    },
  };
  return srv;
}

/** Local HTTP receiver (webhooks / attachment paths). */
export async function receiver(handler?: (req: http.IncomingMessage, body: string, res: http.ServerResponse, n: number) => void) {
  const got: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; at: number }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ method: req.method!, url: req.url!, headers: req.headers, body, at: Date.now() });
      if (handler) handler(req, body, res, got.length);
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, got, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** Result log: every probe line is `RESULT <ok|BAD|info> <id> :: <detail>`. */
export const results: { status: string; id: string; detail: string }[] = [];
export function ok(id: string, detail = '') { results.push({ status: 'ok', id, detail }); console.log(`ok   ${id} ${detail}`); }
export function bad(id: string, detail: string) { results.push({ status: 'BAD', id, detail }); console.log(`BAD  ${id} :: ${detail}`); }
export function info(id: string, detail: string) { results.push({ status: 'info', id, detail }); console.log(`info ${id} :: ${detail}`); }
export function check(id: string, cond: boolean, detail: string) { cond ? ok(id, cond ? '' : detail) : bad(id, detail); }
export const j = (x: unknown) => JSON.stringify(x);
