import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ellipsis } from 'lucide-react';
import { format } from 'date-fns';
import { emails, suppressions as api } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import { DetailHeader, Meta, DashedLink, useTitle } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { iconButtonClass } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { LinkButton } from '@/components/ui/Button';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { useTeamId } from '@/state/session';
import { origin } from './SuppressionsPage';
import { ConfirmRemoveDialog } from './SuppressionDialogs';

function BigAvatar({ text }: { text: string }) {
  return (
    <span
      aria-hidden="true"
      className="relative shrink-0 flex min-w-20 min-h-20 w-20 h-20 text-3xl rounded-full border border-transparent font-medium uppercase text-default"
      style={{ background: 'linear-gradient(42deg, var(--gray-1), var(--gray-2)) padding-box, linear-gradient(42deg, var(--gray-a2) 45%, var(--gray-a6)) border-box' }}
    >
      <span className="m-auto">{(text[0] ?? '?').toUpperCase()}</span>
    </span>
  );
}

export function SuppressionDetailPage() {
  const { id = '' } = useParams();
  const teamId = useTeamId();
  const nav = useNavigate();
  const [removing, setRemoving] = useState(false);
  const s = useTeamQuery(['suppressions', 'detail', id], (t) => api.get(t, id));
  useTitle(s.data ? `${s.data.email} · Suppressions` : 'Suppressions');
  const ev = useTeamQuery(['emails', s.data?.email_id, 'events'], (t) => emails.events(t, s.data!.email_id!), { enabled: !!s.data?.email_id });

  if (s.error) {
    if (s.error instanceof ApiError && s.error.status === 404)
      return (
        <div className="mx-auto w-full max-w-6xl px-6 pt-8">
          <EmptyState compact title="Suppression not found" description="This address is not on your suppression list (it may have been removed)." actions={<LinkButton to="/emails/suppressions">Back to suppressions</LinkButton>} />
        </div>
      );
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <ErrorState error={s.error} onRetry={() => void s.refetch()} />
      </div>
    );
  }
  const d = s.data;
  const o = d ? origin(d.reason) : null;
  const event = ev.data?.data.slice().reverse().find((e) => e.type === 'bounced' || e.type === 'complained' || e.type === 'failed');
  const details =
    (event?.data && ((event.data.message as string) ?? (event.data.reason as string))) ||
    (d?.reason === 'manual' ? `Added manually${d.source ? ` from the ${d.source}` : ''}.` : d?.reason === 'complaint' ? 'The recipient marked an email as spam.' : null);

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 md:pt-8 flex flex-col gap-4 md:flex-row items-center justify-between pb-0">
        {d ? (
          <DetailHeader icon={<BigAvatar text={d.email} />} eyebrow="Suppression" title={d.email} />
        ) : (
          <div className="flex items-center gap-6">
            <Skeleton className="size-20 rounded-full" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-80" />
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <ApiDrawerButton examples={API.suppressions!} />
          <Menu
            align="end"
            className="w-52"
            trigger={
              <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')} disabled={!d}>
                <span className="inline-flex items-center justify-center opacity-100">
                  <Ellipsis size={12} strokeWidth={3} />
                </span>
              </button>
            }
          >
            <MenuItem onClick={async () => d && (await copyText(d.email)) && toast('Email address copied')}>Copy email address</MenuItem>
            {d?.email_id ? <MenuItem onClick={() => nav(`/emails/${d.email_id}`)}>View email</MenuItem> : null}
            <MenuItem danger onClick={() => setRemoving(true)}>
              Remove suppression
            </MenuItem>
          </Menu>
        </div>
      </div>
      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl">
        <div className="md:grid md:grid-cols-4 gap-4">
          <Meta label="Origin">{o ? <Badge tone={o.tone} capitalize={false}>{o.label}</Badge> : <Skeleton className="h-6 w-16" />}</Meta>
          <Meta label="Recipient">
            {d ? (
              <span translate="no" className="truncate" title={d.email}>
                {d.email}
              </span>
            ) : (
              <Skeleton className="h-4 w-40" />
            )}
          </Meta>
          <Meta label="Added">{d ? <span>{format(new Date(d.created_at), "MMM d, yyyy 'at' h:mm a")}</span> : <Skeleton className="h-4 w-32" />}</Meta>
          {d?.email_id ? (
            <Meta label="Email">
              <DashedLink to={`/emails/${d.email_id}`}>
                <span className="font-mono">{d.email_id.slice(0, 8)}…</span>
              </DashedLink>
            </Meta>
          ) : null}
        </div>
        {d && details ? (
          <div className="mt-8 flex w-full flex-col gap-2">
            <span className="text-xs text-default uppercase">Details</span>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-default bg-subtle p-3 text-sm text-emphasis font-mono">{details}</pre>
          </div>
        ) : null}
      </div>
      {d ? <ConfirmRemoveDialog items={removing ? [d] : null} onClose={() => setRemoving(false)} onDone={() => nav('/emails/suppressions')} teamId={teamId} /> : null}
    </>
  );
}
