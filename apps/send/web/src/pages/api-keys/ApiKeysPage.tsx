import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, KeyRound, Plus, Trash } from 'lucide-react';
import { apiKeys, domains as domainsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { ApiKey } from '@/api/types';
import { DashedLink, PageBody, PageHeader } from '@/components/layout/Page';
import { API, ApiDrawerButton } from '@/components/layout/ApiDrawer';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { ExportButton, PageFooter, SearchInput } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Table, TBody, Td, Th, THead, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoLong, timeAgoShort } from '@/lib/format';
import { downloadText, toCsv } from '@/lib/csv';
import { useSession } from '@/state/session';
import { BulkCheck } from '../domains/shared';
import { CreateApiKeyDialog, PERMISSIONS, permissionLabel } from './CreateApiKeyDialog';
import { RenameApiKeyDialog } from './RenameApiKeyDialog';

export function KeyIcon({ size = 32, used = true }: { size?: number; used?: boolean }) {
  return (
    <AppIcon size={size} tone={used ? 'green' : 'gray'} glyphSize={size >= 64 ? 36 : 17}>
      <KeyRound strokeWidth={size >= 64 ? 1.75 : 2} />
    </AppIcon>
  );
}

/** "re_joqCkFGS..." pill; the full token is never available after creation. */
export function TokenPill({ k }: { k: ApiKey }) {
  const preview = k.token_preview ? `${k.token_preview}...` : 're_••••••••...';
  return (
    <Tooltip content="The full key is only shown once, when it’s created.">
      <span className="inline-flex items-center font-medium truncate bg-interactive dark:bg-elevated text-default border border-transparent text-xs h-6 px-2 rounded-lg font-mono" translate="no">
        {preview}
      </span>
    </Tooltip>
  );
}

export function LastUsed({ k }: { k: ApiKey }) {
  if (!k.last_used_at) return <span className="text-sm text-default">Never</span>;
  return (
    <Tooltip content={fullDateTime(k.last_used_at)}>
      <span className="flex items-center gap-2 cursor-auto min-w-0">
        <DashedLink to={`/logs?api_key=${k.id}`}>
          <time className="text-current" dateTime={k.last_used_at}>
            {timeAgoLong(k.last_used_at)}
          </time>
        </DashedLink>
      </span>
    </Tooltip>
  );
}

export function ApiKeysPage() {
  const { canManage } = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const perm = params.get('permission') ?? 'all';
  const creating = params.get('new') === '1' || params.get('new') === 'true';
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(40);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ApiKey[] | null>(null);
  const [rename, setRename] = useState<ApiKey | null>(null);

  const list = useTeamQuery(['api-keys'], (t) => apiKeys.list(t));
  const domains = useTeamQuery(['domains'], (t) => domainsApi.list(t));
  const remove = useTeamMutation((t, ids: string[]) => Promise.all(ids.map((id) => apiKeys.remove(t, id))), [['api-keys']]);

  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (!v || v === 'all') n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
    setPage(1);
  };
  const setCreating = (o: boolean) => set('new', o ? '1' : null);

  const all = list.data?.data ?? [];
  const rows = useMemo(
    () => all.filter((k) => (perm === 'all' || (k.permission ?? 'full_access') === perm) && (!q || k.name.toLowerCase().includes(q.toLowerCase()) || k.id === q || k.token_preview?.startsWith(q))),
    [all, q, perm],
  );
  const pageRows = rows.slice((page - 1) * size, page * size);
  const allChecked = pageRows.length > 0 && pageRows.every((k) => selected.has(k.id));
  const domainName = (id?: string | null) => (id ? (domains.data?.data.find((d) => d.id === id)?.name ?? 'Unknown domain') : 'All domains');

  const exportCsv = () => {
    downloadText(
      `api-keys-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(['id', 'name', 'permission', 'domain', 'last_used_at', 'created_at'], rows.map((k) => [k.id, k.name, k.permission ?? '', domainName(k.domain_id), k.last_used_at, k.created_at])),
    );
    toast.success(`Exported ${rows.length} key${rows.length === 1 ? '' : 's'}`);
  };

  const createButton = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)} disabled={!canManage} title={canManage ? undefined : 'Only team admins can create API keys'}>
      Create API key
    </Button>
  );

  return (
    <>
      <PageHeader
        title="API keys"
        actions={
          <>
            {createButton}
            <ApiDrawerButton examples={API.apiKeys!} />
          </>
        }
      />
      <PageBody>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          <EmptyState icon={<KeyIcon size={105} used={false} />} title="No API keys yet" description="Create an API key to send emails and manage your account through the API." actions={createButton} />
        ) : (
          <>
            <div className="mb-3 flex w-full flex-col gap-2 md:mb-4 md:flex-row">
              <div className="flex flex-col md:grid md:grid-cols-3 gap-2 flex-1">
                <SearchInput className="col-span-2" value={q} onChange={(v) => set('q', v)} />
                <Select
                  ariaLabel="Permission"
                  value={perm}
                  onChange={(v) => set('permission', v)}
                  options={[{ value: 'all', label: 'All permissions' }, ...PERMISSIONS.map((p) => ({ value: p.value, label: p.label }))]}
                />
              </div>
              <ExportButton onClick={exportCsv} disabled={!rows.length} />
            </div>
            {selected.size > 0 ? (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-interactive bg-interactive px-3 py-1.5 text-sm text-default">
                <span>{selected.size} selected</span>
                <div className="flex gap-2">
                  <Button size="1" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <Button size="1" variant="danger" icon={<Trash size={12} />} disabled={!canManage} onClick={() => setConfirm(all.filter((k) => selected.has(k.id)))}>
                    Delete
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="@container/bulk-actions">
              <Table>
                <THead>
                  <Th className="text-nowrap group w-[320px]">
                    <span className="flex items-center">
                      <BulkCheck
                        head
                        label="Select all keys"
                        checked={allChecked}
                        indeterminate={!allChecked && pageRows.some((k) => selected.has(k.id))}
                        visible={selected.size > 0}
                        onChange={(v) => setSelected(v ? new Set(pageRows.map((k) => k.id)) : new Set())}
                      />
                      Name
                    </span>
                  </Th>
                  <Th className="w-[220px]">Token</Th>
                  <Th>Permission</Th>
                  <Th>Last used</Th>
                  <Th className="text-right">Created</Th>
                  <Th className="w-[70px]">
                    <span className="sr-only">Actions</span>
                  </Th>
                </THead>
                <TBody>
                  {list.isPending ? (
                    <SkeletonRows cols={6} rows={3} />
                  ) : pageRows.length === 0 ? (
                    <tr>
                      <Td colSpan={6} className="py-10 text-center text-default">
                        No API keys match your filters.
                      </Td>
                    </tr>
                  ) : (
                    pageRows.map((k) => (
                      <KeyRow
                        key={k.id}
                        k={k}
                        domain={domainName(k.domain_id)}
                        canManage={canManage}
                        checked={selected.has(k.id)}
                        anySelected={selected.size > 0}
                        onCheck={(v) =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (v) n.add(k.id);
                            else n.delete(k.id);
                            return n;
                          })
                        }
                        onDelete={() => setConfirm([k])}
                        onRename={() => setRename(k)}
                      />
                    ))
                  )}
                </TBody>
              </Table>
            </div>
            <PageFooter page={page} pageSize={size} total={rows.length} noun="keys" onPage={setPage} onPageSize={(n) => (setSize(n), setPage(1))} />
          </>
        )}
      </PageBody>
      <CreateApiKeyDialog open={creating && canManage} onOpenChange={setCreating} />
      <RenameApiKeyDialog k={rename} onClose={() => setRename(null)} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.length === 1 ? 'Delete API key' : `Delete ${confirm?.length ?? 0} API keys`}
        description={
          confirm?.length === 1 ? (
            <>
              Requests using <span className="text-emphasis break-all">{confirm[0]!.name}</span> will fail immediately. This can’t be undone.
            </>
          ) : (
            'Requests using these keys will fail immediately. This can’t be undone.'
          )
        }
        loading={remove.isPending}
        onConfirm={async () => {
          if (!confirm) return;
          await remove.mutateAsync(confirm.map((k) => k.id));
          toast.success(confirm.length === 1 ? 'API key deleted' : `${confirm.length} API keys deleted`);
          setSelected(new Set());
          setConfirm(null);
        }}
      />
    </>
  );
}

function KeyRow({
  k,
  domain,
  canManage,
  checked,
  anySelected,
  onCheck,
  onDelete,
  onRename,
}: {
  k: ApiKey;
  domain: string;
  canManage: boolean;
  checked: boolean;
  anySelected: boolean;
  onCheck: (v: boolean) => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const nav = useNavigate();
  const href = `/api-keys/${k.id}`;
  return (
    <tr className="group/row">
      <Td className="py-3 relative max-w-[320px]">
        <div className="group flex items-center gap-3 w-[320px] max-w-full">
          <BulkCheck checked={checked} onChange={onCheck} label={`Select ${k.name}`} visible={anySelected} />
          <a
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            onClick={(e) => {
              e.preventDefault();
              nav(href);
            }}
          >
            <KeyIcon used={!!k.last_used_at} />
          </a>
          <DashedLink to={href} title={k.name}>
            <span translate="no">{k.name}</span>
          </DashedLink>
        </div>
      </Td>
      <Td>
        <TokenPill k={k} />
      </Td>
      <Td>
        <span className="flex items-center gap-2">
          {permissionLabel(k.permission)}
          {k.permission === 'sending_access' && k.domain_id ? (
            <Tooltip content={`Restricted to ${domain}`}>
              <span className="max-w-[140px]">
                <Badge tone="outline" capitalize={false} className="max-w-full">
                  {domain}
                </Badge>
              </span>
            </Tooltip>
          ) : null}
        </span>
      </Td>
      <Td>
        <LastUsed k={k} />
      </Td>
      <Td className="text-right">
        <Tooltip content={fullDateTime(k.created_at)}>
          <time className="cursor-auto text-current text-sm" dateTime={k.created_at}>
            {timeAgoShort(k.created_at)}
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
          <MenuItem onClick={() => nav(href)}>View API key</MenuItem>
          <MenuItem disabled={!canManage} onClick={onRename}>
            Edit name
          </MenuItem>
          <MenuItem onClick={() => nav(`/logs?api_key=${k.id}`)}>View logs</MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={!canManage} onClick={onDelete}>
            Delete API key
          </MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}
