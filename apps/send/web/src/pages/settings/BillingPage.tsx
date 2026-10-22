import type { ReactNode } from 'react';
import { SUPPORT_EMAIL } from '@/lib/config';
import { teams } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { LinkButton } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/EmptyState';
import { formatNumber, longDate } from '@/lib/format';
import { useSession } from '@/state/session';
import { SettingsCard, SettingsLayout } from './SettingsLayout';

const TD = 'border-subtle border-b text-sm text-ellipsis whitespace-nowrap px-2 md:px-3 h-12 first:pl-4 last:pr-4';

function Row({ name, amount, price }: { name: ReactNode; amount: ReactNode; price: ReactNode }) {
  return (
    <tr className="text-default">
      <td className={`${TD} w-full`}>
        <span className="text-sm text-emphasis font-normal">{name}</span>
      </td>
      <td className={`${TD} text-right md:pl-20`}>{amount}</td>
      <td className={`${TD} hidden text-right sm:table-cell md:pl-20`}>{price}</td>
    </tr>
  );
}

/** Read-only "plan & quota": 5050 Send has no payments; quotas are set by mail administrators. */
export function BillingPage() {
  const { team, me } = useSession();
  const usage = useTeamQuery(['usage'], (t) => teams.usage(t));
  const members = useTeamQuery(['members'], (t) => teams.members(t));
  const admins = (members.data?.data ?? []).filter((m) => m.role === 'admin');
  const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Plan change for ${team.name}`)}&body=${encodeURIComponent(`Team: ${team.name} (${team.id})\nRequested by: ${me.email}\n`)}`;
  return (
    <SettingsLayout title="Billing">
      <SettingsCard
        title="Plan and quotas"
        bodyClassName="px-0 pt-4 pb-2"
        footer={<LinkButton href={mail}>Request a change</LinkButton>}
      >
        <div className="relative w-full overflow-x-auto">
          <table className="m-0 w-max min-w-full border-separate border-spacing-0 border-none p-0 text-left md:w-full">
            <tbody className="[&_tr:last-child_td]:border-b-0">
              <Row name="Transactional" amount={`${formatNumber(team.monthly_quota)} emails / mo`} price="Included" />
              <Row name="Daily sending limit" amount={team.daily_quota === null ? 'No daily limit' : `${formatNumber(team.daily_quota)} emails / day`} price="Included" />
              <Row name="Marketing" amount={usage.data ? (usage.data.contacts.limit === null ? 'Unlimited contacts' : `${formatNumber(usage.data.contacts.limit)} contacts`) : <Skeleton className="ml-auto h-4 w-24" />} price="Included" />
              <Row name="API rate limit" amount={`${team.rate_limit} requests / s`} price="Included" />
            </tbody>
          </table>
        </div>
      </SettingsCard>

      <SettingsCard title="Payment methods">
        <p className="text-sm text-default font-normal">There is nothing to pay for. 5050 Send is provided to your team by your 5050 administrator, so no card is needed.</p>
      </SettingsCard>

      <SettingsCard title="Billing contacts">
        <p className="mb-3 text-sm text-default">Team admins receive notices about quota changes.</p>
        {members.error ? (
          <ErrorState error={members.error} onRetry={() => void members.refetch()} />
        ) : members.isPending ? (
          <Skeleton className="h-5 w-64" />
        ) : (
          <ul className="flex flex-col gap-1">
            {admins.map((a) => (
              <li key={a.email} className="truncate text-sm text-emphasis" translate="no" title={a.email}>
                {a.email}
              </li>
            ))}
            {admins.length === 0 ? <li className="text-sm text-muted">No admins yet.</li> : null}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard title="Current period">
        {usage.data ? (
          <p className="text-sm text-default">
            Monthly usage resets on <span className="text-emphasis">{longDate(usage.data.emails.monthly.resets_at)}</span>. {formatNumber(usage.data.emails.monthly.used)} of{' '}
            {usage.data.emails.monthly.limit === null ? 'unlimited' : formatNumber(usage.data.emails.monthly.limit)} emails used so far.
          </p>
        ) : usage.error ? (
          <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
        ) : (
          <Skeleton className="h-5 w-80" />
        )}
      </SettingsCard>

      <SettingsCard title="Invoices">
        <div className="mx-auto flex max-w-md flex-col gap-2 text-center py-8 items-center justify-center">
          <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold">No invoices</h3>
          <span className="text-sm text-default font-normal">5050 Send does not bill teams, so there are no invoices.</span>
        </div>
      </SettingsCard>
    </SettingsLayout>
  );
}
