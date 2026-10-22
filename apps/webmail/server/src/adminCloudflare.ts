/**
 * /api/admin/cloudflare/* — one-click domain setup. Every request re-checks that
 * the signed-in user is a Stalwart admin (reads use a per-session cache of at most
 * 60 s; writes always re-check), and only acts on domains that already exist in
 * Stalwart and that the caller can manage. CSRF / Origin checks come from the
 * /api/* csrfGuard in app.ts.
 */
import { Hono, type Context } from 'hono';
import type { Session } from './sessions.js';
import { detectAdmin, fetchSession, jmapCall, type FetchFn } from './stalwart.js';
import { CloudflareError, normalizeDomain, stalwartRecords, type CloudflareService, type RecordSpec } from './cloudflare.js';

export interface AdminCloudflareDeps {
  /** null when CLOUDFLARE_API_TOKEN is unset: the routes answer 404 not_configured. */
  service: CloudflareService | null;
  loadSession: (c: Context) => Promise<Session | undefined>;
  fetch: FetchFn;
  stalwartUrl: string;
  now?: () => number;
}

const ADMIN_TTL_MS = 60_000;
const MAIN_KINDS = ['mx', 'dkim', 'spf', 'dmarc', 'tlsRpt'];

export interface AdminInfo {
  at: number;
  isAdmin: boolean;
  accountId?: string;
}

export type AdminCloudflareEnv = { Variables: { session: Session; admin: AdminInfo } };

/**
 * Admin-only middleware shared by the /api/admin/* routers: loads the session and
 * re-checks with Stalwart that the user is an admin (reads use a per-session cache
 * of at most 60 s; writes always re-check).
 */
export function adminGuard(deps: Pick<AdminCloudflareDeps, 'loadSession' | 'fetch' | 'stalwartUrl' | 'now'>, scope = 'admin') {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, AdminInfo>();
  const checkAdmin = async (s: Session, fresh: boolean): Promise<AdminInfo | null> => {
    const hit = cache.get(s.id);
    if (!fresh && hit && now() - hit.at < ADMIN_TTL_MS) return hit;
    const upstream = await fetchSession(deps.fetch, deps.stalwartUrl, s.authorization);
    if (!upstream) return null;
    const isAdmin = await detectAdmin(deps.fetch, deps.stalwartUrl, s.authorization, upstream);
    const info: AdminInfo = { at: now(), isAdmin, accountId: upstream.primaryAccounts['urn:stalwart:jmap'] };
    for (const [k, v] of cache) if (now() - v.at >= ADMIN_TTL_MS) cache.delete(k);
    cache.set(s.id, info);
    return info;
  };
  return async (c: Context<AdminCloudflareEnv>, next: () => Promise<void>): Promise<Response | void> => {
    const s = await deps.loadSession(c);
    if (!s) return c.json({ error: 'unauthenticated' }, 401);
    let info: AdminInfo | null;
    try {
      info = await checkAdmin(s, c.req.method !== 'GET' && c.req.method !== 'HEAD');
    } catch (e) {
      console.error(`[${scope}] admin check failed`, (e as Error).message);
      return c.json({ error: 'upstream', message: 'Mail server unavailable' }, 502);
    }
    if (!info) return c.json({ error: 'unauthenticated' }, 401);
    if (!info.isAdmin) return c.json({ error: 'forbidden', message: 'Administrators only' }, 403);
    c.set('session', s);
    c.set('admin', info);
    await next();
  };
}

/**
 * The MX/TXT records Stalwart wants for this domain, or null when it isn't a Stalwart domain the
 * caller can see (x:Domain/get is scoped to what the admin manages). Throws on upstream errors.
 * `allKinds`: every main record kind, even those Stalwart publishes itself.
 */
export async function stalwartRecordSpecs(
  deps: Pick<AdminCloudflareDeps, 'fetch' | 'stalwartUrl'>,
  s: Session,
  info: AdminInfo,
  domain: string,
  opts: { allKinds?: boolean } = {},
): Promise<RecordSpec[] | null> {
  const r = await jmapCall(
    deps.fetch,
    deps.stalwartUrl,
    s.authorization,
    ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
    [
      ['x:Domain/query', { ...(info.accountId ? { accountId: info.accountId } : {}) }, 'q'],
      [
        'x:Domain/get',
        {
          ...(info.accountId ? { accountId: info.accountId } : {}),
          '#ids': { resultOf: 'q', name: 'x:Domain/query', path: '/ids' },
          properties: ['name', 'dnsZoneFile', 'dnsManagement'],
        },
        'g',
      ],
    ],
  );
  const res = r?.methodResponses?.[1];
  if (!res || res[0] !== 'x:Domain/get') throw new Error('x:Domain/get failed');
  const list = (res[1].list ?? []) as {
    name: string;
    dnsZoneFile?: string;
    dnsManagement?: { '@type': string; publishRecords?: Record<string, boolean> };
  }[];
  const d = list.find((x) => x.name.toLowerCase() === domain);
  if (!d) return null;
  const kinds =
    !opts.allKinds && d.dnsManagement?.['@type'] === 'Automatic' ? MAIN_KINDS.filter((k) => d.dnsManagement?.publishRecords?.[k]) : MAIN_KINDS;
  return stalwartRecords(d.dnsZoneFile, new Set(kinds));
}

export function adminCloudflareRoutes(deps: AdminCloudflareDeps): Hono<AdminCloudflareEnv> {
  const app = new Hono<AdminCloudflareEnv>();
  const guard = adminGuard(deps, 'cloudflare');
  app.use('*', async (c, next) => {
    let passed = false;
    const res = await guard(c, async () => {
      passed = true;
    });
    if (!passed) return res as Response;
    if (!deps.service) return c.json({ error: 'not_configured', message: 'Cloudflare is not configured on this server' }, 404);
    await next();
  });

  const stalwartSpecs = (s: Session, info: AdminInfo, domain: string) => stalwartRecordSpecs(deps, s, info, domain);

  const notManaged = (c: Context, domain: string) =>
    c.json({ error: 'domain_not_found', message: `${domain} isn't a domain on this mail server. Add it first.` }, 404);

  const fail = (c: Context, e: unknown) => {
    if (e instanceof CloudflareError) {
      console.error('[cloudflare]', e.message);
      const status = e.status === 409 ? 409 : 502;
      return c.json({ error: status === 409 ? 'busy' : 'cloudflare', message: e.message }, status);
    }
    console.error('[cloudflare] unexpected', (e as Error).message);
    return c.json({ error: 'internal', message: 'Something went wrong' }, 500);
  };

  app.get('/zones', async (c) => {
    try {
      return c.json({ zones: await deps.service!.zoneNames() });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/domain-status', async (c) => {
    const domain = normalizeDomain(c.req.query('domain'));
    if (!domain) return c.json({ error: 'bad_request', message: 'Enter a valid domain name' }, 400);
    try {
      const specs = await stalwartSpecs(c.get('session'), c.get('admin'), domain);
      if (!specs) return notManaged(c, domain);
      return c.json(await deps.service!.status(domain, specs));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/connect', async (c) => {
    let body: { domain?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    const domain = normalizeDomain(body.domain);
    if (!domain) return c.json({ error: 'bad_request', message: 'Enter a valid domain name' }, 400);
    const s = c.get('session');
    try {
      const specs = await stalwartSpecs(s, c.get('admin'), domain);
      if (!specs) return notManaged(c, domain);
      const result = await deps.service!.connect(domain, s.email, specs);
      if (!result.zone) return c.json({ error: 'zone_not_found', message: `${domain} isn't in this Cloudflare account`, ...result }, 404);
      return c.json(result);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.all('*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}
