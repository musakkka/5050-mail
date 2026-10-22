/**
 * One-click domain setup: the BFF's /api/admin/cloudflare/* endpoints (the
 * Cloudflare token stays on the server) and the pure logic behind the setup
 * checklist and the "Sending" card. Pure parts are tested in cloudflare.test.ts.
 *
 * Only domains whose DNS is in this server's Cloudflare account can be
 * connected. (Domain Connect, which Railway uses, could reach other accounts,
 * but needs a service template approved by Cloudflare first: a future option.)
 */
import { CSRF_HEADERS } from '../api/auth';
import { dkimHealth, normalizeDomain, tlsHealth, type Health } from './model';
import type { Certificate, DkimSignature, Domain, DomainTask } from './types';

// ------------------------------------------------------------------ API types (mirror server/src/cloudflare.ts)

export interface RecordCheck {
  type: string;
  name: string;
  content: string;
  priority?: number;
  kind?: string;
  present: boolean;
  conflict?: string;
}

export interface CloudflareDomainStatus {
  domain: string;
  zone: string | null;
  /** false: the server delivers its own mail (no Cloudflare Email Sending); ready = the domain's records are in the zone. */
  emailSending?: boolean;
  sending: { onboarded: boolean; enabled: boolean; returnPath?: string };
  bounceRecords: RecordCheck[];
  stalwartRecords: RecordCheck[];
  sendingReady: boolean;
}

export type ConnectStepId = 'zone' | 'sending' | 'records' | 'verify';
export interface ConnectStep {
  id: ConnectStepId;
  status: 'ok' | 'created' | 'error' | 'skipped';
  detail?: string;
}

export interface ConnectResult {
  domain: string;
  zone: string | null;
  ok: boolean;
  steps: ConnectStep[];
  status?: CloudflareDomainStatus;
  /** Set when the request itself failed (network, 5xx, validation). */
  message?: string;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

const BASE = '/api/admin/cloudflare';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...CSRF_HEADERS, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    const err = new CloudflareApiError(body.message ?? `Request failed (${res.status})`, res.status, body.error);
    (err as CloudflareApiError & { body?: unknown }).body = body;
    throw err;
  }
  return body;
}

export const cloudflareApi = {
  /** Zone names, or null when Cloudflare isn't configured on the server (the feature hides itself). */
  async zones(): Promise<string[] | null> {
    try {
      return (await call<{ zones: string[] }>('/zones')).zones;
    } catch (e) {
      if (e instanceof CloudflareApiError && e.code === 'not_configured') return null;
      throw e;
    }
  },
  status(domain: string): Promise<CloudflareDomainStatus> {
    return call(`/domain-status?domain=${encodeURIComponent(domain)}`);
  },
  /** Never throws for Cloudflare-side problems: they come back as failed steps. */
  async connect(domain: string): Promise<ConnectResult> {
    try {
      return await call<ConnectResult>('/connect', { method: 'POST', body: JSON.stringify({ domain }) });
    } catch (e) {
      const body = (e as { body?: Partial<ConnectResult> }).body;
      if (body?.steps) return { domain, zone: null, ok: false, steps: body.steps, message: (e as Error).message };
      return { domain, zone: null, ok: false, steps: [], message: (e as Error).message };
    }
  },
};

// ------------------------------------------------------------------ DNS check (works without Cloudflare)

export interface DnsCheckRecord extends Omit<RecordCheck, 'conflict'> {
  found: string[];
}
export interface DnsCheckResult {
  domain: string;
  ok: boolean;
  records: DnsCheckRecord[];
}

export const dnsApi = {
  /** Resolve the domain's required records in public DNS (admin only). */
  async check(domain: string): Promise<DnsCheckResult> {
    const res = await fetch(`/api/admin/dns/check?domain=${encodeURIComponent(domain)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...CSRF_HEADERS },
    });
    const body = (await res.json().catch(() => ({}))) as DnsCheckResult & { message?: string; error?: string };
    if (!res.ok) throw new CloudflareApiError(body.message ?? `Request failed (${res.status})`, res.status, body.error);
    return body;
  },
};

/** Key for matching a check to a row of the records table. */
export const recordKey = (fqdn: string, type: string, content: string) => `${fqdn.toLowerCase().replace(/\.$/, '')}|${type}|${content.replace(/\s+/g, '').toLowerCase()}`;

// ------------------------------------------------------------------ zones

/** The most specific zone containing `domain` (mail.example.com → example.com), if any. */
export function zoneFor(domain: string, zones: string[]): string | undefined {
  const d = normalizeDomain(domain);
  return zones
    .filter((z) => d === z || d.endsWith(`.${z}`))
    .sort((a, b) => b.length - a.length)[0];
}

/** Records the one-click flow asks Stalwart to publish. SRV off; SPF is fine since the relay's return path is cf-bounce.<domain>. */
export const ONE_CLICK_RECORDS = ['mx', 'dkim', 'spf', 'dmarc', 'tlsRpt'] as const;

// ------------------------------------------------------------------ checklist

export type StepState = 'done' | 'active' | 'error' | 'skipped' | 'waiting';
export interface ChecklistStep {
  id: 'created' | 'dns' | 'dkim' | 'sending' | 'tls' | 'ready';
  label: string;
  state: StepState;
  detail?: string;
}

export interface ChecklistInput {
  /** undefined while creating. */
  created?: boolean;
  createError?: string;
  domain?: Domain | null;
  signatures?: DkimSignature[];
  certificates?: Certificate[];
  tasks?: DomainTask[];
  cf?: CloudflareDomainStatus;
  /** undefined while running. */
  connect?: ConnectResult;
}

const fromHealth = (h: Health): StepState =>
  h.state === 'ok' ? 'done' : h.state === 'error' || h.state === 'warning' ? 'error' : h.state === 'off' ? 'skipped' : 'active';

const failure = (t?: DomainTask) => (t && t.status['@type'] !== 'Pending' ? (t.status.failureReason ?? 'Unknown error') : undefined);

export function connectChecklist(i: ChecklistInput): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  const createdState: StepState = i.createError ? 'error' : i.created ? 'done' : 'active';
  steps.push({ id: 'created', label: 'Domain created', state: createdState, detail: i.createError });
  const d = i.created ? i.domain : null;
  if (!d) {
    for (const [id, label] of [
      ['dns', 'DNS records published'],
      ['dkim', 'DKIM keys'],
      ['sending', 'Email sending enabled'],
      ['tls', 'TLS certificate'],
    ] as const)
      steps.push({ id, label, state: 'waiting' });
  } else {
    const tasks = i.tasks ?? [];
    // DNS: Stalwart's own records, as seen in the Cloudflare zone.
    const dnsFail = failure(tasks.find((t) => t.domainId === d.id && t['@type'] === 'DnsManagement'));
    const recs = i.cf?.stalwartRecords ?? [];
    const present = recs.filter((r) => r.present).length;
    if (recs.length && present === recs.length) steps.push({ id: 'dns', label: 'DNS records published', state: 'done', detail: `${present} records in ${i.cf?.zone}` });
    else if (dnsFail) steps.push({ id: 'dns', label: 'DNS records published', state: 'error', detail: `Retrying: ${dnsFail}` });
    else steps.push({ id: 'dns', label: 'DNS records published', state: 'active', detail: recs.length ? `${present} of ${recs.length} records` : undefined });

    const dk = dkimHealth(d, i.signatures ?? [], tasks);
    steps.push({ id: 'dkim', label: 'DKIM keys', state: fromHealth(dk), detail: dk.state === 'ok' ? dk.label : dk.detail ?? dk.label });

    const c = i.connect;
    if (i.cf?.emailSending === false) {
      // Direct delivery: nothing to onboard; the DNS step above covers the records.
      steps.push({ id: 'sending', label: 'Email sending', state: 'skipped', detail: 'Delivered directly by this server' });
    } else if (i.cf?.sendingReady) steps.push({ id: 'sending', label: 'Email sending enabled', state: 'done', detail: i.cf.sending.returnPath ? `Return path ${i.cf.sending.returnPath}` : undefined });
    else if (!c) steps.push({ id: 'sending', label: 'Email sending enabled', state: 'active' });
    else if (c.ok) steps.push({ id: 'sending', label: 'Email sending enabled', state: 'done' });
    else {
      const bad = c.steps.find((s) => s.status === 'error');
      steps.push({ id: 'sending', label: 'Email sending enabled', state: 'error', detail: bad?.detail ?? c.message ?? 'Cloudflare setup failed' });
    }

    const tls = tlsHealth(d, i.certificates ?? [], tasks);
    const tlsState = fromHealth(tls);
    steps.push({
      id: 'tls',
      label: 'TLS certificate',
      state: tlsState,
      detail: tlsState === 'active' ? 'Can take a few minutes' : tlsState === 'skipped' ? 'Managed manually' : tls.state === 'ok' ? tls.label : tls.detail,
    });
  }
  const all = steps.every((s) => s.state === 'done' || s.state === 'skipped');
  steps.push({ id: 'ready', label: 'Ready', state: all ? 'done' : 'waiting', detail: all ? 'Mail can be sent and received' : undefined });
  return steps;
}

export const checklistComplete = (steps: ChecklistStep[]) => steps.at(-1)?.state === 'done';

// ------------------------------------------------------------------ sending card

export function sendingHealth(s: CloudflareDomainStatus | undefined): Health {
  if (!s) return { state: 'pending', label: 'Checking…' };
  if (!s.zone)
    return {
      state: 'off',
      label: 'Not on Cloudflare',
      detail: "This domain's DNS isn't in the server's Cloudflare account: add the records below at its DNS provider, then use Check DNS.",
    };
  if (s.emailSending === false) {
    if (s.sendingReady) return { state: 'ok', label: 'Records published', detail: `All mail records are in the ${s.zone} zone` };
    const missing = s.stalwartRecords.filter((r) => !r.present);
    return {
      state: 'warning',
      label: 'Records missing',
      detail: missing.length ? missing.map((r) => `${r.type} ${r.name}${r.conflict ? ` (${r.conflict})` : ''}`).join(', ') : 'The mail server has not produced records yet',
    };
  }
  if (s.sendingReady) return { state: 'ok', label: 'Sending enabled', detail: s.sending.returnPath ? `Bounces return to ${s.sending.returnPath}` : undefined };
  if (!s.sending.onboarded || !s.sending.enabled)
    return { state: 'error', label: 'Not enabled', detail: 'Cloudflare rejects outgoing mail from this domain (550 5.7.1) until Email Sending is enabled.' };
  const missing = s.bounceRecords.filter((r) => !r.present);
  return {
    state: 'warning',
    label: 'Records missing',
    detail: missing.map((r) => `${r.type} ${r.name}${r.conflict ? ` (${r.conflict})` : ''}`).join(', '),
  };
}
