/** The public, Resend-compatible API (served at the root of API_HOST, or under /v locally). */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../context.js';
import { ApiError, E } from '../lib/errors.js';
import { TeamRateLimiter } from '../lib/rateLimit.js';
import { redact } from '../lib/redact.js';
import { verifyApiKey, type AuthContext } from '../services/apiKeys.js';
import { Router, type ApiEnv } from './router.js';
import { registerEmailRoutes } from './routes/emails.js';
import { registerDomainRoutes } from './routes/domains.js';
import { registerApiKeyRoutes } from './routes/apiKeys.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerBroadcastRoutes } from './routes/broadcasts.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerAutomationRoutes } from './routes/automations.js';
import { registerInboxRoutes } from './routes/inboxes.js';
import { registerPublicPages } from './routes/public.js';

export interface PublicApi {
  app: Hono<ApiEnv>;
  router: Router;
  /** Unauthenticated pages on the API host: tracking pixel, click redirect, unsubscribe, share, inbound. */
  pages: Hono;
  limiter: TeamRateLimiter;
}

/** Bindings the internal (dashboard) API passes to call public routes as a team. */
export interface InternalBindings {
  dashboardAuth?: AuthContext;
  incoming?: { socket?: { remoteAddress?: string } };
}

const NO_UA_BODY = 'error code: 1010';

export function createPublicApi(ctx: AppContext): PublicApi {
  const app = new Hono<ApiEnv>();
  const router = new Router(app, ctx);
  const limiter = new TeamRateLimiter();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    ctx.log('api', 'unhandled error', { error: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 5).join(' | '), path: c.req.path });
    return c.json(E.internal().toJSON(), 500);
  });
  app.notFound((c) => c.json(E.endpointNotFound().toJSON(), 404));

  app.use('*', async (c, next) => {
    c.set('startedAt', Date.now());
    const env = c.env as InternalBindings | undefined;
    const internal = env?.dashboardAuth;
    const { route, pathExists } = router.match(c.req.method, c.req.path);
    if (!route) {
      if (pathExists) throw E.methodNotAllowed();
      throw E.endpointNotFound();
    }
    if (!internal && ctx.config.requireUserAgent && !c.req.header('user-agent')) {
      return c.text(NO_UA_BODY, 403);
    }

    // Body
    let parsed: unknown = undefined;
    let raw: string | null = null;
    const ct = c.req.header('content-type') ?? '';
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method) && !ct.startsWith('multipart/form-data')) {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > ctx.config.maxBodyBytes) throw new ApiError(413, 'validation_error', 'The request body is too large.');
      raw = await c.req.text();
      if (raw.length > ctx.config.maxBodyBytes) throw new ApiError(413, 'validation_error', 'The request body is too large.');
      if (raw.trim()) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw E.validation('The request body is not valid JSON.', 400);
        }
      }
    }
    c.set('rawBody', raw);
    c.set('requestBody', parsed);

    // Auth
    let auth: AuthContext;
    if (internal) auth = internal;
    else {
      const h = c.req.header('authorization');
      if (!h) throw E.missingApiKey();
      const m = /^Bearer\s+(.+)$/i.exec(h.trim());
      if (!m || !m[1]!.trim()) throw E.invalidApiKey(400);
      const r = await verifyApiKey(ctx.sql, m[1]!.trim());
      if (r.status === 'malformed') throw E.invalidApiKey(400);
      if (r.status === 'unknown') throw E.invalidApiKey(route.sending ? 401 : 400);
      auth = r.auth;
    }
    c.set('auth', auth);

    if (auth.permission === 'sending_access' && !route.sending) throw E.restricted();

    if (!internal) {
      const rl = limiter.hit(auth.team.id, auth.team.rate_limit);
      const setRl = () => {
        c.header('ratelimit-limit', String(rl.limit));
        c.header('ratelimit-policy', `${rl.limit};w=1`);
        c.header('ratelimit-remaining', String(rl.remaining));
        c.header('ratelimit-reset', String(rl.resetSec));
      };
      if (!rl.allowed) {
        setRl();
        throw E.rateLimited(rl.resetSec);
      }
      try {
        await next();
      } finally {
        setRl();
      }
    } else {
      await next();
    }
  });

  // Request log (after the response is final). Dashboard-originated calls are not logged, like Resend.
  app.use('*', async (c, next) => {
    await next();
    const env = c.env as InternalBindings | undefined;
    const auth = c.get('auth');
    if (env?.dashboardAuth || !auth) return;
    void writeLog(ctx, c, auth).catch((e) => ctx.log('api', 'log write failed', { error: (e as Error).message }));
  });

  registerEmailRoutes(router);
  registerDomainRoutes(router);
  registerApiKeyRoutes(router);
  registerWebhookRoutes(router);
  registerContactRoutes(router);
  registerBroadcastRoutes(router);
  registerTemplateRoutes(router);
  registerAutomationRoutes(router);
  registerInboxRoutes(router);
  registerMiscRoutes(router);

  const pages = registerPublicPages(ctx);
  return { app, router, pages, limiter };
}

export async function writeLog(ctx: AppContext, c: Context<ApiEnv>, auth: AuthContext, source = 'api') {
  let responseBody: unknown = null;
  try {
    const ct = c.res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) responseBody = await c.res.clone().json();
  } catch {
    responseBody = null;
  }
  const url = new URL(c.req.url);
  const endpoint = url.pathname.replace(/^\/v(?=\/)/, '') + url.search;
  const reqBody = c.get('requestBody');
  await ctx.sql`
    insert into api_logs (team_id, api_key_id, source, method, endpoint, response_status, user_agent, ip, request_body, response_body, duration_ms)
    values (${auth.team.id}, ${auth.apiKeyId}, ${source}, ${c.req.method}, ${endpoint}, ${c.res.status}, ${c.req.header('user-agent') ?? null},
            ${clientIp(ctx, c)}, ${reqBody === undefined ? null : ctx.sql.json(redact(reqBody) as never)},
            ${responseBody === null ? null : ctx.sql.json(redact(responseBody) as never)}, ${Date.now() - (c.get('startedAt') ?? Date.now())})`;
}

export function clientIp(ctx: AppContext, c: Context): string | null {
  if (ctx.config.trustProxy) {
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf.trim();
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',').at(-1)!.trim();
  }
  const env = c.env as InternalBindings | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}
