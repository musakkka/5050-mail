import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, Plus, Trash } from 'lucide-react';
import { domains as domainsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Domain } from '@/api/types';
import { DashedLink, PageBody, PageHeader } from '@/components/layout/Page';
import { API, ApiDrawerButton } from '@/components/layout/ApiDrawer';
import { Button, LinkButton, iconButtonClass } from '@/components/ui/Button';
import { ExportButton, PageFooter, SearchInput } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Table, TBody, Td, Th, THead, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { DOMAIN_STATUS, domainStatus } from '@/lib/status';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { downloadText, toCsv } from '@/lib/csv';
import { BulkCheck, DomainIcon } from './shared';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...(['verified', 'pending', 'not_started', 'failed', 'temporary_failure', 'partially_verified', 'partially_failed'] as const).map((s) => ({ value: s, label: DOMAIN_STATUS[s].label })),
];

export function DomainsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(40);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Domain[] | null>(null);

  const list = useTeamQuery(['domains'], (t) => domainsApi.list(t));
  const remove = useTeamMutation((t, ids: string[]) => Promise.all(ids.map((id) => domainsApi.remove(t, id))), [['domains']]);

  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (!v || v === 'all') n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
    setPage(1);
  };

  const all = list.data?.data ?? [];
  const rows = useMemo(
    () => all.filter((d) => (status === 'all' || d.status === status) && (!q || d.name.includes(q.toLowerCase()) || d.id === q)),
    [all, q, status],
  );
  const pageRows = rows.slice((page - 1) * size, page * size);
  const allChecked = pageRows.length > 0 && pageRows.every((d) => selected.has(d.id));

  const exportCsv = () => {
    downloadText(`domains-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(['id', 'name', 'status', 'region', 'created_at'], rows.map((d) => [d.id, d.name, d.status, d.region, d.created_at])));
    toast.success(`Exported ${rows.length} domain${rows.length === 1 ? '' : 's'}`);
  };

  return (
    <>
      <PageHeader
        title="Domains"
        actions={
          <>
            <LinkButton to="/domains/add" variant="primary" icon={<Plus size={16} />}>
              Add domain
            </LinkButton>
            <ApiDrawerButton examples={API.domains!} />
          </>
        }
      />
      <PageBody>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          <EmptyState
            icon={<DomainIcon tone="gray" size={105} />}
            title="No domains yet"
            description="Add a domain you own to send emails from your own address, and to receive emails."
            actions={
              <LinkButton to="/domains/add" variant="primary" icon={<Plus size={16} />}>
                Add domain
              </LinkButton>
            }
          />
        ) : (
          <>
            <div className="mb-3 flex w-full flex-col gap-2 md:mb-4 md:flex-row">
              <div className="flex flex-col md:grid md:grid-cols-3 gap-2 flex-1">
                <SearchInput className="col-span-2" value={q} onChange={(v) => set('q', v)} />
                <Select value={status} onChange={(v) => set('status', v)} options={STATUS_OPTIONS} ariaLabel="Status" />
              </div>
              <ExportButton onClick={exportCsv} disabled={!rows.length} />
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
                  <Button size="1" variant="danger" icon={<Trash size={12} />} onClick={() => setConfirm(all.filter((d) => selected.has(d.id)))}>
                    Delete
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="@container/bulk-actions">
              <Table className="md:table-fixed">
                <THead>
                  <Th className="text-nowrap group w-[calc(260/630*100%)] min-w-0">
                    <span className="flex items-center">
                      <BulkCheck
                        head
                        label="Select all domains"
                        checked={allChecked}
                        indeterminate={!allChecked && pageRows.some((d) => selected.has(d.id))}
                        visible={selected.size > 0}
                        onChange={(v) => setSelected(v ? new Set(pageRows.map((d) => d.id)) : new Set())}
                      />
                      Domain
                    </span>
                  </Th>
                  <Th className="w-[160px]">Status</Th>
                  <Th className="w-[140px] text-right">Created</Th>
                  <Th className="w-[70px] text-center">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <TBody>
                  {list.isPending ? (
                    <SkeletonRows cols={4} rows={3} />
                  ) : pageRows.length === 0 ? (
                    <tr>
                      <Td colSpan={4} className="py-10 text-center text-default">
                        No domains match your filters.
                      </Td>
                    </tr>
                  ) : (
                    pageRows.map((d) => (
                      <DomainRow
                        key={d.id}
                        d={d}
                        checked={selected.has(d.id)}
                        anySelected={selected.size > 0}
                        onCheck={(v) =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (v) n.add(d.id);
                            else n.delete(d.id);
                            return n;
                          })
                        }
                        onDelete={() => setConfirm([d])}
                      />
                    ))
                  )}
                </TBody>
              </Table>
            </div>
            <PageFooter page={page} pageSize={size} total={rows.length} noun="domains" onPage={setPage} onPageSize={(n) => (setSize(n), setPage(1))} />
          </>
        )}
      </PageBody>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.length === 1 ? 'Delete domain' : `Delete ${confirm?.length ?? 0} domains`}
        description={
          confirm?.length === 1 ? (
            <>
              Emails can no longer be sent from <span className="text-emphasis break-all">{confirm[0]!.name}</span> and its DNS records stop being checked. This can't be undone.
            </>
          ) : (
            'Emails can no longer be sent from these domains. This can’t be undone.'
          )
        }
        typeToConfirm={confirm?.length === 1 ? confirm[0]!.name : undefined}
        loading={remove.isPending}
        onConfirm={async () => {
          if (!confirm) return;
          await remove.mutateAsync(confirm.map((d) => d.id));
          toast.success(confirm.length === 1 ? 'Domain deleted' : `${confirm.length} domains deleted`);
          setSelected(new Set());
          setConfirm(null);
        }}
      />
    </>
  );
}

function DomainRow({ d, checked, anySelected, onCheck, onDelete }: { d: Domain; checked: boolean; anySelected: boolean; onCheck: (v: boolean) => void; onDelete: () => void }) {
  const nav = useNavigate();
  const st = domainStatus(d.status);
  const href = `/domains/${d.id}`;
  const verify = useTeamMutation((t, id: string) => domainsApi.verify(t, id), [['domains']], { onSuccess: () => toast('Verification started') });
  return (
    <tr className="group/row" data-active={checked ? '' : undefined}>
      <Td className="py-3 relative">
        <div className="group flex min-w-0 items-center gap-3 w-full">
          <BulkCheck checked={checked} onChange={onCheck} label={`Select ${d.name}`} visible={anySelected} />
          <a
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            onClick={(e) => {
              e.preventDefault();
              nav(href);
            }}
          >
            <DomainIcon tone={st.tone} />
          </a>
          <span translate="no" className="relative flex items-center gap-2 w-full min-w-0">
            <DashedLink to={href} title={d.name}>
              {d.name}
            </DashedLink>
          </span>
        </div>
      </Td>
      <Td className="py-3">
        <div className="flex items-center gap-1">
          <Tooltip content={statusHint(d.status)}>
            <span>
              <Badge tone={st.badge} className="font-sans">
                {st.label.toLowerCase()}
              </Badge>
            </span>
          </Tooltip>
        </div>
      </Td>
      <Td className="py-3 text-right">
        <Tooltip content={fullDateTime(d.created_at)}>
          <time className="cursor-auto text-current text-sm" dateTime={d.created_at}>
            {timeAgoShort(d.created_at)}
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
          <MenuItem onClick={() => nav(href)}>View domain</MenuItem>
          <MenuItem disabled={d.status === 'verified'} onClick={() => verify.mutate(d.id)}>
            Verify DNS records
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={onDelete}>
            Delete domain
          </MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}

export function statusHint(s: string): string {
  switch (s) {
    case 'verified':
      return 'All DNS records are verified. Ready to send.';
    case 'pending':
      return 'Checking your DNS records. This can take a few minutes, up to 72 hours.';
    case 'not_started':
      return 'Add the DNS records, then click Verify.';
    case 'failed':
      return 'Some DNS records could not be found after 72 hours.';
    case 'temporary_failure':
      return 'A record that was verified can’t be found right now. We’ll keep checking.';
    default:
      return domainStatus(s).label;
  }
}
