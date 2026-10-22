import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ellipsis, GalleryVerticalEnd, Mail } from 'lucide-react';
import { format } from 'date-fns';
import { domains, emails } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { Email } from '@/api/types';
import { DetailHeader, Meta, DashedLink, useTitle } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { AppIcon } from '@/components/ui/AppIcon';
import { Button, LinkButton, iconButtonClass } from '@/components/ui/Button';
import { IdPill, copyText } from '@/components/ui/CopyButton';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/toast';
import { emailStatus } from '@/lib/status';
import { fullDateTime } from '@/lib/format';
import { EventTimeline } from './EventTimeline';
import { MessageTabs } from './MessageTabs';
import { addressOf, computeInsights } from './insights';

function Truncated({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span translate="no" className="relative flex items-center gap-2 w-full min-w-0">
      <span className="text-sm text-emphasis font-normal truncate" title={title}>
        {children}
      </span>
    </span>
  );
}

/** Raw tab: the Resend email object, like the API returns it. */
function rawJson(e: Email): string {
  const { log_id: _l, api_key_id: _k, ...rest } = e as Email & { api_key_id?: string | null };
  return JSON.stringify({ object: 'email', ...rest }, null, 2);
}

function toLocalInput(d: Date) {
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

export function EmailDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useTeamQuery(['emails', 'detail', id], (t) => emails.get(t, id));
  const ev = useTeamQuery(['emails', id, 'events'], (t) => emails.events(t, id));
  const doms = useTeamQuery(['domains'], (t) => domains.list(t));
  const e = q.data;
  const sendHost = e ? addressOf(e.from).split('@')[1] ?? '' : '';
  const domainId = doms.data?.data.find((d) => d.name === sendHost || sendHost.endsWith('.' + d.name))?.id;
  const dom = useTeamQuery(['domains', domainId], (t) => domains.get(t, domainId!), { enabled: !!domainId });
  useTitle(e ? `${e.to.join(', ')} · Emails` : 'Emails');

  const [rescheduling, setRescheduling] = useState(false);
  const [when, setWhen] = useState('');
  const [canceling, setCanceling] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const cancel = useTeamMutation((t) => emails.cancel(t, id), [['emails']], {
    onSuccess: () => {
      toast.success('Scheduled email canceled');
      setCanceling(false);
    },
  });
  const reschedule = useTeamMutation((t, at: string) => emails.reschedule(t, id, at), [['emails']], {
    onSuccess: () => {
      toast.success('Email rescheduled');
      setRescheduling(false);
    },
  });
  const share = useTeamMutation((t) => emails.share(t, id), [], { onSuccess: (r) => setShareUrl(r.url) });

  const insights = useMemo(() => (e && (!domainId || dom.data || dom.error || doms.error) ? computeInsights(e, dom.data ?? null) : e && doms.isPending ? null : e ? computeInsights(e, null) : null), [e, dom.data, dom.error, domainId, doms.error, doms.isPending]);

  if (q.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        {q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 422) ? (
          <EmptyState compact title="Email not found" description="This email doesn't exist or belongs to another team." actions={<LinkButton to="/emails">Back to emails</LinkButton>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }

  const st = e ? emailStatus(e.last_event) : null;
  const scheduled = e?.last_event === 'scheduled';
  const to = e?.to.join(', ') ?? '';

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col">
        <div className="flex flex-col items-center gap-6 md:flex-row">
          <div className="min-w-0 flex-1 w-full">
            {e && st ? (
              <DetailHeader
                icon={
                  <AppIcon size={80} tone={st.tone} glyphSize={36}>
                    <Mail strokeWidth={1.75} />
                  </AppIcon>
                }
                eyebrow="Email"
                title={to}
              />
            ) : (
              <div className="flex items-center gap-6">
                <Skeleton className="size-20 rounded-[25px]" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-7 w-72" />
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <ApiDrawerButton examples={API.email!} />
            <Menu
              align="end"
              className="w-56"
              trigger={
                <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                  <span className="inline-flex items-center justify-center opacity-100">
                    <Ellipsis size={12} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <MenuItem onClick={async () => (await copyText(id)) && toast('Email ID copied')}>Copy email ID</MenuItem>
              <MenuItem onClick={() => share.mutate(undefined)} disabled={share.isPending}>
                Share email
              </MenuItem>
              {e?.log_id ? <MenuItem onClick={() => nav(`/logs/${e.log_id}`)}>View log</MenuItem> : null}
              <MenuItem onClick={() => e && nav(`/emails?q=${encodeURIComponent(e.to[0] ?? '')}`)}>More from this recipient</MenuItem>
              {scheduled ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      setWhen(toLocalInput(e?.scheduled_at ? new Date(e.scheduled_at) : new Date(Date.now() + 3600_000)));
                      setRescheduling(true);
                    }}
                  >
                    Reschedule
                  </MenuItem>
                  <MenuItem danger onClick={() => setCanceling(true)}>
                    Cancel scheduled email
                  </MenuItem>
                </>
              ) : null}
            </Menu>
          </div>
        </div>

        <div className="md:grid md:grid-cols-4 gap-4">
          <Meta label="From">{e ? <Truncated title={e.from}>{e.from}</Truncated> : <Skeleton className="h-4 w-40" />}</Meta>
          <Meta label="Subject">{e ? <Truncated title={e.subject}>{e.subject || '(no subject)'}</Truncated> : <Skeleton className="h-4 w-40" />}</Meta>
          <Meta label="To">{e ? <Truncated title={to}>{to}</Truncated> : <Skeleton className="h-4 w-40" />}</Meta>
          <Meta label="ID">{e ? <IdPill value={e.id} /> : <Skeleton className="h-6 w-56" />}</Meta>
          {e?.cc?.length ? <Meta label="Cc"><Truncated title={e.cc.join(', ')}>{e.cc.join(', ')}</Truncated></Meta> : null}
          {e?.bcc?.length ? <Meta label="Bcc"><Truncated title={e.bcc.join(', ')}>{e.bcc.join(', ')}</Truncated></Meta> : null}
          {e?.reply_to?.length ? <Meta label="Reply-To"><Truncated title={e.reply_to.join(', ')}>{e.reply_to.join(', ')}</Truncated></Meta> : null}
          {scheduled && e?.scheduled_at ? <Meta label="Scheduled for"><span title={fullDateTime(e.scheduled_at)}>{format(new Date(e.scheduled_at), "MMM d, yyyy 'at' h:mm a")}</span></Meta> : null}
          {e?.tags?.length ? (
            <Meta label="Tags">
              <span className="flex flex-wrap gap-1">
                {e.tags.map((t) => (
                  <Badge key={t.name} tone="neutral" capitalize={false} className="font-mono">
                    {t.name}: {t.value}
                  </Badge>
                ))}
              </span>
            </Meta>
          ) : null}
          {e?.log_id ? (
            <Meta label="Log">
              <div className="flex min-w-0 font-mono">
                <DashedLink to={`/logs/${e.log_id}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <GalleryVerticalEnd size={14} className="shrink-0" />
                    <span translate="no">POST /emails</span>
                  </span>
                </DashedLink>
              </div>
            </Meta>
          ) : null}
        </div>

        <div className="mt-8 flex flex-col gap-2">
          <span className="text-xs text-default w-fit uppercase">Email Events</span>
          <EventTimeline events={ev.data?.data} loading={ev.isPending && !ev.error} />
          {ev.error ? <p className="text-xs text-error">Couldn't load events: {(ev.error as Error).message}</p> : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl">
        {e ? (
          <MessageTabs html={e.html} text={e.text} raw={rawJson(e)} title={e.subject} insights={insights} generatedAt={new Date().toISOString()} />
        ) : (
          <Skeleton className="h-[680px] w-full rounded-3xl" />
        )}
      </div>

      <Dialog open={canceling} onOpenChange={setCanceling} title="Cancel scheduled email" description="The email will not be sent. This can't be undone." onSubmit={() => cancel.mutate(undefined)}>
        <DialogActions>
          <Button variant="danger" kbd={['⌘', '↩︎']} loading={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
            Cancel email
          </Button>
          <Button onClick={() => setCanceling(false)} kbd={['Esc']}>
            Keep
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={rescheduling}
        onOpenChange={setRescheduling}
        title="Reschedule email"
        onSubmit={() => when && reschedule.mutate(new Date(when).toISOString())}
      >
        <form
          onSubmit={(ev2) => {
            ev2.preventDefault();
            if (when) reschedule.mutate(new Date(when).toISOString());
          }}
        >
          <Field label="Send at" htmlFor="resched" hint="Emails can be scheduled up to 30 days ahead, in your local time zone.">
            <Input
              id="resched"
              type="datetime-local"
              value={when}
              min={toLocalInput(new Date())}
              max={toLocalInput(new Date(Date.now() + 30 * 86400_000))}
              onChange={(x) => setWhen(x.target.value)}
            />
          </Field>
          <DialogActions>
            <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} loading={reschedule.isPending} disabled={!when}>
              Reschedule
            </Button>
            <Button onClick={() => setRescheduling(false)} kbd={['Esc']}>
              Cancel
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={!!shareUrl} onOpenChange={(o) => !o && setShareUrl(null)} title="Share email" description="Anyone with this link can view the email for 48 hours.">
        <div className="mt-6 flex gap-2">
          <Input readOnly value={shareUrl ?? ''} onFocus={(x) => x.currentTarget.select()} aria-label="Share link" />
          <Button variant="primary" onClick={async () => shareUrl && (await copyText(shareUrl)) && toast('Link copied')}>
            Copy
          </Button>
        </div>
      </Dialog>
    </>
  );
}
