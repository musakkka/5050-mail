import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Ellipsis, Inbox, Paperclip } from 'lucide-react';
import { emails as emailsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { ReceivedEmail } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { docsUrl } from '@/components/layout/docs';
import { LinkTabs } from '@/components/ui/Tabs';
import { LinkButton, iconButtonClass } from '@/components/ui/Button';
import { SearchInput, ExportButton, CursorPager } from '@/components/ui/ListControls';
import { DateRangePicker, presetRange, type DateRangeValue, type RangePreset } from '@/components/ui/DateRange';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { toCsv, downloadText } from '@/lib/csv';
import { EMAIL_TABS } from './EmailsPage';

function rangeFrom(params: URLSearchParams): DateRangeValue {
  const preset = (params.get('range') ?? '15d') as RangePreset;
  const from = params.get('from');
  const to = params.get('to');
  if (preset === 'custom' && from && to) return { preset, from: new Date(from), to: new Date(to) };
  return presetRange(preset === 'custom' ? '15d' : preset);
}

function inRange(iso: string, r: DateRangeValue) {
  const t = Date.parse(iso);
  return t >= r.from.getTime() && t <= r.to.getTime();
}

function matches(e: ReceivedEmail, q: string) {
  const s = q.toLowerCase();
  return e.from.toLowerCase().includes(s) || e.to.join(',').toLowerCase().includes(s) || e.subject.toLowerCase().includes(s) || e.id === s;
}

export function ReceivingPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const range = rangeFrom(params);
  const q = params.get('q') ?? '';
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === '' ? n.delete(k) : n.set(k, v);
    setParams(n, { replace: true });
    setCursors([]);
  };

  const list = useTeamQuery(['received', after], (t) => emailsApi.receiving(t, { limit: 100, after }), { keepPrevious: true });
  const rows = useMemo(() => (list.data?.data ?? []).filter((e) => inRange(e.created_at, range) && (!q || matches(e, q))), [list.data, range, q]);
  const filtered = !!(q || range.preset !== '15d');
  const anyAtAll = (list.data?.data.length ?? 0) > 0 || !!after;

  const exportCsv = () =>
    downloadText(
      `received-emails-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(['id', 'created_at', 'from', 'to', 'cc', 'subject', 'attachments'], rows.map((e) => [e.id, e.created_at, e.from, e.to.join('; '), e.cc?.join('; '), e.subject, e.attachments?.length ?? 0])),
    );

  return (
    <>
      <PageHeader title="Emails" />
      <PageBody>
        <div className="mb-4 flex items-center justify-between gap-2">
          <LinkTabs tabs={EMAIL_TABS} />
          <div className="flex gap-2">
            <ApiDrawerButton examples={API.receiving!} />
            <Menu
              align="end"
              className="w-60"
              trigger={
                <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                  <span className="inline-flex items-center justify-center opacity-100">
                    <Ellipsis size={12} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <MenuItem onClick={() => nav('/inboxes')}>Manage inboxes</MenuItem>
              <MenuItem onClick={() => nav('/domains')}>Enable receiving on a domain</MenuItem>
              <MenuItem onClick={() => nav('/webhooks?new=1')}>Add an email.received webhook</MenuItem>
            </Menu>
          </div>
        </div>
        <div className="mb-3 flex flex-col items-center gap-2 md:mb-4 md:flex-row">
          <div className="w-full md:flex-9/12">
            <SearchInput value={q} onChange={(v) => set({ q: v })} />
          </div>
          <div className="w-full md:w-[351px] md:shrink-0">
            <DateRangePicker
              value={range}
              onChange={(v) => set(v.preset === 'custom' ? { range: 'custom', from: v.from.toISOString(), to: v.to.toISOString() } : { range: v.preset === '15d' ? null : v.preset, from: null, to: null })}
            />
          </div>
          <ExportButton onClick={exportCsv} disabled={!rows.length} />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && rows.length === 0 ? (
          filtered && anyAtAll ? (
            <EmptyState compact title="No emails found" description="No received emails match these filters. Try a wider date range." />
          ) : (
            <EmptyState
              icon={
                <AppIcon size={105} tone="gray" glyphSize={44}>
                  <Inbox strokeWidth={1.75} />
                </AppIcon>
              }
              title="No received emails yet"
              description={
                <>
                  Start receiving emails by enabling receiving on one of your{' '}
                  <DashedLink to="/domains">domains</DashedLink> and pointing its MX record at 5050 Send.
                </>
              }
              actions={
                <LinkButton href={docsUrl('/receiving/introduction')} variant="primary" icon={<ArrowUpRight size={16} />}>
                  Go to docs
                </LinkButton>
              }
            />
          )
        ) : (
          <>
            <Table>
              <THead>
                <Th className="w-[300px]">From</Th>
                <Th className="w-[240px]">To</Th>
                <Th>Subject</Th>
                <Th className="text-right w-[140px]">Received</Th>
                <Th className="w-[70px]">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody className={list.isPlaceholderData ? 'opacity-60' : undefined}>
                {list.isPending ? <SkeletonRows cols={5} /> : rows.map((e) => <ReceivedRow key={e.id} e={e} />)}
              </TBody>
            </Table>
            <CursorPager
              hasNewer={cursors.length > 0}
              hasOlder={!!list.data?.has_more}
              onNewer={() => setCursors((c) => c.slice(0, -1))}
              onOlder={() => list.data?.data.length && setCursors((c) => [...c, list.data!.data.at(-1)!.id])}
            />
          </>
        )}
      </PageBody>
    </>
  );
}

function ReceivedRow({ e }: { e: ReceivedEmail }) {
  const nav = useNavigate();
  const href = `/emails/receiving/${e.id}`;
  const to = e.to.join(', ');
  return (
    <tr>
      <Td className="max-w-[300px] py-3">
        <div className="group flex items-center gap-3 w-full">
          <a href={href} tabIndex={-1} aria-hidden="true" onClick={(x) => { x.preventDefault(); nav(href); }}>
            <AppIcon size={32} tone="blue" glyphSize={17}>
              <Inbox strokeWidth={2} />
            </AppIcon>
          </a>
          <span translate="no" className="relative flex items-center gap-2 w-full min-w-0">
            <DashedLink to={href} title={e.from}>
              {e.from}
            </DashedLink>
          </span>
        </div>
      </Td>
      <Td className="max-w-[240px]">
        <div className="truncate" title={to}>
          {to}
        </div>
      </Td>
      <Td className="max-w-[280px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate" title={e.subject}>
            {e.subject || '(no subject)'}
          </span>
          {e.attachments?.length ? <Paperclip size={14} className="shrink-0 text-default" aria-label={`${e.attachments.length} attachment(s)`} /> : null}
        </div>
      </Td>
      <Td className="text-right">
        <Tooltip content={fullDateTime(e.created_at)}>
          <time className="cursor-auto text-current text-sm" dateTime={e.created_at}>
            {timeAgoShort(e.created_at)}
          </time>
        </Tooltip>
      </Td>
      <Td className="text-center">
        <Menu
          align="end"
          className="w-48"
          trigger={
            <button type="button" aria-label="More actions" className={iconButtonClass('ghost', '2', 'align-middle')}>
              <span className="inline-flex items-center justify-center opacity-100">
                <Ellipsis size={12} strokeWidth={3} />
              </span>
            </button>
          }
        >
          <MenuItem onClick={() => nav(href)}>View email</MenuItem>
          <MenuItem onClick={async () => (await copyText(e.id)) && toast('Email ID copied')}>Copy email ID</MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}
