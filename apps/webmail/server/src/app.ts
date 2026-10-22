import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Config } from './config.js';
import type { SessionStore, Session } from './sessions.js';
import { RateLimiter } from './rateLimit.js';
import { csrfGuard, securityHeaders } from './security.js';
import { inCidrs } from './net.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basicAuth, detectAdmin, fetchDisplayName, fetchSession, type FetchFn } from './stalwart.js';
import { proxyToStalwart } from './proxy.js';
import { CloudflareClient, CloudflareService } from './cloudflare.js';
import { fakeCloudflareFetch, fakeState } from './cloudflareFake.js';
import { adminCloudflareRoutes } from './adminCloudflare.js';
import { adminDnsRoutes, type DnsLookup } from './adminDns.js';
import type { MailWorker } from './worker.js';

export interface AppDeps {
  config: Config;
  store: SessionStore;
  fetch?: FetchFn;
  /** Resolve the socket peer address (injected by index.ts; tests use the default). */
  peerIp?: (c: Context) => string | undefined;
  /** Mount static file serving for the SPA (injected by index.ts). */
  mountStatic?: (app: Hono<Env>) => void;
  /** fetch used for the Cloudflare API (tests inject a fake). */
  cloudflareFetch?: FetchFn;
  /** DNS resolver for /api/admin/dns/check (tests inject a fake). */
  dnsLookup?: DnsLookup;
  /** Snooze / scheduled-send worker; POST /api/sweep runs it for the signed-in account. */
  worker?: MailWorker;
}

/** The Cloudflare service, or null when neither a token nor the test-only fake is configured. */
export function buildCloudflareService(config: Config, cloudflareFetch?: FetchFn): CloudflareService | null {
  if (config.cloudflareFake) {
    console.warn('[webmail] CLOUDFLARE_FAKE is on: Cloudflare API calls go to an in-memory fake (test only)');
    const f = cloudflareFetch ?? fakeCloudflareFetch(fakeState(config.cloudflareFakeZones));
    return new CloudflareService(new CloudflareClient({ token: 'fake-token', fetch: f }), undefined, undefined, config.cloudflareEmailSending);
  }
  if (!config.cloudflareApiToken) return null;
  return new CloudflareService(new CloudflareClient({ token: config.cloudflareApiToken, accountId: config.cloudflareAccountId, fetch: cloudflareFetch }), undefined, undefined, config.cloudflareEmailSending);
}

type Env = { Variables: { session: Session } };

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
/** Delay added to every login attempt while the global failure limit is exceeded. */
const LOGIN_SLOWDOWN_MS = 1000;
/** "Known device" cookie: set after a successful login, lets that browser past the per-account lock. */
const DEVICE_COOKIE = 'mail_device';
const DEVICE_MAX_AGE_S = 90 * 86400;

export function createApp(deps: AppDeps): Hono<Env> {
  const { config, store } = deps;
  const fetchFn = deps.fetch ?? fetch;
  const loginLimiter = new RateLimiter(config.loginRateLimit, config.loginRateWindowMs);
  // Every login is checked against Stalwart from the BFF's own IP, so Stalwart's
  // auth-failure ban would lock out *everyone*: cap failures per target account
  // and globally too (a spray from many client IPs).
  const accountLimiter = new RateLimiter(config.loginRateLimit, config.loginRateWindowMs);
  const globalFailLimiter = new RateLimiter(config.loginGlobalFailLimit, 60_000);
  const deviceKey = randomBytes(32);
  const app = new Hono<Env>();

  /** Forwarding headers count only with TRUST_PROXY *and* a socket peer in TRUSTED_PROXIES. */
  const fromTrustedProxy = (c: Context): boolean => config.trustProxy && inCidrs(deps.peerIp?.(c), config.trustedProxies);

  /**
   * Client IP for rate limiting. Behind a trusted proxy: CF-Connecting-IP when TRUST_CF_HEADER is
   * set (Cloudflare overwrites any client-supplied value), else the right-most X-Forwarded-For
   * entry — the one appended by our own proxy, not anything the client sent.
   */
  const clientIp = (c: Context): string => {
    if (fromTrustedProxy(c)) {
      if (config.trustCfHeader) {
        const cf = c.req.header('CF-Connecting-IP');
        if (cf) return cf.trim();
      }
      const xff = c.req.header('X-Forwarded-For');
      if (xff) return xff.split(',').at(-1)!.trim();
    }
    return deps.peerIp?.(c) ?? 'unknown';
  };

  const isHttps = (c: Context): boolean => {
    if (config.cookieSecure !== 'auto') return config.cookieSecure;
    if (fromTrustedProxy(c)) {
      const p = c.req.header('X-Forwarded-Proto');
      if (p) return p.split(',')[0]!.trim() === 'https';
    }
    return new URL(c.req.url).protocol === 'https:';
  };

  const loadSession = async (c: Context): Promise<Session | undefined> => {
    const sid = getCookie(c, config.cookieName);
    if (!sid) return undefined;
    const s = await store.get(sid);
    if (s) await store.touch(sid);
    return s;
  };

  const deviceToken = (account: string, exp: number) =>
    createHmac('sha256', deviceKey).update(`${account}\n${exp}`).digest('base64url');
  /** True if this browser signed in to `account` successfully before (signed, expiring cookie). */
  const knownDevice = (c: Context, account: string): boolean => {
    const v = getCookie(c, DEVICE_COOKIE);
    if (!v) return false;
    for (const entry of v.split('|')) {
      const [acct, exp, mac] = entry.split('.');
      if (!acct || !exp || !mac || Number(exp) < Date.now() / 1000) continue;
      let name: string;
      try {
        name = Buffer.from(acct, 'base64url').toString('utf8');
      } catch {
        continue;
      }
      if (name !== account) continue;
      const want = Buffer.from(deviceToken(name, Number(exp)));
      const got = Buffer.from(mac);
      if (want.length === got.length && timingSafeEqual(want, got)) return true;
    }
    return false;
  };
  const rememberDevice = (c: Context, account: string) => {
    const exp = Math.floor(Date.now() / 1000) + DEVICE_MAX_AGE_S;
    const entry = `${Buffer.from(account).toString('base64url')}.${exp}.${deviceToken(account, exp)}`;
    const others = (getCookie(c, DEVICE_COOKIE) ?? '')
      .split('|')
      .filter((e) => e && !e.startsWith(`${Buffer.from(account).toString('base64url')}.`))
      .slice(-4);
    setCookie(c, DEVICE_COOKIE, [...others, entry].join('|'), {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: 'Strict',
      path: '/api/login',
      maxAge: DEVICE_MAX_AGE_S,
    });
  };

  app.use('*', securityHeaders);
  app.use('*', async (c, next) => {
    await next();
    if (isHttps(c)) c.res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  });
  const csrf = csrfGuard({ trustForwardedHost: fromTrustedProxy });

  app.get('/health', (c) => c.json({ ok: true }));

  // ---------- auth API ----------
  app.use('/api/*', csrf);
  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  app.post('/api/login', async (c) => {
    const ip = clientIp(c);
    const retryAfter = loginLimiter.hit(ip);
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' }, 429);
    }
    let body: { email?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email) || !password || email.length > 320 || password.length > 1024) {
      return c.json({ error: 'bad_request', message: 'Enter an email and password' }, 400);
    }
    const accountKey = email.toLowerCase();
    // Per-account lock (distributed guessing) — except for a browser that has signed in to this
    // account before, so an attacker can't lock the owner out.
    if (accountLimiter.peek(accountKey) && !knownDevice(c, accountKey)) {
      return c.json({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' }, 429);
    }
    // Under a site-wide failure spike (a spray across many IPs) every attempt is slowed down rather
    // than refused, so nobody can lock everyone out; per-IP and per-account limits still block.
    if (globalFailLimiter.peek('*')) await new Promise((r) => setTimeout(r, config.loginSlowdownMs ?? LOGIN_SLOWDOWN_MS));
    const authorization = basicAuth(email, password);
    let upstream;
    try {
      upstream = await fetchSession(fetchFn, config.stalwartUrl, authorization, { 'X-Forwarded-For': ip });
    } catch (e) {
      console.error('[login] upstream error', (e as Error).message);
      return c.json({ error: 'upstream', message: 'Mail server unavailable' }, 502);
    }
    if (!upstream) {
      accountLimiter.hit(accountKey);
      globalFailLimiter.hit('*');
      return c.json({ error: 'invalid_credentials', message: 'Wrong email or password' }, 401);
    }
    loginLimiter.reset(ip);
    accountLimiter.reset(accountKey);

    const canonical = upstream.username || email;
    const [isAdmin, name] = await Promise.all([
      detectAdmin(fetchFn, config.stalwartUrl, authorization, upstream),
      fetchDisplayName(fetchFn, config.stalwartUrl, authorization, upstream, canonical),
    ]);
    // Rotate: drop any prior session carried by this browser.
    const old = getCookie(c, config.cookieName);
    if (old) await store.delete(old);
    const s = await store.create({ email: canonical, name, isAdmin, authorization, accountIds: Object.keys(upstream.accounts ?? {}) });
    setCookie(c, config.cookieName, s.id, {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(config.sessionMaxMs / 1000),
    });
    rememberDevice(c, accountKey);
    return c.json({ email: s.email, name: s.name, isAdmin: s.isAdmin, mailHost: config.mailHostname ?? null });
  });

  app.post('/api/logout', async (c) => {
    const sid = getCookie(c, config.cookieName);
    if (sid) await store.delete(sid);
    deleteCookie(c, config.cookieName, { path: '/', secure: isHttps(c) });
    return c.json({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const s = await loadSession(c);
    if (!s) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({ email: s.email, name: s.name, isAdmin: s.isAdmin, mailHost: config.mailHostname ?? null });
  });

  // Wake due snoozed mail and file delivered scheduled mail now (the app calls this while open;
  // the background worker covers everyone else). Results younger than 15 s are reused.
  app.post('/api/sweep', async (c) => {
    const s = await loadSession(c);
    if (!s) return c.json({ error: 'unauthenticated' }, 401);
    if (!deps.worker) return c.json({ woken: 0, sent: 0, worker: false });
    try {
      const r = await deps.worker.sweep({ email: s.email, authorization: s.authorization }, 15_000);
      return c.json({ ...r, worker: true });
    } catch (e) {
      console.error('[sweep]', (e as Error).message);
      return c.json({ error: 'upstream', message: 'Mail server unavailable' }, 502);
    }
  });

  app.route(
    '/api/admin/cloudflare',
    adminCloudflareRoutes({
      service: buildCloudflareService(config, deps.cloudflareFetch),
      loadSession,
      fetch: fetchFn,
      stalwartUrl: config.stalwartUrl,
    }),
  );

  app.route('/api/admin/dns', adminDnsRoutes({ loadSession, fetch: fetchFn, stalwartUrl: config.stalwartUrl, lookup: deps.dnsLookup }));

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // ---------- JMAP proxy ----------
  const proxy = async (c: Context<Env>) => {
    const s = await loadSession(c);
    if (!s) return c.json({ type: 'urn:5050:error:unauthenticated', status: 401, detail: 'Not signed in' }, 401);
    try {
      const out = await proxyToStalwart(c, s, { fetch: fetchFn, stalwartUrl: config.stalwartUrl, clientIp: clientIp(c) });
      if (out.kind === 'notFound') return c.json({ type: 'urn:5050:error:notFound', status: 404, detail: 'Not found' }, 404);
      if (out.kind === 'forbidden') return c.json({ type: 'urn:ietf:params:jmap:error:forbidden', status: 403, detail: out.detail }, 403);
      if (out.kind === 'unauthorized') {
        // Credentials no longer valid upstream (password changed / account disabled).
        await store.delete(s.id);
        deleteCookie(c, config.cookieName, { path: '/', secure: isHttps(c) });
        return c.json({ type: 'urn:5050:error:unauthenticated', status: 401, detail: 'Session expired' }, 401);
      }
      return out.response;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return new Response(null, { status: 499 });
      console.error('[proxy] upstream error', (e as Error).message);
      return c.json({ type: 'urn:5050:error:upstream', status: 502, detail: 'Mail server unavailable' }, 502);
    }
  };
  app.use('/jmap/*', csrf);
  app.use('/jmap', csrf);
  app.all('/jmap', proxy);
  app.all('/jmap/*', proxy);
  app.get('/.well-known/jmap', proxy);

  deps.mountStatic?.(app);
  return app;
}
