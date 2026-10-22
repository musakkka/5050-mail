import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Dialog as D } from '@base-ui/react/dialog';
import { CircleAlert, CircleCheck, Ellipsis, Eye, EyeOff, RotateCw, X } from 'lucide-react';
import { webhooks as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { WebhookDelivery, WebhookEventType } from '@/api/types';
import { DetailHeader, Meta, PageBody } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button, IconButton, LinkButton, iconButtonClass } from '@/components/ui/Button';
import { CopyButton, IdPill } from '@/components/ui/CopyButton';
import { Code } from '@/components/ui/Code';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { CursorPager } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { fullDateTime, shortDateTime, timeAgoShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DeleteWebhookDialog } from './DeleteWebhookDialog';
import { EventsPicker, WebhookIcon, endpointError } from './shared';

const DELIVERY_TONE: Record<string, BadgeTone> = { success: 'success', failed: 'error', pending: 'neutral', attempting: 'warning' };
const DELIVERY_LABEL: Record<string, string> = { success: 'succeeded', failed: 'failed', pending: 'pending', attempting: 'retrying' };

function Banner({ tone, title, children }: { tone: 'error' | 'success'; title: string; children: ReactNode }) {
  const c = tone === 'error' ? 'from-red-4 border-red-5' : 'from-green-4 border-green-5';
  return (
    <div
      role="alert"
      className={cn('bg-gradient-fade flex items-center gap-4 border bg-clip-padding sm:gap-2 p-4 rounded-2xl', c)}
      style={{ ['--tw-gradient-to' as string]: 'var(--background)' }}
    >
      <span className={cn('shrink-0 self-start', tone === 'error' ? 'text-error' : 'text-success')}>
        {tone === 'error' ? <CircleAlert size={16} className="translate-y-0.5" /> : <CircleCheck size={16} className="translate-y-0.5" />}
      </span>
      <p className="text-sm text-default font-normal">
        <span className="text-emphasis">{title}</span> {children}
      </p>
    </div>
  );
}

function SigningSecret({ webhookId, secret }: { webhookId: string; secret: string | undefined }) {
  const [shown, setShown] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const rotate = useTeamMutation((t) => api.rotateSecret(t, webhookId), [['webhook', webhookId]], {
    onSuccess: () => {
      toast.success('Signing secret rotated. The previous secret keeps working for 24 hours.');
      setConfirm(false);
      setShown(true);
    },
  });
  return (
    <>
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <span
          className="inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-xl border border-transparent bg-interactive pl-3 pr-1 font-mono text-[13px] text-default dark:bg-elevated"
          translate="no"
        >
          <span className={cn('truncate', !shown && 'tracking-widest')} aria-label={shown ? undefined : 'Hidden signing secret'}>
            {secret ? (shown ? secret : 'whsec_' + '•'.repeat(24)) : '—'}
          </span>
          <Tooltip content={shown ? 'Hide' : 'Reveal'}>
            <IconButton label={shown ? 'Hide signing secret' : 'Reveal signing secret'} variant="ghost" size="1" onClick={() => setShown((s) => !s)} disabled={!secret}>
              {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
          </Tooltip>
          {secret ? <CopyButton value={secret} label="Copy signing secret" /> : null}
        </span>
        <Button size="2" icon={<RotateCw size={14} />} onClick={() => setConfirm(true)}>
          Rotate
        </Button>
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Rotate signing secret"
        description="A new secret is generated right away. The current one keeps verifying signatures for 24 hours so you can update your endpoint."
        onSubmit={() => !rotate.isPending && rotate.mutate(undefined)}
      >
        <DialogActions>
          <Button variant="primary" kbd={['⌘', '↩︎']} loading={rotate.isPending} onClick={() => rotate.mutate(undefined)}>
            Rotate secret
          </Button>
          <Button onClick={() => setConfirm(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function EditDialog({ open, onOpenChange, id, endpoint, events }: { open: boolean; onOpenChange: (o: boolean) => void; id: string; endpoint: string; events: string[] }) {
  const [url, setUrl] = useState(endpoint);
  const [ev, setEv] = useState<WebhookEventType[]>(events as WebhookEventType[]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setUrl(endpoint);
      setEv(events as WebhookEventType[]);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open]);
  const save = useTeamMutation((t, b: { endpoint: string; events: WebhookEventType[] }) => api.update(t, id, b), [['webhooks'], ['webhook', id]], {
    silent: true,
    onSuccess: () => {
      toast.success('Webhook updated');
      onOpenChange(false);
    },
  });
  const err = endpointError(url);
  const submit = () => {
    if (err || !ev.length || save.isPending) return;
    save.mutate({ endpoint: url.trim(), events: ev }, { onError: (e) => setError((e as Error).message) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Edit webhook" onSubmit={submit}>
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Endpoint URL" htmlFor="edit-endpoint" error={(url && err) || error}>
          <Input id="edit-endpoint" type="url" value={url} invalid={!!((url && err) || error)} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <label htmlFor="edit-events" className="text-sm text-default">
            Events
          </label>
          <EventsPicker id="edit-events" value={ev} onChange={setEv} />
        </div>
        <DialogActions className="mt-0">
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!!err || !ev.length} loading={save.isPending}>
            Save
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Right-hand panel with one delivery: payload, attempts and Replay. */
function DeliveryPanel({ webhookId, delivery, onClose }: { webhookId: string; delivery: WebhookDelivery | null; onClose: () => void }) {
  const id = delivery?.id ?? '';
  const detail = useTeamQuery(['webhook', webhookId, 'event', id], (t) => api.event(t, webhookId, id), { enabled: !!delivery });
  const attempts = useTeamQuery(['webhook', webhookId, 'attempts', id], (t) => api.attempts(t, webhookId, id), { enabled: !!delivery });
  const replay = useTeamMutation(
    (t) => api.replay(t, webhookId, id),
    [
      ['webhook', webhookId, 'attempts', id],
      ['webhook', webhookId, 'event', id],
      ['webhook', webhookId, 'events'],
      ['webhook', webhookId, 'health'],
    ],
    { onSuccess: () => toast.success('Event replayed') },
  );
  const payload = detail.data?.payload ?? delivery?.payload;
  const json = payload !== undefined ? JSON.stringify(payload, null, 2) : '';
  const status = detail.data?.status ?? delivery?.status ?? 'pending';
  return (
    <D.Root open={!!delivery} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <D.Popup className="fixed inset-y-2 right-2 z-50 flex w-[min(600px,calc(100vw-16px))] flex-col overflow-hidden rounded-3xl border border-default bg-background shadow-lg outline-none transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] data-starting-style:translate-x-8 data-starting-style:opacity-0 data-ending-style:translate-x-8 data-ending-style:opacity-0">
          <div className="flex items-start justify-between gap-3 border-b border-default px-5 py-4">
            <div className="min-w-0">
              <D.Title className="truncate font-mono text-sm font-semibold text-emphasis">{delivery?.type}</D.Title>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-default">
                <Badge tone={DELIVERY_TONE[status] ?? 'neutral'}>{DELIVERY_LABEL[status] ?? status}</Badge>
                <span>{delivery ? fullDateTime(delivery.created_at) : ''}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="2" icon={<RotateCw size={14} />} loading={replay.isPending} onClick={() => replay.mutate(undefined)}>
                Replay
              </Button>
              <D.Close render={<IconButton label="Close" variant="ghost" size="1"><X size={18} /></IconButton>} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-emphasis">Payload</h3>
              {json ? <CopyButton value={json} /> : null}
            </div>
            <div className="overflow-hidden rounded-2xl border border-gray-2 bg-white dark:bg-black">
              {json ? <Code code={json} lang="json" wrap /> : detail.isPending ? <Skeleton className="m-4 h-32" /> : <p className="p-4 text-sm text-muted">No payload.</p>}
            </div>
            <h3 className="mb-2 mt-6 text-sm font-semibold text-emphasis">Attempts</h3>
            {attempts.isPending ? (
              <Skeleton className="h-20 w-full rounded-2xl" />
            ) : attempts.error ? (
              <ErrorState error={attempts.error} onRetry={() => void attempts.refetch()} />
            ) : !attempts.data?.data.length ? (
              <p className="rounded-2xl border border-gray-3 p-4 text-sm text-muted">No attempts yet. The first attempt is sent within a few seconds.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {attempts.data.data.map((a) => {
                  const ok = a.http_status_code !== null && a.http_status_code >= 200 && a.http_status_code < 300;
                  return (
                    <li key={a.id} className="rounded-2xl border border-gray-3 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge tone={ok ? 'success' : 'error'} capitalize={false}>
                            {a.http_status_code ?? 'No response'}
                          </Badge>
                          {a.is_replay ? <Badge capitalize={false}>Replay</Badge> : null}
                          {a.duration_ms != null ? <span className="text-xs text-muted">{a.duration_ms} ms</span> : null}
                        </div>
                        <Tooltip content={fullDateTime(a.sent_at)}>
                          <time className="text-xs text-default" dateTime={a.sent_at}>
                            {shortDateTime(a.sent_at)}
                          </time>
                        </Tooltip>
                      </div>
                      {a.error || a.response ? (
                        <pre className={cn('mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-interactive p-2 font-mono text-xs', a.error ? 'text-error' : 'text-default')}>
                          {a.error ?? a.response}
                        </pre>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </D.Popup>
      </D.Portal>
    </D.Root>
  );
}

type DeliveryFilter = 'all' | 'success' | 'failed' | 'pending';

export function WebhookDetailPage() {
  const { id = '' } = useParams();
  const wh = useTeamQuery(['webhook', id], (t) => api.get(t, id));
  const health = useTeamQuery(['webhook', id, 'health'], (t) => api.health(t, id));
  const [filter, setFilter] = useState<DeliveryFilter>('all');
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const page = { limit: 20, after, status: filter === 'all' ? undefined : filter };
  const deliveries = useTeamQuery(['webhook', id, 'events', page], (t) => api.events(t, id, page), { keepPrevious: true });
  const [open, setOpen] = useState<WebhookDelivery | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toggle = useTeamMutation((t, status: 'enabled' | 'disabled') => api.update(t, id, { status }), [['webhooks'], ['webhook', id]], {
    onSuccess: (_r, s) => toast.success(s === 'enabled' ? 'Webhook enabled' : 'Webhook disabled'),
  });

  if (wh.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        {wh.error instanceof ApiError && (wh.error.status === 404 || wh.error.status === 422) ? (
          <EmptyState compact title="Webhook not found" description="It may have been deleted." actions={<LinkButton to="/webhooks">Back to webhooks</LinkButton>} />
        ) : (
          <ErrorState error={wh.error} onRetry={() => void wh.refetch()} />
        )}
      </div>
    );
  }
  const w = wh.data;
  const h = health.data?.last_7_days;
  const total = h ? h.success + h.failed : 0;
  const rows = deliveries.data?.data ?? [];

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col">
        <DetailHeader
          icon={<WebhookIcon status={w?.status} size={80} />}
          eyebrow="Webhook"
          title={w ? w.endpoint : <Skeleton className="mt-1 h-8 w-80 max-w-full" />}
          actions={
            <>
              <ApiDrawerButton examples={API.webhooks!} />
              <Menu
                align="end"
                className="w-52"
                trigger={
                  <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')} disabled={!w}>
                    <span className="inline-flex items-center justify-center opacity-100">
                      <Ellipsis size={12} strokeWidth={3} />
                    </span>
                  </button>
                }
              >
                <MenuItem onClick={() => setEditing(true)}>Edit webhook</MenuItem>
                <MenuItem onClick={() => w && toggle.mutate(w.status === 'enabled' ? 'disabled' : 'enabled')}>{w?.status === 'enabled' ? 'Disable webhook' : 'Enable webhook'}</MenuItem>
                <MenuSeparator />
                <MenuItem danger onClick={() => setDeleting(true)}>
                  Delete webhook
                </MenuItem>
              </Menu>
            </>
          }
        />
        <div className="md:grid md:grid-cols-4 gap-4">
          <Meta label="Created">
            {w ? (
              <Tooltip content={fullDateTime(w.created_at)}>
                <time dateTime={w.created_at}>{timeAgoShort(w.created_at)}</time>
              </Tooltip>
            ) : (
              <Skeleton className="h-4 w-20" />
            )}
          </Meta>
          <Meta label="Status">
            {w ? (
              <>
                <Switch label={w.status === 'enabled' ? 'Disable webhook' : 'Enable webhook'} checked={w.status === 'enabled'} disabled={toggle.isPending} onChange={(on) => toggle.mutate(on ? 'enabled' : 'disabled')} />
                <Badge tone={w.status === 'enabled' ? 'success' : 'neutral'}>{w.status}</Badge>
              </>
            ) : (
              <Skeleton className="h-6 w-24" />
            )}
          </Meta>
          <Meta label="Last 7 days">
            {h ? (
              <Tooltip content={`${h.success} succeeded · ${h.failed} failed · ${h.pending} pending`}>
                <span className="flex items-center gap-2">
                  <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: h.failed ? 'var(--amber-a11)' : 'var(--green-a11)' }} />
                  {total ? `${Math.round((h.success / total) * 1000) / 10}% delivered` : 'No deliveries'}
                  {h.failed ? <span className="text-error">· {h.failed} failed</span> : null}
                </span>
              </Tooltip>
            ) : (
              <Skeleton className="h-4 w-28" />
            )}
          </Meta>
          <Meta label="ID">{w ? <IdPill value={w.id} /> : <Skeleton className="h-6 w-40" />}</Meta>
        </div>
        <div className="md:grid md:grid-cols-4 gap-4">
          <Meta label="Signing secret" className="md:col-span-2">
            {w ? <SigningSecret webhookId={w.id} secret={w.signing_secret} /> : <Skeleton className="h-8 w-72" />}
          </Meta>
          <Meta label="Events" className="md:col-span-2">
            {w ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {w.events.slice(0, 6).map((e) => (
                  <Badge key={e} capitalize={false} className="font-mono text-[12px]">
                    {e}
                  </Badge>
                ))}
                {w.events.length > 6 ? (
                  <Tooltip content={<span className="font-mono">{w.events.slice(6).join(', ')}</span>}>
                    <span>
                      <Badge capitalize={false}>+{w.events.length - 6} more</Badge>
                    </span>
                  </Tooltip>
                ) : null}
                <Button size="1" variant="ghost" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
            ) : (
              <Skeleton className="h-6 w-60" />
            )}
          </Meta>
        </div>
        {w?.status === 'disabled' && (health.data?.disabled_reason || w.disabled_reason) ? (
          <div className="mt-8">
            <Banner tone="error" title="Webhook disabled:">
              {health.data?.disabled_reason ?? w.disabled_reason}. Enable it to resume deliveries; events from the last 24 hours can be replayed.
            </Banner>
          </div>
        ) : health.data?.failing_since ? (
          <div className="mt-8">
            <Banner tone="error" title="Endpoint failing:">
              deliveries have been failing since {fullDateTime(health.data.failing_since)}. It is disabled automatically after 5 days of failures.
            </Banner>
          </div>
        ) : null}
      </div>
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg text-emphasis font-bold">Deliveries</h2>
          <Tabs
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setCursors([]);
            }}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'success', label: 'Succeeded' },
              { value: 'failed', label: 'Failed' },
              { value: 'pending', label: 'Pending' },
            ]}
          />
        </div>
        {deliveries.error ? (
          <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />
        ) : !deliveries.isPending && rows.length === 0 && !after ? (
          <EmptyState compact title="No deliveries yet" description={filter === 'all' ? 'Events sent to this endpoint will show up here.' : 'No deliveries with this status.'} />
        ) : (
          <>
            <Table>
              <THead>
                <Th>Event</Th>
                <Th className="w-[140px]">Status</Th>
                <Th className="w-[120px]">Attempts</Th>
                <Th className="w-[160px] text-right">Created</Th>
              </THead>
              <TBody className={deliveries.isPlaceholderData ? 'opacity-60' : undefined}>
                {deliveries.isPending ? (
                  <SkeletonRows cols={4} rows={5} />
                ) : (
                  rows.map((d) => (
                    <tr
                      key={d.id}
                      tabIndex={0}
                      className="cursor-pointer hover:bg-gray-a2 focus-visible:bg-gray-a2 outline-none"
                      onClick={() => setOpen(d)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpen(d);
                        }
                      }}
                      aria-label={`${d.type} delivery, ${DELIVERY_LABEL[d.status] ?? d.status}`}
                    >
                      <Td className="py-3">
                        <span className="font-mono text-[13px] text-emphasis">{d.type}</span>
                      </Td>
                      <Td className="py-3">
                        <Badge tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{DELIVERY_LABEL[d.status] ?? d.status}</Badge>
                      </Td>
                      <Td className="py-3 text-default">{d.attempts ?? '—'}</Td>
                      <Td className="py-3 text-right">
                        <Tooltip content={fullDateTime(d.created_at)}>
                          <time className="text-sm" dateTime={d.created_at}>
                            {timeAgoShort(d.created_at)}
                          </time>
                        </Tooltip>
                      </Td>
                    </tr>
                  ))
                )}
              </TBody>
            </Table>
            <CursorPager
              hasNewer={cursors.length > 0}
              hasOlder={!!deliveries.data?.has_more}
              onNewer={() => setCursors((c) => c.slice(0, -1))}
              onOlder={() => rows.length && setCursors((c) => [...c, rows.at(-1)!.id])}
            />
          </>
        )}
      </PageBody>
      <DeliveryPanel webhookId={id} delivery={open} onClose={() => setOpen(null)} />
      {w ? <EditDialog open={editing} onOpenChange={setEditing} id={w.id} endpoint={w.endpoint} events={w.events} /> : null}
      <DeleteWebhookDialog webhook={deleting && w ? w : null} onOpenChange={(o) => !o && setDeleting(false)} redirect />
    </>
  );
}
