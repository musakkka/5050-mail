/**
 * Domains on Cloudflare Email Sending, presented in Resend's shape.
 *
 * - Zone in our Cloudflare account → onboard + publish the cf-bounce records (one click),
 *   and trust the zone's own records for verification. Only for `cf_managed` domains: added
 *   by a platform admin, or whose zone we created for that domain (live only once the owner
 *   delegates NS). Ordinary teams cannot add names inside the operator's zones at all.
 * - Otherwise → show the records to add, and `verify` checks public DNS plus the
 *   Cloudflare sending status. Cloudflare only onboards zones in the account, so the
 *   DKIM key exists once the zone is there (optionally created by us as a pending zone,
 *   CLOUDFLARE_CREATE_ZONES=1).
 */
import type { AppContext } from '../context.js';
import { pgToIso } from '../db.js';
import { normalizeDomain, txtValue, CloudflareError, type RecordCheck } from '../cloudflare/client.js';
import { ApiError, E } from '../lib/errors.js';
import { enqueue } from './jobs.js';
import { emit } from './webhooks.js';
import { ensureDkimKey, localDomainMode, spfAuthorises, spfValue, type LocalKey } from './localDomains.js';

export type RecordStatus = 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure';

export interface DomainRecord {
  record: 'SPF' | 'DKIM' | 'DMARC' | 'Receiving' | 'Tracking' | 'TrackingCAA';
  name: string;
  type: 'MX' | 'TXT' | 'CNAME' | 'CAA';
  ttl: string;
  status: RecordStatus;
  value: string;
  priority?: number;
}

export const REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'];
/** Resend keeps verifying a pending domain for 72 hours. */
export const VERIFY_WINDOW_MS = 72 * 3600_000;
export const VERIFY_INTERVAL_MS = 5 * 60_000;
const RETURN_PATH = 'cf-bounce';
const CF_MX = [
  { value: 'route1.mx.cloudflare.net', priority: 47 },
  { value: 'route2.mx.cloudflare.net', priority: 6 },
  { value: 'route3.mx.cloudflare.net', priority: 99 },
];

export interface DomainRow {
  id: string;
  team_id: string;
  name: string;
  status: string;
  region: string;
  open_tracking: boolean;
  click_tracking: boolean;
  tls: string;
  tracking_subdomain: string | null;
  custom_return_path: string | null;
  sending: string;
  receiving: string;
  records: DomainRecord[];
  cf_zone_id: string | null;
  cf_zone_name: string | null;
  cf_subdomain_tag: string | null;
  cf_enabled: boolean;
  cf_managed: boolean;
  last_error: string | null;
  created_at: string;
  verified_at: string | null;
}

const rel = (fqdn: string, domain: string) => (fqdn === domain ? '@' : fqdn.endsWith(`.${domain}`) ? fqdn.slice(0, -domain.length - 1) : fqdn);
const abs = (name: string, domain: string) => (name === '@' ? domain : `${name}.${domain}`);

/** The record list for a domain, before any DNS check (statuses carried over by key). */
export function expectedRecords(ctx: AppContext, d: Pick<DomainRow, 'name' | 'sending' | 'receiving' | 'tracking_subdomain' | 'records'>, dkim?: { name: string; value: string } | null, bounce?: RecordCheck[], local?: LocalKey): DomainRecord[] {
  const prev = new Map((d.records ?? []).map((r) => [`${r.record}|${r.type}|${r.name}|${r.value}`, r.status]));
  const st = (r: Omit<DomainRecord, 'status' | 'ttl'>): DomainRecord => ({
    ...r,
    ttl: 'Auto',
    status: prev.get(`${r.record}|${r.type}|${r.name}|${r.value}`) ?? 'not_started',
  });
  const out: DomainRecord[] = [];
  if (d.sending === 'enabled' && local) {
    // Self-hosted: our own DKIM key, SPF authorising the mail server, DMARC.
    out.push(st({ record: 'DKIM', name: `${local.selector}._domainkey`, type: 'TXT', value: `v=DKIM1; k=rsa; p=${local.publicKey}` }));
    out.push(st({ record: 'SPF', name: '@', type: 'TXT', value: spfValue() }));
    out.push(st({ record: 'DMARC', name: '_dmarc', type: 'TXT', value: ctx.config.dmarcValue }));
  } else if (d.sending === 'enabled') {
    const mx = bounce?.filter((b) => b.type === 'MX') ?? [];
    const spf = bounce?.find((b) => b.type === 'TXT' && /^v=spf1/i.test(txtValue(b.content)));
    const dk = bounce?.find((b) => b.type === 'TXT' && b.name.includes('._domainkey.'));
    const dkimRec = dk ? { name: rel(dk.name, d.name), value: txtValue(dk.content) } : dkim;
    out.push(st({ record: 'DKIM', name: dkimRec?.name ?? `${RETURN_PATH}._domainkey`, type: 'TXT', value: dkimRec?.value ?? '' }));
    const mxList = mx.length ? mx.map((m) => ({ value: m.content, priority: m.priority ?? 10 })) : CF_MX;
    for (const m of mxList) out.push(st({ record: 'SPF', name: RETURN_PATH, type: 'MX', value: m.value, priority: m.priority }));
    out.push(st({ record: 'SPF', name: RETURN_PATH, type: 'TXT', value: spf ? txtValue(spf.content) : 'v=spf1 include:_spf.mx.cloudflare.net ~all' }));
    out.push(st({ record: 'DMARC', name: '_dmarc', type: 'TXT', value: ctx.config.dmarcValue }));
  }
  if (d.receiving === 'enabled') {
    out.push(st({ record: 'Receiving', name: '@', type: 'MX', value: ctx.config.inboundMxHost, priority: 10 }));
  }
  if (d.tracking_subdomain) {
    out.push(st({ record: 'Tracking', name: d.tracking_subdomain, type: 'CNAME', value: ctx.config.trackingCnameTarget }));
  }
  return out;
}

/** Resend's aggregate status from per-record statuses and capabilities. */
export function aggregateStatus(records: DomainRecord[], sendingReady: boolean, sendingEnabled: boolean, receivingEnabled: boolean): string {
  const send = records.filter((r) => ['DKIM', 'SPF'].includes(r.record));
  const recv = records.filter((r) => r.record === 'Receiving');
  const state = (rs: DomainRecord[], extraOk = true) => {
    if (!rs.length) return 'none';
    if (rs.every((r) => r.status === 'verified') && extraOk) return 'verified';
    if (rs.some((r) => r.status === 'failed')) return 'failed';
    if (rs.every((r) => r.status === 'not_started')) return 'not_started';
    return 'pending';
  };
  const s = sendingEnabled ? state(send, sendingReady) : 'none';
  const r = receivingEnabled ? state(recv) : 'none';
  const parts = [s, r].filter((x) => x !== 'none');
  if (!parts.length) return 'not_started';
  if (parts.every((p) => p === 'verified')) return 'verified';
  if (parts.length === 2 && parts.includes('verified')) return parts.includes('failed') ? 'partially_failed' : 'partially_verified';
  if (parts.includes('failed')) return 'failed';
  if (parts.every((p) => p === 'not_started')) return 'not_started';
  return 'pending';
}

export function domainEventData(d: DomainRow) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    created_at: pgToIso(d.created_at),
    region: d.region,
    capabilities: { sending: d.sending, receiving: d.receiving },
    records: d.records,
  };
}

export interface CreateDomainInput {
  name?: unknown;
  region?: unknown;
  custom_return_path?: unknown;
  open_tracking?: unknown;
  click_tracking?: unknown;
  tls?: unknown;
  capabilities?: unknown;
  tracking_subdomain?: unknown;
}

const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function capabilities(v: unknown, current?: { sending: string; receiving: string }) {
  const out = { sending: current?.sending ?? 'enabled', receiving: current?.receiving ?? 'disabled' };
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object' || Array.isArray(v)) throw E.validation('Invalid `capabilities` field. It must be an object.');
  for (const k of ['sending', 'receiving'] as const) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (x !== 'enabled' && x !== 'disabled') throw E.validation(`Invalid \`capabilities.${k}\` field. It must be \`enabled\` or \`disabled\`.`);
    out[k] = x;
  }
  if (out.sending === 'disabled' && out.receiving === 'disabled') throw E.validation('At least one capability must be enabled.');
  return out;
}

export async function createDomain(ctx: AppContext, teamId: string, b: CreateDomainInput, opts: { platformAdmin?: boolean } = {}): Promise<DomainRow> {
  if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
  const name = normalizeDomain(b.name);
  if (!name) throw E.validation('Invalid `name` field. It must be a valid domain name like `example.com`.');
  const region = b.region ?? 'us-east-1';
  if (typeof region !== 'string' || !REGIONS.includes(region)) throw new ApiError(422, 'invalid_region', `Invalid \`region\` field. It must be one of: ${REGIONS.join(', ')}.`);
  if (b.tls !== undefined && b.tls !== 'opportunistic' && b.tls !== 'enforced') throw E.validation('Invalid `tls` field. It must be `opportunistic` or `enforced`.');
  for (const k of ['open_tracking', 'click_tracking'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw E.validation(`Invalid \`${k}\` field. It must be a boolean.`);
  if (b.custom_return_path !== undefined && (typeof b.custom_return_path !== 'string' || !SUB_RE.test(b.custom_return_path))) throw E.validation('Invalid `custom_return_path` field. It must be a valid subdomain label.');
  if (b.tracking_subdomain !== undefined && (typeof b.tracking_subdomain !== 'string' || !SUB_RE.test(b.tracking_subdomain))) throw E.validation('Invalid `tracking_subdomain` field. It must be a valid subdomain label.');
  const caps = capabilities(b.capabilities);
  const [exists] = await ctx.sql`select id from domains where lower(name) = ${name}`;
  if (exists) throw E.forbidden(`The ${name} domain has been registered already.`);
  // A subdomain of a domain another team registered belongs to that team (use a domain claim to move it).
  const [parent] = await ctx.sql`select name from domains where team_id <> ${teamId} and ${name} like '%.' || lower(name) limit 1`;
  if (parent) throw E.forbidden(`The ${name} domain is under ${parent.name as string}, which has been registered already.`);
  const platformAdmin = opts.platformAdmin === true;
  if (ctx.cf && !platformAdmin) {
    // Names inside a zone of the operator's Cloudflare account can't be proven by a team (the
    // operator controls that DNS), so only platform admins may add them.
    let zone: { name: string } | null;
    try {
      zone = await ctx.cf.cf.findZone(name);
    } catch (e) {
      ctx.log('domains', 'zone lookup failed', { domain: name, error: (e as Error).message });
      throw new ApiError(503, 'application_error', 'Could not check the domain right now. Please try again.');
    }
    if (zone) throw E.forbidden(`The ${name} domain is in a DNS zone managed by this server's operator. Ask an administrator to add it for your team.`);
  }

  const [row] = await ctx.sql`
    insert into domains (team_id, name, region, open_tracking, click_tracking, tls, tracking_subdomain, custom_return_path, sending, receiving, cf_managed)
    values (${teamId}, ${name}, ${region}, ${(b.open_tracking as boolean | undefined) ?? false}, ${(b.click_tracking as boolean | undefined) ?? false},
            ${(b.tls as string | undefined) ?? 'opportunistic'}, ${(b.tracking_subdomain as string | undefined) ?? null}, ${(b.custom_return_path as string | undefined) ?? null},
            ${caps.sending}, ${caps.receiving}, ${platformAdmin})
    returning *`;
  let d = row as unknown as DomainRow;
  d = await refreshFromCloudflare(ctx, d, { onboard: true });
  await emit(ctx, teamId, 'domain.created', domainEventData(d));
  if (d.cf_zone_id && d.cf_enabled) {
    // One-click: records were published in our zone; verify right away.
    await startVerification(ctx, d, { emitUpdate: false });
  }
  return (await getDomain(ctx, teamId, d.id))!;
}

export async function getDomain(ctx: AppContext, teamId: string, id: string): Promise<DomainRow | null> {
  const [row] = await ctx.sql`select * from domains where id = ${id} and team_id = ${teamId}`;
  return (row as unknown as DomainRow) ?? null;
}

/**
 * Locate the zone, onboard Email Sending (create zone first when allowed), publish
 * missing records when the zone is ours, and rebuild the record list.
 */
export async function refreshFromCloudflare(ctx: AppContext, d: DomainRow, opts: { onboard: boolean }): Promise<DomainRow> {
  if (localDomainMode(ctx)) return refreshLocal(ctx, d);
  let zoneId = d.cf_zone_id;
  let zoneName = d.cf_zone_name;
  let enabled = d.cf_enabled;
  let managed = d.cf_managed;
  let lastError: string | null = null;
  let bounce: RecordCheck[] | undefined;
  if (d.sending === 'enabled' && ctx.cf) {
    try {
      let zone = await ctx.cf.cf.findZone(d.name);
      if (!zone && opts.onboard && ctx.config.cloudflareCreateZones) {
        zone = await ctx.cf.cf.createZone(d.name);
        managed = true; // our zone, for this domain: it only goes live when the owner moves NS
        ctx.log('domains', 'created pending zone for external domain', { domain: d.name });
      }
      if (zone && !managed) {
        // A zone of the operator's account that this domain was not set up in by an admin: never
        // onboard it, publish into it or trust its records on a team's behalf.
        lastError = `${d.name} is in a DNS zone managed by this server's operator; an administrator must connect it.`;
      } else if (zone) {
        zoneId = zone.id;
        zoneName = zone.name;
        if (opts.onboard) {
          const r = await ctx.cf.connect(d.name, `team:${d.team_id}`);
          const failed = r.steps.filter((s) => s.status === 'error' && s.id !== 'verify');
          if (failed.length) lastError = failed.map((s) => s.detail).join('; ');
          await ensureDmarc(ctx, zone, d.name);
        }
        const st = await ctx.cf.status(d.name);
        enabled = st.sending.enabled;
        bounce = st.bounceRecords;
      } else {
        lastError = `${d.name} is not in the connected Cloudflare account yet; add the DNS records below and ask an administrator to onboard the zone.`;
      }
    } catch (e) {
      lastError = e instanceof CloudflareError ? e.message : (e as Error).message;
      ctx.log('domains', 'cloudflare refresh failed', { domain: d.name, error: lastError });
    }
  }
  const records = expectedRecords(ctx, d, null, bounce);
  const [row] = await ctx.sql`
    update domains set cf_zone_id = ${zoneId}, cf_zone_name = ${zoneName}, cf_enabled = ${enabled}, cf_managed = ${managed}, records = ${ctx.sql.json(records as never)},
                       last_error = ${lastError}, updated_at = now()
    where id = ${d.id} returning *`;
  return row as unknown as DomainRow;
}

/** Self-hosted mode: no Cloudflare; sending is ready once DKIM/SPF verify in public DNS. */
async function refreshLocal(ctx: AppContext, d: DomainRow): Promise<DomainRow> {
  const key = d.sending === 'enabled' ? await ensureDkimKey(ctx, d.id) : undefined;
  const records = expectedRecords(ctx, d, null, undefined, key);
  const [row] = await ctx.sql`
    update domains set cf_enabled = true, records = ${ctx.sql.json(records as never)}, last_error = null, updated_at = now()
    where id = ${d.id} returning *`;
  return row as unknown as DomainRow;
}

async function ensureDmarc(ctx: AppContext, zone: { id: string; name: string }, domain: string) {
  try {
    const name = `_dmarc.${domain}`;
    const have = await ctx.cf!.cf.dnsRecordsByName(zone.id, name);
    if (have.some((r) => r.type === 'TXT' && /^v=DMARC1/i.test(txtValue(r.content)))) return;
    await ctx.cf!.cf.createDnsRecord(zone.id, { type: 'TXT', name, content: `"${ctx.config.dmarcValue}"` }, '5050 Send: DMARC');
  } catch (e) {
    ctx.log('domains', 'dmarc publish failed', { domain, error: (e as Error).message });
  }
}

/** POST /domains/:id/verify — mark pending, then verify asynchronously (worker). */
export async function startVerification(ctx: AppContext, d: DomainRow, opts: { emitUpdate?: boolean } = {}): Promise<void> {
  const records = d.records.map((r) => (r.status === 'verified' ? r : { ...r, status: 'pending' as RecordStatus }));
  const [row] = await ctx.sql`update domains set status = 'pending', records = ${ctx.sql.json(records as never)}, last_checked_at = null, updated_at = now() where id = ${d.id} returning *`;
  if (opts.emitUpdate !== false && d.status !== 'pending') await emit(ctx, d.team_id, 'domain.updated', domainEventData(row as unknown as DomainRow));
  await enqueue(ctx.sql, 'domain_verify', { domainId: d.id, startedAt: ctx.now().toISOString() }, { uniqueKey: `domain_verify:${d.id}` });
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

async function checkRecordDns(ctx: AppContext, domain: string, r: DomainRecord): Promise<boolean> {
  const fq = abs(r.name, domain);
  if (r.type === 'TXT') {
    if (!r.value) return false;
    const vals = (await ctx.dns.txt(fq)).map((v) => txtValue(v));
    if (r.record === 'SPF' && r.name === '@' && localDomainMode(ctx)) return spfAuthorises(vals);
    if (r.record === 'DMARC') return vals.some((v) => /^v=DMARC1/i.test(v));
    return vals.some((v) => v.replace(/\s+/g, '') === txtValue(r.value).replace(/\s+/g, ''));
  }
  if (r.type === 'MX') return (await ctx.dns.mx(fq)).some((m) => norm(m.exchange) === norm(r.value));
  if (r.type === 'CNAME') return (await ctx.dns.cname(fq)).some((v) => norm(v) === norm(r.value));
  return false;
}

/** One verification pass (worker job). Returns true while the domain should be re-checked. */
export async function runVerification(ctx: AppContext, domainId: string, startedAt: Date): Promise<boolean> {
  const [row] = await ctx.sql`select * from domains where id = ${domainId}`;
  if (!row) return false;
  let d = row as unknown as DomainRow;
  const before = JSON.stringify([d.status, d.records]);
  // Re-onboard if needed (e.g. the zone was added to the account since creation).
  d = await refreshFromCloudflare(ctx, d, { onboard: !d.cf_enabled });
  let zoneActive = false;
  if (d.cf_zone_id && d.cf_managed && ctx.cf) {
    try {
      zoneActive = (await ctx.cf.cf.zoneStatus(d.cf_zone_id)) === 'active';
    } catch {
      zoneActive = false;
    }
  }
  let bounceChecks: RecordCheck[] = [];
  if (zoneActive && ctx.cf) {
    try {
      bounceChecks = (await ctx.cf.status(d.name)).bounceRecords;
    } catch {
      bounceChecks = [];
    }
  }
  const expired = ctx.now().getTime() - startedAt.getTime() > VERIFY_WINDOW_MS;
  const records: DomainRecord[] = [];
  for (const r of d.records) {
    let ok: boolean;
    let transient = false;
    try {
      if (zoneActive && (r.record === 'DKIM' || r.record === 'SPF')) {
        const fq = abs(r.name, d.name);
        ok = bounceChecks.some((b) => b.present && b.type === r.type && norm(b.name) === norm(fq) && (b.type !== 'MX' || norm(b.content) === norm(r.value)));
        if (!ok) ok = await checkRecordDns(ctx, d.name, r);
      } else {
        ok = await checkRecordDns(ctx, d.name, r);
      }
    } catch {
      ok = false;
      transient = true;
    }
    records.push({ ...r, status: ok ? 'verified' : transient ? 'temporary_failure' : expired ? 'failed' : 'pending' });
  }
  const sendingReady = d.sending !== 'enabled' || d.cf_enabled;
  let status = aggregateStatus(records, sendingReady, d.sending === 'enabled', d.receiving === 'enabled');
  if (status === 'pending' && expired) status = 'failed';
  const [upd] = await ctx.sql`
    update domains set status = ${status}, records = ${ctx.sql.json(records as never)}, last_checked_at = now(), updated_at = now(),
                       verified_at = case when ${status} = 'verified' then coalesce(verified_at, now()) else verified_at end
    where id = ${d.id} returning *`;
  const after = upd as unknown as DomainRow;
  if (JSON.stringify([after.status, after.records]) !== before) await emit(ctx, after.team_id, 'domain.updated', domainEventData(after));
  return status === 'pending' || status === 'partially_verified';
}

export async function updateDomain(ctx: AppContext, d: DomainRow, b: Record<string, unknown>): Promise<void> {
  for (const k of ['open_tracking', 'click_tracking'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw E.validation(`Invalid \`${k}\` field. It must be a boolean.`);
  if (b.tls !== undefined && b.tls !== 'opportunistic' && b.tls !== 'enforced') throw E.validation('Invalid `tls` field. It must be `opportunistic` or `enforced`.');
  if (b.tracking_subdomain !== undefined) {
    if (b.tracking_subdomain === null || b.tracking_subdomain === '') {
      if (d.tracking_subdomain) throw E.validation('The `tracking_subdomain` can only be changed, never removed.');
    } else if (typeof b.tracking_subdomain !== 'string' || !SUB_RE.test(b.tracking_subdomain)) throw E.validation('Invalid `tracking_subdomain` field. It must be a valid subdomain label.');
  }
  const caps = capabilities(b.capabilities, { sending: d.sending, receiving: d.receiving });
  const tracking = typeof b.tracking_subdomain === 'string' && b.tracking_subdomain ? b.tracking_subdomain : d.tracking_subdomain;
  const changedCaps = caps.sending !== d.sending || caps.receiving !== d.receiving || tracking !== d.tracking_subdomain;
  const [row] = await ctx.sql`
    update domains set
      open_tracking = ${(b.open_tracking as boolean | undefined) ?? d.open_tracking},
      click_tracking = ${(b.click_tracking as boolean | undefined) ?? d.click_tracking},
      tls = ${(b.tls as string | undefined) ?? d.tls},
      tracking_subdomain = ${tracking},
      sending = ${caps.sending}, receiving = ${caps.receiving}, updated_at = now()
    where id = ${d.id} returning *`;
  let upd = row as unknown as DomainRow;
  if (changedCaps) {
    upd = await refreshFromCloudflare(ctx, upd, { onboard: caps.sending === 'enabled' && !upd.cf_enabled });
    const status = aggregateStatus(upd.records, upd.sending !== 'enabled' || upd.cf_enabled, upd.sending === 'enabled', upd.receiving === 'enabled');
    [upd] = (await ctx.sql`update domains set status = ${status} where id = ${d.id} returning *`) as unknown as DomainRow[];
  }
  await emit(ctx, d.team_id, 'domain.updated', domainEventData(upd));
}

export async function deleteDomain(ctx: AppContext, d: DomainRow): Promise<void> {
  await ctx.sql`delete from domains where id = ${d.id}`;
  await ctx.sql`delete from jobs where unique_key = ${`domain_verify:${d.id}`}`;
  await emit(ctx, d.team_id, 'domain.deleted', domainEventData(d));
}
