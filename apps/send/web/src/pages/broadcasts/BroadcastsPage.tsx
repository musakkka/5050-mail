import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, Plus, Radio } from 'lucide-react';
import { broadcasts as broadcastsApi, segments as segmentsApi } from '@/api/client';
import { post } from '@/api/http';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Broadcast, BroadcastStatus } from '@/api/types';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { DashedLink, PageBody, PageHeader } from '@/components/layout/Page';
import { AppIcon } from '@/components/ui/AppIcon';
import { Badge } from '@/components/ui/Badge';
import { LinkButton, iconButtonClass } from '@/components/ui/Button';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ExportButton, FilterMenu, PageFooter, SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { downloadText, toCsv } from '@/lib/csv';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { ConfirmDialog } from '../audience/shared';
import { BROADCAST_STATUS, broadcastStatus } from './status';

const STATUSES: BroadcastStatus[] = ['draft', 'scheduled', 'queued', 'sending', 'sent', 'canceled', 'failed'];

export function BroadcastIcon({ status, size = 32 }: { status: string; size?: number }) {
  return (
    <AppIcon size={size} tone={broadcastStatus(status).tone} glyphSize={Math.round(size * 0.53)}>
      <Radio strokeWidth={size > 40 ? 1.75 : 2} />
    </AppIcon>
  );
}

export function BroadcastsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as BroadcastStatus | '';
  const segment = params.get('segment') ?? 'all';
  const q = params.get('q') ?? '';
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [toDelete, setToDelete] = useState<Broadcast | null>(null);
  const list = useTeamQuery(['broadcasts'], (t) => broadcastsApi.list(t));
  const segs = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  const segName = useMemo(() => new Map((segs.data?.data ?? []).map((s) => [s.id, s.name])), [segs.data]);

  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === '' ? n.delete(k) : n.set(k, v);
    setParams(n, { replace: true });
    setPage(1);
  };

  const all = list.data?.data ?? [];
  const rows = useMemo(
    () =>
      all.filter(
        (b) =>
          (!status || b.status === status) &&
          (segment === 'all' || b.segment_id === segment) &&
          (!q || `${b.name ?? ''} ${b.subject ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [all, status, segment, q],
  );
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);

  const remove = useTeamMutation((t, id: string) => broadcastsApi.remove(t, id), [['broadcasts']], {
    onSuccess: () => {
      toast.success('Broadcast deleted');
      setToDelete(null);
    },
  });
  const duplicate = useTeamMutation((t, id: string) => post<{ id: string }>(`/teams/${t}/resend/broadcasts/${id}/duplicate`), [['broadcasts']], {
    onSuccess: (r) => {
      toast.success('Broadcast duplicated');
      nav(`/broadcasts/${r.id}`);
    },
  });

  const exportCsv = () =>
    downloadText(
      `broadcasts-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        ['id', 'name', 'status', 'segment', 'created_at', 'scheduled_at', 'sent_at'],
        rows.map((b) => [b.id, b.name, b.status, b.segment_id ? (segName.get(b.segment_id) ?? b.segment_id) : '', b.created_at, b.scheduled_at, b.sent_at]),
      ),
    );

  const createBtn = (
    <LinkButton to="/broadcasts/new" variant="primary" icon={<Plus size={16} />}>
      Create broadcast
    </LinkButton>
  );

  return (
    <>
      <PageHeader
        title="Broadcasts"
        actions={
          <>
            {createBtn}
            <ApiDrawerButton examples={API.broadcasts!} />
          </>
        }
      />
      <PageBody>
        <div className="mb-3 flex flex-col items-center gap-2 md:mb-4 md:flex-row">
          <div className="w-full md:flex-[5]">
            <SearchInput value={q} onChange={(v) => set({ q: v })} />
          </div>
          <div className="grid w-full gap-2 md:flex-[5] md:grid-cols-2">
            <FilterMenu
              value={status}
              allLabel="All Statuses"
              onChange={(v) => set({ status: v })}
              options={STATUSES.map((s) => ({ value: s, label: BROADCAST_STATUS[s].label, dot: BROADCAST_STATUS[s].dot }))}
            />
            <Select
              value={segment}
              onChange={(v) => set({ segment: v === 'all' ? null : v })}
              ariaLabel="Audience"
              options={[{ value: 'all', label: 'All audiences' }, ...(segs.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
            />
          </div>
          <ExportButton onClick={exportCsv} disabled={!rows.length} />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && rows.length === 0 ? (
          all.length ? (
            <EmptyState compact title="No broadcasts found" description="No broadcasts match these filters." />
          ) : (
            <EmptyState
              icon={<BroadcastIcon status="draft" size={105} />}
              title="No broadcasts yet"
              description="Start reaching many recipients at once by creating and sending a broadcast."
              actions={createBtn}
            />
          )
        ) : (
          <>
            <Table>
              <THead>
                <Th className="w-[320px]">Name</Th>
                <Th className="w-[120px]">Status</Th>
                <Th>Audience</Th>
                <Th className="text-right w-[220px]">Created</Th>
                <Th className="w-[70px]">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody>
                {list.isPending ? (
                  <SkeletonRows cols={5} rows={4} />
                ) : (
                  visible.map((b) => {
                    const href = `/broadcasts/${b.id}`;
                    const st = broadcastStatus(b.status);
                    const when = b.status === 'sent' && b.sent_at ? b.sent_at : b.status === 'scheduled' && b.scheduled_at ? b.scheduled_at : b.created_at;
                    const name = b.name || b.subject || 'Untitled';
                    return (
                      <tr key={b.id}>
                        <Td className="py-3 max-w-[320px]">
                          <div className="group flex min-w-0 items-center gap-3">
                            <Link to={href} tabIndex={-1} aria-hidden="true">
                              <BroadcastIcon status={b.status} />
                            </Link>
                            <DashedLink to={href} title={name}>
                              {b.name || b.subject ? <span translate="no">{name}</span> : <span className="text-muted">Untitled</span>}
                            </DashedLink>
                          </div>
                        </Td>
                        <Td>
                          <Badge tone={st.badge}>{st.label.toLowerCase()}</Badge>
                        </Td>
                        <Td className="max-w-[260px]">
                          <div className="truncate">{b.segment_id ? (segName.get(b.segment_id) ?? '—') : <span className="text-muted">—</span>}</div>
                        </Td>
                        <Td className="text-right">
                          <Tooltip content={`${b.status === 'sent' ? 'Sent' : b.status === 'scheduled' ? 'Scheduled for' : 'Created'} ${fullDateTime(when)}`}>
                            <time className="cursor-auto text-current text-sm" dateTime={when}>
                              {timeAgoShort(when)}
                            </time>
                          </Tooltip>
                        </Td>
                        <Td className="text-center">
                          <Menu
                            align="end"
                            className="w-44"
                            trigger={
                              <button type="button" aria-label="More actions" className={iconButtonClass('ghost', '2', 'align-middle')}>
                                <span className="inline-flex items-center justify-center opacity-100">
                                  <Ellipsis size={12} strokeWidth={3} />
                                </span>
                              </button>
                            }
                          >
                            <MenuItem onClick={() => nav(href)}>{b.status === 'draft' ? 'Edit' : 'View'}</MenuItem>
                            <MenuItem onClick={() => duplicate.mutate(b.id)}>Duplicate</MenuItem>
                            {b.status === 'draft' || b.status === 'scheduled' ? (
                              <>
                                <MenuSeparator />
                                <MenuItem danger onClick={() => setToDelete(b)}>
                                  Delete
                                </MenuItem>
                              </>
                            ) : null}
                          </Menu>
                        </Td>
                      </tr>
                    );
                  })
                )}
              </TBody>
            </Table>
            {!list.isPending ? (
              <PageFooter page={page} pageSize={pageSize} total={rows.length} noun="broadcasts" onPage={setPage} onPageSize={(n) => (setPageSize(n), setPage(1))} />
            ) : null}
          </>
        )}
      </PageBody>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete broadcast"
        description={toDelete?.status === 'scheduled' ? 'The scheduled send is canceled and the broadcast is deleted.' : 'This draft will be deleted.'}
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </>
  );
}

