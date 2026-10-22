import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ellipsis } from 'lucide-react';
import { apiKeys, domains as domainsApi, logs } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { DashedLink, DetailHeader } from '@/components/layout/Page';
import { API, ApiDrawerButton } from '@/components/layout/ApiDrawer';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { fullDateTime, initial, timeAgoShort } from '@/lib/format';
import { useSession } from '@/state/session';
import { KeyIcon, LastUsed, TokenPill } from './ApiKeysPage';
import { permissionLabel } from './CreateApiKeyDialog';
import { RenameApiKeyDialog } from './RenameApiKeyDialog';

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-8 flex w-full min-w-0 flex-col gap-2">
      <span className="text-xs text-default uppercase">{label}</span>
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-emphasis">{children}</div>
    </div>
  );
}

export function ApiKeyDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { canManage, me } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const list = useTeamQuery(['api-keys'], (t) => apiKeys.list(t));
  const domains = useTeamQuery(['domains'], (t) => domainsApi.list(t));
  const k = list.data?.data.find((x) => x.id === id);
  const uses = useTeamQuery(['logs', { api_key_id: id, limit: 100 }], (t) => logs.list(t, { api_key_id: id, limit: 100 }), { enabled: !!k });
  const remove = useTeamMutation((t, _v: void) => apiKeys.remove(t, id), [['api-keys']]);

  if (list.error) return <div className="mx-auto max-w-6xl px-6 pt-8"><ErrorState error={list.error} onRetry={() => void list.refetch()} /></div>;
  if (list.data && !k) {
    return (
      <div className="mx-auto max-w-6xl px-6 pt-8">
        <EmptyState title="API key not found" description="It may have been deleted, or it belongs to another team." actions={<Button onClick={() => nav('/api-keys')}>Back to API keys</Button>} />
      </div>
    );
  }
  const domain = k?.domain_id ? (domains.data?.data.find((d) => d.id === k.domain_id)?.name ?? 'Unknown domain') : 'All domains';
  const n = uses.data?.data.length ?? 0;
  const creator = k?.created_by ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col">
      <DetailHeader
        icon={<KeyIcon size={80} used={!!k?.last_used_at} />}
        eyebrow="API key"
        title={k?.name ?? <Skeleton className="h-8 w-56 mt-1" />}
        actions={
          <>
            <ApiDrawerButton examples={API.apiKeys!} />
            <Menu
              align="end"
              className="w-48"
              trigger={
                <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                  <span className="inline-flex items-center justify-center opacity-100">
                    <Ellipsis size={12} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <MenuItem disabled={!canManage || !k} onClick={() => setRenaming(true)}>
                Edit name
              </MenuItem>
              <MenuItem
                onClick={async () => {
                  if (await copyText(id)) toast('API key ID copied');
                }}
              >
                Copy API key ID
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger disabled={!canManage || !k} onClick={() => setConfirm(true)}>
                Delete API key
              </MenuItem>
            </Menu>
          </>
        }
      />
      <div className="md:grid md:grid-cols-4 gap-4 mb-10">
        <Cell label="Permission">{k ? permissionLabel(k.permission) : <Skeleton className="h-4 w-24" />}</Cell>
        <Cell label="Domain">{k ? <span className="truncate" title={domain}>{domain}</span> : <Skeleton className="h-4 w-24" />}</Cell>
        <Cell label="Total uses">
          {uses.isPending ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            <Tooltip content="API requests made with this key (from the logs)">
              <span>
                <DashedLink to={`/logs?api_key=${id}`}>
                  {n >= 100 && uses.data?.has_more ? '100+' : n} {n === 1 ? 'time' : 'times'}
                </DashedLink>
              </span>
            </Tooltip>
          )}
        </Cell>
        <Cell label="Token">{k ? <TokenPill k={k} /> : <Skeleton className="h-6 w-28" />}</Cell>
        <Cell label="Last used">{k ? <LastUsed k={k} /> : <Skeleton className="h-4 w-28" />}</Cell>
        <Cell label="Created">
          {k ? (
            <Tooltip content={fullDateTime(k.created_at)}>
              <time className="cursor-auto text-current text-sm" dateTime={k.created_at}>
                {timeAgoShort(k.created_at)}
              </time>
            </Tooltip>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
        </Cell>
        <Cell label="Creator">
          {k ? (
            <div className="group flex min-w-0 items-center gap-3">
              <span
                className="relative shrink-0 flex min-w-[24px] min-h-[24px] h-[24px] w-[24px] text-xs rounded-full border border-transparent font-medium uppercase text-default"
                style={{ background: 'linear-gradient(42deg, var(--gray-1), var(--gray-2)) padding-box, linear-gradient(42deg, var(--gray-a2) 45%, var(--gray-a6)) border-box' }}
              >
                <span className="m-auto">{initial(creator ?? me.email)}</span>
              </span>
              <span className="truncate text-sm text-emphasis font-normal" translate="no" title={creator ?? undefined}>
                {creator ?? 'Unknown'}
              </span>
            </div>
          ) : (
            <Skeleton className="h-6 w-40" />
          )}
        </Cell>
      </div>
      <RenameApiKeyDialog k={renaming ? (k ?? null) : null} onClose={() => setRenaming(false)} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete API key"
        description={
          <>
            Requests using <span className="text-emphasis break-all">{k?.name}</span> will fail immediately. This can’t be undone.
          </>
        }
        loading={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('API key deleted');
          nav('/api-keys', { replace: true });
        }}
      />
    </div>
  );
}
