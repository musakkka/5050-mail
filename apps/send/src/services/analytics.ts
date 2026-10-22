/**
 * Delivery outcomes from Cloudflare's GraphQL Analytics (`emailSendingAdaptive`).
 *
 * The production token may not yet have Account Analytics:Read; Cloudflare then
 * answers "not authorized for that account". We record that in system_state
 * (the dashboard shows a warning), back off, and leave emails at "sent". Once the
 * token gains the permission the next poll succeeds with no code change.
 */
import type { AppContext } from '../context.js';
import { CloudflareError } from '../cloudflare/client.js';
import { loadEmailForEvents, recordEvent, type EmailEventType } from './emailEvents.js';

export interface AnalyticsState {
  authorized: boolean | null;
  scope?: 'account' | 'zone';
  last_error?: string | null;
  last_attempt_at?: string | null;
  last_success_at?: string | null;
  backoff_until?: string | null;
  backoff_ms?: number;
  cursor?: string | null;
}

const KEY = 'cf_analytics';
const MIN_BACKOFF = 5 * 60_000;
const MAX_BACKOFF = 3600_000;

export async function analyticsState(ctx: AppContext): Promise<AnalyticsState> {
  const [r] = await ctx.sql`select value from system_state where key = ${KEY}`;
  return (r?.value as AnalyticsState) ?? { authorized: null };
}

async function saveState(ctx: AppContext, s: AnalyticsState) {
  await ctx.sql`insert into system_state (key, value) values (${KEY}, ${ctx.sql.json(s as never)})
                on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export interface CfSendingEvent {
  datetime: string;
  messageId?: string | null;
  status?: string | null;
  eventType?: string | null;
  errorCause?: string | null;
  errorDetail?: string | null;
  isSpam?: number | null;
  isNDR?: number | null;
  to?: string | null;
  from?: string | null;
  subject?: string | null;
  sendingDomain?: string | null;
}

const FIELDS = 'datetime messageId status eventType errorCause errorDetail isSpam isNDR to from subject sendingDomain';
const ACCOUNT_QUERY = `query SendEvents($accountTag: string!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    emailSendingAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 1000, orderBy: [datetime_ASC]) { ${FIELDS} }
  } } }`;
const ZONE_QUERY = `query SendEvents($zoneTag: string!, $since: Time!, $until: Time!) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    emailSendingAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: 1000, orderBy: [datetime_ASC]) { ${FIELDS} }
  } } }`;

const isAuthError = (m: string) => /not authori[sz]ed|authz|permission|forbidden|access denied/i.test(m);
const isSchemaError = (m: string) => /cannot query field|unknown field|unknown argument/i.test(m);

/** Map one Cloudflare event to our email event type (null = ignore). */
export function mapCfEvent(ev: CfSendingEvent): { type: EmailEventType; extra?: Record<string, unknown> } | null {
  const status = (ev.status ?? '').toLowerCase();
  if (ev.isSpam && status !== 'deliveryfailed') return { type: 'complained' };
  switch (status) {
    case 'delivered':
      return { type: 'delivered' };
    case 'deliveryfailed': {
      const detail = `${ev.errorCause ?? ''} ${ev.errorDetail ?? ''}`.trim();
      const code = /\b([245])\d\d\b/.exec(detail)?.[1] ?? /\b([245])\.\d+\.\d+\b/.exec(detail)?.[1];
      if (code === '4') return { type: 'delivery_delayed' };
      return {
        type: 'bounced',
        extra: { bounce: { message: detail || 'The recipient mail server rejected the email.', subType: ev.errorCause || 'General', type: code === '5' || !code ? 'Permanent' : 'Undetermined' } },
      };
    }
    case 'rejected':
      return { type: 'suppressed', extra: { suppressed: { message: ev.errorDetail || 'The recipient is on the Cloudflare suppression list.', type: 'OnAccountSuppressionList' } } };
    case 'failed':
      return { type: 'failed', extra: { failed: { reason: ev.errorCause || ev.errorDetail || 'delivery_failed' } } };
    default:
      return null;
  }
}

export async function applyCfEvents(ctx: AppContext, events: CfSendingEvent[]): Promise<number> {
  let n = 0;
  for (const ev of events) {
    if (!ev.messageId) continue;
    const mapped = mapCfEvent(ev);
    if (!mapped) continue;
    const mid = ev.messageId.trim();
    const bare = mid.replace(/^<|>$/g, '');
    const [row] = await ctx.sql`select id from emails where provider_message_id = any(${[mid, `<${bare}>`, bare]}) or message_id = any(${[mid, `<${bare}>`]}) limit 1`;
    if (!row) continue;
    const email = await loadEmailForEvents(ctx, row.id as string);
    if (!email) continue;
    const ok = await recordEvent(ctx, email, mapped.type, {
      recipients: ev.to ? [ev.to] : undefined,
      extra: mapped.extra,
      at: new Date(ev.datetime),
      dedupeKey: `cf:${bare}:${ev.to ?? ''}:${ev.status}:${ev.datetime}`,
    });
    if (ok) n++;
  }
  return n;
}

/** One poll (worker, every ANALYTICS_POLL_INTERVAL_SEC). */
export async function pollAnalytics(ctx: AppContext): Promise<{ status: 'skipped' | 'unauthorized' | 'error' | 'ok'; applied?: number }> {
  if (!ctx.cf) return { status: 'skipped' };
  const st = await analyticsState(ctx);
  const now = ctx.now();
  if (st.backoff_until && new Date(st.backoff_until) > now) return { status: 'skipped' };
  const since = st.cursor ? new Date(new Date(st.cursor).getTime() - 5 * 60_000) : new Date(now.getTime() - 3600_000);
  const vars = { since: since.toISOString(), until: now.toISOString() };
  const url = ctx.config.cloudflareGraphqlUrl;
  const next: AnalyticsState = { ...st, last_attempt_at: now.toISOString() };
  try {
    let events: CfSendingEvent[] = [];
    let errors: { message: string }[] = [];
    let scope: 'account' | 'zone' = st.scope ?? 'account';
    if (scope === 'account') {
      const r = await ctx.cf.cf.graphql<{ viewer: { accounts: { emailSendingAdaptive: CfSendingEvent[] }[] } }>(url, ACCOUNT_QUERY, { accountTag: ctx.cf.cf.accountId ?? '', ...vars });
      errors = r.errors;
      if (errors.length && errors.every((e) => isSchemaError(e.message))) scope = 'zone';
      else events = r.data?.viewer?.accounts?.flatMap((a) => a.emailSendingAdaptive ?? []) ?? [];
    }
    if (scope === 'zone') {
      errors = [];
      const zones = await ctx.sql`select distinct cf_zone_id from domains where cf_zone_id is not null`;
      for (const z of zones) {
        const r = await ctx.cf.cf.graphql<{ viewer: { zones: { emailSendingAdaptive: CfSendingEvent[] }[] } }>(url, ZONE_QUERY, { zoneTag: z.cf_zone_id as string, ...vars });
        errors.push(...r.errors);
        events.push(...(r.data?.viewer?.zones?.flatMap((x) => x.emailSendingAdaptive ?? []) ?? []));
      }
    }
    next.scope = scope;
    if (errors.length && !events.length) {
      const msg = errors.map((e) => e.message).join('; ').slice(0, 500);
      const backoff = Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, (st.backoff_ms ?? 0) * 2));
      next.last_error = msg;
      next.backoff_ms = backoff;
      next.backoff_until = new Date(now.getTime() + backoff).toISOString();
      if (isAuthError(msg)) {
        if (st.authorized !== false) ctx.log('analytics', 'Cloudflare analytics not authorized for this token; delivery events limited to send-time results', { error: msg });
        next.authorized = false;
        await saveState(ctx, next);
        return { status: 'unauthorized' };
      }
      ctx.log('analytics', 'GraphQL error', { error: msg });
      await saveState(ctx, next);
      return { status: 'error' };
    }
    const applied = await applyCfEvents(ctx, events);
    const maxTs = events.reduce((m, e) => (e.datetime > m ? e.datetime : m), st.cursor ?? since.toISOString());
    Object.assign(next, { authorized: true, last_error: null, backoff_ms: 0, backoff_until: null, last_success_at: now.toISOString(), cursor: maxTs });
    if (st.authorized === false) ctx.log('analytics', 'Cloudflare analytics access restored');
    await saveState(ctx, next);
    return { status: 'ok', applied };
  } catch (e) {
    const msg = e instanceof CloudflareError ? e.message : (e as Error).message;
    const backoff = Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, (st.backoff_ms ?? 0) * 2));
    Object.assign(next, { last_error: msg, backoff_ms: backoff, backoff_until: new Date(now.getTime() + backoff).toISOString() });
    await saveState(ctx, next);
    ctx.log('analytics', 'poll failed', { error: msg });
    return { status: 'error' };
  }
}
