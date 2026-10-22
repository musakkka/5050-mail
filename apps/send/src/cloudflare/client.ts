/**
 * Copied from web/server/src/cloudflare.ts (the webmail BFF's one-click setup) so
 * 5050 Send does not import across packages; send-raw and GraphQL were added below.
 *
 * Cloudflare side of "one-click domain setup" (admin only).
 *
 * Stalwart publishes a domain's own records (MX, DKIM, SPF, DMARC, TLS-RPT) to
 * Cloudflare through its DnsServer. What it can't do is onboard the domain for
 * Cloudflare Email Sending, which our outbound relay requires: without it the
 * relay answers `550 5.7.1 Not authorized to send from domain X`. This module
 * does that part with the Cloudflare API, using a token that never leaves the BFF.
 *
 * Endpoints used (https://developers.cloudflare.com/api/resources/email_sending/):
 *   GET  /zones?name=<candidate>[&account.id=]                         find the zone (walks up the labels, like wrangler)
 *   GET  /zones?page=&per_page=50[&account.id=]                        zone names for the picker
 *   GET  /zones/{zone}/email/sending/subdomains                        onboarded sending domains ({name, tag, enabled, …})
 *   POST /zones/{zone}/email/sending/subdomains  {"name": "<domain>"}  onboard, or re-enable a disabled one
 *   GET  /zones/{zone}/email/sending/subdomains/{tag}/dns              records Cloudflare needs (cf-bounce MX/SPF, DKIM)
 *   GET  /zones/{zone}/dns_records?name=<fqdn>&per_page=100            what the zone actually has
 *   POST /zones/{zone}/dns_records  {type,name,content,priority?,ttl:1,comment}   add a missing cf-bounce record
 *
 * There is no "apply records" endpoint for Email Sending (the dns sub-resource
 * is read-only), so missing records are created through the regular DNS API.
 *
 * Domains whose DNS is not in this Cloudflare account can't be connected here.
 * TODO(domain-connect): Domain Connect (what Railway uses for "connect
 * Cloudflare") would let us write records into *another* account's zone, but it
 * requires Cloudflare to approve a service template for us first.
 */

export type FetchFn = typeof fetch;

/** Lower-case hostname, ≤253 chars, LDH labels of 1–63, at least two labels, alphabetic TLD. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalised domain, or null when the input isn't a plain hostname. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  return HOSTNAME_RE.test(d) ? d : null;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

export interface Zone {
  id: string;
  name: string;
}

export interface SendingSubdomain {
  /** Not documented, but some responses carry it; `tag` is the documented identifier. */
  id?: string;
  tag: string;
  name: string;
  enabled: boolean;
  return_path_domain?: string;
  dkim_selector?: string;
}

export interface CfDnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
}

/** A record we expect to find in the zone. */
export interface RecordSpec {
  type: string;
  /** Fully-qualified, lower case, no trailing dot. */
  name: string;
  content: string;
  priority?: number;
  /** For Stalwart records: which publishRecords switch covers it. */
  kind?: string;
}

export interface RecordCheck extends RecordSpec {
  present: boolean;
  /** Another record of the same kind is in the way (e.g. a different SPF). */
  conflict?: string;
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
}

const API = 'https://api.cloudflare.com/client/v4';

/** Thin typed client over the Cloudflare v4 API. */
export class CloudflareClient {
  private base: string;
  constructor(
    private opts: { token: string; accountId?: string; fetch?: FetchFn; baseUrl?: string; timeoutMs?: number },
  ) {
    this.base = (opts.baseUrl ?? API).replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new CloudflareError(`Cloudflare unreachable: ${(e as Error).message}`, 502);
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.success) {
      const err = json?.errors?.[0];
      throw new CloudflareError(err ? `${err.message} (${err.code})` : `Cloudflare returned ${res.status}`, res.status || 502, err?.code);
    }
    return json;
  }

  private accountParam(): string {
    return this.opts.accountId ? `&account.id=${encodeURIComponent(this.opts.accountId)}` : '';
  }

  async listZones(): Promise<Zone[]> {
    const out: Zone[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await this.call<Zone[]>('GET', `/zones?page=${page}&per_page=50${this.accountParam()}`);
      out.push(...r.result.map((z) => ({ id: z.id, name: z.name })));
      if (page >= (r.result_info?.total_pages ?? 1)) break;
    }
    return out;
  }

  async zoneByName(name: string): Promise<Zone | null> {
    const r = await this.call<Zone[]>('GET', `/zones?name=${encodeURIComponent(name)}${this.accountParam()}`);
    const z = r.result.find((x) => x.name.toLowerCase() === name);
    return z ? { id: z.id, name: z.name } : null;
  }

  /** The zone that contains `domain`: the domain itself, else the closest parent the token can see. */
  async findZone(domain: string): Promise<Zone | null> {
    const labels = domain.split('.');
    for (let i = 0; i <= labels.length - 2; i++) {
      const z = await this.zoneByName(labels.slice(i).join('.'));
      if (z) return z;
    }
    return null;
  }

  async listSendingSubdomains(zoneId: string): Promise<SendingSubdomain[]> {
    return (await this.call<SendingSubdomain[]>('GET', `/zones/${zoneId}/email/sending/subdomains`)).result ?? [];
  }

  async createSendingSubdomain(zoneId: string, name: string): Promise<SendingSubdomain> {
    return (await this.call<SendingSubdomain>('POST', `/zones/${zoneId}/email/sending/subdomains`, { name })).result;
  }

  async sendingDns(zoneId: string, subdomainId: string): Promise<CfDnsRecord[]> {
    return (await this.call<CfDnsRecord[]>('GET', `/zones/${zoneId}/email/sending/subdomains/${encodeURIComponent(subdomainId)}/dns`)).result ?? [];
  }

  async dnsRecordsByName(zoneId: string, fqdn: string): Promise<CfDnsRecord[]> {
    return (await this.call<CfDnsRecord[]>('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(fqdn)}&per_page=100`)).result ?? [];
  }

  async createDnsRecord(zoneId: string, r: RecordSpec, comment: string): Promise<CfDnsRecord> {
    return (
      await this.call<CfDnsRecord>('POST', `/zones/${zoneId}/dns_records`, {
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: 1,
        ...(r.priority !== undefined ? { priority: r.priority } : {}),
        comment,
      })
    ).result;
  }

  // ---- 5050 Send additions (not in the webmail copy) ----

  /** DELETE /zones/{zone}/dns_records/{id} (ACME DNS-01 cleanup). */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call<unknown>('DELETE', `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`);
  }

  get accountId(): string | undefined {
    return this.opts.accountId;
  }

  /** Zone activation status (`active`, `pending`, …); the fake has none and counts as active. */
  async zoneStatus(zoneId: string): Promise<string> {
    const r = await this.call<{ status?: string }>('GET', `/zones/${zoneId}`);
    return r.result?.status ?? 'active';
  }

  /** Add a zone to the account (opt-in, CLOUDFLARE_CREATE_ZONES): it stays `pending` until NS move, but Email Sending can onboard it. */
  async createZone(name: string): Promise<Zone> {
    if (!this.opts.accountId) throw new CloudflareError('CLOUDFLARE_ACCOUNT_ID is not set', 500);
    const r = await this.call<Zone>('POST', '/zones', { name, account: { id: this.opts.accountId }, type: 'full' });
    return { id: r.result.id, name: r.result.name };
  }

  /** POST /accounts/{account_id}/email/sending/send_raw — full MIME plus SMTP envelope. */
  async sendRaw(body: { from: string; recipients: string[]; mime_message: string }): Promise<SendRawResult> {
    if (!this.opts.accountId) throw new CloudflareError('CLOUDFLARE_ACCOUNT_ID is not set', 500);
    return (await this.call<SendRawResult>('POST', `/accounts/${encodeURIComponent(this.opts.accountId)}/email/sending/send_raw`, body)).result;
  }

  /** GraphQL Analytics API. Returns data + errors without throwing on GraphQL-level errors. */
  async graphql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: { message: string; extensions?: Record<string, unknown> }[] }> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new CloudflareError(`Cloudflare unreachable: ${(e as Error).message}`, 502);
    }
    const json = (await res.json().catch(() => null)) as { data?: T | null; errors?: { message: string }[] | null } | null;
    if (!json) throw new CloudflareError(`Cloudflare GraphQL returned ${res.status}`, res.status || 502);
    return { data: json.data ?? null, errors: json.errors ?? [] };
  }
}

export interface SendRawResult {
  delivered: string[];
  message_id?: string;
  permanent_bounces: string[];
  queued: string[];
  suppressed_recipients?: string[];
}

// ------------------------------------------------------------------ record matching

const fqdn = (name: string, zone: string): string => {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  const z = zone.toLowerCase();
  if (n === '@' || n === '') return z;
  return n === z || n.endsWith(`.${z}`) ? n : `${n}.${z}`;
};

/** TXT content as one string: joins `"a" "b"` chunks, strips quotes. */
export function txtValue(content: string): string {
  const s = content.trim();
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
  return (parts.length ? parts.join('') : s).replace(/\s+/g, ' ').trim();
}

const hostValue = (content: string) => content.trim().toLowerCase().replace(/\.$/, '');

function sameValue(type: string, a: string, b: string): boolean {
  return type === 'TXT' ? txtValue(a) === txtValue(b) : hostValue(a) === hostValue(b);
}

/** "v=spf1 …" → "spf1"; used to spot a different record of the same kind at the same name. */
const txtTag = (v: string) => /^v=([a-z0-9]+)/i.exec(txtValue(v))?.[1]?.toLowerCase();

/** Compare what we need against what the zone has (one lookup per distinct name). */
export async function checkRecords(cf: CloudflareClient, zone: Zone, specs: RecordSpec[]): Promise<RecordCheck[]> {
  const names = [...new Set(specs.map((s) => s.name))];
  const existing = new Map<string, CfDnsRecord[]>();
  await Promise.all(names.map(async (n) => existing.set(n, await cf.dnsRecordsByName(zone.id, n))));
  return specs.map((s) => {
    const have = (existing.get(s.name) ?? []).filter((r) => r.type === s.type);
    let present = have.some((r) => sameValue(s.type, r.content, s.content));
    let conflict: string | undefined;
    if (!present && s.type === 'TXT') {
      const tag = txtTag(s.content);
      const other = tag ? have.find((r) => txtTag(r.content) === tag) : undefined;
      // A name holds one DMARC policy, and any policy satisfies Email Sending: keep the one
      // already there (e.g. Stalwart's, published moments earlier by the same one click).
      if (tag === 'dmarc1' && other) present = true;
      else if (tag && other) conflict = `A different ${tag.toUpperCase()} record already exists: ${txtValue(other.content)}`;
    }
    return { ...s, present, ...(conflict ? { conflict } : {}) };
  });
}

// ------------------------------------------------------------------ Stalwart's records

/** MX/TXT records Stalwart wants for the domain, from its `dnsZoneFile` (BIND format, absolute names). */
export function stalwartRecords(zoneFile: string | null | undefined, kinds?: Set<string>): RecordSpec[] {
  if (!zoneFile) return [];
  // Join "( … )" continuations into one logical line.
  const lines: string[] = [];
  let buf = '';
  let depth = 0;
  for (const raw of zoneFile.split(/\r?\n/)) {
    const line = raw.replace(/;[^"]*$/, '');
    if (!line.trim() && !depth) continue;
    const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '');
    depth += (bare.match(/\(/g)?.length ?? 0) - (bare.match(/\)/g)?.length ?? 0);
    buf += ` ${line.trim()}`;
    if (depth <= 0) {
      lines.push(buf.trim());
      buf = '';
      depth = 0;
    }
  }
  const out: RecordSpec[] = [];
  for (const l of lines) {
    const m = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?(MX|TXT)\s+(.*)$/.exec(l);
    if (!m) continue;
    const name = m[1]!.toLowerCase().replace(/\.$/, '');
    const type = m[2]!;
    let rdata = m[3]!.trim();
    let spec: RecordSpec;
    if (type === 'MX') {
      const [p, host] = rdata.split(/\s+/);
      spec = { type, name, content: hostValue(host ?? ''), priority: Number(p) };
    } else {
      rdata = rdata.replace(/^\(|\)$/g, '').trim();
      spec = { type, name, content: txtValue(rdata) };
    }
    const kind =
      type === 'MX'
        ? 'mx'
        : name.includes('._domainkey.')
          ? 'dkim'
          : name.startsWith('_dmarc.')
            ? 'dmarc'
            : name.startsWith('_smtp._tls.')
              ? 'tlsRpt'
              : /^v=spf1\b/i.test(spec.content)
                ? 'spf'
                : undefined;
    if (!kind || (kinds && !kinds.has(kind))) continue;
    out.push({ ...spec, kind });
  }
  return out;
}

// ------------------------------------------------------------------ service

export type StepStatus = 'ok' | 'created' | 'error' | 'skipped';
export interface StepResult {
  id: 'zone' | 'sending' | 'records' | 'verify';
  status: StepStatus;
  detail?: string;
}

export interface SendingStatus {
  onboarded: boolean;
  enabled: boolean;
  returnPath?: string;
}

export interface DomainCloudflareStatus {
  domain: string;
  zone: string | null;
  sending: SendingStatus;
  bounceRecords: RecordCheck[];
  stalwartRecords: RecordCheck[];
  /** Email Sending enabled and every cf-bounce record present. */
  sendingReady: boolean;
  error?: string;
}

export interface ConnectResult {
  domain: string;
  zone: string | null;
  ok: boolean;
  steps: StepResult[];
  status?: DomainCloudflareStatus;
}

const RECORD_COMMENT = 'Mail admin: Cloudflare Email Sending return path';

export class CloudflareService {
  private zoneCache: { at: number; zones: string[] } | null = null;
  private inFlight = new Set<string>();

  constructor(
    readonly cf: CloudflareClient,
    private log: (msg: string) => void = (m) => console.log(`[cloudflare] ${m}`),
    private now: () => number = Date.now,
  ) {}

  /** Zone names the token can see (cached for a minute). */
  async zoneNames(): Promise<string[]> {
    if (this.zoneCache && this.now() - this.zoneCache.at < 60_000) return this.zoneCache.zones;
    const zones = (await this.cf.listZones()).map((z) => z.name.toLowerCase()).sort();
    this.zoneCache = { at: this.now(), zones };
    return zones;
  }

  private async subdomain(zone: Zone, domain: string): Promise<SendingSubdomain | undefined> {
    return (await this.cf.listSendingSubdomains(zone.id)).find((s) => s.name.toLowerCase() === domain);
  }

  private async bounceSpecs(zone: Zone, sub: SendingSubdomain): Promise<RecordSpec[]> {
    const recs = await this.cf.sendingDns(zone.id, sub.id ?? sub.tag);
    return recs.map((r) => ({
      type: r.type,
      name: fqdn(r.name, zone.name),
      content: r.type === 'TXT' ? r.content : hostValue(r.content),
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    }));
  }

  async status(domain: string, stalwart: RecordSpec[] = []): Promise<DomainCloudflareStatus> {
    const zone = await this.cf.findZone(domain);
    const empty: DomainCloudflareStatus = {
      domain,
      zone: null,
      sending: { onboarded: false, enabled: false },
      bounceRecords: [],
      stalwartRecords: [],
      sendingReady: false,
    };
    if (!zone) return empty;
    const sub = await this.subdomain(zone, domain);
    const [bounceRecords, stalwartRecords] = await Promise.all([
      sub ? this.bounceSpecs(zone, sub).then((s) => checkRecords(this.cf, zone, s)) : Promise.resolve([]),
      checkRecords(this.cf, zone, stalwart),
    ]);
    const sending = { onboarded: !!sub, enabled: !!sub?.enabled, ...(sub?.return_path_domain ? { returnPath: sub.return_path_domain } : {}) };
    return {
      domain,
      zone: zone.name,
      sending,
      bounceRecords,
      stalwartRecords,
      sendingReady: sending.enabled && bounceRecords.length > 0 && bounceRecords.every((r) => r.present),
    };
  }

  /**
   * Idempotent: find the zone, onboard Email Sending if needed, add any missing
   * cf-bounce record (never one that conflicts with an existing record), read back.
   */
  async connect(domain: string, actor: string, stalwart: RecordSpec[] = []): Promise<ConnectResult> {
    if (this.inFlight.has(domain)) throw new CloudflareError('A connect for this domain is already running', 409);
    this.inFlight.add(domain);
    try {
      return await this.doConnect(domain, actor, stalwart);
    } finally {
      this.inFlight.delete(domain);
    }
  }

  private async doConnect(domain: string, actor: string, stalwart: RecordSpec[]): Promise<ConnectResult> {
    const steps: StepResult[] = [];
    const skip = (...ids: StepResult['id'][]) => ids.forEach((id) => steps.push({ id, status: 'skipped' }));
    const zone = await this.cf.findZone(domain);
    if (!zone) {
      steps.push({ id: 'zone', status: 'error', detail: `No zone for ${domain} in this Cloudflare account` });
      skip('sending', 'records', 'verify');
      this.log(`connect ${domain} by ${actor}: zone not found`);
      return { domain, zone: null, ok: false, steps };
    }
    steps.push({ id: 'zone', status: 'ok', detail: zone.name });

    let sub: SendingSubdomain | undefined;
    try {
      sub = await this.subdomain(zone, domain);
      if (sub?.enabled) steps.push({ id: 'sending', status: 'ok', detail: 'Already enabled' });
      else {
        const created = await this.cf.createSendingSubdomain(zone.id, domain);
        sub = { ...sub, ...created };
        steps.push({ id: 'sending', status: 'created', detail: sub.enabled ? 'Email Sending enabled' : 'Email Sending requested' });
        this.log(`connect ${domain} by ${actor}: email sending ${created.enabled ? 'enabled' : 'requested'} in zone ${zone.name}`);
      }
    } catch (e) {
      steps.push({ id: 'sending', status: 'error', detail: (e as Error).message });
      skip('records');
      this.log(`connect ${domain} by ${actor}: enabling email sending failed: ${(e as Error).message}`);
    }

    if (sub) {
      try {
        const checks = await checkRecords(this.cf, zone, await this.bounceSpecs(zone, sub));
        const missing = checks.filter((c) => !c.present && !c.conflict);
        const conflicts = checks.filter((c) => c.conflict);
        const failures: string[] = [];
        for (const r of missing) {
          try {
            await this.cf.createDnsRecord(zone.id, r, RECORD_COMMENT);
            this.log(`connect ${domain} by ${actor}: created ${r.type} ${r.name}`);
          } catch (e) {
            failures.push(`${r.type} ${r.name}: ${(e as Error).message}`);
          }
        }
        if (failures.length || conflicts.length) {
          const detail = [...failures, ...conflicts.map((c) => `${c.type} ${c.name}: ${c.conflict}`)].join('; ');
          steps.push({ id: 'records', status: 'error', detail });
          this.log(`connect ${domain} by ${actor}: records incomplete: ${detail}`);
        } else if (missing.length) steps.push({ id: 'records', status: 'created', detail: `Added ${missing.length} record${missing.length === 1 ? '' : 's'}` });
        else steps.push({ id: 'records', status: 'ok', detail: checks.length ? 'All records present' : 'No records required' });
      } catch (e) {
        steps.push({ id: 'records', status: 'error', detail: (e as Error).message });
        this.log(`connect ${domain} by ${actor}: reading records failed: ${(e as Error).message}`);
      }
    }

    let status: DomainCloudflareStatus | undefined;
    try {
      status = await this.status(domain, stalwart);
      steps.push(
        status.sendingReady
          ? { id: 'verify', status: 'ok' }
          : { id: 'verify', status: 'error', detail: status.sending.enabled ? 'Some sending records are still missing' : 'Email Sending is not enabled yet' },
      );
    } catch (e) {
      steps.push({ id: 'verify', status: 'error', detail: (e as Error).message });
    }
    const ok = steps.every((s) => s.status !== 'error');
    this.log(`connect ${domain} by ${actor}: ${ok ? 'ready' : 'incomplete'}`);
    return { domain, zone: zone.name, ok, steps, ...(status ? { status } : {}) };
  }
}
