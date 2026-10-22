import { parseCidr, type Cidr } from './net.js';

export interface Config {
  port: number;
  /** Base URL of the Stalwart HTTP listener, no trailing slash. */
  stalwartUrl: string;
  /** Directory containing the built SPA (index.html + assets). */
  staticDir: string;
  /** Idle timeout for a session in ms. */
  sessionIdleMs: number;
  /** Absolute max lifetime of a session in ms. */
  sessionMaxMs: number;
  /** 'auto' = Secure when the request arrived over https (directly or via X-Forwarded-Proto). */
  cookieSecure: 'auto' | boolean;
  cookieName: string;
  /**
   * Trust X-Forwarded-For / -Proto / -Host (set when running behind a reverse proxy / tunnel) —
   * only on requests whose socket peer is in `trustedProxies`.
   */
  trustProxy: boolean;
  /** Reverse proxies allowed to set forwarding headers (TRUSTED_PROXIES, CIDRs; default loopback). */
  trustedProxies: Cidr[];
  /** Also trust CF-Connecting-IP from those proxies (TRUST_CF_HEADER=1; only when the proxy is Cloudflare's tunnel). */
  trustCfHeader: boolean;
  /** Login attempts allowed per IP (and failed attempts per account) per window. */
  loginRateLimit: number;
  /** Failed logins allowed per minute across all clients (protects the BFF IP from Stalwart's auth ban). */
  loginGlobalFailLimit: number;
  loginRateWindowMs: number;
  /** Delay per login while the global failure limit is exceeded (tests set 0). */
  loginSlowdownMs?: number;
  /** Optional; not used yet (see sessions.ts TODO). */
  redisUrl?: string;
  /** Postgres for shared sessions (required to run more than one process). Unset = in-memory sessions. */
  databaseUrl?: string;
  /** Encrypts the stored Stalwart credential in Postgres sessions (>= 32 chars). */
  sessionSecret: string;
  /** Mail server hostname shown to users for IMAP/SMTP settings and to admins in DNS records. */
  mailHostname?: string;
  /** Public webmail URL (for sign-in details handed to new users). */
  publicUrl?: string;
  /** Cloudflare one-click also onboards Cloudflare Email Sending (only when the outbound relay is Cloudflare Email Service). */
  cloudflareEmailSending: boolean;
  /** Upstream request timeout for non-streaming calls in ms. */
  upstreamTimeoutMs: number;
  /** Cloudflare API token for one-click domain setup (admin only). Unset = feature hidden. Never sent to the browser. */
  cloudflareApiToken?: string;
  /** Restrict zone lookups to this account. */
  cloudflareAccountId?: string;
  /** Test only: serve the Cloudflare API from an in-memory fake (CLOUDFLARE_FAKE=1). Refused when NODE_ENV=production. */
  cloudflareFake: boolean;
  /** Zones the fake knows (CLOUDFLARE_FAKE_ZONES, comma separated). */
  cloudflareFakeZones: string[];
  /** Run the snooze / scheduled-send worker (WORKER=off disables it). */
  workerEnabled: boolean;
  workerIntervalMs: number;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Production defaults to Secure cookies even when TLS terminates at a proxy we can't see.
  const secure = env.COOKIE_SECURE ?? (env.NODE_ENV === 'production' ? 'true' : 'auto');
  const cookieSecure = secure === 'auto' ? 'auto' : bool(secure, true);
  const cloudflareFake = bool(env.CLOUDFLARE_FAKE, false);
  if (cloudflareFake && env.NODE_ENV === 'production') {
    throw new Error('CLOUDFLARE_FAKE is a test-only setting and must not be enabled in production');
  }
  return {
    port: Number(env.PORT ?? 3000),
    stalwartUrl: (env.STALWART_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
    staticDir: env.STATIC_DIR ?? new URL('../client', import.meta.url).pathname,
    sessionIdleMs: Number(env.SESSION_IDLE_HOURS ?? 24 * 7) * 3600_000,
    sessionMaxMs: Number(env.SESSION_MAX_DAYS ?? 30) * 86400_000,
    cookieSecure,
    // __Host- pins the cookie to this exact origin over HTTPS (no Domain, Path=/, Secure).
    cookieName: env.COOKIE_NAME ?? (cookieSecure === true ? '__Host-mail_sid' : 'mail_sid'),
    trustProxy: bool(env.TRUST_PROXY, false),
    trustedProxies: (env.TRUSTED_PROXIES ?? '127.0.0.0/8,::1/128')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map(parseCidr),
    trustCfHeader: bool(env.TRUST_CF_HEADER, false),
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
    loginGlobalFailLimit: Number(env.LOGIN_GLOBAL_FAIL_LIMIT ?? 30),
    loginRateWindowMs: Number(env.LOGIN_RATE_WINDOW_SEC ?? 900) * 1000,
    redisUrl: env.REDIS_URL || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    sessionSecret: env.SESSION_SECRET ?? '',
    mailHostname: env.MAIL_HOSTNAME || (env.MAIL_DOMAIN ? `mail.${env.MAIL_DOMAIN}` : undefined),
    publicUrl: env.PUBLIC_URL || undefined,
    cloudflareEmailSending: bool(env.CLOUDFLARE_EMAIL_SENDING, false),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 60_000),
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN || undefined,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || undefined,
    cloudflareFake,
    cloudflareFakeZones: (env.CLOUDFLARE_FAKE_ZONES ?? 'cfzone.test,acmedemo.test')
      .split(',')
      .map((z) => z.trim().toLowerCase())
      .filter(Boolean),
    workerEnabled: bool(env.WORKER, true),
    workerIntervalMs: Math.max(10, Number(env.WORKER_INTERVAL_SEC ?? 60)) * 1000,
  };
}
