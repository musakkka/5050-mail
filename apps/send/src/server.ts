/**
 * One process, two surfaces chosen by Host:
 *   API_HOST        → public Resend-compatible API at the root (+ tracking/unsubscribe pages)
 *   DASHBOARD_HOST  → dashboard placeholder + /api/internal/* (session cookie)
 * Locally, /v/* always reaches the public API (RESEND_BASE_URL=http://localhost:3000/v).
 */
import { Hono } from 'hono';
import type { AppContext } from './context.js';
import { createPublicApi, type InternalBindings, type PublicApi } from './api/app.js';
import { createDashboardApp } from './internal/app.js';

export interface ServerApp {
  app: Hono;
  api: PublicApi;
}

export function createServerApp(ctx: AppContext): ServerApp {
  const api = createPublicApi(ctx);
  const dashboard = createDashboardApp(ctx, api);
  const root = new Hono();

  root.get('/health', async (c) => {
    try {
      await ctx.sql`select 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forward = async (target: { fetch: (r: Request, env?: any) => Response | Promise<Response> }, req: Request, env: unknown, strip?: string) => {
    if (!strip) return target.fetch(req, env);
    const u = new URL(req.url);
    u.pathname = u.pathname.slice(strip.length) || '/';
    return target.fetch(new Request(u, req), env);
  };

  root.all('*', async (c) => {
    const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    const hostWithPort = (c.req.header('host') ?? '').toLowerCase();
    const path = c.req.path;
    const env = c.env as InternalBindings;
    const isApiHost = host === ctx.config.apiHost || hostWithPort === ctx.config.apiHost;
    const isDashHost = host === ctx.config.dashboardHost || hostWithPort === ctx.config.dashboardHost;
    const surface = isApiHost ? 'api' : isDashHost ? 'dashboard' : path === '/v' || path.startsWith('/v/') ? 'api-prefixed' : ctx.config.defaultSurface;
    // Never let a request smuggle in a dashboard identity.
    const safeEnv: InternalBindings = { incoming: env?.incoming };
    if (surface === 'api' || surface === 'api-prefixed') {
      const strip = surface === 'api-prefixed' ? '/v' : undefined;
      const sub = strip ? path.slice(2) || '/' : path;
      const pageMatch = /^\/(t\/[oc]\/|unsubscribe\/|attachments\/|receiving\/raw\/|inbound$)/.test(sub);
      return forward(pageMatch ? api.pages : api.app, c.req.raw, safeEnv, strip);
    }
    if (surface === 'dashboard') return forward(dashboard, c.req.raw, safeEnv);
    return c.json({ statusCode: 404, message: 'The requested endpoint does not exist.', name: 'not_found' }, 404);
  });

  return { app: root, api };
}
