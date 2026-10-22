import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, CloudUpload, Ellipsis, UserRound } from 'lucide-react';
import { contacts as contactsApi, segments as segmentsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { Contact } from '@/api/types';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { DashedLink } from '@/components/layout/Page';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { SearchInput, ExportButton, PageFooter } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Switch';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { toast, toastError } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort, formatNumber } from '@/lib/format';
import { toCsv, downloadText } from '@/lib/csv';
import { cn } from '@/lib/cn';
import { useTeamId } from '@/state/session';
import { AddContactDialog, ImportContactsDialog } from './AddContactsDialogs';
import {
  AudienceFrame,
  BULK_CONTAINER,
  ConfirmDialog,
  HEAD_CHECK_WRAP,
  ROW_CHECK_WRAP,
  Stat,
  contactName,
  useAllContacts,
  useInvalidateAudience,
  useSegmentContacts,
} from './shared';

type SubFilter = 'all' | 'subscribed' | 'unsubscribed';

function AddContactsMenu({ onManual, onImport }: { onManual: () => void; onImport: () => void }) {
  return (
    <Menu
      align="end"
      className="w-44"
      trigger={
        <Button variant="primary" icon={<Plus size={16} />}>
          Add contacts
        </Button>
      }
    >
      <MenuItem icon={<Pencil />} onClick={onManual}>
        Add manually
      </MenuItem>
      <MenuItem icon={<CloudUpload />} onClick={onImport}>
        Import CSV
      </MenuItem>
    </Menu>
  );
}

/** Contacts over the last 30 days (running total), as a tiny line. */
function Sparkline({ contacts }: { contacts: Contact[] }) {
  const pts = useMemo(() => {
    const days = 30;
    const now = Date.now();
    const vals: number[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const cutoff = now - i * 86400000;
      vals.push(contacts.filter((c) => Date.parse(c.created_at) <= cutoff).length);
    }
    const min = Math.min(...vals);
    const span = Math.max(1, Math.max(...vals) - min);
    return vals.map((v, i) => `${(i / (days - 1)) * 148 + 1},${33 - ((v - min) / span) * 30}`).join(' ');
  }, [contacts]);
  return (
    <svg width="150" height="35" viewBox="0 0 150 35" aria-label="Contacts over the last 30 days" role="img">
      <polyline points={pts} fill="none" stroke="var(--green-a10)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ContactsPage() {
  const teamId = useTeamId();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const segmentId = params.get('segmentId');
  const sub = (params.get('subscription') ?? 'all') as SubFilter;
  const q = params.get('q') ?? '';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [confirm, setConfirm] = useState<null | { ids: string[] }>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateAudience();

  const all = useAllContacts();
  const segContacts = useSegmentContacts(segmentId);
  const segs = useTeamQuery(['segments'], (t) => segmentsApi.list(t));

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === '' ? n.delete(k) : n.set(k, v);
    setParams(n, { replace: true });
    setPage(1);
    setSelected(new Set());
  };

  const source = segmentId ? segContacts : all;
  const base = source.data ?? [];
  const filtered = useMemo(() => {
    let rows = base;
    if (sub !== 'all') rows = rows.filter((c) => (sub === 'unsubscribed' ? c.unsubscribed : !c.unsubscribed));
    if (q) {
      const terms = q
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter(Boolean);
      rows = rows.filter((c) => {
        const hay = `${c.email} ${contactName(c)}`.toLowerCase();
        return terms.length > 1 ? terms.some((t) => c.email.toLowerCase() === t || hay.includes(t)) : hay.includes(terms[0]!);
      });
    }
    return rows;
  }, [base, sub, q]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  const totals = all.data ?? [];
  const subscribers = totals.filter((c) => !c.unsubscribed).length;
  const hasAny = totals.length > 0;
  const isFiltering = !!(segmentId || sub !== 'all' || q);

  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visible.forEach((c) => n.delete(c.id));
      else visible.forEach((c) => n.add(c.id));
      return n;
    });

  const bulk = async (kind: 'delete' | 'unsubscribe' | 'subscribe', ids: string[]) => {
    setBusy(true);
    let ok = 0;
    for (const id of ids) {
      try {
        if (kind === 'delete') await contactsApi.remove(teamId, id);
        else await contactsApi.update(teamId, id, { unsubscribed: kind === 'unsubscribe' });
        ok++;
      } catch (e) {
        toastError(e);
      }
    }
    await invalidate();
    setBusy(false);
    setSelected(new Set());
    setConfirm(null);
    if (ok) toast.success(`${formatNumber(ok)} contact${ok === 1 ? '' : 's'} ${kind === 'delete' ? 'deleted' : kind === 'unsubscribe' ? 'unsubscribed' : 'resubscribed'}`);
  };

  const exportCsv = () => {
    downloadText(
      `contacts-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['id', 'email', 'first_name', 'last_name', 'unsubscribed', 'created_at'],
        filtered.map((c) => [c.id, c.email, c.first_name, c.last_name, c.unsubscribed, c.created_at]),
      ),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setDropped(f);
      setImportOpen(true);
    }
  };

  const segOptions = [{ value: 'all', label: 'All contacts' }, ...(segs.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))];
  const actions = (
    <>
      <AddContactsMenu onManual={() => setManual(true)} onImport={() => (setDropped(null), setImportOpen(true))} />
      <ApiDrawerButton examples={API.contacts!} />
    </>
  );

  return (
    <AudienceFrame title="Contacts" actions={actions}>
      <div className="mt-4 mb-6 grid grid-cols-2 gap-y-12 px-3 md:mb-8 md:flex md:justify-between md:gap-0">
        <Stat label="All contacts" value={all.isPending ? '—' : formatNumber(totals.length)} />
        <Stat label="Subscribers" value={all.isPending ? '—' : formatNumber(subscribers)} />
        <Stat label="Unsubscribers" value={all.isPending ? '—' : formatNumber(totals.length - subscribers)} />
        <div className="flex w-full min-w-[150px] flex-col items-start gap-2 md:max-w-fit">
          <span className="text-xs text-default font-normal uppercase">Metrics</span>
          {hasAny ? <Sparkline contacts={totals} /> : <span className="h-[35px]" />}
        </div>
      </div>

      {selected.size ? (
        <div className="mb-6 flex min-h-8 flex-wrap items-center gap-2 md:mb-3" role="toolbar" aria-label="Bulk actions">
          <span className="mr-2 text-sm text-emphasis">{formatNumber(selected.size)} selected</span>
          <Button size="2" onClick={() => void bulk('unsubscribe', [...selected])} disabled={busy}>
            Unsubscribe
          </Button>
          <Button size="2" onClick={() => void bulk('subscribe', [...selected])} disabled={busy}>
            Resubscribe
          </Button>
          <Button size="2" variant="danger" onClick={() => setConfirm({ ids: [...selected] })} disabled={busy}>
            Delete
          </Button>
          <Button size="2" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : (
        <div className="@container/filters mb-6 md:mb-3">
          <div className="flex flex-col gap-3 @min-[40rem]/filters:flex-row @min-[40rem]/filters:gap-2">
            <div className="flex-auto @min-[54rem]/filters:min-w-[420px]">
              <SearchInput value={q} onChange={(v) => set({ q: v })} placeholder="Search by name, email, or multiple emails..." />
            </div>
            <div className="flex w-full min-w-0 gap-2 @min-[40rem]/filters:w-2/3">
              <Select value={segmentId ?? 'all'} onChange={(v) => set({ segmentId: v === 'all' ? null : v })} options={segOptions} ariaLabel="Segment" className="min-w-0 flex-1" />
              <Select
                value={sub}
                onChange={(v) => set({ subscription: v === 'all' ? null : v })}
                options={[
                  { value: 'all', label: 'All subscriptions' },
                  { value: 'subscribed', label: 'Subscribed' },
                  { value: 'unsubscribed', label: 'Unsubscribed' },
                ]}
                ariaLabel="Subscription"
                className="min-w-0 flex-1"
              />
            </div>
            <ExportButton onClick={exportCsv} disabled={!filtered.length} />
          </div>
        </div>
      )}

      <div
        role="presentation"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
        }}
        onDrop={onDrop}
        className={cn('relative rounded-2xl border border-dashed', drag ? 'border-gray-8 bg-interactive' : 'border-transparent')}
      >
        {drag ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/80 text-sm text-emphasis">
            <CloudUpload size={18} className="mr-2" /> Drop your CSV to import contacts
          </div>
        ) : null}
        {source.error ? (
          <ErrorState error={source.error} onRetry={() => void source.refetch()} />
        ) : !source.isPending && !hasAny && !segmentId ? (
          <EmptyState
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <UserRound strokeWidth={1.75} />
              </AppIcon>
            }
            title="No contacts yet"
            description={<span className="inline-block max-w-96">Add contacts to manage, segment, and reach your audience.</span>}
            actions={
              <>
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => setManual(true)}>
                  Add contacts
                </Button>
                <Button icon={<CloudUpload size={16} />} onClick={() => (setDropped(null), setImportOpen(true))}>
                  Import contacts
                </Button>
              </>
            }
          />
        ) : !source.isPending && filtered.length === 0 ? (
          <EmptyState compact title="No contacts found" description={isFiltering ? 'No contacts match these filters.' : 'This segment has no contacts yet.'} />
        ) : (
          <div className={BULK_CONTAINER}>
            <Table>
              <THead>
                <Th className="w-[320px] group relative">
                  <span className="flex items-center">
                    <span className={HEAD_CHECK_WRAP}>
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={!allVisibleSelected && visible.some((c) => selected.has(c.id))}
                        onChange={toggleAll}
                        label="Select all contacts on this page"
                      />
                    </span>
                    Email
                  </span>
                </Th>
                <Th className="w-[200px]">Name</Th>
                <Th className="w-[140px]">Status</Th>
                <Th className="text-right">Added</Th>
                <Th className="w-[70px]">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody>
                {source.isPending ? (
                  <SkeletonRows cols={5} />
                ) : (
                  visible.map((c) => (
                    <ContactRow
                      key={c.id}
                      c={c}
                      checked={selected.has(c.id)}
                      onCheck={(v) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (v) n.add(c.id);
                          else n.delete(c.id);
                          return n;
                        })
                      }
                      onOpen={() => nav(`/audience/contacts/${c.id}`)}
                      onToggleSub={() => void bulk(c.unsubscribed ? 'subscribe' : 'unsubscribe', [c.id])}
                      onDelete={() => setConfirm({ ids: [c.id] })}
                    />
                  ))
                )}
              </TBody>
            </Table>
            {!source.isPending ? (
              <PageFooter page={page} pageSize={pageSize} total={filtered.length} noun="contacts" onPage={setPage} onPageSize={(n) => (setPageSize(n), setPage(1))} />
            ) : null}
          </div>
        )}
      </div>

      <AddContactDialog open={manual} onOpenChange={setManual} defaultSegment={segmentId} />
      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} initialFile={dropped} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm && confirm.ids.length > 1 ? `Delete ${confirm.ids.length} contacts` : 'Delete contact'}
        description="Deleted contacts are removed from every segment and stop receiving broadcasts. This can't be undone."
        loading={busy}
        onConfirm={() => confirm && void bulk('delete', confirm.ids)}
      />
    </AudienceFrame>
  );
}

function ContactRow({
  c,
  checked,
  onCheck,
  onOpen,
  onToggleSub,
  onDelete,
}: {
  c: Contact;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onOpen: () => void;
  onToggleSub: () => void;
  onDelete: () => void;
}) {
  const href = `/audience/contacts/${c.id}`;
  const name = contactName(c);
  return (
    <tr data-active={checked ? '' : undefined} className="group">
      <Td className="py-3 relative group max-w-[320px]">
        <div className="group flex items-center gap-3 w-full min-w-0">
          <div className={ROW_CHECK_WRAP}>
            <Checkbox checked={checked} onChange={onCheck} label={`Select ${c.email}`} className="my-auto" />
          </div>
          <Link to={href} tabIndex={-1} aria-hidden="true">
            <AppIcon size={32} tone={c.unsubscribed ? 'gray' : 'blue'} glyphSize={17}>
              <UserRound strokeWidth={2} />
            </AppIcon>
          </Link>
          <span translate="no" className="relative flex items-center gap-2 w-full min-w-0">
            <DashedLink to={href} title={c.email}>
              {c.email}
            </DashedLink>
          </span>
        </div>
      </Td>
      <Td className="max-w-[200px]">
        <div className="truncate" title={name}>
          {name || <span className="text-muted">—</span>}
        </div>
      </Td>
      <Td>
        <Badge tone={c.unsubscribed ? 'neutral' : 'success'}>{c.unsubscribed ? 'unsubscribed' : 'subscribed'}</Badge>
      </Td>
      <Td className="text-right">
        <Tooltip content={fullDateTime(c.created_at)}>
          <time className="cursor-auto text-current text-sm" dateTime={c.created_at}>
            {timeAgoShort(c.created_at)}
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
          <MenuItem onClick={onOpen}>View contact</MenuItem>
          <MenuItem onClick={onToggleSub}>{c.unsubscribed ? 'Resubscribe' : 'Unsubscribe'}</MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={onDelete}>
            Delete contact
          </MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}
