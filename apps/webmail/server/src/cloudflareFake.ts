/**
 * In-memory stand-in for the slice of the Cloudflare API that cloudflare.ts uses.
 * Used by the unit tests and, with CLOUDFLARE_FAKE=1, by local e2e runs, so the
 * one-click flow can be exercised without a real account. Refused in production
 * (see config.ts).
 */
import type { CfDnsRecord, SendingSubdomain } from './cloudflare.js';

export interface FakeZone {
  id: string;
  name: string;
  records: (CfDnsRecord & { id: string })[];
  subdomains: SendingSubdomain[];
}

export interface FakeCloudflareState {
  zones: FakeZone[];
  /** Every request made, for assertions ("METHOD /path?query"). */
  calls: string[];
  /** Return this HTTP status for matching requests (key: "METHOD /path-prefix"). */
  failures: Map<string, number>;
  /** Real Cloudflare may add the cf-bounce records itself on onboarding; off by default. */
  autoCreateRecords: boolean;
}

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(32, '0');

export function fakeState(zoneNames: string[], over: Partial<FakeCloudflareState> = {}): FakeCloudflareState {
  return {
    zones: zoneNames.map((name) => ({ id: nextId(), name, records: [], subdomains: [] })),
    calls: [],
    failures: new Map(),
    autoCreateRecords: false,
    ...over,
  };
}

/** The records Cloudflare asks for when a domain is onboarded for Email Sending. */
export function bounceRecordsFor(domain: string): CfDnsRecord[] {
  const rp = `cf-bounce.${domain}`;
  return [
    { type: 'MX', name: rp, content: 'route1.mx.cloudflare.net', priority: 47 },
    { type: 'MX', name: rp, content: 'route2.mx.cloudflare.net', priority: 6 },
    { type: 'MX', name: rp, content: 'route3.mx.cloudflare.net', priority: 99 },
    { type: 'TXT', name: rp, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
    { type: 'TXT', name: `cf-bounce._domainkey.${domain}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AFAKEFAKEFAKE"' },
  ];
}

const ok = (result: unknown, info?: Record<string, number>) =>
  Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

export function fakeCloudflareFetch(state: FakeCloudflareState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    state.calls.push(`${req.method} ${path}${url.search}`);
    if (!/^Bearer \S+$/.test(req.headers.get('authorization') ?? '')) return fail(401, 10000, 'Authentication error');
    for (const [key, status] of state.failures) {
      const [m, p] = key.split(' ');
      if (m === req.method && path.startsWith(p!)) return fail(status, 1001, 'Injected failure');
    }
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

    if (path === '/zones' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      if (name) return ok(state.zones.filter((z) => z.name === name).map(({ id, name }) => ({ id, name })));
      const perPage = Number(url.searchParams.get('per_page') ?? 20);
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = state.zones.map(({ id, name }) => ({ id, name }));
      return ok(all.slice((page - 1) * perPage, page * perPage), {
        page,
        per_page: perPage,
        total_count: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
      });
    }

    const m = /^\/zones\/([^/]+)\/(.*)$/.exec(path);
    const zone = m && state.zones.find((z) => z.id === m[1]);
    if (!m || !zone) return fail(404, 7003, 'Could not route to /zones');
    const rest = m[2]!;

    if (rest === 'email/sending/subdomains') {
      if (req.method === 'GET') return ok(zone.subdomains);
      const name = String(body.name ?? '').toLowerCase();
      if (name !== zone.name && !name.endsWith(`.${zone.name}`)) return fail(400, 1004, 'Name is not within the zone');
      let sub = zone.subdomains.find((s) => s.name === name);
      if (sub) sub.enabled = true;
      else {
        sub = { tag: nextId(), name, enabled: true, return_path_domain: `cf-bounce.${name}`, dkim_selector: 'cf-bounce' };
        zone.subdomains.push(sub);
        if (state.autoCreateRecords) for (const r of bounceRecordsFor(name)) zone.records.push({ ...r, id: nextId() });
      }
      return ok(sub);
    }
    const dns = /^email\/sending\/subdomains\/([^/]+)\/dns$/.exec(rest);
    if (dns && req.method === 'GET') {
      const sub = zone.subdomains.find((s) => s.tag === dns[1]);
      return sub ? ok(bounceRecordsFor(sub.name)) : fail(404, 1002, 'Subdomain not found');
    }
    if (rest === 'dns_records') {
      if (req.method === 'GET') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        return ok(zone.records.filter((r) => (!name || r.name === name) && (!type || r.type === type)));
      }
      const rec = {
        id: nextId(),
        type: String(body.type),
        name: String(body.name).toLowerCase(),
        content: String(body.content),
        ...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
      };
      if (zone.records.some((r) => r.type === rec.type && r.name === rec.name && r.content === rec.content))
        return fail(400, 81058, 'An identical record already exists.');
      zone.records.push(rec);
      return ok(rec);
    }
    return fail(404, 7003, 'Could not route');
  }) as typeof fetch;
}
