import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MailX, Ellipsis, Mail } from 'lucide-react';
import { emails as emailsApi, apiKeys } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { EmailListItem, EmailStatus } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { LinkTabs } from '@/components/ui/Tabs';
import { LinkButton, iconButtonClass } from '@/components/ui/Button';
import { SearchInput, FilterMenu, ExportButton, CursorPager } from '@/components/ui/ListControls';
import { DateRangePicker, presetRange, type DateRangeValue, type RangePreset } from '@/components/ui/DateRange';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { EMAIL_STATUS, EMAIL_STATUS_ORDER, emailStatus } from '@/lib/status';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { toCsv, downloadText } from '@/lib/csv';
import { useTeamId } from '@/state/session';

export const EMAIL_TABS = [
  { to: '/emails', label: 'Sending', match: (p: string) => p === '/emails' || (p.startsWith('/emails/') && !p.startsWith('/emails/receiving')) },
  { to: '/emails/receiving', label: 'Receiving' },
];

function useRange(params: URLSearchParams): DateRangeValue {
  const preset = (params.get('range') ?? '15d') as RangePreset;
  const from = params.get('from');
  const to = params.get('to');
  if (preset === 'custom' && from && to) return { preset, from: new Date(from), to: new Date(to) };
  return presetRange(preset === 'custom' ? '15d' : preset);
}

export function EmailRowIcon({ status, to }: { status: string; to: string }) {
  return (
    <DashedLinkIcon to={to}>
      <AppIcon size={32} tone={emailStatus(status).tone} glyphSize={17}>
        <Mail strokeWidth={2} />
      </AppIcon>
    </DashedLinkIcon>
  );
}

function DashedLinkIcon({ to, children }: { to: string; children: React.ReactNode }) {
  const nav = useNavigate();
  return (
    <a
      href={to}
      tabIndex={-1}
      aria-hidden="true"
      onClick={(e) => {
        e.preventDefault();
        nav(to);
      }}
    >
      {children}
    </a>
  );
}

export function EmailsPage() {
  const teamId = useTeamId();
  const [params, setParams] = useSearchParams();
  const range = useRange(params);
  const status = (params.get('status') ?? '') as EmailStatus | '';
  const keyId = params.get('api_key') ?? 'all';
  const q = params.get('q') ?? '';
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === '' ? n.delete(k) : n.set(k, v);
    setParams(n, { replace: true });
    setCursors([]);
  };

  const filters = { status, api_key_id: keyId === 'all' ? undefined : keyId, q: q || undefined, start: range.from.toISOString(), end: range.to.toISOString(), limit: 40, after };
  const list = useTeamQuery(['emails', filters], (t) => emailsApi.list(t, filters), { keepPrevious: true });
  const keys = useTeamQuery(['api-keys'], (t) => apiKeys.list(t));

  const keyOptions = useMemo(() => [{ value: 'all', label: 'All API keys' }, ...(keys.data?.data ?? []).map((k) => ({ value: k.id, label: k.name }))], [keys.data]);
  const rows = list.data?.data ?? [];
  const filtered = !!(status || q || keyId !== 'all' || range.preset !== '15d');

  const exportCsv = async () => {
    const all: EmailListItem[] = [];
    let cur: string | undefined;
    for (let i = 0; i < 25; i++) {
      const page = await emailsApi.list(teamId, { ...filters, after: cur, limit: 100 });
      all.push(...page.data);
      if (!page.has_more || !page.data.length) break;
      cur = page.data.at(-1)!.id;
    }
    downloadText(
      `emails-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['id', 'created_at', 'from', 'to', 'cc', 'bcc', 'subject', 'status', 'scheduled_at'],
        all.map((e) => [e.id, e.created_at, e.from, e.to.join('; '), e.cc?.join('; '), e.bcc?.join('; '), e.subject, e.last_event, e.scheduled_at]),
      ),
    );
    toast.success(`Exported ${all.length} email${all.length === 1 ? '' : 's'}`);
  };

  return (
    <>
      <PageHeader title="Emails" />
      <PageBody>
        <div className="mb-4 flex items-center justify-between gap-2">
          <LinkTabs tabs={EMAIL_TABS} />
          <div className="flex gap-2">
            <LinkButton to="/emails/suppressions" icon={<MailX size={16} />}>
              Suppressions
            </LinkButton>
            <ApiDrawerButton examples={API.emails!} />
          </div>
        </div>
        <div className="mb-3 flex flex-col items-center gap-2 md:mb-4 md:flex-row">
          <div className="w-full md:flex-9/12">
            <SearchInput value={q} onChange={(v) => set({ q: v })} />
          </div>
          <div className="w-full grid gap-2 md:grid-cols-3">
            <DateRangePicker
              value={range}
              onChange={(v) => set(v.preset === 'custom' ? { range: 'custom', from: v.from.toISOString(), to: v.to.toISOString() } : { range: v.preset === '15d' ? null : v.preset, from: null, to: null })}
            />
            <FilterMenu
              value={status}
              allLabel="All Statuses"
              onChange={(v) => set({ status: v })}
              options={EMAIL_STATUS_ORDER.map((s) => ({ value: s, label: EMAIL_STATUS[s].label, dot: EMAIL_STATUS[s].dot }))}
            />
            <Select value={keyId} onChange={(v) => set({ api_key: v === 'all' ? null : v })} options={keyOptions} ariaLabel="API key" className="max-w-none" />
          </div>
          <ExportButton onClick={() => void exportCsv()} disabled={!rows.length} />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && rows.length === 0 && !after ? (
          filtered ? (
            <EmptyState compact title="No emails found" description="No emails match these filters. Try a different date range or status." />
          ) : (
            <EmptyState
              icon={
                <AppIcon size={105} tone="green" glyphSize={44}>
                  <Mail strokeWidth={1.75} />
                </AppIcon>
              }
              title="No sent emails yet"
              description="Send your first email with the API or SMTP and it will show up here."
              actions={
                <LinkButton to="/onboarding" variant="primary">
                  Get started
                </LinkButton>
              }
            />
          )
        ) : (
          <>
            <Table>
              <THead>
                <Th className="w-[320px]">To</Th>
                <Th className="w-[120px]">Status</Th>
                <Th>Subject</Th>
                <Th className="text-right w-[220px]">Sent</Th>
                <Th className="w-[70px]">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody className={list.isPlaceholderData ? 'opacity-60' : undefined}>
                {list.isPending ? (
                  <SkeletonRows cols={5} />
                ) : (
                  rows.map((e) => <EmailRow key={e.id} e={e} />)
                )}
              </TBody>
            </Table>
            <CursorPager
              hasNewer={cursors.length > 0}
              hasOlder={!!list.data?.has_more}
              onNewer={() => setCursors((c) => c.slice(0, -1))}
              onOlder={() => rows.length && setCursors((c) => [...c, rows.at(-1)!.id])}
            />
          </>
        )}
      </PageBody>
    </>
  );
}

function EmailRow({ e }: { e: EmailListItem }) {
  const nav = useNavigate();
  const to = e.to.join(', ');
  const href = `/emails/${e.id}`;
  const st = emailStatus(e.last_event);
  const when = e.last_event === 'scheduled' && e.scheduled_at ? e.scheduled_at : e.created_at;
  return (
    <tr>
      <Td className="w-[270px] max-w-[320px] py-3">
        <div className="group flex items-center gap-3 w-full">
          <EmailRowIcon status={e.last_event} to={href} />
          <span translate="no" className="relative flex items-center gap-2 w-full min-w-0">
            <DashedLink to={href} title={to}>
              {to}
            </DashedLink>
          </span>
        </div>
      </Td>
      <Td className="max-w-[260px]">
        <div className="group flex items-start gap-3 w-full truncate">
          <Tooltip content={st.label}>
            <span>
              <Badge tone={st.badge}>{st.label.toLowerCase()}</Badge>
            </span>
          </Tooltip>
        </div>
      </Td>
      <Td className="max-w-[280px]">
        <div className="truncate" title={e.subject}>
          <span translate="no">{e.subject || '(no subject)'}</span>
        </div>
      </Td>
      <Td className="text-right w-[220px]">
        <Tooltip content={fullDateTime(when)}>
          <time className="cursor-auto text-current text-sm" dateTime={when}>
            {timeAgoShort(when)}
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
          <MenuItem
            onClick={async () => {
              if (await copyText(e.id)) toast('Email ID copied');
            }}
          >
            Copy email ID
          </MenuItem>
          <MenuItem onClick={() => nav(`/emails?q=${encodeURIComponent(e.to[0] ?? '')}`)}>More from this recipient</MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}
