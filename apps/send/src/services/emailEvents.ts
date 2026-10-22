/** Email lifecycle events: timeline rows, `last_event`, webhooks, suppressions. */
import type { AppContext } from '../context.js';
import { pgToIso } from '../db.js';
import { emit, type WebhookEventType } from './webhooks.js';

export type EmailEventType =
  | 'queued' | 'scheduled' | 'sent' | 'delivered' | 'delivery_delayed' | 'bounced'
  | 'complained' | 'opened' | 'clicked' | 'failed' | 'suppressed' | 'canceled' | 'unsubscribed';

export interface EmailRow {
  id: string;
  team_id: string;
  domain_id: string | null;
  broadcast_id: string | null;
  template_id: string | null;
  contact_id?: string | null;
  from_addr: string;
  to_addrs: string[];
  cc: string[] | null;
  bcc: string[] | null;
  subject: string;
  message_id: string;
  tags: { name: string; value: string }[] | null;
  created_at: string;
}

export const EMAIL_EVENT_COLUMNS = 'id, team_id, domain_id, broadcast_id, template_id, contact_id, from_addr, to_addrs, cc, bcc, subject, message_id, tags, created_at';

/** The common `data` of every email.* webhook (https://resend.com/docs/webhooks/emails/sent). */
export function baseEventData(e: EmailRow, recipients?: string[]): Record<string, unknown> {
  const tags = e.tags?.length ? Object.fromEntries(e.tags.map((t) => [t.name, t.value])) : undefined;
  return {
    ...(e.broadcast_id ? { broadcast_id: e.broadcast_id } : {}),
    created_at: pgToIso(e.created_at),
    email_id: e.id,
    from: e.from_addr,
    to: recipients?.length ? recipients : e.to_addrs,
    message_id: e.message_id,
    subject: e.subject,
    ...(e.template_id ? { template_id: e.template_id } : {}),
    ...(tags ? { tags } : {}),
  };
}

export interface RecordOpts {
  recipients?: string[];
  /** Extra webhook data, e.g. `{ bounce: {...} }`, `{ click: {...} }`. */
  extra?: Record<string, unknown>;
  at?: Date;
  dedupeKey?: string;
  /** false: timeline only (no webhook). */
  webhook?: boolean;
}

/** Returns false when the event was a duplicate (same dedupeKey). */
export async function recordEvent(ctx: AppContext, e: EmailRow, type: EmailEventType, opts: RecordOpts = {}): Promise<boolean> {
  const at = (opts.at ?? ctx.now()).toISOString();
  const data = { ...(opts.recipients ? { recipients: opts.recipients } : {}), ...(opts.extra ?? {}) };
  const ins = await ctx.sql`
    insert into email_events (email_id, team_id, domain_id, broadcast_id, type, recipient, data, dedupe_key, created_at)
    values (${e.id}, ${e.team_id}, ${e.domain_id}, ${e.broadcast_id}, ${type}, ${opts.recipients?.[0] ?? null},
            ${ctx.sql.json(data as never)}, ${opts.dedupeKey ?? null}, ${at})
    on conflict do nothing
    returning id`;
  if (!ins.length) return false;
  if (type !== 'unsubscribed') {
    await ctx.sql`
      update emails set last_event = ${type}, last_event_at = ${at}, updated_at = now()
      where id = ${e.id} and last_event_at <= ${at}`;
  }
  if (opts.webhook !== false && type !== 'queued' && type !== 'canceled' && type !== 'unsubscribed') {
    await emit(ctx, e.team_id, `email.${type}` as WebhookEventType, { ...baseEventData(e, opts.recipients), ...(opts.extra ?? {}) });
  }
  if (type === 'bounced' && (opts.extra?.bounce as { type?: string } | undefined)?.type === 'Permanent') {
    for (const r of opts.recipients ?? []) if (!/@resend\.dev$/i.test(r)) await addSuppression(ctx, e.team_id, r, 'bounce', e.id);
  }
  if (type === 'complained') {
    for (const r of opts.recipients ?? e.to_addrs) if (!/@resend\.dev$/i.test(r)) await addSuppression(ctx, e.team_id, r, 'complaint', e.id);
  }
  return true;
}

export async function addSuppression(ctx: AppContext, teamId: string, email: string, origin: 'bounce' | 'complaint' | 'manual', sourceId: string | null) {
  const rows = await ctx.sql`
    insert into suppressions (team_id, email, origin, source_id) values (${teamId}, ${email.toLowerCase()}, ${origin}, ${sourceId})
    on conflict (team_id, lower(email)) do nothing
    returning id, email, origin, source_id, created_at`;
  if (rows.length) {
    const r = rows[0]!;
    await emit(ctx, teamId, 'suppression.added', {
      id: r.id, email: r.email, origin: r.origin, source_id: r.source_id, created_at: pgToIso(r.created_at as string),
    });
  }
  return rows[0];
}

export async function loadEmailForEvents(ctx: AppContext, id: string): Promise<EmailRow | null> {
  const [row] = await ctx.sql`select id, team_id, domain_id, broadcast_id, template_id, contact_id, from_addr, to_addrs, cc, bcc, subject, message_id, tags, created_at from emails where id = ${id}`;
  return (row as unknown as EmailRow) ?? null;
}
