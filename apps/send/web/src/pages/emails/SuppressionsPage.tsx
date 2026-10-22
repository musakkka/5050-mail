import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, MailX, Pencil, Plus, CloudUpload, Trash } from 'lucide-react';
import { Menu as M } from '@base-ui/react/menu';
import { suppressions as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Suppression } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Button, buttonClass, iconButtonClass } from '@/components/ui/Button';
import { SearchInput, ExportButton, PageFooter } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem, ITEM_CLASS, POPUP_CLASS } from '@/components/ui/Menu';
import { Checkbox } from '@/components/ui/Switch';
import { AppIcon } from '@/components/ui/AppIcon';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { toCsv, downloadText, parseCsv } from '@/lib/csv';
import { cn } from '@/lib/cn';
import { useTeamId } from '@/state/session';
import { AddSuppressionDialog, ConfirmRemoveDialog } from './SuppressionDialogs';

export const ORIGINS: Record<string, { label: string; tone: 'error' | 'warning' | 'neutral' | 'info' }> = {
  bounce: { label: 'Bounce', tone: 'error' },
  complaint: { label: 'Complaint', tone: 'warning' },
  unsubscribe: { label: 'Unsubscribe', tone: 'info' },
  manual: { label: 'Manual', tone: 'neutral' },
};
export const origin = (r: string) => ORIGINS[r] ?? { label: r.replace(/_/g, ' '), tone: 'neutral' as const };

const TIMES = [
  { value: 'all', label: 'All time', days: 0 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
];

export function Avatar({ text, size = 24 }: { text: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="relative shrink-0 flex text-xs rounded-full border border-transparent font-medium uppercase text-default"
      style={{
        width: size,
        height: size,
        minWidth: size,
        background: 'linear-gradient(42deg, var(--gray-1), var(--gray-2)) padding-box, linear-gradient(42deg, var(--gray-a2) 45%, var(--gray-a6)) border-box',
      }}
    >
      <span className="m-auto">{(text.trim()[0] ?? '?').toUpperCase()}</span>
    </span>
  );
}

export function SuppressionsPage() {
  const teamId = useTeamId();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const reason = params.get('origin') ?? 'all';
  const time = params.get('time') ?? 'all';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Suppression[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (!v || v === 'all') n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
    setPage(1);
    setSelected(new Set());
  };

  const list = useTeamQuery(['suppressions', q, reason], (t) => api.list(t, { q: q || undefined, reason: reason === 'all' ? undefined : reason, limit: 100 }), { keepPrevious: true });
  const all = useMemo(() => {
    let rows = list.data?.data ?? [];
    const days = TIMES.find((t) => t.value === time)?.days ?? 0;
    if (days) rows = rows.filter((s) => Date.now() - Date.parse(s.created_at) < days * 86400_000);
    if (q) rows = rows.filter((s) => s.email.toLowerCase().includes(q.toLowerCase()));
    if (reason !== 'all') rows = rows.filter((s) => s.reason === reason);
    return rows;
  }, [list.data, time, q, reason]);
  const rows = all.slice((page - 1) * pageSize, page * pageSize);
  const filtered = !!(q || reason !== 'all' || time !== 'all');

  const importCsv = useTeamMutation(
    async (t, emails: string[]) => {
      let ok = 0;
      for (const e of emails) {
        try {
          await api.add(t, e);
          ok++;
        } catch {
          /* already suppressed or invalid */
        }
      }
      return { ok, total: emails.length };
    },
    [['suppressions']],
    { onSuccess: (r) => toast.success(`Added ${r.ok} of ${r.total} email address${r.total === 1 ? '' : 'es'}`) },
  );

  const exportCsv = () =>
    downloadText(
      `suppressions-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(['id', 'email', 'origin', 'created_at'], all.map((s) => [s.id, s.email, s.reason, s.created_at])),
    );

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <PageHeader
        title="Suppressions"
        actions={
          <>
            <M.Root>
              <M.Trigger aria-label="Add email address" className={buttonClass('primary', '2', 'pl-2.5 max-sm:pr-2.5')}>
                <span className="opacity-100">
                  <Plus size={16} />
                </span>
                <span className="hidden sm:inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">Add email address</span>
              </M.Trigger>
              <M.Portal>
                <M.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
                  <M.Popup className={cn(POPUP_CLASS, 'w-44')}>
                    <M.Item className={ITEM_CLASS} onClick={() => setAdding(true)}>
                      <Pencil size={14} /> Add manually
                    </M.Item>
                    <M.Item className={ITEM_CLASS} onClick={() => fileRef.current?.click()}>
                      <CloudUpload size={14} /> Import CSV
                    </M.Item>
                  </M.Popup>
                </M.Positioner>
              </M.Portal>
            </M.Root>
            <ApiDrawerButton examples={API.suppressions!} />
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const rowsCsv = parseCsv(await f.text());
          const emails = [...new Set(rowsCsv.flat().map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
          if (!emails.length) {
            toast.error('No email addresses found in that file.');
            return;
          }
          importCsv.mutate(emails);
        }}
      />
      <PageBody>
        <div className="@container/filters mb-3">
          <div className="flex flex-col gap-3 @min-[40rem]/filters:flex-row @min-[40rem]/filters:gap-2">
            <div className="flex-auto @min-[54rem]/filters:min-w-[420px]">
              <SearchInput value={q} onChange={(v) => set('q', v)} />
            </div>
            <div className="flex flex-auto gap-2">
              <Select
                value={reason}
                onChange={(v) => set('origin', v)}
                ariaLabel="Origin"
                className="max-w-none"
                options={[{ value: 'all', label: 'All origins' }, ...Object.entries(ORIGINS).map(([value, o]) => ({ value, label: o.label }))]}
              />
              <Select value={time} onChange={(v) => set('time', v)} ariaLabel="Added" className="max-w-none" options={TIMES.map(({ value, label }) => ({ value, label }))} />
              <div className="shrink-0">
                <ExportButton onClick={exportCsv} disabled={!all.length} />
              </div>
            </div>
          </div>
        </div>
        {selected.size > 0 ? (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-interactive bg-interactive px-3 py-1.5 text-sm text-default">
            <span>
              {selected.size} selected
            </span>
            <div className="flex gap-2">
              <Button size="1" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="1" variant="danger" icon={<Trash size={12} />} onClick={() => setRemoving(all.filter((s) => selected.has(s.id)))}>
                Remove
              </Button>
            </div>
          </div>
        ) : null}
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          filtered ? (
            <EmptyState compact title="No suppressions found" description="No suppressed addresses match these filters." />
          ) : (
            <EmptyState
              icon={
                <AppIcon size={105} tone="red" glyphSize={44}>
                  <MailX strokeWidth={1.75} />
                </AppIcon>
              }
              title="No suppressions"
              description="Addresses that hard bounce or complain are added automatically so you never send to them again. You can also add addresses yourself."
              actions={
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                  Add email address
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="@container/bulk-actions">
              <Table>
                <THead>
                  <Th className="relative">
                    <span className="absolute -left-8 top-1/2 hidden -translate-y-1/2 @min-[68.6rem]/bulk-actions:block">
                      <Checkbox
                        label="Select all"
                        checked={allOnPage}
                        indeterminate={!allOnPage && rows.some((r) => selected.has(r.id))}
                        onChange={(v) => setSelected((s) => {
                          const n = new Set(s);
                          rows.forEach((r) => (v ? n.add(r.id) : n.delete(r.id)));
                          return n;
                        })}
                      />
                    </span>
                    Email
                  </Th>
                  <Th>Origin</Th>
                  <Th className="text-right">Added</Th>
                  <Th className="w-[70px]">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <TBody className={list.isPlaceholderData ? 'opacity-60' : undefined}>
                  {list.isPending ? (
                    <SkeletonRows cols={4} />
                  ) : (
                    rows.map((s) => {
                      const o = origin(s.reason);
                      const href = `/emails/suppressions/${encodeURIComponent(s.id)}`;
                      const sel = selected.has(s.id);
                      return (
                        <tr key={s.id} data-active={sel ? '' : undefined} className="group">
                          <Td className="py-3 relative w-full lg:w-[429px] max-w-[60vw] lg:max-w-[429px]">
                            <div className="group flex items-center gap-3 min-w-0">
                              <div
                                className={cn(
                                  'flex items-center overflow-visible @min-[68.6rem]/bulk-actions:absolute @min-[68.6rem]/bulk-actions:-left-8 @min-[68.6rem]/bulk-actions:w-9 @min-[68.6rem]/bulk-actions:h-full @min-[68.6rem]/bulk-actions:opacity-0 @min-[68.6rem]/bulk-actions:group-hover:opacity-100 @min-[68.6rem]/bulk-actions:group-focus-within:opacity-100',
                                  (sel || selected.size > 0) && '@min-[68.6rem]/bulk-actions:opacity-100',
                                )}
                              >
                                <Checkbox
                                  label={`Select ${s.email}`}
                                  checked={sel}
                                  onChange={(v) => setSelected((cur) => {
                                    const n = new Set(cur);
                                    if (v) n.add(s.id);
                                    else n.delete(s.id);
                                    return n;
                                  })}
                                />
                              </div>
                              <Avatar text={s.email} />
                              <span translate="no" className="relative flex items-center gap-2 w-full min-w-0 truncate">
                                <DashedLink to={href} title={s.email}>
                                  {s.email}
                                </DashedLink>
                              </span>
                            </div>
                          </Td>
                          <Td className="py-3 lg:min-w-[322px]">
                            <Badge tone={o.tone} capitalize={false}>
                              {o.label}
                            </Badge>
                          </Td>
                          <Td className="py-3 text-right">
                            <Tooltip content={fullDateTime(s.created_at)}>
                              <time className="cursor-auto text-current text-sm" dateTime={s.created_at}>
                                {timeAgoShort(s.created_at)}
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
                              <MenuItem onClick={() => nav(href)}>View details</MenuItem>
                              <MenuItem
                                onClick={async () => {
                                  if (await copyText(s.email)) toast('Email address copied');
                                }}
                              >
                                Copy email address
                              </MenuItem>
                              {s.email_id ? <MenuItem onClick={() => nav(`/emails/${s.email_id}`)}>View email</MenuItem> : null}
                              <MenuItem danger onClick={() => setRemoving([s])}>
                                Remove suppression
                              </MenuItem>
                            </Menu>
                          </Td>
                        </tr>
                      );
                    })
                  )}
                </TBody>
              </Table>
            </div>
            <PageFooter page={page} pageSize={pageSize} total={all.length} noun="suppressions" onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
          </>
        )}
      </PageBody>
      <AddSuppressionDialog open={adding} onOpenChange={setAdding} />
      <ConfirmRemoveDialog
        items={removing}
        onClose={() => setRemoving(null)}
        onDone={() => setSelected(new Set())}
        teamId={teamId}
      />
    </>
  );
}
