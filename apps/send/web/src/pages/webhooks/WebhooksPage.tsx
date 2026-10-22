import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, Plus } from 'lucide-react';
import { webhooks as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Webhook, WebhookEventType } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/toast';
import { copyText } from '@/components/ui/CopyButton';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { EventsPicker, WebhookIcon, endpointError } from './shared';
import { DeleteWebhookDialog } from './DeleteWebhookDialog';

export function AddWebhookDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate();
  const [endpoint, setEndpoint] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setEndpoint('');
      setEvents([]);
      setTouched(false);
      setServerError(null);
    }
  }, [open]);
  const create = useTeamMutation((t, b: { endpoint: string; events: WebhookEventType[] }) => api.create(t, b), [['webhooks']], {
    silent: true,
    onSuccess: (w) => {
      toast.success('Webhook added');
      onOpenChange(false);
      if (w?.id) nav(`/webhooks/${w.id}`);
    },
  });
  const err = endpointError(endpoint);
  const valid = !err && events.length > 0;
  const submit = () => {
    setTouched(true);
    if (!valid || create.isPending) return;
    setServerError(null);
    create.mutate({ endpoint: endpoint.trim(), events }, { onError: (e) => setServerError((e as Error).message) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add webhook" onSubmit={submit} initialFocus={ref}>
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Endpoint URL" htmlFor="endpoint" error={(touched && endpoint && err) || serverError}>
          <Input
            ref={ref}
            id="endpoint"
            name="endpoint"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://"
            value={endpoint}
            invalid={!!((touched && endpoint && err) || serverError)}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setServerError(null);
            }}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <label htmlFor="events" className="text-sm text-default">
            Select events to listen
          </label>
          <EventsPicker id="events" value={events} onChange={setEvents} />
          {touched && events.length === 0 && endpoint ? <p className="text-xs text-error">Select at least one event.</p> : null}
        </div>
        <DialogActions className="mt-0">
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!valid} loading={create.isPending}>
            Add
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function Row({ w, onDelete }: { w: Webhook; onDelete: (w: Webhook) => void }) {
  const nav = useNavigate();
  const href = `/webhooks/${w.id}`;
  const toggle = useTeamMutation((t, status: 'enabled' | 'disabled') => api.update(t, w.id, { status }), [['webhooks'], ['webhook', w.id]], {
    onSuccess: (_r, s) => toast.success(s === 'enabled' ? 'Webhook enabled' : 'Webhook disabled'),
  });
  return (
    <tr>
      <Td className="py-3 max-w-0 w-[45%]">
        <div className="group flex min-w-0 items-center gap-3 w-full">
          <a
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            onClick={(e) => {
              e.preventDefault();
              nav(href);
            }}
          >
            <WebhookIcon status={w.status} />
          </a>
          <DashedLink to={href} title={w.endpoint}>
            <span translate="no">{w.endpoint}</span>
          </DashedLink>
        </div>
      </Td>
      <Td className="py-3">
        <Badge tone={w.status === 'enabled' ? 'success' : 'neutral'}>{w.status}</Badge>
      </Td>
      <Td className="py-3">
        <Tooltip content={<span className="font-mono">{w.events.join(', ')}</span>}>
          <span className="text-sm text-default">
            {w.events.length} event{w.events.length === 1 ? '' : 's'}
          </span>
        </Tooltip>
      </Td>
      <Td className="py-3 text-right">
        <Tooltip content={fullDateTime(w.created_at)}>
          <time className="cursor-auto text-current text-sm" dateTime={w.created_at}>
            {timeAgoShort(w.created_at)}
          </time>
        </Tooltip>
      </Td>
      <Td className="text-center w-[70px]">
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
          <MenuItem onClick={() => nav(href)}>View webhook</MenuItem>
          <MenuItem
            onClick={async () => {
              if (await copyText(w.endpoint)) toast('Endpoint copied');
            }}
          >
            Copy endpoint
          </MenuItem>
          <MenuItem onClick={() => toggle.mutate(w.status === 'enabled' ? 'disabled' : 'enabled')}>{w.status === 'enabled' ? 'Disable' : 'Enable'}</MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => onDelete(w)}>
            Delete webhook
          </MenuItem>
        </Menu>
      </Td>
    </tr>
  );
}

export function WebhooksPage() {
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(params.get('new') === '1');
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const list = useTeamQuery(['webhooks'], (t) => api.list(t));
  const rows = list.data?.data ?? [];
  const setOpen = (o: boolean) => {
    setAdding(o);
    if (!o && params.has('new')) {
      const n = new URLSearchParams(params);
      n.delete('new');
      setParams(n, { replace: true });
    }
  };
  const addButton = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>
      Add webhook
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Webhooks"
        actions={
          <>
            {addButton}
            <ApiDrawerButton examples={API.webhooks!} />
          </>
        }
      />
      <PageBody>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && rows.length === 0 ? (
          <EmptyState
            icon={<WebhookIcon size={105} />}
            title="No webhooks yet"
            description="Configure a webhook to receive real-time updates about email events."
            actions={addButton}
          />
        ) : (
          <Table>
            <THead>
              <Th>Endpoint</Th>
              <Th className="w-[140px]">Status</Th>
              <Th className="w-[140px]">Events</Th>
              <Th className="w-[140px] text-right">Created</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>{list.isPending ? <SkeletonRows cols={5} rows={3} /> : rows.map((w) => <Row key={w.id} w={w} onDelete={setDeleting} />)}</TBody>
          </Table>
        )}
      </PageBody>
      <AddWebhookDialog open={adding} onOpenChange={setOpen} />
      <DeleteWebhookDialog webhook={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
    </>
  );
}
