/**
 * Receiving via Stalwart: a domain's receiving MX points at mail-1, Stalwart routes
 * the receiving domains into one catch-all mailbox, and the worker polls it over JMAP.
 * Each message is downloaded as raw MIME, ingested with ingestRaw() (same path as
 * POST /inbound), then moved to "Processed" (or destroyed with INBOUND_JMAP_MODE=destroy).
 *
 * Env: INBOUND_JMAP_URL (Stalwart base, e.g. https://mail.example.com),
 *      INBOUND_JMAP_USER, INBOUND_JMAP_PASSWORD, INBOUND_JMAP_MODE=move|destroy,
 *      INBOUND_JMAP_MAILBOX (mailbox name to read; default: the account's inbox),
 *      INBOUND_JMAP_INTERVAL_SEC (default 15).
 */
import type { AppContext } from '../context.js';
import { ingestRaw } from './inbound.js';

export interface JmapInboundConfig {
  url: string;
  user: string;
  password: string;
  mode: 'move' | 'destroy';
  /** Mailbox name to poll; null = the role:inbox mailbox. */
  mailbox: string | null;
}

export function jmapInboundConfig(env: NodeJS.ProcessEnv = process.env): JmapInboundConfig | null {
  if (!env.INBOUND_JMAP_URL || !env.INBOUND_JMAP_USER || !env.INBOUND_JMAP_PASSWORD) return null;
  return {
    url: env.INBOUND_JMAP_URL.replace(/\/+$/, ''),
    user: env.INBOUND_JMAP_USER,
    password: env.INBOUND_JMAP_PASSWORD,
    mode: env.INBOUND_JMAP_MODE === 'destroy' ? 'destroy' : 'move',
    mailbox: env.INBOUND_JMAP_MAILBOX || null,
  };
}

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

/** Rebase Stalwart's advertised URLs (which may name its public host) onto the configured base. */
function rebase(base: string, advertised: string): string {
  try {
    const a = new URL(advertised);
    const b = new URL(base);
    return `${b.origin}${a.pathname}${a.search}`.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return advertised;
  }
}

/** Envelope recipients from the delivery headers Stalwart (or a forwarder) adds. */
export function envelopeFromHeaders(raw: Buffer): string[] {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1').split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const out: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^(delivered-to|x-original-to|envelope-to|x-envelope-to)\s*:\s*(.+)$/i.exec(line);
    if (m) for (const a of m[2]!.split(',')) out.push(a.trim().replace(/^<|>$/g, ''));
  }
  if (!out.length) {
    for (const line of unfolded.split(/\r?\n/)) {
      if (!/^received\s*:/i.test(line)) continue;
      const f = /\bfor\s+<?([^\s<>;]+@[^\s<>;]+)>?/i.exec(line);
      if (f) out.push(f[1]!);
    }
  }
  return [...new Set(out.filter((a) => a.includes('@')).map((a) => a.toLowerCase()))];
}

export class JmapInboundPoller {
  private session: { apiUrl: string; downloadUrl: string; accountId: string } | null = null;
  private inboxId: string | null = null;
  private processedId: string | null = null;
  constructor(private ctx: AppContext, private cfg: JmapInboundConfig) {}

  private auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString('base64');
  }

  private async call(methodCalls: unknown[]): Promise<[string, Record<string, unknown>, string][]> {
    const s = await this.ensureSession();
    const res = await fetch(s.apiUrl, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: USING, methodCalls }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`JMAP ${res.status}`);
    const j = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
    for (const r of j.methodResponses) if (r[0] === 'error') throw new Error(`JMAP error: ${JSON.stringify(r[1])}`);
    return j.methodResponses;
  }

  private async ensureSession() {
    if (this.session) return this.session;
    const res = await fetch(`${this.cfg.url}/jmap/session`, { headers: { Authorization: this.auth() }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`JMAP session ${res.status}`);
    const s = (await res.json()) as { apiUrl: string; downloadUrl: string; primaryAccounts: Record<string, string> };
    this.session = {
      apiUrl: rebase(this.cfg.url, s.apiUrl),
      downloadUrl: rebase(this.cfg.url, s.downloadUrl),
      accountId: s.primaryAccounts['urn:ietf:params:jmap:mail']!,
    };
    return this.session;
  }

  private async mailboxes() {
    if (this.inboxId && (this.processedId || this.cfg.mode === 'destroy')) return;
    const s = await this.ensureSession();
    const [r] = await this.call([['Mailbox/get', { accountId: s.accountId, properties: ['id', 'name', 'role', 'parentId'] }, 'm']]);
    const list = (r![1].list as { id: string; name: string; role: string | null; parentId: string | null }[]) ?? [];
    this.inboxId = (this.cfg.mailbox ? list.find((m) => m.name === this.cfg.mailbox) : list.find((m) => m.role === 'inbox'))?.id ?? null;
    if (!this.inboxId) throw new Error(`catch-all account has no ${this.cfg.mailbox ?? 'inbox'} mailbox`);
    if (this.cfg.mode === 'move') {
      this.processedId = list.find((m) => m.name === 'Processed' && !m.parentId)?.id ?? null;
      if (!this.processedId) {
        const [c] = await this.call([['Mailbox/set', { accountId: s.accountId, create: { p: { name: 'Processed', parentId: null } } }, 'c']]);
        this.processedId = ((c![1].created as Record<string, { id: string }>)?.p?.id) ?? null;
        if (!this.processedId) throw new Error('could not create the Processed mailbox');
      }
    }
  }

  /** One pass. Returns the number of messages ingested. */
  async pollOnce(limit = 50): Promise<number> {
    await this.mailboxes();
    const s = await this.ensureSession();
    const res = await this.call([
      ['Email/query', { accountId: s.accountId, filter: { inMailbox: this.inboxId }, sort: [{ property: 'receivedAt', isAscending: true }], limit }, 'q'],
      ['Email/get', { accountId: s.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'blobId'] }, 'g'],
    ]);
    const emails = (res[1]![1].list as { id: string; blobId: string }[]) ?? [];
    let n = 0;
    for (const e of emails) {
      const url = s.downloadUrl
        .replace('{accountId}', encodeURIComponent(s.accountId))
        .replace('{blobId}', encodeURIComponent(e.blobId))
        .replace('{name}', 'message.eml')
        .replace('{type}', encodeURIComponent('message/rfc822'));
      const dl = await fetch(url, { headers: { Authorization: this.auth() }, signal: AbortSignal.timeout(60_000) });
      if (!dl.ok) {
        this.ctx.log('inbound', 'jmap download failed', { status: dl.status });
        continue;
      }
      const raw = Buffer.from(await dl.arrayBuffer());
      const env = envelopeFromHeaders(raw);
      const r = await ingestRaw(this.ctx, raw, env.length ? env : undefined);
      if (r.unmatched.length) this.ctx.log('inbound', 'recipients with no receiving domain', { count: r.unmatched.length });
      const update = this.cfg.mode === 'destroy'
        ? { destroy: [e.id] }
        : { update: { [e.id]: { mailboxIds: { [this.processedId!]: true }, keywords: { $seen: true } } } };
      await this.call([['Email/set', { accountId: s.accountId, ...update }, 's']]);
      n++;
    }
    return n;
  }
}
