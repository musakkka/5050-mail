/**
 * Dashboard host: placeholder UI, the shared-email page, and /api/internal/* for
 * the dashboard SPA. Security posture copied from the webmail BFF
 * (web/server/src/app.ts): httpOnly session cookie, X-Requested-With + Origin
 * check on unsafe methods, per-IP / per-account login limits and a global slowdown.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext } from '../context.js';
import type { PublicApi } from '../api/app.js';
import { clientIp } from '../api/app.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { verifyToken } from '../lib/crypto.js';
import { escapeHtml } from '../services/render.js';
import { basicAuth, detectAdmin, fetchDisplayName, fetchSession } from './stalwart.js';
import { createSession, deleteSession, loadSession, type DashboardSession } from './sessions.js';
import { registerInternalRoutes } from './routes.js';
import { mountSpa } from './spa.js';

export type InternalEnv = { Variables: { session: DashboardSession; sid: string } };

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CSRF_HEADER = 'X-Requested-With';
/** Delay added to every login attempt while the global failure limit is exceeded. */
const LOGIN_SLOWDOWN_MS = 1000;

const APP_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:",
  "font-src 'self' data:", "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', APP_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
};

/** X-Forwarded-Host is only honoured behind a trusted proxy (TRUST_PROXY); otherwise a client could forge it to match a hostile Origin. */
export const csrfGuard = (cfg: { trustProxy: boolean }): MiddlewareHandler => async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    if (!c.req.header(CSRF_HEADER)) return c.json({ error: 'csrf', message: `Missing ${CSRF_HEADER} header` }, 403);
    const origin = c.req.header('Origin');
    if (origin && origin !== 'null') {
      const fwd = cfg.trustProxy ? c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim() : undefined;
      const host = fwd || c.req.header('Host');
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        /* invalid */
      }
      if (!host || originHost !== host) return c.json({ error: 'csrf', message: 'Cross-origin request rejected' }, 403);
    }
  }
  await next();
};

export function createDashboardApp(ctx: AppContext, api: PublicApi): Hono<InternalEnv> {
  const cfg = ctx.config;
  const app = new Hono<InternalEnv>();
  const loginLimiter = new RateLimiter(cfg.loginRateLimit, cfg.loginRateWindowMs);
  const accountLimiter = new RateLimiter(cfg.loginRateLimit, cfg.loginRateWindowMs);
  const globalFailLimiter = new RateLimiter(cfg.loginGlobalFailLimit, 60_000);

  const isHttps = (c: Context): boolean => {
    if (cfg.cookieSecure !== 'auto') return cfg.cookieSecure;
    if (cfg.trustProxy) {
      const p = c.req.header('X-Forwarded-Proto');
      if (p) return p.split(',')[0]!.trim() === 'https';
    }
    return new URL(c.req.url).protocol === 'https:';
  };

  app.use('*', securityHeaders);
  app.onError((err, c) => {
    ctx.log('internal', 'unhandled error', { error: (err as Error).message, path: c.req.path });
    return c.json({ error: 'internal', message: 'Something went wrong' }, 500);
  });

  app.use('/api/*', csrfGuard(cfg));
  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  app.post('/api/internal/login', async (c) => {
    const ip = clientIp(ctx, c) ?? 'unknown';
    const retryAfter = loginLimiter.hit(ip);
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' }, 429);
    }
    let b: { email?: unknown; password?: unknown };
    try {
      b = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!EMAIL_RE.test(email) || !password || email.length > 320 || password.length > 1024) {
      return c.json({ error: 'bad_request', message: 'Enter an email and password' }, 400);
    }
    const accountKey = email.toLowerCase();
    if (accountLimiter.peek(accountKey)) {
      return c.json({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' }, 429);
    }
    // Under a site-wide failure spike (e.g. a spray across many IPs) every attempt is slowed down
    // rather than refused, so attackers can't lock everyone out; per-IP/per-account limits still block.
    if (globalFailLimiter.peek('*')) await new Promise((r) => setTimeout(r, LOGIN_SLOWDOWN_MS));
    const authorization = basicAuth(email, password);
    let upstream;
    try {
      upstream = await fetchSession(fetch, cfg.stalwartUrl, authorization, { 'X-Forwarded-For': ip });
    } catch (e) {
      ctx.log('internal', 'login upstream error', { error: (e as Error).message });
      return c.json({ error: 'upstream', message: 'Mail server unavailable' }, 502);
    }
    if (!upstream) {
      accountLimiter.hit(accountKey);
      globalFailLimiter.hit('*');
      return c.json({ error: 'invalid_credentials', message: 'Wrong email or password' }, 401);
    }
    loginLimiter.reset(ip);
    accountLimiter.reset(accountKey);
    const canonical = (upstream.username || email).toLowerCase();
    const [isAdmin, name] = await Promise.all([
      detectAdmin(fetch, cfg.stalwartUrl, authorization, upstream),
      fetchDisplayName(fetch, cfg.stalwartUrl, authorization, upstream, canonical),
    ]);
    if (!isAdmin) {
      const [m] = await ctx.sql`select 1 from team_members where email = ${canonical} limit 1`;
      if (!m) return c.json({ error: 'no_team', message: 'Your mail account is not a member of any 5050 Send team. Ask an administrator to add you.' }, 403);
    }
    const old = getCookie(c, cfg.cookieName);
    if (old) await deleteSession(ctx, old);
    const sid = await createSession(ctx, { email: canonical, name, isAdmin, authorization });
    setCookie(c, cfg.cookieName, sid, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: Math.floor(cfg.sessionMaxMs / 1000) });
    return c.json({ email: canonical, name, isAdmin });
  });

  app.post('/api/internal/logout', async (c) => {
    const sid = getCookie(c, cfg.cookieName);
    if (sid) await deleteSession(ctx, sid);
    deleteCookie(c, cfg.cookieName, { path: '/', secure: isHttps(c) });
    return c.json({ ok: true });
  });

  // Everything else under /api/internal needs a session.
  app.use('/api/internal/*', async (c, next) => {
    const sid = getCookie(c, cfg.cookieName);
    const s = await loadSession(ctx, sid);
    if (!s) return c.json({ error: 'unauthenticated', message: 'Not signed in' }, 401);
    // Re-check Stalwart admin status at most once a minute (admin can be revoked upstream).
    if (s.credential && ctx.now().getTime() - s.adminCheckedAt.getTime() > 60_000) {
      try {
        const up = await fetchSession(fetch, cfg.stalwartUrl, s.credential);
        if (!up) {
          await deleteSession(ctx, sid!);
          return c.json({ error: 'unauthenticated', message: 'Session expired' }, 401);
        }
        s.isAdmin = await detectAdmin(fetch, cfg.stalwartUrl, s.credential, up);
        await ctx.sql`update dashboard_sessions set is_admin = ${s.isAdmin}, admin_checked_at = now() where id_hash = ${s.idHash}`;
      } catch {
        /* Stalwart unreachable: keep the cached flag */
      }
    }
    c.set('session', s);
    c.set('sid', sid!);
    await next();
  });

  registerInternalRoutes(app, ctx, api);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // Public "shared email" page (POST /emails/:id/share links here).
  app.get('/shared', async (c) => {
    const tok = verifyToken<{ k: 'sent' | 'received'; e: string; x: number }>(cfg.sessionSecret, 'share', c.req.query('token') ?? '');
    if (!tok || tok.x * 1000 < ctx.now().getTime()) return c.html(sharedPage('Link expired', '<p>This shared link is invalid or has expired.</p>'), 404);
    const [e] = tok.k === 'sent'
      ? await ctx.sql`select from_addr as f, to_addrs as t, subject, html, text, created_at from emails where id = ${tok.e}`
      : await ctx.sql`select from_addr as f, to_addrs as t, subject, html, text, created_at from received_emails where id = ${tok.e}`;
    if (!e) return c.html(sharedPage('Not found', '<p>This email no longer exists.</p>'), 404);
    const body = e.html
      ? `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(e.html as string)}" style="width:100%;min-height:70vh;border:1px solid #ddd;border-radius:8px;background:#fff"></iframe>`
      : `<pre style="white-space:pre-wrap">${escapeHtml((e.text as string) ?? '')}</pre>`;
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(sharedPage(String(e.subject ?? ''), `<h1>${escapeHtml(String(e.subject ?? '(no subject)'))}</h1><p><b>From:</b> ${escapeHtml(String(e.f))}<br><b>To:</b> ${escapeHtml((e.t as string[]).join(', '))}<br><b>Date:</b> ${escapeHtml(String(e.created_at))}</p>${body}`));
  });

  // The dashboard SPA (send/web/dist, or DASHBOARD_DIST); placeholder when it isn't built.
  if (!mountSpa(app)) app.get('*', (c) =>
    c.html(sharedPage('5050 Send', '<h1>5050 Send</h1><p>The dashboard is coming soon. The API lives at <code>' + escapeHtml(cfg.publicApiBase) + '</code>.</p>')),
  );

  return app;
}

function sharedPage(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px;background:#f6f6f4;color:#1a1a1a}main{max-width:860px;margin:0 auto}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head><body><main>${inner}</main></body></html>`;
}
