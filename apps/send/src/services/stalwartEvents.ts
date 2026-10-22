/**
 * Delivery feedback from the local mail server (Stalwart). Stalwart POSTs batches of log events to
 * /internal/stalwart-events; this maps them onto Send's email events:
 *
 *   delivery.dsn-success    -> email.delivered           (one event per recipient)
 *   delivery.dsn-perm-fail  -> email.bounced             (+ suppression for Permanent bounces)
 *   delivery.dsn-temp-fail  -> email.delivery_delayed    (first deferral per recipient)
 *   queue.rescheduled       -> email.delivery_delayed    (recipients with no outcome yet)
 *   queue.blob-not-found    -> email.failed
 *
 * Correlation is the queue id Stalwart returned in its 250 reply (emails.smtp_queue_id). Everything
 * is idempotent through per-recipient dedupe keys, so redelivered webhooks change nothing.
 */
import type { AppContext } from '../context.js';
import { loadEmailForEvents, recordEvent, type EmailEventType, type EmailRow } from './emailEvents.js';

export interface StalwartEvent {
  id?: string;
  type: string;
  createdAt?: string;
  data: Record<string, unknown>;
}

export interface MappedEvent {
  queueId: string;
  type: Extract<EmailEventType, 'delivered' | 'bounced' | 'delivery_delayed' | 'failed'>;
  /** Recipients the event is about. `all`: every recipient of the queue message (those without an outcome yet). */
  recipients: string[];
  scope: 'recipient' | 'message';
  extra?: Record<string, unknown>;
  at: Date;
}

export const SUBSCRIBED_EVENTS = ['delivery.dsn-success', 'delivery.dsn-perm-fail', 'delivery.dsn-temp-fail', 'queue.rescheduled', 'queue.blob-not-found'] as const;

/** Queue ids are 64-bit integers, beyond what JSON.parse keeps exactly: quote them first. */
export function parseEventsBody(raw: string): StalwartEvent[] {
  const quoted = raw.replace(/"queueId"\s*:\s*(\d+)/g, '"queueId":"$1"');
  const body = JSON.parse(quoted) as { events?: unknown };
  const list = Array.isArray(body?.events) ? body.events : [];
  return list.filter((e): e is StalwartEvent => !!e && typeof e === 'object' && typeof (e as StalwartEvent).type === 'string' && !!(e as StalwartEvent).data && typeof (e as StalwartEvent).data === 'object');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const recipientsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** Text Stalwart gives for a failure (field names vary by event), plus the SMTP reply code. */
function failureText(d: Record<string, unknown>): { text: string; code?: number } {
  const parts = ['details', 'reason', 'error', 'message', 'response', 'status'].map((k) => str(d[k])).filter((x): x is string => !!x);
  const code = Number(d.code);
  return { text: [...new Set(parts)].join(' ').slice(0, 1000), code: Number.isFinite(code) && code >= 100 ? code : undefined };
}

/** Resend's bounce vocabulary (type + subType) from an SMTP failure. */
export function classifyBounce(text: string, code?: number): { type: 'Permanent' | 'Transient' | 'Undetermined'; subType: string; message: string } {
  const enhanced = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text);
  const cls = enhanced ? Number(enhanced[1]) : code ? Math.floor(code / 100) : 0;
  const sub = enhanced ? `${enhanced[2]}.${enhanced[3]}` : '';
  const message = text || "The recipient's mail server permanently rejected the email.";
  if (/mailbox (?:is )?full|over quota|quota exceeded/i.test(text) || sub === '2.2') return { type: 'Transient', subType: 'MailboxFull', message };
  if (/too large|message size|exceeds .*size/i.test(text) || sub === '3.4') return { type: 'Transient', subType: 'MessageTooLarge', message };
  if (/attachment/i.test(text) && /reject|block|not allowed/i.test(text)) return { type: 'Transient', subType: 'AttachmentRejected', message };
  if (/spam|content|policy|blocked|blacklist|denied/i.test(text) || enhanced?.[2] === '7') return { type: 'Transient', subType: 'ContentRejected', message };
  if (/expired|too many (?:attempts|retries)|timed? ?out/i.test(text) || cls === 4) return { type: 'Transient', subType: 'General', message };
  if (/user unknown|no such user|does not exist|unknown recipient|invalid (?:mailbox|recipient|address)|nxdomain|no mx|not found/i.test(text) || (enhanced && enhanced[2] === '1' && ['1', '2', '3', '4', '6'].includes(enhanced[3]!))) {
    return { type: 'Permanent', subType: 'NoEmail', message };
  }
  return { type: 'Permanent', subType: 'General', message };
}

/** One Stalwart event -> our event (null: not an outcome we track). Pure. */
export function mapStalwartEvent(ev: StalwartEvent, now = new Date()): MappedEvent | null {
  const d = ev.data;
  const queueId = typeof d.queueId === 'string' || typeof d.queueId === 'number' ? String(d.queueId) : '';
  if (!/^\d+$/.test(queueId)) return null;
  const at = ev.createdAt && !Number.isNaN(Date.parse(ev.createdAt)) ? new Date(ev.createdAt) : now;
  switch (ev.type) {
    case 'delivery.dsn-success': {
      const to = recipientsOf(d.to);
      return to.length ? { queueId, type: 'delivered', recipients: to, scope: 'recipient', at } : null;
    }
    case 'delivery.dsn-perm-fail': {
      const to = recipientsOf(d.to);
      if (!to.length) return null;
      const { text, code } = failureText(d);
      return { queueId, type: 'bounced', recipients: to, scope: 'recipient', extra: { bounce: classifyBounce(text, code) }, at };
    }
    case 'delivery.dsn-temp-fail': {
      const to = recipientsOf(d.to);
      return to.length ? { queueId, type: 'delivery_delayed', recipients: to, scope: 'recipient', at } : null;
    }
    case 'queue.rescheduled': {
      const to = recipientsOf(d.to);
      return to.length ? { queueId, type: 'delivery_delayed', recipients: to, scope: 'message', at } : null;
    }
    case 'queue.blob-not-found':
      return { queueId, type: 'failed', recipients: [], scope: 'message', extra: { failed: { reason: 'message_lost_in_mail_queue' } }, at };
    default:
      return null;
  }
}

const finalKey = (queueId: string, rcpt: string) => `stw:final:${queueId}:${rcpt.toLowerCase()}`;
const delayedKey = (queueId: string, rcpt: string) => `stw:delayed:${queueId}:${rcpt.toLowerCase()}`;

/** Record one mapped event for a known email. Returns how many timeline events were new. */
async function applyToEmail(ctx: AppContext, email: EmailRow, floor: Date | null, m: MappedEvent): Promise<number> {
  // Stalwart's timestamps have second resolution: never place an outcome before what we already recorded
  // (e.g. `sent`), so the timeline reads sent -> delivered and the newest-event rule follows arrival order.
  const at = floor && floor > m.at ? floor : m.at;
  const byLower = new Map([...email.to_addrs, ...(email.cc ?? []), ...(email.bcc ?? [])].map((a) => [bareAddress(a).toLowerCase(), bareAddress(a)]));
  const spell = (r: string) => byLower.get(r.toLowerCase()) ?? r;

  if (m.type === 'failed') {
    return (await recordEvent(ctx, email, 'failed', { extra: m.extra, at, dedupeKey: `stw:failed:${m.queueId}` })) ? 1 : 0;
  }
  let n = 0;
  let rcpts = m.recipients.map(spell);
  if (m.scope === 'message') {
    // queue.rescheduled lists every recipient of the message: only those still waiting are delayed.
    const keys = rcpts.map((r) => finalKey(m.queueId, r));
    const done = await ctx.sql`select dedupe_key from email_events where dedupe_key = any(${keys})`;
    const doneSet = new Set(done.map((r) => r.dedupe_key as string));
    rcpts = rcpts.filter((r) => !doneSet.has(finalKey(m.queueId, r)));
  }
  for (const r of rcpts) {
    if (m.type === 'delivery_delayed') {
      if (m.scope === 'recipient') {
        const [fin] = await ctx.sql`select 1 from email_events where dedupe_key = ${finalKey(m.queueId, r)}`;
        if (fin) continue;
      }
      if (await recordEvent(ctx, email, 'delivery_delayed', { recipients: [r], at, dedupeKey: delayedKey(m.queueId, r) })) n++;
    } else {
      // Per recipient the first outcome (delivered or bounced) wins: both share one dedupe key.
      if (await recordEvent(ctx, email, m.type, { recipients: [r], extra: m.extra, at, dedupeKey: finalKey(m.queueId, r) })) n++;
    }
  }
  return n;
}

const bareAddress = (a: string) => /<([^>]+)>/.exec(a)?.[1] ?? a;

async function findEmailByQueue(ctx: AppContext, queueId: string): Promise<{ email: EmailRow; floor: Date | null } | null> {
  const [row] = await ctx.sql`select id, last_event_at from emails where smtp_queue_id = ${queueId} limit 1`;
  if (!row) return null;
  const email = await loadEmailForEvents(ctx, row.id as string);
  return email ? { email, floor: row.last_event_at ? new Date(row.last_event_at as string) : null } : null;
}

/** Apply a batch from Stalwart. Events for queue ids we do not know yet are parked for a replay. */
export async function applyStalwartEvents(ctx: AppContext, events: StalwartEvent[]): Promise<{ applied: number; parked: number; ignored: number }> {
  let applied = 0, parked = 0, ignored = 0;
  for (const ev of events) {
    const m = mapStalwartEvent(ev, ctx.now());
    if (!m) {
      ignored++;
      continue;
    }
    const hit = await findEmailByQueue(ctx, m.queueId);
    if (hit) {
      applied += await applyToEmail(ctx, hit.email, hit.floor, m);
    } else {
      await ctx.sql`insert into stalwart_pending_events (queue_id, event) values (${m.queueId}, ${ctx.sql.json(ev as never)})`;
      parked++;
    }
  }
  return { applied, parked, ignored };
}

/** Called by the worker once it has stored an email's queue id (and recorded `sent`). */
export async function replayPendingStalwartEvents(ctx: AppContext, queueId: string): Promise<number> {
  const rows = await ctx.sql`delete from stalwart_pending_events where queue_id = ${queueId} returning event, id`;
  if (!rows.length) return 0;
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  const r = await applyStalwartEvents(ctx, rows.map((x) => x.event as StalwartEvent));
  return r.applied;
}

export async function purgePendingStalwartEvents(ctx: AppContext): Promise<void> {
  await ctx.sql`delete from stalwart_pending_events where created_at < now() - interval '1 hour'`;
}
