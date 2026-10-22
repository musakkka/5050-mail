import type { Context, Hono } from 'hono';
import type { AppContext } from '../context.js';
import type { AuthContext } from '../services/apiKeys.js';
import { E } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';

export type ApiEnv = {
  Variables: {
    auth: AuthContext;
    requestBody: unknown;
    rawBody: string | null;
    startedAt: number;
  };
  Bindings: { incoming?: { socket?: { remoteAddress?: string } } };
};

export type Handler = (c: Context<ApiEnv>, ctx: AppContext) => Promise<Response> | Response;

export interface RouteDef {
  method: string;
  path: string;
  re: RegExp;
  /** sending_access keys may call this route. */
  sending: boolean;
}

/** Hono wrapper that remembers routes (for 405 detection and sending_access rules). */
export class Router {
  readonly routes: RouteDef[] = [];
  constructor(
    readonly app: Hono<ApiEnv>,
    readonly ctx: AppContext,
  ) {}

  private add(method: string, path: string, h: Handler, opts: { sending?: boolean } = {}) {
    const re = new RegExp('^' + path.replace(/:[A-Za-z_]+/g, '[^/]+') + '/?$');
    this.routes.push({ method, path, re, sending: !!opts.sending });
    const fn = (c: Context<ApiEnv>) => h(c, this.ctx);
    if (method === 'GET') this.app.get(path, fn);
    else if (method === 'POST') this.app.post(path, fn);
    else if (method === 'PATCH') this.app.patch(path, fn);
    else if (method === 'PUT') this.app.put(path, fn);
    else if (method === 'DELETE') this.app.delete(path, fn);
  }
  get(p: string, h: Handler, o?: { sending?: boolean }) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: { sending?: boolean }) { this.add('POST', p, h, o); }
  patch(p: string, h: Handler, o?: { sending?: boolean }) { this.add('PATCH', p, h, o); }
  put(p: string, h: Handler, o?: { sending?: boolean }) { this.add('PUT', p, h, o); }
  delete(p: string, h: Handler, o?: { sending?: boolean }) { this.add('DELETE', p, h, o); }

  match(method: string, path: string): { route?: RouteDef; pathExists: boolean } {
    const m = method === 'HEAD' ? 'GET' : method;
    const same = this.routes.filter((r) => r.re.test(path));
    return { route: same.find((r) => r.method === m), pathExists: same.length > 0 };
  }
}

/** Parsed JSON body (set by the body middleware); `{}` when the request had none. */
export function body<T = Record<string, unknown>>(c: Context<ApiEnv>): T {
  return (c.get('requestBody') ?? {}) as T;
}

export function query(c: Context<ApiEnv>): Record<string, string | undefined> {
  return c.req.query() as Record<string, string | undefined>;
}

/** Path parameter that must be a UUID (Resend: 422 invalid_parameter … must be a valid UUID). */
export function uuidParam(c: Context<ApiEnv>, name: string, label = name): string {
  const v = c.req.param(name);
  if (!v || !isUuid(v)) throw E.invalidUuid(label);
  return v.toLowerCase();
}

export const param = (c: Context<ApiEnv>, name: string): string => c.req.param(name) ?? '';

export const teamId = (c: Context<ApiEnv>) => c.get('auth').team.id;
