import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Menu as M } from '@base-ui/react/menu';
import { Check, ChevronDown, X } from 'lucide-react';
import { logs as logsApi, apiKeys } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { ApiLog } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { SearchInput, ExportButton } from '@/components/ui/ListControls';
import { DateRangePicker, presetRange, type DateRangeValue, type RangePreset } from '@/components/ui/DateRange';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClass } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ITEM_CLASS, POPUP_CLASS } from '@/components/ui/Menu';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { toCsv, downloadText } from '@/lib/csv';
import { cn } from '@/lib/cn';
import { useTeamId } from '@/state/session';
import { LOG_STATUSES, LogIcon, USER_AGENTS, statusTone } from './shared';

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useRange(params: URLSearchParams): DateRangeValue {
  const preset = (params.get('range') ?? '15d') as RangePreset;
  const from = params.get('from');
  const to = params.get('to');
  if (preset === 'custom' && from && to) return { preset, from: new Date(from), to: new Date(to) };
  return presetRange(preset === 'custom' ? '15d' : preset);
}

/** Status + method filter in one menu ("All statuses", "4xx · POST"). */
function StatusMethodMenu({ status, method, onChange }: { status: string; method: string; onChange: (p: { status?: string; method?: string }) => void }) {
  const label = [status ? LOG_STATUSES.find((s) => s.value === status)?.value : '', method].filter(Boolean).join(' · ') || 'All statuses';
  const row = (active: boolean, text: string, onClick: () => void, dot?: string) => (
    <M.Item key={text} className={cn(ITEM_CLASS, 'justify-between')} onClick={onClick}>
      <div className="flex items-center gap-2">
        {dot === undefined ? null : dot ? (
          <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: dot }} />
        ) : (
          <span className="block h-2 w-2 rounded-full bg-background border-gray-10 border-[1.5px]" />
        )}
        <span className="text-sm font-normal text-default">{text}</span>
      </div>
      {active ? <Check size={14} className="text-default" /> : null}
    </M.Item>
  );
  return (
    <M.Root>
      <M.Trigger className={buttonClass('secondary', '2', 'justify-between pr-2.5 font-normal w-full group')}>
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">{label}</span>
        <span className="opacity-100">
          <ChevronDown size={16} className="text-default transition-transform group-aria-expanded:rotate-180" />
        </span>
      </M.Trigger>
      <M.Portal>
        <M.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className={cn(POPUP_CLASS, 'w-60 max-w-[19rem] min-w-(--anchor-width) max-h-[min(28rem,var(--available-height))]')}>
            {row(!status, 'All statuses', () => onChange({ status: '' }), '')}
            <M.Separator className="min-h-px w-full bg-interactive-hover" />
            {LOG_STATUSES.map((s) => row(status === s.value, s.label, () => onChange({ status: s.value }), s.dot))}
            <M.Separator className="min-h-px w-full bg-interactive-hover" />
            <div className="px-3 pt-1 pb-0.5 text-xs text-muted select-none">Method</div>
            {row(!method, 'All methods', () => onChange({ method: '' }))}
            {METHODS.map((m) => row(method === m, m, () => onChange({ method: m })))}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}

export function LogsPage() {
  const teamId = useTeamId();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const range = useRange(params);
  const status = params.get('status') ?? '';
  const method = params.get('method') ?? '';
  const ua = params.get('user_agent') ?? 'all';
  const source = params.get('source') ?? 'all';
  const keyId = params.get('api_key') ?? '';
  const q = params.get('q') ?? '';
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState(40);
  const before = cursors.at(-1);

  const set = (patch: Record<string, string | null | undefined>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || v === '' || v === 'all') n.delete(k);
      else n.set(k, v);
    }
    setParams(n, { replace: true });
    setCursors([]);
  };

  const byId = UUID.test(q);
  const filters = {
    status: status || undefined,
    method: method || undefined,
    user_agent: ua === 'all' ? undefined : ua,
    source: source === 'all' ? undefined : source,
    api_key_id: keyId || undefined,
    endpoint: q && !byId ? (q.startsWith('/') ? q : `/${q}`) : undefined,
    start: range.from.toISOString(),
    end: range.to.toISOString(),
    limit: pageSize,
    before,
  };
  const list = useTeamQuery(['logs', filters], (t) => logsApi.list(t, filters), { keepPrevious: true, enabled: !byId });
  const one = useTeamQuery(['log', q], (t) => logsApi.get(t, q), { enabled: byId });
  const keys = useTeamQuery(['api-keys'], (t) => apiKeys.list(t));
  const keyName = useMemo(() => keys.data?.data.find((k) => k.id === keyId)?.name, [keys.data, keyId]);

  const rows: ApiLog[] = byId ? (one.data ? [one.data] : []) : (list.data?.data ?? []);
  const pending = byId ? one.isPending && !one.error : list.isPending;
  const error = byId ? (one.error instanceof ApiError && one.error.status === 404 ? null : one.error) : list.error;
  const filtered = !!(status || method || ua !== 'all' || source !== 'all' || keyId || q || range.preset !== '15d');
  const total = list.data?.total;
  const page = cursors.length + 1;

  const exportCsv = async () => {
    const all: ApiLog[] = [];
    let cur: string | undefined;
    for (let i = 0; i < 30; i++) {
      const p = await logsApi.list(teamId, { ...filters, before: cur, limit: 100 });
      all.push(...p.data);
      if (!p.has_more || !p.data.length) break;
      cur = p.data.at(-1)!.id;
    }
    downloadText(
      `logs-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['id', 'created_at', 'method', 'endpoint', 'status', 'user_agent', 'source', 'api_key_id', 'duration_ms', 'ip'],
        all.map((l) => [l.id, l.created_at, l.method, l.endpoint, l.response_status, l.user_agent, l.source, l.api_key_id, l.duration_ms, l.ip]),
      ),
    );
    toast.success(`Exported ${all.length} log${all.length === 1 ? '' : 's'}`);
  };

  return (
    <>
      <PageHeader title="Logs" actions={<ApiDrawerButton examples={API.logs!} />} />
      <PageBody>
        <div className="mb-3 flex flex-col items-center gap-2 md:mb-4 md:flex-row">
          <div className="w-full md:flex-9/12">
            <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Search..." />
          </div>
          <div className="grid w-full items-center gap-2 md:grid-cols-4">
            <DateRangePicker
              value={range}
              onChange={(v) => set(v.preset === 'custom' ? { range: 'custom', from: v.from.toISOString(), to: v.to.toISOString() } : { range: v.preset === '15d' ? null : v.preset, from: null, to: null })}
            />
            <StatusMethodMenu status={status} method={method} onChange={(p) => set(p)} />
            <Select
              value={ua}
              onChange={(v) => set({ user_agent: v })}
              ariaLabel="User agent"
              options={[{ value: 'all', label: 'All user agents' }, ...USER_AGENTS]}
              className="max-w-[30rem]"
            />
            <Select
              value={source}
              onChange={(v) => set({ source: v })}
              ariaLabel="Source"
              options={[
                { value: 'all', label: 'All sources' },
                { value: 'api', label: 'API' },
                { value: 'smtp', label: 'SMTP' },
                { value: 'dashboard', label: 'Dashboard' },
              ]}
              className="max-w-none"
            />
          </div>
          <ExportButton onClick={() => void exportCsv()} disabled={!rows.length} />
        </div>
        {keyId ? (
          <div className="mb-3 flex items-center gap-2 text-xs text-default">
            <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-lg border border-interactive bg-interactive pl-2 pr-1">
              <span className="truncate">
                API key: <span className="text-emphasis">{keyName ?? keyId}</span>
              </span>
              <button type="button" aria-label="Clear API key filter" onClick={() => set({ api_key: null })} className="inline-flex h-5 w-5 items-center justify-center rounded-md hover:bg-interactive-hover">
                <X size={12} />
              </button>
            </span>
          </div>
        ) : null}
        {error ? (
          <ErrorState error={error} onRetry={() => void (byId ? one.refetch() : list.refetch())} />
        ) : !pending && rows.length === 0 && !before ? (
          filtered ? (
            <EmptyState compact title="No logs found" description={byId ? 'No log has this ID.' : 'No API requests match these filters. Try a different date range or status.'} />
          ) : (
            <EmptyState
              icon={<LogIcon status={200} size={105} />}
              title="No logs yet"
              description="Every request to the 5050 Send API and SMTP relay shows up here, with its request and response."
            />
          )
        ) : (
          <>
            <Table className="md:table-fixed">
              <THead>
                <Th className="text-nowrap w-[calc(260/630*100%)] min-w-0">Endpoint</Th>
                <Th className="text-nowrap w-[160px]">Status</Th>
                <Th className="text-nowrap">Method</Th>
                <Th className="text-nowrap w-[140px] text-right">Created</Th>
              </THead>
              <TBody className={list.isPlaceholderData ? 'opacity-60' : undefined}>
                {pending ? (
                  <SkeletonRows cols={4} />
                ) : (
                  rows.map((l) => (
                    <tr key={l.id}>
                      <Td className="py-3">
                        <div className="group flex min-w-0 items-center gap-3 w-full">
                          <a
                            href={`/logs/${l.id}`}
                            tabIndex={-1}
                            aria-hidden="true"
                            onClick={(e) => {
                              e.preventDefault();
                              nav(`/logs/${l.id}`);
                            }}
                          >
                            <LogIcon status={l.response_status} />
                          </a>
                          <DashedLink to={`/logs/${l.id}`} title={l.endpoint}>
                            <span translate="no">{l.endpoint}</span>
                          </DashedLink>
                        </div>
                      </Td>
                      <Td className="py-3">
                        <Tooltip content={l.duration_ms != null ? `${l.response_status} · ${l.duration_ms} ms` : String(l.response_status)}>
                          <span>
                            <Badge tone={statusTone(l.response_status).badge} capitalize={false}>
                              {l.response_status}
                            </Badge>
                          </span>
                        </Tooltip>
                      </Td>
                      <Td className="py-3">{l.method}</Td>
                      <Td className="py-3 text-right">
                        <Tooltip content={fullDateTime(l.created_at)}>
                          <time className="cursor-auto text-current text-sm" dateTime={l.created_at}>
                            {timeAgoShort(l.created_at)}
                          </time>
                        </Tooltip>
                      </Td>
                    </tr>
                  ))
                )}
              </TBody>
            </Table>
            <div className="flex w-full flex-wrap items-center justify-between gap-2 px-0 py-4">
              <span className="text-xs text-default font-normal inline-flex flex-wrap items-center gap-1">
                {byId ? (
                  '1 log'
                ) : (
                  <>
                    Page {page}
                    {total !== undefined ? ` – ${Math.max(1, Math.ceil(total / pageSize))} of ${total} logs` : ''} –{' '}
                    <Select
                      variant="inline"
                      ariaLabel="Items per page"
                      value={String(pageSize)}
                      onChange={(v) => {
                        setPageSize(Number(v));
                        setCursors([]);
                      }}
                      options={[20, 40, 60, 100].map((n) => ({ value: String(n), label: `${n} items` }))}
                    />
                  </>
                )}
              </span>
              <div className="flex gap-2">
                <Button size="1" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  Newer
                </Button>
                <Button size="1" disabled={byId || !list.data?.has_more} onClick={() => rows.length && setCursors((c) => [...c, rows.at(-1)!.id])}>
                  Older
                </Button>
              </div>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

