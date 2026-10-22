/**
 * Pure admin-console logic (no I/O): building Stalwart objects from form input,
 * parsing zone files, suspension via permissions, health summaries and error
 * messages. Everything here is unit-tested in model.test.ts.
 */
import type { Id } from '../jmap/types';
import type {
  AcmeProvider,
  Account,
  Certificate,
  DkimSignature,
  DnsRecordType,
  DnsServer,
  Domain,
  DomainTask,
  EmailAlias,
  MtaOutboundStrategy,
  MtaRoute,
  Permissions,
} from './types';

// ------------------------------------------------------------------ domains

/** Records published by default when DNS is automatic. SRV is deliberately off. */
export const DEFAULT_PUBLISH: DnsRecordType[] = ['dkim', 'mx', 'tlsRpt'];

export const RECORD_LABELS: Record<DnsRecordType, string> = {
  dkim: 'DKIM keys',
  mx: 'MX',
  tlsRpt: 'TLS reporting (TLS-RPT)',
  spf: 'SPF',
  dmarc: 'DMARC policy',
  mtaSts: 'MTA-STS',
  caa: 'CAA',
  tlsa: 'TLSA (DANE)',
  srv: 'SRV (client discovery)',
  autoConfig: 'Autoconfig',
  autoConfigLegacy: 'Autoconfig (legacy)',
  autoDiscover: 'Autodiscover (Outlook)',
};

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normalizeDomain(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '');
}

/** Returns an error message, or null when the name is a plausible DNS domain. */
export function validateDomainName(name: string): string | null {
  const n = normalizeDomain(name);
  if (!n) return 'Enter a domain name';
  if (n.includes('@')) return 'Enter just the domain, without a mailbox (example.com)';
  if (!DOMAIN_RE.test(n)) return 'Enter a valid domain name, like example.com';
  return null;
}

/** Second-level public suffixes common enough to matter when guessing a zone apex. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'org.nz',
  'com.ng',
  'org.ng',
  'gov.ng',
  'co.za',
  'org.za',
  'com.br',
  'co.jp',
  'co.in',
  'com.mx',
  'com.sg',
  'com.tr',
  'co.ke',
  'com.gh',
]);

/** Best guess of the DNS zone (the registrable domain) a mail domain lives in: mail.example.co.uk → example.co.uk. */
export function suggestZoneApex(domain: string): string {
  const labels = normalizeDomain(domain).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(MULTI_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
}

/** Is `origin` the domain itself or one of its parents? */
export function isZoneOf(domain: string, origin: string): boolean {
  const d = normalizeDomain(domain);
  const o = normalizeDomain(origin);
  return !!o && (d === o || d.endsWith(`.${o}`));
}

export type DnsChoice = { mode: 'automatic'; dnsServerId: Id; origin: string; records: DnsRecordType[] } | { mode: 'manual' };
export type TlsChoice = { mode: 'automatic'; acmeProviderId: Id } | { mode: 'manual' };

export interface DomainForm {
  name: string;
  description: string;
  dns: DnsChoice;
  tls: TlsChoice;
}

/** Prefer the Cloudflare server (that's what our production zones use), else the first one. */
export function pickDnsServer(servers: DnsServer[]): DnsServer | undefined {
  return servers.find((s) => s['@type'] === 'Cloudflare') ?? servers[0];
}

/** DNS-01 ACME needs the server to publish the challenge record, i.e. automatic DNS. */
export function acmeNeedsAutoDns(p: AcmeProvider | undefined): boolean {
  return p?.challengeType === 'Dns01';
}

export function defaultDomainForm(name: string, opts: { dnsServers: DnsServer[]; acmeProviders: AcmeProvider[] }): DomainForm {
  const server = pickDnsServer(opts.dnsServers);
  const acme = opts.acmeProviders[0];
  const dns: DnsChoice = server
    ? { mode: 'automatic', dnsServerId: server.id, origin: name ? suggestZoneApex(name) : '', records: [...DEFAULT_PUBLISH] }
    : { mode: 'manual' };
  const tls: TlsChoice = acme && (dns.mode === 'automatic' || !acmeNeedsAutoDns(acme)) ? { mode: 'automatic', acmeProviderId: acme.id } : { mode: 'manual' };
  return { name, description: '', dns, tls };
}

/** Field → message map; empty when the form can be submitted. */
export function validateDomainForm(f: DomainForm, acmeProviders: AcmeProvider[] = []): Record<string, string> {
  const errors: Record<string, string> = {};
  const nameErr = validateDomainName(f.name);
  if (nameErr) errors.name = nameErr;
  if (f.dns.mode === 'automatic') {
    if (!f.dns.dnsServerId) errors.dnsServerId = 'Choose a DNS provider';
    if (!f.dns.origin.trim()) errors.origin = 'Enter the DNS zone';
    else if (!nameErr && !isZoneOf(f.name, f.dns.origin)) errors.origin = `The zone must be ${normalizeDomain(f.name)} or one of its parent domains`;
    if (!f.dns.records.length) errors.records = 'Publish at least one record type';
  }
  if (f.tls.mode === 'automatic') {
    const acme = acmeProviders.find((p) => p.id === (f.tls as { acmeProviderId: Id }).acmeProviderId);
    if (!f.tls.acmeProviderId) errors.acmeProviderId = 'Choose a certificate provider';
    else if (acmeNeedsAutoDns(acme) && f.dns.mode !== 'automatic') errors.tls = 'Automatic certificates use DNS validation, so they need automatic DNS';
  }
  return errors;
}

const toSet = <T extends string>(xs: readonly T[]) => Object.fromEntries(xs.map((x) => [x, true])) as Partial<Record<T, boolean>>;

export function dnsManagementOf(dns: DnsChoice): Domain['dnsManagement'] {
  return dns.mode === 'automatic'
    ? { '@type': 'Automatic', dnsServerId: dns.dnsServerId, origin: normalizeDomain(dns.origin), publishRecords: toSet(dns.records) }
    : { '@type': 'Manual' };
}

export function certificateManagementOf(tls: TlsChoice): Domain['certificateManagement'] {
  return tls.mode === 'automatic' ? { '@type': 'Automatic', acmeProviderId: tls.acmeProviderId, subjectAlternativeNames: {} } : { '@type': 'Manual' };
}

/** The x:Domain/set create object: DKIM is always automatic with Ed25519 + RSA. */
export function buildDomainCreate(f: DomainForm): Record<string, unknown> {
  return {
    name: normalizeDomain(f.name),
    description: f.description.trim() || null,
    isEnabled: true,
    dkimManagement: { '@type': 'Automatic', algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true } },
    certificateManagement: certificateManagementOf(f.tls),
    dnsManagement: dnsManagementOf(f.dns),
  };
}

/** Read a domain's current automation back into form choices (for editing). */
export function domainToForm(d: Domain): DomainForm {
  const dns: DnsChoice =
    d.dnsManagement['@type'] === 'Automatic'
      ? {
          mode: 'automatic',
          dnsServerId: d.dnsManagement.dnsServerId,
          origin: d.dnsManagement.origin ?? suggestZoneApex(d.name),
          records: Object.entries(d.dnsManagement.publishRecords)
            .filter(([, v]) => v)
            .map(([k]) => k as DnsRecordType),
        }
      : { mode: 'manual' };
  const tls: TlsChoice =
    d.certificateManagement['@type'] === 'Automatic' ? { mode: 'automatic', acmeProviderId: d.certificateManagement.acmeProviderId } : { mode: 'manual' };
  return { name: d.name, description: d.description ?? '', dns, tls };
}

// ------------------------------------------------------------------ zone file

export interface DnsRecord {
  /** Fully-qualified owner name, without the trailing dot. */
  fqdn: string;
  type: string;
  /** Record data exactly as in the zone file (single line). */
  rdata: string;
  /** What to paste into a DNS provider's "content" field (TXT strings joined and unquoted, MX without priority). */
  content: string;
  priority?: number;
  /** Which `publishRecords` switch covers this record, if known. */
  kind?: DnsRecordType;
}

/** Split a zone file into logical records, joining `( … )` continuations. */
function logicalLines(zone: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const raw of zone.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim() && depth === 0) continue;
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"/g, '')) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    buf += (buf ? ' ' : '') + line.trim();
    if (depth <= 0) {
      out.push(
        buf
          .replace(/[()]/g, (m, i: number) => (insideQuotes(buf, i) ? m : ' '))
          .replace(/\s+/g, ' ')
          .trim(),
      );
      buf = '';
      depth = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function stripComment(line: string): string {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') i++;
    else if (c === '"') inQ = !inQ;
    else if (c === ';' && !inQ) return line.slice(0, i);
  }
  return line;
}

function insideQuotes(s: string, idx: number): boolean {
  let inQ = false;
  for (let i = 0; i < idx; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') inQ = !inQ;
  }
  return inQ;
}

function txtStrings(rdata: string): string[] {
  return [...rdata.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
}

export function classifyRecord(fqdn: string, type: string, content: string): DnsRecordType | undefined {
  const n = fqdn.toLowerCase();
  if (type === 'MX') return 'mx';
  if (type === 'SRV') return 'srv';
  if (type === 'TLSA') return 'tlsa';
  if (type === 'CAA' || n.startsWith('_validation-persist.')) return 'caa';
  if (n.includes('._domainkey.')) return 'dkim';
  if (n.startsWith('_dmarc.')) return 'dmarc';
  if (n.startsWith('_smtp._tls.')) return 'tlsRpt';
  if (n.startsWith('mta-sts.') || n.startsWith('_mta-sts.')) return 'mtaSts';
  if (n.startsWith('autodiscover.')) return 'autoDiscover';
  if (n.startsWith('autoconfig.')) return 'autoConfigLegacy';
  if (n.startsWith('ua-auto-config.') || n.startsWith('_ua-auto-config.')) return 'autoConfig';
  if (type === 'TXT' && /^v=spf1\b/i.test(content)) return 'spf';
  return undefined;
}

/** Parse Stalwart's `dnsZoneFile` (BIND presentation format, absolute names). */
export function parseZoneFile(zone: string | undefined | null): DnsRecord[] {
  if (!zone) return [];
  const records: DnsRecord[] = [];
  for (const line of logicalLines(zone)) {
    if (line.startsWith('$')) continue;
    const m = /^(\S+)\s+(?:(\d+)\s+)?(?:IN\s+)?(?:(\d+)\s+)?([A-Z][A-Z0-9]*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const fqdn = m[1]!.replace(/\.$/, '');
    const type = m[4]!;
    const rdata = m[5]!.trim();
    let content = rdata;
    let priority: number | undefined;
    if (type === 'TXT') content = txtStrings(rdata).join('');
    else if (type === 'MX') {
      const [p, ...rest] = rdata.split(' ');
      priority = Number(p);
      content = rest.join(' ');
    }
    records.push({ fqdn, type, rdata, content, priority, kind: classifyRecord(fqdn, type, content) });
  }
  return records;
}

/** Name relative to the zone, as DNS dashboards show it ("@" for the apex). */
export function relativeName(fqdn: string, origin: string | null | undefined): string {
  const n = fqdn.replace(/\.$/, '').toLowerCase();
  const o = (origin ?? '').replace(/\.$/, '').toLowerCase();
  if (!o) return n;
  if (n === o) return '@';
  return n.endsWith(`.${o}`) ? n.slice(0, -(o.length + 1)) : n;
}

// ------------------------------------------------------------------ health

export type HealthState = 'ok' | 'pending' | 'warning' | 'error' | 'off';
export interface Health {
  state: HealthState;
  label: string;
  detail?: string;
}

const taskFailure = (t: DomainTask | undefined) =>
  t && (t.status['@type'] === 'Retry' || t.status['@type'] === 'Failed') ? (t.status.failureReason ?? 'Unknown error') : undefined;

const DKIM_ALGO_LABEL: Record<string, string> = {
  Dkim1Ed25519Sha256: 'Ed25519',
  Dkim1RsaSha256: 'RSA',
  Dkim2Ed25519Sha256: 'Ed25519 (DKIM2)',
  Dkim2RsaSha256: 'RSA (DKIM2)',
};
export const dkimAlgorithmLabel = (t: string) => DKIM_ALGO_LABEL[t] ?? t;

export function dkimHealth(domain: Domain, signatures: DkimSignature[], tasks: DomainTask[]): Health {
  const sigs = signatures.filter((s) => s.domainId === domain.id);
  const active = sigs.filter((s) => s.stage === 'active');
  const failure = taskFailure(tasks.find((t) => t.domainId === domain.id && t['@type'] === 'DkimManagement'));
  if (!sigs.length) {
    if (domain.dkimManagement['@type'] === 'Manual') return { state: 'off', label: 'Manual', detail: 'No DKIM keys. Outgoing mail is not signed.' };
    return failure ? { state: 'error', label: 'Key setup failed', detail: failure } : { state: 'pending', label: 'Generating keys' };
  }
  const algos = [...new Set(active.map((s) => dkimAlgorithmLabel(s['@type'])))].join(' + ');
  if (failure)
    return { state: 'warning', label: active.length ? `Signing (${algos})` : 'Keys pending', detail: `Publishing the DKIM record failed: ${failure}` };
  if (!active.length) return { state: 'pending', label: 'Keys pending activation' };
  return { state: 'ok', label: `Signing with ${algos}` };
}

/** Certificates whose SANs cover the domain or a host under it (e.g. mx1.example.com). */
export function certificatesFor(domain: Domain, certs: Certificate[]): Certificate[] {
  const name = domain.name.toLowerCase();
  return certs.filter((c) =>
    Object.keys(c.subjectAlternativeNames ?? {}).some((san) => {
      const s = san.toLowerCase().replace(/^\*\./, '');
      return s === name || s.endsWith(`.${name}`);
    }),
  );
}

export function tlsHealth(domain: Domain, certs: Certificate[], tasks: DomainTask[], now = new Date()): Health {
  const mine = certificatesFor(domain, certs).sort((a, b) => b.notValidAfter.localeCompare(a.notValidAfter));
  const best = mine[0];
  const valid = best && new Date(best.notValidAfter) > now;
  const until = best ? new Date(best.notValidAfter).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  if (domain.certificateManagement['@type'] === 'Manual') {
    if (valid) return { state: 'ok', label: `Valid until ${until}`, detail: `Manually managed certificate, issued by ${best.issuer}` };
    return { state: 'off', label: 'Manual', detail: 'Certificates for this domain are not managed automatically.' };
  }
  const failure = taskFailure(tasks.find((t) => t.domainId === domain.id && t['@type'] === 'AcmeRenewal'));
  if (valid)
    return failure
      ? { state: 'warning', label: `Valid until ${until}`, detail: `Renewal failing: ${failure}` }
      : { state: 'ok', label: `Valid until ${until}`, detail: `Issued by ${best.issuer}` };
  if (failure) return { state: 'error', label: 'Certificate request failed', detail: failure };
  return {
    state: 'pending',
    label: best ? 'Expired, renewal pending' : 'Waiting for certificate',
    detail: 'The certificate is requested once the DNS records are published.',
  };
}

export function dnsHealth(domain: Domain, tasks: DomainTask[], servers: DnsServer[] = []): Health {
  if (domain.dnsManagement['@type'] === 'Manual') return { state: 'off', label: 'Manual', detail: 'Add the records below at your DNS provider.' };
  const server = servers.find((s) => s.id === (domain.dnsManagement as { dnsServerId: Id }).dnsServerId);
  const via = server ? ` via ${server.description || server['@type']}` : '';
  const task = tasks.find((t) => t.domainId === domain.id && t['@type'] === 'DnsManagement');
  const failure = taskFailure(task);
  if (failure) return { state: 'error', label: 'Publishing failed', detail: failure };
  if (task) return { state: 'pending', label: `Publishing${via}` };
  return { state: 'ok', label: `Automatic${via}`, detail: domain.dnsManagement.origin ? `Zone ${domain.dnsManagement.origin}` : undefined };
}

// ------------------------------------------------------------------ accounts

/** Suspension = the `authenticate` permission disabled on the account (Stalwart has no enabled flag on accounts). */
export function isSuspended(p: Permissions | undefined): boolean {
  return !!p && p['@type'] !== 'Inherit' && !!p.disabledPermissions?.authenticate;
}

export function withSuspension(p: Permissions | undefined, suspended: boolean): Permissions {
  const cur: Permissions = p ?? { '@type': 'Inherit' };
  if (suspended) {
    if (cur['@type'] === 'Inherit') return { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } };
    const enabled = { ...cur.enabledPermissions };
    delete enabled.authenticate;
    return { ...cur, enabledPermissions: enabled, disabledPermissions: { ...cur.disabledPermissions, authenticate: true } };
  }
  if (cur['@type'] === 'Inherit') return cur;
  const disabled = { ...cur.disabledPermissions };
  delete disabled.authenticate;
  if (cur['@type'] === 'Merge') {
    if (!Object.keys(disabled).length && !Object.keys(cur.enabledPermissions ?? {}).length) return { '@type': 'Inherit' };
    return { ...cur, disabledPermissions: disabled };
  }
  // Replace: the enabled set is complete, so signing in has to be granted back explicitly.
  return { ...cur, enabledPermissions: { ...cur.enabledPermissions, authenticate: true }, disabledPermissions: disabled };
}

export function isAdminRole(a: Pick<Account, 'roles'>): boolean {
  return a.roles?.['@type'] === 'Admin';
}

export function aliasList(a: { aliases?: Record<string, EmailAlias> }): EmailAlias[] {
  return Object.entries(a.aliases ?? {})
    .sort(([x], [y]) => Number(x) - Number(y))
    .map(([, v]) => v);
}

/** objectList → the re-indexed map the server expects. */
export function aliasMap(list: EmailAlias[]): Record<string, EmailAlias> {
  return Object.fromEntries(
    list.map((a, i) => [String(i), { name: a.name, domainId: a.domainId, enabled: a.enabled ?? true, description: a.description ?? null }]),
  );
}

export function aliasAddress(a: EmailAlias, domainsById: Map<Id, Domain>): string {
  return `${a.name}@${domainsById.get(a.domainId)?.name ?? '?'}`;
}

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

export function validateLocalPart(local: string): string | null {
  const l = local.trim();
  if (!l) return 'Enter a name';
  if (l.includes('@')) return 'Enter only the part before @';
  if (l.length > 64 || !LOCAL_RE.test(l)) return 'Use letters, numbers, dots, dashes or underscores';
  return null;
}

/** Split `name@domain` against the domains this server hosts. */
export function parseLocalAddress(address: string, domains: Domain[]): { name: string; domainId: Id } | null {
  const at = address.trim().lastIndexOf('@');
  if (at <= 0) return null;
  const name = address.trim().slice(0, at).toLowerCase();
  const dn = address
    .trim()
    .slice(at + 1)
    .toLowerCase();
  const d = domains.find((x) => x.name.toLowerCase() === dn);
  return d && !validateLocalPart(name) ? { name, domainId: d.id } : null;
}

export function matchesSearch(a: Pick<Account, 'name' | 'emailAddress' | 'description' | 'aliases'>, term: string, domainsById?: Map<Id, Domain>): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  const hay = [a.name, a.emailAddress, a.description ?? '', ...aliasList(a).map((x) => (domainsById ? aliasAddress(x, domainsById) : x.name))];
  return hay.some((h) => h.toLowerCase().includes(t));
}

export const GIB = 1024 ** 3;

export function quotaBytes(gb: string): number | null {
  const n = Number(gb.trim().replace(',', '.'));
  return gb.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * GIB) : null;
}

export function quotaGb(bytes: number | undefined | null): string {
  return bytes ? String(Math.round((bytes / GIB) * 100) / 100) : '';
}

/** Readable random password: 4 groups of 4 from an unambiguous alphabet, always mixing cases and digits. */
export function generatePassword(random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  for (;;) {
    const r = random(16);
    const chars = [...r].map((v) => all[v % all.length]!);
    const pw = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters';
  if (pw.length > 256) return 'Use at most 256 characters';
  return null;
}

// ------------------------------------------------------------------ relay

/** `'cloudflare'` → cloudflare; anything that isn't a plain literal is returned as-is. */
export function expressionLiteral(expr: string | undefined): string | null {
  if (!expr) return null;
  const m = /^'([^']*)'$/.exec(expr.trim());
  return m ? m[1]! : expr.trim();
}

export function defaultRemoteRoute(strategy: MtaOutboundStrategy | null | undefined): string | null {
  return expressionLiteral(strategy?.route?.else);
}

export function describeRoute(r: MtaRoute): string {
  switch (r['@type']) {
    case 'Relay':
      return `${r.address ?? '?'}:${r.port ?? 25} · ${r.implicitTls ? 'implicit TLS' : 'STARTTLS'}${r.protocol && r.protocol !== 'smtp' ? ` · ${r.protocol.toUpperCase()}` : ''}`;
    case 'Mx':
      return "Direct delivery to the recipient's MX hosts";
    case 'Local':
      return 'Delivery to local mailboxes';
    default:
      return r['@type'];
  }
}

// ------------------------------------------------------------------ errors

export interface SetErrorLike {
  type: string;
  description?: string;
  properties?: string[];
  linkedObjects?: { object: string; id: Id }[];
}

const LINKED_NAMES: Record<string, [string, string]> = {
  Account: ['account', 'accounts'],
  MailingList: ['mailing list', 'mailing lists'],
  DkimSignature: ['DKIM key', 'DKIM keys'],
  Domain: ['domain', 'domains'],
};

export function describeLinked(linked: { object: string }[]): string {
  const counts = new Map<string, number>();
  for (const l of linked) counts.set(l.object, (counts.get(l.object) ?? 0) + 1);
  const parts = [...counts].map(([obj, n]) => {
    const [one, many] = LINKED_NAMES[obj] ?? [obj, `${obj}s`];
    return `${n} ${n === 1 ? one : many}`;
  });
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Human message for an x:<Object>/set error. */
export function describeSetError(e: SetErrorLike): string {
  switch (e.type) {
    case 'primaryKeyViolation':
      return 'That address or name is already in use.';
    case 'objectIsLinked':
      return `It's still in use by ${describeLinked(e.linkedObjects ?? [])}.`;
    case 'forbidden':
      return "You don't have permission to do that.";
    case 'notFound':
      return 'It no longer exists. Refresh and try again.';
    case 'invalidProperties':
      return e.description ?? `Invalid ${e.properties?.join(', ') ?? 'value'}.`;
    default:
      return e.description ?? e.type;
  }
}
