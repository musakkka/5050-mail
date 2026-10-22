/** Runtime configuration, read once from the environment. See README "Environment". */

export interface Config {
  env: string;
  port: number;
  databaseUrl: string;
  stalwartUrl: string;
  /** Host header that selects the public (Resend-compatible) API. */
  apiHost: string;
  /** Host header that selects the dashboard + /api/internal. */
  dashboardHost: string;
  /** Surface used for any other Host (local dev). `/v/*` always maps to the public API. */
  defaultSurface: 'api' | 'dashboard' | 'none';
  /** Absolute base URL of the public API (used in links we generate). */
  publicApiBase: string;
  /** Base URL for open-pixel / click-redirect / unsubscribe links. */
  publicTrackingBase: string;
  dashboardBase: string;
  /** HMAC key for tracking/share/unsubscribe tokens. Required in production. */
  sessionSecret: string;
  trustProxy: boolean;
  cookieSecure: 'auto' | boolean;
  cookieName: string;
  sessionIdleMs: number;
  sessionMaxMs: number;
  loginRateLimit: number;
  loginRateWindowMs: number;
  loginGlobalFailLimit: number;
  requireUserAgent: boolean;
  defaultRateLimit: number;
  defaultMonthlyQuota: number;
  defaultDailyQuota: number | null;
  /** Resend's shared test domain; `onboarding@resend.dev` etc. work like on Resend. */
  sandboxDomain: string;
  transport: 'smtp' | 'cloudflare' | 'fake' | 'log';
  /** TRANSPORT=smtp: where finished messages are submitted (the mail server's internal relay port). */
  smtpRelayUrl: string;
  /** Where domain records come from: `local` (own DKIM key, public-DNS verification) or `cloudflare` (Email Sending). */
  domainRecords: 'local' | 'cloudflare';
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  cloudflareApiBase: string;
  cloudflareGraphqlUrl: string;
  /** Opt-in: add domains that aren't in the account as (pending) zones so Email Sending can onboard them. */
  cloudflareCreateZones: boolean;
  /** CNAME target shown for a domain's tracking subdomain. */
  trackingCnameTarget: string;
  /** Default DMARC policy suggested in domain records. */
  dmarcValue: string;
  cloudflareFake: boolean;
  cloudflareFakeZones: string[];
  analyticsPollIntervalMs: number;
  logRetentionDays: number;
  workerInline: boolean;
  workerPollMs: number;
  /** Test only: allow webhook delivery to private addresses. */
  allowPrivateWebhooks: boolean;
  maxBodyBytes: number;
  smtpHostname: string;
  smtpPortsTls: number[];
  smtpPortsStartTls: number[];
  smtpTlsCert?: string;
  smtpTlsKey?: string;
  smtpMaxMessageBytes: number;
  acmeEnabled: boolean;
  acmeEmail?: string;
  acmeDirectory: string;
  acmeStateDir: string;
  /** Shared secret for POST /inbound (raw MIME ingest from the receiving relay). */
  inboundSecret?: string;
  /** Receiving MX host shown in domain records (capabilities.receiving). */
  inboundMxHost: string;
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const ports = (v: string | undefined, d: number[]) =>
  v === undefined ? d : v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const stripSlash = (s: string) => s.replace(/\/+$/, '');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prod = env.NODE_ENV === 'production';
  const apiHost = (env.API_HOST ?? 'api.example.com').toLowerCase();
  const dashboardHost = (env.DASHBOARD_HOST ?? 'send.example.com').toLowerCase();
  const publicApiBase = stripSlash(env.PUBLIC_API_BASE ?? `https://${apiHost}`);
  const cloudflareFake = bool(env.CLOUDFLARE_FAKE, false);
  if (prod && cloudflareFake) throw new Error('CLOUDFLARE_FAKE is test-only and refused in production');
  const transport = (env.TRANSPORT ?? (prod ? 'smtp' : 'fake')) as Config['transport'];
  if (!['smtp', 'cloudflare', 'fake', 'log'].includes(transport)) throw new Error(`TRANSPORT must be smtp, cloudflare, fake or log (got ${transport})`);
  if (prod && transport === 'fake') throw new Error('TRANSPORT=fake is refused in production');
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (prod && sessionSecret.length < 32) throw new Error('SESSION_SECRET (>= 32 chars) is required in production');
  if (prod && bool(env.ALLOW_PRIVATE_WEBHOOKS, false)) throw new Error('ALLOW_PRIVATE_WEBHOOKS is test-only');
  return {
    env: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://send:sendpw@localhost:55432/send',
    stalwartUrl: stripSlash(env.STALWART_URL ?? 'http://localhost:18090'),
    apiHost,
    dashboardHost,
    defaultSurface: (env.DEFAULT_SURFACE ?? (prod ? 'none' : 'dashboard')) as Config['defaultSurface'],
    publicApiBase,
    publicTrackingBase: stripSlash(env.PUBLIC_TRACKING_BASE ?? publicApiBase),
    dashboardBase: stripSlash(env.DASHBOARD_BASE ?? `https://${dashboardHost}`),
    sessionSecret: sessionSecret || 'dev-only-insecure-session-secret-change-me',
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: env.COOKIE_SECURE === undefined || env.COOKIE_SECURE === 'auto' ? 'auto' : bool(env.COOKIE_SECURE, true),
    cookieName: env.COOKIE_NAME ?? 'send_sid',
    sessionIdleMs: Number(env.SESSION_IDLE_HOURS ?? 24 * 7) * 3600_000,
    sessionMaxMs: Number(env.SESSION_MAX_DAYS ?? 30) * 86400_000,
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
    loginRateWindowMs: Number(env.LOGIN_RATE_WINDOW_SEC ?? 900) * 1000,
    loginGlobalFailLimit: Number(env.LOGIN_GLOBAL_FAIL_LIMIT ?? 30),
    requireUserAgent: bool(env.REQUIRE_USER_AGENT, true),
    defaultRateLimit: Number(env.DEFAULT_RATE_LIMIT ?? 2),
    defaultMonthlyQuota: Number(env.DEFAULT_MONTHLY_QUOTA ?? 3000),
    defaultDailyQuota: env.DEFAULT_DAILY_QUOTA ? Number(env.DEFAULT_DAILY_QUOTA) : null,
    sandboxDomain: (env.SANDBOX_DOMAIN ?? 'resend.dev').toLowerCase(),
    transport,
    smtpRelayUrl: env.SMTP_RELAY_URL ?? 'smtp://stalwart:2525',
    domainRecords: (env.DOMAIN_RECORDS ?? (transport === 'smtp' ? 'local' : 'cloudflare')) === 'local' ? 'local' : 'cloudflare',
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || undefined,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || undefined,
    cloudflareApiBase: stripSlash(env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4'),
    cloudflareGraphqlUrl: env.CLOUDFLARE_GRAPHQL_URL ?? 'https://api.cloudflare.com/client/v4/graphql',
    cloudflareCreateZones: bool(env.CLOUDFLARE_CREATE_ZONES, false),
    trackingCnameTarget: env.TRACKING_CNAME_TARGET ?? apiHost,
    dmarcValue: env.DMARC_VALUE ?? 'v=DMARC1; p=none;',
    cloudflareFake,
    cloudflareFakeZones: (env.CLOUDFLARE_FAKE_ZONES ?? 'cfzone.test,acmedemo.test')
      .split(',')
      .map((z) => z.trim().toLowerCase())
      .filter(Boolean),
    analyticsPollIntervalMs: Number(env.ANALYTICS_POLL_INTERVAL_SEC ?? 60) * 1000,
    logRetentionDays: Number(env.LOG_RETENTION_DAYS ?? 30),
    workerInline: bool(env.WORKER_INLINE, false),
    workerPollMs: Number(env.WORKER_POLL_MS ?? 1000),
    allowPrivateWebhooks: bool(env.ALLOW_PRIVATE_WEBHOOKS, false),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 60 * 1024 * 1024),
    smtpHostname: env.SMTP_HOSTNAME ?? 'smtp.example.com',
    smtpPortsTls: ports(env.SMTP_PORTS_TLS, [465, 2465]),
    smtpPortsStartTls: ports(env.SMTP_PORTS_STARTTLS, [587, 2587]),
    smtpTlsCert: env.SMTP_TLS_CERT || undefined,
    smtpTlsKey: env.SMTP_TLS_KEY || undefined,
    smtpMaxMessageBytes: Number(env.SMTP_MAX_MESSAGE_BYTES ?? (transport === 'cloudflare' ? 5 * 1024 * 1024 : 40 * 1024 * 1024)),
    acmeEnabled: bool(env.ACME_ENABLED, false),
    acmeEmail: env.ACME_EMAIL || undefined,
    acmeDirectory: env.ACME_DIRECTORY ?? 'https://acme-v02.api.letsencrypt.org/directory',
    acmeStateDir: env.ACME_STATE_DIR ?? '/var/lib/5050-send/acme',
    inboundSecret: env.INBOUND_SECRET || undefined,
    inboundMxHost: env.INBOUND_MX_HOST ?? 'inbound.example.com',
  };
}
