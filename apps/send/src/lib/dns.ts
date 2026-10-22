import { Resolver } from 'node:dns/promises';

/** The DNS lookups domain verification needs (injectable for tests). */
export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  cname(name: string): Promise<string[]>;
}

const empty = (e: unknown) => {
  const code = (e as { code?: string }).code;
  if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN' || code === 'ESERVFAIL') return true;
  throw e;
};

export function systemResolver(servers?: string[]): DnsResolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (servers?.length) r.setServers(servers);
  return {
    txt: async (n) => (await r.resolveTxt(n).catch((e) => (empty(e) ? [] : []))).map((chunks) => chunks.join('')),
    mx: async (n) => await r.resolveMx(n).catch((e) => (empty(e) ? [] : [])),
    cname: async (n) => await r.resolveCname(n).catch((e) => (empty(e) ? [] : [])),
  };
}

/** In-memory DNS for tests. Keys are lower-case FQDNs. */
export class FakeDns implements DnsResolver {
  records = new Map<string, { txt?: string[]; mx?: { exchange: string; priority: number }[]; cname?: string[] }>();
  set(name: string, rec: { txt?: string[]; mx?: { exchange: string; priority: number }[]; cname?: string[] }) {
    this.records.set(name.toLowerCase(), { ...this.records.get(name.toLowerCase()), ...rec });
  }
  async txt(n: string) {
    return this.records.get(n.toLowerCase())?.txt ?? [];
  }
  async mx(n: string) {
    return this.records.get(n.toLowerCase())?.mx ?? [];
  }
  async cname(n: string) {
    return this.records.get(n.toLowerCase())?.cname ?? [];
  }
}
