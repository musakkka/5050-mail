/**
 * /api/admin/dns/check?domain= — "Verify" for domains whose DNS is managed by
 * hand (no Cloudflare needed): resolves the records Stalwart wants for the domain
 * (MX, SPF, DKIM, DMARC, TLS-RPT) in public DNS and reports each one.
 */
import { Resolver } from 'node:dns/promises';
import { Hono } from 'hono';
import { adminGuard, stalwartRecordSpecs, type AdminCloudflareDeps, type AdminCloudflareEnv } from './adminCloudflare.js';
import { normalizeDomain, txtValue, type RecordSpec } from './cloudflare.js';

export interface DnsLookup {
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  txt(name: string): Promise<string[][]>;
}

export interface DnsCheck extends RecordSpec {
  present: boolean;
  /** What public DNS returned for this name and type. */
  found: string[];
}

const host = (h: string) => h.trim().toLowerCase().replace(/\.$/, '');
const tag = (v: string) => /^v=([a-z0-9]+)/i.exec(v)?.[1]?.toLowerCase();

export function systemLookup(servers = process.env.DNS_SERVERS?.split(',').filter(Boolean)): DnsLookup {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  if (servers?.length) r.setServers(servers);
  const empty = (e: unknown) => {
    const code = (e as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
    throw e;
  };
  return { mx: (n) => r.resolveMx(n).catch(empty), txt: (n) => r.resolveTxt(n).catch(empty) };
}

export async function checkDns(lookup: DnsLookup, specs: RecordSpec[]): Promise<DnsCheck[]> {
  return Promise.all(
    specs.map(async (s): Promise<DnsCheck> => {
      if (s.type === 'MX') {
        const mx = await lookup.mx(s.name);
        return { ...s, present: mx.some((m) => host(m.exchange) === host(s.content)), found: mx.map((m) => `${m.priority} ${host(m.exchange)}`) };
      }
      const txt = (await lookup.txt(s.name)).map((chunks) => chunks.join(''));
      const want = txtValue(s.content);
      const t = tag(want);
      // DMARC and TLS-RPT: any policy counts (the owner may already publish their own).
      const present =
        txt.some((v) => txtValue(v).replace(/\s+/g, '') === want.replace(/\s+/g, '')) ||
        ((t === 'dmarc1' || t === 'tlsrptv1') && txt.some((v) => tag(v) === t));
      return { ...s, present, found: txt };
    }),
  );
}

export function adminDnsRoutes(deps: Omit<AdminCloudflareDeps, 'service'> & { lookup?: DnsLookup }): Hono<AdminCloudflareEnv> {
  const app = new Hono<AdminCloudflareEnv>();
  const lookup = deps.lookup ?? systemLookup();
  app.use('*', adminGuard(deps, 'dns'));
  app.get('/check', async (c) => {
    const domain = normalizeDomain(c.req.query('domain'));
    if (!domain) return c.json({ error: 'bad_request', message: 'Enter a valid domain name' }, 400);
    try {
      const specs = await stalwartRecordSpecs(deps, c.get('session'), c.get('admin'), domain, { allKinds: true });
      if (!specs) return c.json({ error: 'domain_not_found', message: `${domain} isn't a domain on this mail server. Add it first.` }, 404);
      const records = await checkDns(lookup, specs);
      return c.json({ domain, ok: records.length > 0 && records.every((r) => r.present), records });
    } catch (e) {
      console.error('[dns] check failed', (e as Error).message);
      return c.json({ error: 'dns', message: `DNS lookup failed: ${(e as Error).message}` }, 502);
    }
  });
  app.all('*', (c) => c.json({ error: 'not_found' }, 404));
  return app;
}
