import { useState, type ReactNode } from 'react';
import { SUPPORT_EMAIL } from '@/lib/config';
import { ChevronDown } from 'lucide-react';
import { teams } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { Quota, Usage } from '@/api/types';
import { ApiDrawerButton } from '@/components/layout/ApiDrawer';
import { LinkButton } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatNumber, longDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useSession } from '@/state/session';
import { SettingsLayout, SplitSection } from './SettingsLayout';

const R = 8;
const C = 2 * Math.PI * R;

/** Small progress ring (22px) like the reference quota rows. */
function Ring({ used, limit }: { used: number; limit: number | null }) {
  const pct = limit && limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = pct >= 0.9 ? 'text-error' : pct >= 0.75 ? 'text-warning' : 'text-success';
  return (
    <svg aria-hidden="true" className="-mt-[1px] -scale-x-100 rotate-180 inline-block" height="22" width="22">
      <circle className="text-gray-3" cx="11" cy="11" fill="transparent" r={R} stroke="currentColor" strokeWidth="3" />
      <circle className={tone} cx="11" cy="11" fill="transparent" r={R} stroke="currentColor" strokeDasharray={C} strokeLinecap="round" strokeWidth="3" strokeDashoffset={C * (1 - pct)} />
    </svg>
  );
}

const TD = 'border-subtle h-10 border-b text-sm text-ellipsis whitespace-nowrap px-0 py-3.5';

function QuotaRow({ label, q, unit, detail, last, value }: { label: string; q?: Quota; unit?: string; detail?: ReactNode; last?: boolean; value?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const expandable = !!detail;
  const limitText = q ? (q.limit === null ? 'Unlimited' : `${formatNumber(q.used)} / ${formatNumber(q.limit)}`) : null;
  return (
    <>
      <tr
        className={cn(expandable && 'cursor-pointer hover:[&>td]:text-emphasis')}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <td className={cn(TD, 'w-[32px] text-center', last && !open && 'border-none')}>{q ? <Ring used={q.used} limit={q.limit} /> : <Ring used={0} limit={0} />}</td>
        <td className={cn(TD, 'w-3/5 pl-3 text-default', last && !open && 'border-none')}>{label}</td>
        <td className={cn(TD, 'text-right text-emphasis', last && !open && 'border-none')}>
          <div className="flex items-center justify-end gap-2">
            {value ?? (
              <span className={cn('tabular-nums', q?.limit === null && 'text-default')}>
                {q?.limit === null ? 'Unlimited' : limitText}
                {unit && q?.limit !== null ? <span className="sr-only"> {unit}</span> : null}
              </span>
            )}
            {expandable ? (
              <button
                type="button"
                aria-label={open ? `Hide ${label} details` : `Show ${label} details`}
                className="inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-focus outline-hidden"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
              >
                <ChevronDown size={16} className={cn('text-gray-11 transition-transform', open && 'rotate-180')} />
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {open && detail ? (
        <tr>
          <td className={cn('border-subtle border-b', last && 'border-none')} />
          <td colSpan={2} className={cn('border-subtle border-b pb-3.5 pl-3 text-xs text-default', last && 'border-none')}>
            {detail}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function QuotaTable({ plan, children }: { plan: string; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <h3 className="text-base text-emphasis font-medium">{plan}</h3>
      </div>
      <div className="relative w-full overflow-x-hidden">
        <table className="m-0 w-full border-separate border-spacing-0 border-none text-left mb-2 py-4 table-fixed">
          <tbody>{children}</tbody>
        </table>
      </div>
    </>
  );
}

function split(q: Quota & { sent?: number; received?: number }) {
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      <span>Sent {formatNumber(q.sent ?? q.used)}</span>
      <span>Received {formatNumber(q.received ?? 0)}</span>
      {q.resets_at ? <span>Resets {longDate(q.resets_at)}</span> : null}
    </span>
  );
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-10 py-8" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-4 md:flex-row">
          <div className="flex w-full flex-col gap-3 md:w-1/2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="flex w-full flex-col gap-4 md:w-1/2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function UsagePage() {
  const { team, me } = useSession();
  const usage = useTeamQuery(['usage'], (t) => teams.usage(t));
  const u: Usage | undefined = usage.data;
  const plan = 'Current quota';
  const ask = (
    <LinkButton
      href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Quota increase for ${team.name}`)}&body=${encodeURIComponent(`Team: ${team.name} (${team.id})\nRequested by: ${me.email}\n\nWhat do you need?`)}`}
      className="shrink-0"
    >
      Request increase
    </LinkButton>
  );
  return (
    <SettingsLayout
      title="Usage"
      right={
        <ApiDrawerButton
          examples={[{ title: 'Usage', method: 'GET', path: '/usage', node: `const res = await fetch('https://api.example.com/usage', {\n  headers: { Authorization: 'Bearer re_xxxxxxxxx' },\n});\nconsole.log(await res.json());` }]}
        />
      }
    >
      {usage.error ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      ) : !u ? (
        <UsageSkeleton />
      ) : (
        <div>
          <SplitSection id="transactional" title="Transactional" description="Integrate email into your app using the 5050 Send API or SMTP interface." action={ask}>
            <QuotaTable plan={plan}>
              <QuotaRow label="Monthly limit" q={u.emails.monthly} detail={split(u.emails.monthly)} />
              <QuotaRow label="Daily limit" q={u.emails.daily} detail={split(u.emails.daily)} last />
            </QuotaTable>
          </SplitSection>
          <SplitSection id="marketing" title="Marketing" description="Design and send marketing emails using Broadcasts and Audiences." action={ask}>
            <QuotaTable plan={plan}>
              <QuotaRow label="Contacts limit" q={u.contacts} />
              <QuotaRow label="Segments limit" q={u.segments} value={<span className="tabular-nums">{u.segments.limit === null ? `${formatNumber(u.segments.used)} / Unlimited` : `${formatNumber(u.segments.used)} / ${formatNumber(u.segments.limit)}`}</span>} />
              <QuotaRow label="Broadcasts limit" q={u.broadcasts} value={<span className="text-default">Unlimited</span>} last />
            </QuotaTable>
          </SplitSection>
          <SplitSection id="team" title="Team" description="Understand the quotas and limits for your team." last>
            <QuotaTable plan={plan}>
              {u.automation_runs ? <QuotaRow label="Automation runs" q={u.automation_runs} detail={u.automation_runs.resets_at ? <span>Resets {longDate(u.automation_runs.resets_at)}</span> : undefined} /> : null}
              <QuotaRow label="Domains" q={u.domains} value={<span className="tabular-nums">{u.domains.limit === null ? `${formatNumber(u.domains.used)} / Unlimited` : `${formatNumber(u.domains.used)} / ${formatNumber(u.domains.limit)}`}</span>} />
              <QuotaRow label="Rate limit" value={<span className="tabular-nums">{u.rate_limit.limit} req/s</span>} last />
            </QuotaTable>
          </SplitSection>
        </div>
      )}
    </SettingsLayout>
  );
}
