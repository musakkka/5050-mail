/** GET /emails/metrics and the dashboard Metrics page, computed from email_events. */
import type { AppContext } from '../context.js';
import { E } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';

export const METRICS = [
  'received', 'delivered', 'complained', 'suppressed', 'bounced', 'bounced_transient', 'bounced_permanent', 'bounced_undetermined',
  'opened', 'clicked', 'unsubscribed', 'delivery_delayed', 'failed', 'sent', 'unique_opened', 'unique_clicked',
  'delivery_rate', 'open_rate', 'click_rate', 'bounce_rate', 'complaint_rate', 'unsubscribe_rate',
] as const;
export type Metric = (typeof METRICS)[number];
const DIMENSIONS = ['period', 'domain', 'email', 'broadcast'] as const;
const GRANULARITY = ['hourly', 'daily', 'weekly', 'monthly'] as const;

export interface MetricsQuery {
  start_date?: string;
  end_date?: string;
  timezone?: string;
  granularity?: string;
  metrics?: string[];
  dimensions?: string[];
  domain_id?: string[];
  email_id?: string[];
  broadcast_id?: string[];
}

const multi = (v: string[] | undefined) => (v ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);

function parseDate(name: string, v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw E.validation(`Invalid \`${name}\`. It must be an ISO 8601 date or datetime.`);
  return d;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

function finalize(c: Record<string, number>, wanted: Metric[]): Record<string, number> {
  const v: Record<string, number> = {
    received: c.received ?? 0, delivered: c.delivered ?? 0, complained: c.complained ?? 0, suppressed: c.suppressed ?? 0,
    bounced: c.bounced ?? 0, bounced_transient: c.bounced_transient ?? 0, bounced_permanent: c.bounced_permanent ?? 0,
    bounced_undetermined: c.bounced_undetermined ?? 0, opened: c.opened ?? 0, clicked: c.clicked ?? 0, unsubscribed: c.unsubscribed ?? 0,
    delivery_delayed: c.delivery_delayed ?? 0, failed: c.failed ?? 0, sent: c.sent ?? 0, unique_opened: c.unique_opened ?? 0, unique_clicked: c.unique_clicked ?? 0,
  };
  v.delivery_rate = pct(v.delivered!, v.sent!);
  v.open_rate = pct(v.unique_opened!, v.delivered!);
  v.click_rate = pct(v.unique_clicked!, v.delivered!);
  v.bounce_rate = pct(v.bounced!, v.sent!);
  v.complaint_rate = pct(v.complained!, v.delivered!);
  v.unsubscribe_rate = pct(v.unsubscribed!, v.delivered!);
  return Object.fromEntries(wanted.map((m) => [m, v[m] ?? 0]));
}

export async function computeMetrics(ctx: AppContext, teamId: string, q: MetricsQuery) {
  const now = ctx.now();
  let end = parseDate('end_date', q.end_date) ?? now;
  if (end > now) end = now;
  const start = parseDate('start_date', q.start_date) ?? new Date(end.getTime() - 6 * 86400_000);
  if (start > end) throw E.validation('The `start_date` must be on or before `end_date`.');
  const tz = q.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw E.validation('Invalid `timezone`. It must be an IANA timezone like `America/New_York`.');
  }
  const granularity = (q.granularity || 'daily') as (typeof GRANULARITY)[number];
  if (!GRANULARITY.includes(granularity)) throw E.validation('Invalid `granularity`. It must be one of hourly, daily, weekly, monthly.');
  const metricsList = multi(q.metrics);
  for (const m of metricsList) if (!(METRICS as readonly string[]).includes(m)) throw E.validation(`Invalid metric \`${m}\`.`);
  const metrics = (metricsList.length ? [...new Set(metricsList)] : [...METRICS]) as Metric[];
  const dims = [...new Set(multi(q.dimensions))];
  for (const d of dims) if (!(DIMENSIONS as readonly string[]).includes(d)) throw E.validation(`Invalid dimension \`${d}\`.`);
  const domainIds = multi(q.domain_id);
  const emailIds = multi(q.email_id);
  const broadcastIds = multi(q.broadcast_id);
  for (const [n, l] of [['domain_id', domainIds], ['email_id', emailIds], ['broadcast_id', broadcastIds]] as const) {
    if (l.length > 100) throw E.validation(`At most 100 values are allowed for \`${n}\`.`);
    for (const x of l) if (!isUuid(x)) throw E.invalidUuid(n);
  }
  if ((dims.includes('email') || emailIds.length) && (dims.includes('broadcast') || broadcastIds.length)) {
    throw E.validation('The `email` dimension and `email_id` cannot be combined with the `broadcast` dimension or `broadcast_id`.');
  }
  const unitMs = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000, monthly: 28 * 86400_000 }[granularity];
  if (dims.includes('period') && (end.getTime() - start.getTime()) / unitMs > 10_000) throw E.validation('The date range produces more than 10,000 periods at this granularity.');

  const trunc = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' }[granularity];
  const sql = ctx.sql;
  const periodExpr = sql`to_char(date_trunc(${trunc}, ev.created_at at time zone ${tz}), ${granularity === 'hourly' ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD'})`;
  const groupCols = [
    dims.includes('period') ? sql`${periodExpr} as period` : sql`null::text as period`,
    dims.includes('domain') ? sql`ev.domain_id::text as domain_id` : sql`null::text as domain_id`,
    dims.includes('email') ? sql`ev.email_id::text as email_id` : sql`null::text as email_id`,
    dims.includes('broadcast') ? sql`ev.broadcast_id::text as broadcast_id` : sql`null::text as broadcast_id`,
  ];
  const filters = [
    sql`ev.team_id = ${teamId}`,
    sql`ev.created_at >= ${start.toISOString()}`,
    sql`ev.created_at <= ${end.toISOString()}`,
    ...(domainIds.length ? [sql`ev.domain_id = any(${domainIds})`] : []),
    ...(emailIds.length ? [sql`ev.email_id = any(${emailIds})`] : []),
    ...(broadcastIds.length ? [sql`ev.broadcast_id = any(${broadcastIds})`] : []),
  ];
  const where = filters.reduce((a, f) => sql`${a} and ${f}`);
  const rows = await sql`
    select ${groupCols[0]!}, ${groupCols[1]!}, ${groupCols[2]!}, ${groupCols[3]!},
      count(*) filter (where ev.type = 'sent')::int as sent,
      count(*) filter (where ev.type = 'delivered')::int as delivered,
      count(*) filter (where ev.type = 'complained')::int as complained,
      count(*) filter (where ev.type = 'suppressed')::int as suppressed,
      count(*) filter (where ev.type = 'bounced')::int as bounced,
      count(*) filter (where ev.type = 'bounced' and ev.data->'bounce'->>'type' = 'Transient')::int as bounced_transient,
      count(*) filter (where ev.type = 'bounced' and ev.data->'bounce'->>'type' = 'Permanent')::int as bounced_permanent,
      count(*) filter (where ev.type = 'bounced' and coalesce(ev.data->'bounce'->>'type', 'Undetermined') not in ('Transient', 'Permanent'))::int as bounced_undetermined,
      count(*) filter (where ev.type = 'opened')::int as opened,
      count(*) filter (where ev.type = 'clicked')::int as clicked,
      count(*) filter (where ev.type = 'unsubscribed')::int as unsubscribed,
      count(*) filter (where ev.type = 'delivery_delayed')::int as delivery_delayed,
      count(*) filter (where ev.type = 'failed')::int as failed,
      count(distinct ev.email_id) filter (where ev.type = 'opened')::int as unique_opened,
      count(distinct ev.email_id) filter (where ev.type = 'clicked')::int as unique_clicked
    from email_events ev
    where ${where}
    group by 1, 2, 3, 4
    order by 1 nulls first, 2 nulls first, 3 nulls first, 4 nulls first`;

  // Received emails (inbound) are counted from received_emails.
  const recvRows = emailIds.length || broadcastIds.length ? [] : await sql`
    select ${dims.includes('period') ? sql`to_char(date_trunc(${trunc}, created_at at time zone ${tz}), ${granularity === 'hourly' ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD'})` : sql`null::text`} as period,
           ${dims.includes('domain') ? sql`domain_id::text` : sql`null::text`} as domain_id, count(*)::int as received
    from received_emails where team_id = ${teamId} and created_at >= ${start.toISOString()} and created_at <= ${end.toISOString()}
      ${domainIds.length ? sql`and domain_id = any(${domainIds})` : sql``}
    group by 1, 2`;

  const key = (r: Record<string, unknown>) => `${r.period ?? ''}|${r.domain_id ?? ''}|${r.email_id ?? ''}|${r.broadcast_id ?? ''}`;
  const groups = new Map<string, Record<string, unknown>>();
  for (const r of rows) groups.set(key(r), { ...r });
  if (!dims.includes('email') && !dims.includes('broadcast')) {
    for (const r of recvRows) {
      const k = key(r);
      const g: Record<string, unknown> = groups.get(k) ?? { period: r.period, domain_id: r.domain_id, email_id: null, broadcast_id: null };
      g.received = r.received;
      groups.set(k, g);
    }
  }
  const totalsRaw: Record<string, number> = {};
  for (const g of groups.values()) for (const m of METRICS) if (typeof g[m] === 'number') totalsRaw[m] = (totalsRaw[m] ?? 0) + (g[m] as number);
  // unique_* totals must be distinct across groups: recompute.
  const [u] = await sql`
    select count(distinct ev.email_id) filter (where ev.type = 'opened')::int as unique_opened,
           count(distinct ev.email_id) filter (where ev.type = 'clicked')::int as unique_clicked
    from email_events ev where ${where}`;
  totalsRaw.unique_opened = u!.unique_opened as number;
  totalsRaw.unique_clicked = u!.unique_clicked as number;

  const out: Record<string, unknown> = {
    object: 'metrics',
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    metrics,
    dimensions: dims,
    granularity,
    totals: finalize(totalsRaw, metrics),
  };
  if (dims.length) {
    const domainNames = new Map<string, string>();
    const broadcastNames = new Map<string, string>();
    if (dims.includes('domain')) for (const d of await sql`select id::text, name from domains where team_id = ${teamId}`) domainNames.set(d.id as string, d.name as string);
    if (dims.includes('broadcast')) for (const b of await sql`select id::text, name from broadcasts where team_id = ${teamId}`) broadcastNames.set(b.id as string, (b.name as string) ?? '');
    out.data = [...groups.values()].map((g) => ({
      ...(dims.includes('period') ? { period: g.period } : {}),
      ...(dims.includes('domain') ? { domain_id: g.domain_id ?? null, domain_name: g.domain_id ? domainNames.get(g.domain_id as string) ?? null : null } : {}),
      ...(dims.includes('email') ? { email_id: g.email_id } : {}),
      ...(dims.includes('broadcast') ? { broadcast_id: g.broadcast_id ?? null, broadcast_name: g.broadcast_id ? broadcastNames.get(g.broadcast_id as string) ?? null : null } : {}),
      ...finalize(g as Record<string, number>, metrics),
    }));
  }
  return out;
}
