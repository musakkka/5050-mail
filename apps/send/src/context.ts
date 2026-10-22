import type { Config } from './config.js';
import { createSql, type Sql } from './db.js';
import { CloudflareClient, CloudflareService } from './cloudflare/client.js';
import { fakeCloudflareFetch, fakeState, type FakeCloudflareState } from './cloudflare/fake.js';
import { systemResolver, type DnsResolver } from './lib/dns.js';
import { signingKeyFor } from './services/localDomains.js';
import { CloudflareTransport, FakeTransport, LogTransport, SmtpTransport, type Transport } from './transport/index.js';

/** Everything a request handler, worker job or SMTP session needs. */
export interface AppContext {
  config: Config;
  sql: Sql;
  transport: Transport;
  /** null when no Cloudflare token (and no fake) is configured. */
  cf: CloudflareService | null;
  /** Present when CLOUDFLARE_FAKE=1 (tests / local dev). */
  cfFake?: FakeCloudflareState;
  now: () => Date;
  log: (scope: string, msg: string, extra?: Record<string, unknown>) => void;
  dns: DnsResolver;
  /** Overridable for tests (webhook delivery, attachment `path` fetches go through safeRequest otherwise). */
  fetchImpl?: typeof fetch;
}

export function defaultLog(scope: string, msg: string, extra?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), scope, msg, ...(extra ?? {}) };
  console.log(JSON.stringify(line));
}

export function createContext(config: Config, over: Partial<AppContext> = {}): AppContext {
  const sql = over.sql ?? createSql(config.databaseUrl);
  let cf: CloudflareService | null = null;
  let cfFake: FakeCloudflareState | undefined;
  const log = over.log ?? defaultLog;
  if (config.cloudflareFake) {
    cfFake = over.cfFake ?? fakeState(config.cloudflareFakeZones);
    const client = new CloudflareClient({ token: 'fake-token', accountId: config.cloudflareAccountId ?? 'fake-account', fetch: fakeCloudflareFetch(cfFake) });
    cf = new CloudflareService(client, (m) => log('cloudflare', m));
  } else if (config.cloudflareApiToken) {
    const client = new CloudflareClient({ token: config.cloudflareApiToken, accountId: config.cloudflareAccountId, baseUrl: config.cloudflareApiBase });
    cf = new CloudflareService(client, (m) => log('cloudflare', m));
  }
  let transport: Transport;
  let ctxRef: AppContext | undefined;
  if (over.transport) transport = over.transport;
  else if (config.transport === 'cloudflare') {
    if (!cf) throw new Error('TRANSPORT=cloudflare needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
    transport = new CloudflareTransport(cf.cf);
  } else if (config.transport === 'smtp') transport = new SmtpTransport(config.smtpRelayUrl, undefined, (from) => signingKeyFor(ctxRef!, from));
  else if (config.transport === 'log') transport = new LogTransport();
  else transport = new FakeTransport();
  ctxRef = { config, sql, transport, cf: over.cf ?? cf, cfFake, now: over.now ?? (() => new Date()), log, fetchImpl: over.fetchImpl, dns: over.dns ?? systemResolver(process.env.DNS_SERVERS?.split(',').filter(Boolean)) };
  return ctxRef;
}
