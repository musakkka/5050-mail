import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ellipsis, Plus, Workflow } from 'lucide-react';
import { automations as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Automation } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { AutomationTabsRow } from './shared';

export function AutomationsPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [toDelete, setToDelete] = useState<Automation | null>(null);
  const list = useTeamQuery(['automations'], (t) => api.list(t));
  const toggle = useTeamMutation((t, a: Automation) => (a.status === 'enabled' ? api.stop(t, a.id) : api.update(t, a.id, { status: 'enabled' })), [['automations']], {
    onSuccess: (_r, a) => toast.success(a.status === 'enabled' ? 'Automation disabled' : 'Automation enabled'),
  });
  const duplicate = useTeamMutation((t, id: string) => api.duplicate(t, id), [['automations']], { onSuccess: () => toast.success('Automation duplicated') });
  const remove = useTeamMutation((t, id: string) => api.remove(t, id), [['automations']], {
    onSuccess: () => {
      toast.success('Automation deleted');
      setToDelete(null);
    },
  });

  const all = list.data?.data ?? [];
  const rows = useMemo(() => {
    const s = q.toLowerCase();
    return all.filter((a) => (status === 'all' || a.status === status) && (!s || a.name.toLowerCase().includes(s) || a.id === s));
  }, [all, q, status]);
  const create = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => nav('/automations/new')}>
      Create automation
    </Button>
  );

  return (
    <>
      <PageHeader title="Automations" />
      <PageBody>
        <AutomationTabsRow action={create} />
        <div className="mb-3 flex w-full flex-col justify-between gap-2 md:mb-4 md:flex-row">
          <SearchInput value={q} onChange={setQ} className="w-full" />
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel="Status"
            className="max-w-[30rem] md:max-w-[200px]"
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          <EmptyState
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <Workflow strokeWidth={1.75} />
              </AppIcon>
            }
            title="No automations yet"
            description="Automate your email sending with triggers, delays, and conditions."
            actions={create}
          />
        ) : !list.isPending && rows.length === 0 ? (
          <EmptyState compact title="No automations found" description="No automations match these filters." />
        ) : (
          <Table>
            <THead>
              <Th>Name</Th>
              <Th className="w-[140px]">Status</Th>
              <Th className="w-[180px]">Updated</Th>
              <Th className="text-right w-[160px]">Created</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>
              {list.isPending ? (
                <SkeletonRows cols={5} />
              ) : (
                rows.map((a) => (
                  <tr key={a.id}>
                    <Td className="py-3 max-w-[420px]">
                      <div className="group flex items-center gap-3 w-full min-w-0">
                        <AppIcon size={32} tone={a.status === 'enabled' ? 'green' : 'gray'} glyphSize={16}>
                          <Workflow />
                        </AppIcon>
                        <DashedLink to={`/automations/${a.id}`} title={a.name}>
                          {a.name}
                        </DashedLink>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={a.status === 'enabled' ? 'success' : 'neutral'}>{a.status}</Badge>
                    </Td>
                    <Td>
                      {a.updated_at ? (
                        <Tooltip content={fullDateTime(a.updated_at)}>
                          <time dateTime={a.updated_at}>{timeAgoShort(a.updated_at)}</time>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="text-right">
                      <Tooltip content={fullDateTime(a.created_at)}>
                        <time dateTime={a.created_at}>{timeAgoShort(a.created_at)}</time>
                      </Tooltip>
                    </Td>
                    <Td className="text-center">
                      <Menu
                        align="end"
                        className="w-44"
                        trigger={
                          <button type="button" aria-label={`More actions for ${a.name}`} className={iconButtonClass('ghost', '2', 'align-middle')}>
                            <span className="inline-flex items-center justify-center opacity-100">
                              <Ellipsis size={12} strokeWidth={3} />
                            </span>
                          </button>
                        }
                      >
                        <MenuItem onClick={() => nav(`/automations/${a.id}`)}>Edit</MenuItem>
                        <MenuItem onClick={() => toggle.mutate(a)}>{a.status === 'enabled' ? 'Disable' : 'Enable'}</MenuItem>
                        <MenuItem onClick={() => duplicate.mutate(a.id)}>Duplicate</MenuItem>
                        <MenuSeparator />
                        <MenuItem danger onClick={() => setToDelete(a)}>
                          Delete
                        </MenuItem>
                      </Menu>
                    </Td>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
        )}
      </PageBody>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete automation"
        description={
          <>
            <span className="text-emphasis break-all">{toDelete?.name}</span> and its running runs will be deleted.
          </>
        }
        loading={remove.isPending}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
        }}
      />
    </>
  );
}
