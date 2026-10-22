import { useParams } from 'react-router-dom';
import { Download, Ellipsis, Inbox, Paperclip } from 'lucide-react';
import { format } from 'date-fns';
import { emails } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { ReceivedEmail } from '@/api/types';
import { DetailHeader, Meta, useTitle } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { AppIcon } from '@/components/ui/AppIcon';
import { LinkButton, iconButtonClass } from '@/components/ui/Button';
import { IdPill, copyText } from '@/components/ui/CopyButton';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/toast';
import { formatBytes, fullDateTime } from '@/lib/format';
import { MessageTabs } from './MessageTabs';

function raw(e: ReceivedEmail) {
  return JSON.stringify({ object: 'email', ...e }, null, 2);
}

function Text({ v }: { v: string }) {
  return (
    <span translate="no" className="text-sm text-emphasis font-normal truncate" title={v}>
      {v}
    </span>
  );
}

export function ReceivedDetailPage() {
  const { id = '' } = useParams();
  const q = useTeamQuery(['received', 'detail', id], (t) => emails.received(t, id));
  const e = q.data;
  useTitle(e ? `${e.subject || e.from} · Receiving` : 'Receiving');

  if (q.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        {q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 422) ? (
          <EmptyState compact title="Email not found" description="This received email doesn't exist or belongs to another team." actions={<LinkButton to="/emails/receiving">Back to received emails</LinkButton>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col">
        <div className="flex flex-col items-center gap-6 md:flex-row">
          <div className="min-w-0 flex-1 w-full">
            {e ? (
              <DetailHeader
                icon={
                  <AppIcon size={80} tone="blue" glyphSize={36}>
                    <Inbox strokeWidth={1.75} />
                  </AppIcon>
                }
                eyebrow="Received email"
                title={e.subject || '(no subject)'}
              />
            ) : (
              <div className="flex items-center gap-6">
                <Skeleton className="size-20 rounded-[25px]" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-7 w-72" />
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <ApiDrawerButton examples={API.receiving!} />
            <Menu
              align="end"
              className="w-52"
              trigger={
                <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                  <span className="inline-flex items-center justify-center opacity-100">
                    <Ellipsis size={12} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <MenuItem onClick={async () => (await copyText(id)) && toast('Email ID copied')}>Copy email ID</MenuItem>
              {e?.message_id ? <MenuItem onClick={async () => (await copyText(e.message_id!)) && toast('Message-ID copied')}>Copy Message-ID</MenuItem> : null}
            </Menu>
          </div>
        </div>
        <div className="md:grid md:grid-cols-4 gap-4">
          <Meta label="From">{e ? <Text v={e.from} /> : <Skeleton className="h-4 w-40" />}</Meta>
          <Meta label="To">{e ? <Text v={e.to.join(', ')} /> : <Skeleton className="h-4 w-40" />}</Meta>
          <Meta label="Received">{e ? <span title={fullDateTime(e.created_at)}>{format(new Date(e.created_at), "MMM d, yyyy 'at' h:mm a")}</span> : <Skeleton className="h-4 w-32" />}</Meta>
          <Meta label="ID">{e ? <IdPill value={e.id} /> : <Skeleton className="h-6 w-56" />}</Meta>
          {e?.cc?.length ? <Meta label="Cc"><Text v={e.cc.join(', ')} /></Meta> : null}
          {e?.reply_to?.length ? <Meta label="Reply-To"><Text v={e.reply_to.join(', ')} /></Meta> : null}
          {e?.message_id ? <Meta label="Message-ID"><span className="font-mono text-[13px] truncate" title={e.message_id}>{e.message_id}</span></Meta> : null}
        </div>
        {e?.attachments?.length ? (
          <div className="mt-8 flex flex-col gap-2">
            <span className="text-xs text-default w-fit uppercase">Attachments</span>
            <ul className="flex flex-wrap gap-2">
              {e.attachments.map((a) => (
                <li key={a.id} className="flex max-w-full items-center gap-2 rounded-xl border border-default bg-subtle py-1.5 pl-3 pr-1.5 text-sm text-emphasis">
                  <Paperclip size={14} className="shrink-0 text-default" />
                  <span className="truncate" title={a.filename}>
                    {a.filename}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{formatBytes(a.size)}</span>
                  {a.download_url ? (
                    <a href={a.download_url} target="_blank" rel="noopener noreferrer" aria-label={`Download ${a.filename}`} className={iconButtonClass('ghost', '1')}>
                      <Download size={14} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl">
        {e ? <MessageTabs html={e.html} text={e.text} raw={raw(e)} title={e.subject} /> : <Skeleton className="h-[680px] w-full rounded-3xl" />}
      </div>
    </>
  );
}
