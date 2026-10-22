import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Menu as M } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { Check, ChevronDown, CircleQuestionMark, Minus, Plus } from 'lucide-react';
import { format, subDays } from 'date-fns';
import { metrics as metricsApi, domains as domainsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { MetricsRow } from '@/api/types';
import { useTitle, H1_CLASS } from '@/components/layout/Page';
import { buttonClass, iconButtonClass } from '@/components/ui/Button';
import { ITEM_CLASS, POPUP_CLASS } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { ErrorState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { EventsChart, RateChart, niceStep, type SeriesDef } from './charts';

const EVENTS: SeriesDef[] = [
  { key: 'received', label: 'Received', color: 'var(--cyan-a11)' },
  { key: 'delivered', label: 'Delivered', color: 'var(--green-a11)' },
  { key: 'opened', label: 'Opened', color: 'var(--blue-a11)' },
  { key: 'clicked', label: 'Clicked', color: 'var(--violet-a11)' },
  { key: 'bounced', label: 'Bounced', color: 'var(--red-a11)' },
  { key: 'complained', label: 'Complained', color: 'var(--amber-a11)' },
  { key: 'unsubscribed', label: 'Unsubscribed', color: 'var(--orange-a11)' },
  { key: 'delivery_delayed', label: 'Delivery delayed', color: 'var(--sand-a11)' },
  { key: 'failed', label: 'Failed', color: 'var(--red-a9)' },
  { key: 'suppressed', label: 'Suppressed', color: 'var(--slate-a11)' },
];

const RANGES = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 15, label: 'Last 15 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 60, label: 'Last 60 days' },
  { days: 90, label: 'Last 90 days' },
];

const ZOOMS = [1, 2, 4, 8];

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const fmtPct = (v: number) => (v === 0 ? '0%' : v >= 10 ? `${Math.round(v * 10) / 10}%` : `${Number(v.toFixed(2))}%`);

function RangeMenu({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <M.Root>
      <M.Trigger className={buttonClass('secondary', '2', 'justify-between pr-2 font-normal group w-full md:w-auto')}>
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">{RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`}</span>
        <ChevronDown size={16} className="text-default transition-transform group-aria-expanded:rotate-180" />
      </M.Trigger>
      <M.Portal>
        <M.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className={cn(POPUP_CLASS, 'w-48 min-w-(--anchor-width)')}>
            {RANGES.map((r) => (
              <M.Item key={r.days} className={cn(ITEM_CLASS, 'justify-between')} onClick={() => onChange(r.days)}>
                <span>{r.label}</span>
                {r.days === days ? <Check size={14} /> : null}
              </M.Item>
            ))}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}

function EventsMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const item = (key: string, label: string, color?: string) => (
    <M.Item key={key} className={cn(ITEM_CLASS, 'justify-between select-none')} onClick={() => onChange(key)}>
      <div className="flex items-center gap-2">
        {color ? <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: color }} /> : <span className="block h-2 w-2 rounded-full bg-background border-gray-10 border-[1.5px]" />}
        <span className="text-sm font-normal text-default">{label}</span>
      </div>
      {value === key ? <Check size={14} className="text-default" /> : null}
    </M.Item>
  );
  return (
    <M.Root>
      <M.Trigger className={buttonClass('secondary', '2', 'justify-between pr-2 font-normal group')}>
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">{EVENTS.find((e) => e.key === value)?.label ?? 'All Events'}</span>
        <ChevronDown size={16} className="text-default transition-transform group-aria-expanded:rotate-180" />
      </M.Trigger>
      <M.Portal>
        <M.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className={cn(POPUP_CLASS, 'w-56 max-w-[19rem]')}>
            {item('all', 'All Events')}
            <M.Separator className="min-h-px w-full bg-interactive-hover" />
            {EVENTS.map((e) => item(e.key, e.label, e.color))}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}

/** Y-axis zoom for the events chart ("100%" = fit the largest day). */
function ZoomControl({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
  const i = ZOOMS.indexOf(zoom);
  return (
    <div className="inline-flex items-center gap-0.5 rounded-xl border border-interactive bg-interactive p-0.5" role="group" aria-label="Chart zoom">
      <Tooltip content="Zoom out">
        <button type="button" aria-label="Zoom out" disabled={i <= 0} onClick={() => onChange(ZOOMS[i - 1]!)} className={iconButtonClass('ghost', '1', 'disabled:opacity-40 disabled:cursor-not-allowed')}>
          <Minus size={12} />
        </button>
      </Tooltip>
      <Tooltip content="Reset zoom">
        <button type="button" onClick={() => onChange(1)} className="h-6 min-w-11 rounded-lg px-1 text-xs tabular-nums text-default hover:bg-interactive-hover hover:text-emphasis">
          {zoom * 100}%
        </button>
      </Tooltip>
      <Tooltip content="Zoom in">
        <button type="button" aria-label="Zoom in" disabled={i >= ZOOMS.length - 1} onClick={() => onChange(ZOOMS[i + 1]!)} className={iconButtonClass('ghost', '1', 'disabled:opacity-40 disabled:cursor-not-allowed')}>
          <Plus size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

function Help({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <div className="absolute right-4 top-4 z-10">
        <Popover.Trigger aria-label={label} className={iconButtonClass('ghost', '2')}>
          <span className="inline-flex items-center justify-center opacity-100">
            <CircleQuestionMark size={20} />
          </span>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-[1000]">
          <Popover.Popup className="w-80 max-w-[calc(100vw-16px)] rounded-2xl border border-interactive bg-background p-4 text-sm text-default shadow-lg outline-hidden transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0">
            <Popover.Title className="mb-1 font-semibold text-emphasis">{label}</Popover.Title>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Stat({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-default font-normal uppercase">{label}</p>
      {loading ? <Skeleton className="my-1.5 h-[30px] w-20" /> : <p className="text-[35px] leading-[42px] tracking-[-0.64px] text-emphasis font-normal tabular-nums">{value}</p>}
    </div>
  );
}

function BreakdownTable({ rows }: { rows: { label: string; color: string; count: number; pct: number; to: string }[] }) {
  return (
    <table className="m-0 w-full border-separate border-spacing-0 border-none p-0 text-left">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="group items-center">
            <td className="h-10 border-b border-gray-2 pr-3 pl-2 text-sm whitespace-nowrap md:px-3 group-last:border-0">
              <div className="flex items-center gap-2">
                <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: r.color }} />
                <Link to={r.to} className="cursor-pointer truncate border-b border-dashed border-link transition duration-300 ease-in-out hover:border-link-hover">
                  <span className="text-sm text-emphasis font-normal">{r.label}</span>
                </Link>
              </div>
            </td>
            <td className="h-10 border-b border-gray-2 pr-3 pl-2 text-sm whitespace-nowrap md:px-3 group-last:border-0">
              <div className="flex items-center justify-end gap-2">
                <span className="text-sm text-emphasis font-normal opacity-40 tabular-nums">{r.count.toLocaleString()}</span>
                <span className="text-sm text-emphasis font-normal tabular-nums">{fmtPct(r.pct)}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RateCard({
  title,
  help,
  value,
  loading,
  chart,
  breakdown,
}: {
  title: string;
  help: ReactNode;
  value: number;
  loading: boolean;
  chart: ReactNode;
  breakdown: ReactNode;
}) {
  return (
    <div className="relative w-full min-w-0 border border-default rounded-3xl">
      <div
        aria-hidden="true"
        className="absolute right-0 top-0 h-px w-[200px] hidden dark:block"
        style={{ background: 'linear-gradient(90deg, rgba(56,189,248,0) 0%, rgba(232,232,232,0.2) 33%, rgba(143,143,143,0.67) 64%, rgba(236,72,153,0) 99%)' }}
      />
      <div className="p-4 flex flex-col gap-8">
        <Help label={`How ${title.toLowerCase().replace(/^./, (c) => c.toUpperCase())} works`}>{help}</Help>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-default font-normal uppercase">{title}</p>
          {loading ? <Skeleton className="my-1.5 h-[30px] w-16" /> : <p className="text-[35px] leading-[42px] tracking-[-0.64px] text-emphasis font-normal tabular-nums">{fmtPct(value)}</p>}
        </div>
        <div className="flex flex-col gap-6">
          {loading ? <Skeleton className="h-[300px] w-full rounded-2xl" /> : chart}
          <div>{breakdown}</div>
        </div>
      </div>
    </div>
  );
}

export function MetricsPage() {
  useTitle('Metrics');
  const [days, setDays] = useState(15);
  const [domainId, setDomainId] = useState('all');
  const [event, setEvent] = useState('all');
  const [zoom, setZoom] = useState(1);
  const domains = useTeamQuery(['domains'], (t) => domainsApi.list(t));
  const params = { days, dimensions: ['period', 'domain'], domain_id: domainId === 'all' ? undefined : domainId, granularity: 'daily' };
  const q = useTeamQuery(['metrics', params], (t) => metricsApi.get(t, params), { keepPrevious: true });
  const loading = q.isPending;

  const { series, byDomain, totals } = useMemo(() => {
    const periods: string[] = [];
    for (let i = days - 1; i >= 0; i--) periods.push(format(subDays(new Date(), i), 'yyyy-MM-dd'));
    const map = new Map<string, Record<string, number | string>>(periods.map((p) => [p, { period: p }]));
    const dom = new Map<string, { name: string; sent: number; delivered: number }>();
    const tot: Record<string, number> = {};
    for (const r of (q.data?.data ?? []) as (MetricsRow & { domain_name?: string | null })[]) {
      const key = String(r.period).slice(0, 10);
      const row = map.get(key) ?? { period: key };
      map.set(key, row);
      for (const [k, v] of Object.entries(r)) {
        if (typeof v !== 'number' || k.endsWith('_rate')) continue;
        row[k] = n(row[k]) + v;
        tot[k] = (tot[k] ?? 0) + v;
      }
      if (r.domain_id) {
        const d = dom.get(r.domain_id) ?? { name: r.domain_name ?? domains.data?.data.find((x) => x.id === r.domain_id)?.name ?? '—', sent: 0, delivered: 0 };
        d.sent += n(r.sent);
        d.delivered += n(r.delivered);
        dom.set(r.domain_id, d);
      }
    }
    const rows = [...map.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
    for (const r of rows) {
      r.bounce_rate = pct(n(r.bounced), n(r.sent));
      r.complaint_rate = pct(n(r.complained), n(r.delivered));
    }
    return { series: rows, byDomain: [...dom.entries()].filter(([, d]) => d.sent > 0).sort((a, b) => b[1].sent - a[1].sent), totals: tot };
  }, [q.data, days, domains.data]);

  const sent = n(totals.sent);
  const deliverability = pct(n(totals.delivered), sent);
  const bounceRate = pct(n(totals.bounced), sent);
  const complaintRate = pct(n(totals.complained), n(totals.delivered));
  const shown = event === 'all' ? EVENTS : EVENTS.filter((e) => e.key === event);
  const start = format(subDays(new Date(), days - 1), 'yyyy-MM-dd');
  const end = format(new Date(), 'yyyy-MM-dd');
  const emailsLink = (status: string) => `/emails?status=${status}&range=custom&from=${encodeURIComponent(new Date(start).toISOString())}&to=${encodeURIComponent(new Date(`${end}T23:59:59`).toISOString())}`;
  const scale = (floor: number, k: number, key: string) => {
    const peak = Math.max(floor, ...series.map((r) => n(r[key])));
    const s = niceStep(peak / k);
    return { max: s * k, ticks: Array.from({ length: k + 1 }, (_, i) => Number((s * i).toFixed(4))) };
  };
  const bounceScale = scale(10, 5, 'bounce_rate');
  const complaintScale = scale(0.2, 4, 'complaint_rate');
  const lastUpdated = q.dataUpdatedAt ? format(new Date(q.dataUpdatedAt), 'h:mm a') : '—';

  return (
    <div className="[--metrics-axis:rgb(228,231,241)] dark:[--metrics-axis:rgb(36,37,43)]">
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 md:pt-8 pb-4 md:flex md:items-center md:justify-between md:pb-8">
        <h1 className={cn(H1_CLASS, 'mb-6 md:mb-4')}>Metrics</h1>
        <div className="flex gap-2 flex-col md:flex-row">
          <Select
            value={domainId}
            onChange={setDomainId}
            ariaLabel="Domain"
            className="w-full md:w-auto md:min-w-[130px] max-w-[260px] font-normal"
            options={[{ value: 'all', label: 'All domains' }, ...(domains.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
          />
          <RangeMenu
            days={days}
            onChange={(d) => {
              setDays(d);
              setZoom(1);
            }}
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl flex flex-col gap-10">
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className={cn('flex flex-col gap-6 transition-opacity', q.isPlaceholderData && 'opacity-60')}>
            <div className="relative rounded-3xl border border-gray-3 w-full">
              <div className="flex justify-between items-start gap-4 px-3 py-5 md:px-5 md:flex-row flex-col">
                <div className="flex gap-16">
                  <Stat label="Emails" value={sent.toLocaleString()} loading={loading} />
                  <Stat label="Deliverability Rate" value={sent ? fmtPct(deliverability) : '0%'} loading={loading} />
                </div>
                <div className="flex items-center gap-2">
                  {zoom !== 1 ? <ZoomControl zoom={zoom} onChange={setZoom} /> : null}
                  <EventsMenu value={event} onChange={setEvent} />
                </div>
              </div>
              <div className="group/chart relative mb-2">
                {loading ? <Skeleton className="mx-5 h-[300px] rounded-2xl" /> : <EventsChart data={series} series={shown} zoom={zoom} />}
                {!loading && zoom === 1 ? (
                  <div className="absolute left-6 top-1 opacity-0 transition-opacity group-hover/chart:opacity-100 focus-within:opacity-100">
                    <ZoomControl zoom={zoom} onChange={setZoom} />
                  </div>
                ) : null}
                {!loading && sent === 0 ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-8">
                    <p className="rounded-xl bg-background/80 px-3 py-1.5 text-sm text-default">No emails sent in this period</p>
                  </div>
                ) : null}
              </div>
              <div className="p-4">
                {loading ? (
                  <Skeleton className="h-10 w-full" />
                ) : byDomain.length ? (
                  <table className="m-0 w-full border-separate border-spacing-0 border-none p-0 text-left">
                    <tbody>
                      {byDomain.map(([id, d]) => {
                        const rate = pct(d.delivered, d.sent);
                        return (
                          <tr key={id} className="group">
                            <td className="h-10 max-w-0 w-full truncate border-b border-gray-2 pr-3 pl-2 text-sm whitespace-nowrap md:px-3 group-last:border-0">
                              <span translate="no">{d.name}</span> <span className="ml-1 opacity-70">({d.sent.toLocaleString()})</span>
                            </td>
                            <td className="h-10 border-b border-gray-2 pr-3 pl-2 text-sm whitespace-nowrap md:px-3 group-last:border-0">
                              <Tooltip content={`${d.delivered.toLocaleString()} of ${d.sent.toLocaleString()} delivered`}>
                                <span className="flex min-w-[48px] items-center justify-end gap-2 text-right whitespace-nowrap">
                                  <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: rate >= 95 ? 'var(--green-a11)' : rate >= 85 ? 'var(--amber-a11)' : 'var(--red-a11)' }} />
                                  <span className="text-sm text-default font-normal">{fmtPct(rate)}</span>
                                </span>
                              </Tooltip>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-3 py-2.5 text-sm text-muted">No sending domains in this period.</p>
                )}
              </div>
            </div>
            <div className="flex gap-10 flex-col md:flex-row">
              <RateCard
                title="Bounce rate"
                value={bounceRate}
                loading={loading}
                help={
                  <p>
                    The share of sent emails that bounced. Mailbox providers treat a bounce rate above <b className="text-emphasis">4%</b> as a risk; keep it under 2% by removing invalid addresses
                    and using double opt-in. Bounced addresses are added to your suppression list automatically.
                  </p>
                }
                chart={<RateChart data={series} dataKey="bounce_rate" color="var(--red-a11)" max={bounceScale.max} threshold={4} ticks={bounceScale.ticks} />}
                breakdown={
                  <BreakdownTable
                    rows={[
                      { label: 'Transient', color: 'var(--red-a11)', count: n(totals.bounced_transient), pct: pct(n(totals.bounced_transient), sent), to: emailsLink('bounced') },
                      { label: 'Permanent', color: 'var(--red-a11)', count: n(totals.bounced_permanent), pct: pct(n(totals.bounced_permanent), sent), to: emailsLink('bounced') },
                      { label: 'Undetermined', color: 'var(--red-a11)', count: n(totals.bounced_undetermined), pct: pct(n(totals.bounced_undetermined), sent), to: emailsLink('bounced') },
                    ]}
                  />
                }
              />
              <RateCard
                title="Complaint rate"
                value={complaintRate}
                loading={loading}
                help={
                  <p>
                    The share of delivered emails marked as spam. Keep it under <b className="text-emphasis">0.08%</b>; above 0.3% mailbox providers start blocking mail. Only send to people who
                    asked for it and make unsubscribing easy.
                  </p>
                }
                chart={<RateChart data={series} dataKey="complaint_rate" color="var(--amber-a11)" max={complaintScale.max} threshold={0.08} ticks={complaintScale.ticks} />}
                breakdown={<BreakdownTable rows={[{ label: 'Complained', color: 'var(--amber-a11)', count: n(totals.complained), pct: complaintRate, to: emailsLink('complained') }]} />}
              />
            </div>
            <span className="text-sm text-default font-normal">
              Data is updated every 15 minutes. Last updated <span className="text-sm text-emphasis font-normal">{lastUpdated}.</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
