import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Ellipsis, Plus } from 'lucide-react';
import { segments as segmentsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Segment } from '@/api/types';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { DashedLink } from '@/components/layout/Page';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Switch';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { PageFooter, SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { formatNumber, fullDateTime, timeAgoShort } from '@/lib/format';
import { AudienceFrame, BULK_CONTAINER, ConfirmDialog, DashedNumber, HEAD_CHECK_WRAP, ROW_CHECK_WRAP, SegmentIcon, useSegmentContacts } from './shared';

function SegmentDialog({ open, onOpenChange, segment }: { open: boolean; onOpenChange: (o: boolean) => void; segment?: Segment | null }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(segment?.name ?? '');
      setError(null);
    }
  }, [open, segment]);
  const save = useTeamMutation(
    (t, n: string) => (segment ? segmentsApi.update(t, segment.id, n) : segmentsApi.create(t, n)),
    [['segments'], ['contacts']],
    {
      silent: true,
      onSuccess: () => {
        toast.success(segment ? 'Segment renamed' : 'Segment created');
        onOpenChange(false);
      },
    },
  );
  const submit = () => {
    const n = name.trim();
    if (!n) return setError('Enter a name.');
    if (n.length > 100) return setError('Use at most 100 characters.');
    save.mutate(n, { onError: (e) => setError(e instanceof Error ? e.message : 'Failed') });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={segment ? 'Rename segment' : 'Create segment'} onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" htmlFor="segment-name" error={error}>
          <Input id="segment-name" autoFocus autoComplete="off" placeholder="e.g., Registered users" value={name} invalid={!!error} onChange={(e) => setName(e.target.value)} />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()} kbd={['⌘', '↩︎']}>
            {segment ? 'Save' : 'Create'}
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Counts per segment: uses the API's counts when present, otherwise counts members. */
function SegmentCounts({ s }: { s: Segment }) {
  const need = s.contacts_count === undefined;
  const members = useSegmentContacts(need ? s.id : null);
  const total = s.contacts_count ?? members.data?.length;
  const unsub = s.unsubscribed_count ?? members.data?.filter((c) => c.unsubscribed).length ?? (s.contacts_count !== undefined ? 0 : undefined);
  return (
    <>
      <Td>
        <Tooltip content="Contacts in this segment">
          <DashedNumber>{total === undefined ? '—' : formatNumber(total)}</DashedNumber>
        </Tooltip>
      </Td>
      <Td>
        <Tooltip content="Unsubscribed contacts in this segment">
          <DashedNumber>{unsub === undefined ? '—' : formatNumber(unsub)}</DashedNumber>
        </Tooltip>
      </Td>
    </>
  );
}

export function SegmentsPage() {
  const nav = useNavigate();
  const list = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(40);
  const [dialog, setDialog] = useState<{ segment: Segment | null } | null>(null);
  const [toDelete, setToDelete] = useState<Segment[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const remove = useTeamMutation(
    async (t, ids: string[]) => {
      for (const id of ids) await segmentsApi.remove(t, id);
    },
    [['segments'], ['contacts']],
    {
      onSuccess: (_r, ids) => {
        toast.success(ids.length > 1 ? `${ids.length} segments deleted` : 'Segment deleted');
        setToDelete(null);
        setSelected(new Set());
      },
    },
  );

  const rows = useMemo(() => {
    const all = list.data?.data ?? [];
    return q ? all.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : all;
  }, [list.data, q]);
  const visible = rows.slice((page - 1) * pageSize, page * pageSize);
  const allSel = visible.length > 0 && visible.every((s) => selected.has(s.id));

  const actions = (
    <>
      <Button variant="primary" icon={<Plus size={16} />} onClick={() => setDialog({ segment: null })}>
        Create segment
      </Button>
      <ApiDrawerButton examples={API.segments!} />
    </>
  );

  return (
    <AudienceFrame title="Segments" actions={actions}>
      {selected.size ? (
        <div className="mb-4 flex h-8 items-center gap-2">
          <span className="mr-2 text-sm text-emphasis">{selected.size} selected</span>
          <Button variant="danger" onClick={() => setToDelete((list.data?.data ?? []).filter((s) => selected.has(s.id)))}>
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : (
        <div className="mb-4">
          <SearchInput
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
        </div>
      )}
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.isPending && rows.length === 0 ? (
        q ? (
          <EmptyState compact title="No segments found" description={`No segments match “${q}”.`} />
        ) : (
          <EmptyState
            icon={<SegmentIcon size={105} />}
            title="No segments yet"
            description="Group contacts into segments to target your broadcasts."
            actions={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setDialog({ segment: null })}>
                Create segment
              </Button>
            }
          />
        )
      ) : (
        <div className={BULK_CONTAINER}>
          <Table>
            <THead>
              <Th className="w-[320px] group relative">
                <span className="flex items-center">
                  <span className={HEAD_CHECK_WRAP}>
                    <Checkbox
                      checked={allSel}
                      label="Select all segments"
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          visible.forEach((x) => (allSel ? n.delete(x.id) : n.add(x.id)));
                          return n;
                        })
                      }
                    />
                  </span>
                  Name
                </span>
              </Th>
              <Th className="w-[120px]">Contacts</Th>
              <Th className="w-[140px]">Unsubscribed</Th>
              <Th className="text-right">Created</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>
              {list.isPending ? (
                <SkeletonRows cols={5} rows={3} />
              ) : (
                visible.map((s) => {
                  const href = `/audience?segmentId=${s.id}`;
                  return (
                    <tr key={s.id} className="group" data-active={selected.has(s.id) ? '' : undefined}>
                      <Td className="py-3 relative group">
                        <div className="group flex items-center gap-3 w-[320px] max-w-full">
                          <div className={ROW_CHECK_WRAP}>
                            <Checkbox
                              checked={selected.has(s.id)}
                              label={`Select ${s.name}`}
                              className="my-auto"
                              onChange={(v) =>
                                setSelected((x) => {
                                  const n = new Set(x);
                                  if (v) n.add(s.id);
                                  else n.delete(s.id);
                                  return n;
                                })
                              }
                            />
                          </div>
                          <Link to={href} tabIndex={-1} aria-hidden="true">
                            <SegmentIcon />
                          </Link>
                          <DashedLink to={href} title={s.name}>
                            <span translate="no">{s.name}</span>
                          </DashedLink>
                        </div>
                      </Td>
                      <SegmentCounts s={s} />
                      <Td className="text-right">
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
                          <MenuItem onClick={() => nav(href)}>View contacts</MenuItem>
                          <MenuItem onClick={() => setDialog({ segment: s })}>Rename</MenuItem>
                          <MenuSeparator />
                          <MenuItem danger onClick={() => setToDelete([s])}>
                            Delete segment
                          </MenuItem>
                        </Menu>
                      </Td>
                    </tr>
                  );
                })
              )}
            </TBody>
          </Table>
          {!list.isPending ? (
            <PageFooter page={page} pageSize={pageSize} total={rows.length} noun="segments" onPage={setPage} onPageSize={(n) => (setPageSize(n), setPage(1))} />
          ) : null}
        </div>
      )}
      <SegmentDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} segment={dialog?.segment} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete && toDelete.length > 1 ? `Delete ${toDelete.length} segments` : 'Delete segment'}
        description={
          toDelete?.length === 1 ? (
            <>
              Delete <span className="text-emphasis break-all">{toDelete[0]!.name}</span>? Its contacts are kept; they're only removed from this segment.
            </>
          ) : (
            'Contacts are kept; they are only removed from these segments.'
          )
        }
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.map((s) => s.id))}
      />
    </AudienceFrame>
  );
}
