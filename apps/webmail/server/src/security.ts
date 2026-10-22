import type { Context, MiddlewareHandler } from 'hono';

/**
 * CSP for the SPA. Email bodies are rendered in a sandboxed `srcdoc` iframe
 * (no allow-scripts) which inherits this policy and additionally carries its
 * own stricter <meta> CSP that blocks remote images until the user opts in.
 * img-src therefore has to allow https: so "Display images below" can work.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'self' blob: about:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** CSP for proxied downloads: attachments must never run as our origin. */
export const DOWNLOAD_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', APP_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'X-Requested-With';

/**
 * CSRF defence for cookie-authenticated endpoints: every non-safe request (any method other than
 * GET/HEAD/OPTIONS) must carry a custom header (which cross-site forms can't set and cross-origin
 * fetch can't send without a CORS preflight we never grant). If the browser sends Origin, it must
 * match the Host we're served on. X-Forwarded-Host only counts from a trusted proxy.
 */
export const csrfGuard =
  (opts: { trustForwardedHost: (c: Context) => boolean } = { trustForwardedHost: () => false }): MiddlewareHandler =>
  async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      if (!c.req.header(CSRF_HEADER)) {
        return c.json({ error: 'csrf', message: `Missing ${CSRF_HEADER} header` }, 403);
      }
      const origin = c.req.header('Origin');
      if (origin && origin !== 'null') {
        const fwd = opts.trustForwardedHost(c) ? c.req.header('X-Forwarded-Host')?.split(',')[0]?.trim() : undefined;
        const host = fwd || c.req.header('Host');
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          /* invalid origin */
        }
        if (!host || originHost !== host) {
          return c.json({ error: 'csrf', message: 'Cross-origin request rejected' }, 403);
        }
      }
    }
    await next();
  };
