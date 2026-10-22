import type { ReactNode } from 'react';
import { Ban, Calendar, CircleCheck, CircleX, Clock, MailOpen, MailX, Send, SquareMousePointer, TriangleAlert } from 'lucide-react';
import type { EmailEvent } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { emailStatus } from '@/lib/status';
import { fullDateTime, shortDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const ICON: Record<string, { icon: typeof Send; cls: string }> = {
  sent: { icon: Send, cls: 'text-gray-11' },
  queued: { icon: Clock, cls: 'text-gray-11' },
  scheduled: { icon: Calendar, cls: 'text-gray-11' },
  delivered: { icon: CircleCheck, cls: 'text-success' },
  opened: { icon: MailOpen, cls: 'text-info' },
  clicked: { icon: SquareMousePointer, cls: 'text-violet-11' },
  bounced: { icon: MailX, cls: 'text-error' },
  failed: { icon: CircleX, cls: 'text-error' },
  complained: { icon: TriangleAlert, cls: 'text-warning' },
  delivery_delayed: { icon: Clock, cls: 'text-warning' },
  canceled: { icon: Ban, cls: 'text-gray-11' },
  suppressed: { icon: Ban, cls: 'text-gray-11' },
};

/** Dot-grid backdrop drawn with CSS (no image asset). */
export const DOT_PATTERN: React.CSSProperties = {
  backgroundImage: 'radial-gradient(circle at 1px 1px, var(--gray-a4) 1px, transparent 0)',
  backgroundSize: '8px 8px',
};

function detail(e: EmailEvent): ReactNode {
  const d = e.data ?? {};
  const msg = (d.message as string) ?? (d.reason as string) ?? (d.link ? `Link: ${d.link as string}` : null);
  return (
    <span className="flex max-w-xs flex-col gap-0.5">
      <span>{fullDateTime(e.created_at)}</span>
      {e.recipient ? <span className="text-default break-all">{e.recipient}</span> : null}
      {msg ? <span className="text-default break-words">{msg}</span> : null}
    </span>
  );
}

/** Horizontal event timeline (Sent → Delivered → Opened …) on a dot pattern. */
export function EventTimeline({ events, loading }: { events: EmailEvent[] | undefined; loading?: boolean }) {
  return (
    <div className="w-full overflow-x-auto p-8" style={DOT_PATTERN}>
      {loading || !events ? (
        <div className="flex gap-12">
          {[0, 1].map((i) => (
            <div key={i} className="flex min-w-[6rem] flex-col items-center gap-2">
              <Skeleton className="size-10 rounded-xl" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-default">No events yet.</p>
      ) : (
        <ol className="relative flex w-fit gap-12" aria-label="Email events">
          {events.length > 1 ? (
            <span aria-hidden="true" className="pointer-events-none absolute left-8 top-1/2 mt-0.5 h-0.5 -translate-y-8 select-none bg-gray-3 dark:bg-gray-2 w-[calc(100%-4rem)]" />
          ) : null}
          {events.map((e, i) => {
            const meta = ICON[e.type] ?? ICON.sent!;
            const st = emailStatus(e.type);
            const Icon = meta.icon;
            const hasData = !!e.data && Object.keys(e.data).length > 0;
            return (
              <li key={`${e.type}-${i}`} className="relative flex min-w-[6rem] flex-col items-center justify-center gap-2">
                <Tooltip content={detail(e)}>
                  <button type="button" className={cn('group flex flex-col items-center justify-center gap-2 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-focus', hasData ? 'cursor-pointer' : 'cursor-default')}>
                    <span
                      className={cn('relative z-20 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-default transition-colors', hasData && 'group-hover:border-interactive group-focus-visible:border-interactive')}
                      style={{ background: 'border-box linear-gradient(to bottom, #ffffff20, #ffffff00), var(--background)' }}
                    >
                      <Icon size={20} className={meta.cls} />
                    </span>
                    <span className="bg-background">
                      <Badge tone={st.badge}>{st.label.toLowerCase()}</Badge>
                    </span>
                  </button>
                </Tooltip>
                <time dateTime={e.created_at} className="text-xs text-default font-normal text-center whitespace-nowrap">
                  {shortDateTime(e.created_at)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
