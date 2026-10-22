import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, CircleAlert, CircleCheck, Clock, Ellipsis, Info, PartyPopper, RefreshCw } from 'lucide-react';
import { auth, domains as domainsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import { useQuery } from '@tanstack/react-query';
import type { Domain, DomainRecord } from '@/api/types';
import { DetailHeader, PageBody } from '@/components/layout/Page';
import { API, ApiDrawerButton } from '@/components/layout/ApiDrawer';
import { Button, LinkButton, iconButtonClass } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { Tabs } from '@/components/ui/Tabs';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CopyButton, copyText } from '@/components/ui/CopyButton';
import { ErrorState, EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/toast';
import { domainStatus } from '@/lib/status';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DomainIcon, RegionLabel } from './shared';
import { statusHint } from './DomainsPage';

type Tab = 'records' | 'configuration';

export function DomainDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'configuration' ? 'configuration' : 'records';
  const [confirm, setConfirm] = useState(false);

  // Poll every 5 s while the DNS records are being checked.
  const [polling, setPolling] = useState(false);
  const q = useTeamQuery(['domains', id], (t) => domainsApi.get(t, id), { refetchInterval: polling ? 5000 : false });
  const d = q.data;
  const pending = d?.status === 'pending';
  useEffect(() => setPolling(pending), [pending]);
  const cf = useTeamQuery(['domains', id, 'cloudflare'], (t) => domainsApi.cloudflare(t, id), { enabled: !!q.data });
  const system = useQuery({ queryKey: ['system'], queryFn: () => auth.system(), staleTime: 300_000 });

  const verify = useTeamMutation((t, _v: void) => domainsApi.verify(t, id), [['domains']], {
    onSuccess: () => toast('Verifying DNS records. This can take a few minutes.'),
  });
  const remove = useTeamMutation((t, _v: void) => domainsApi.remove(t, id), [['domains']]);

  if (q.error) {
    return (
      <PageBody className="pt-8">
        {q.error instanceof ApiError && q.error.status === 404 ? (
          <EmptyState title="Domain not found" description="It may have been deleted, or it belongs to another team." actions={<Button onClick={() => nav('/domains')}>Back to domains</Button>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        )}
      </PageBody>
    );
  }

  const st = domainStatus(d?.status ?? 'not_started');
  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 md:pt-8 flex flex-col pb-8">
        <DetailHeader
          icon={<DomainIcon tone={d ? st.tone : 'gray'} size={80} />}
          eyebrow="Domain"
          title={d?.name ?? <Skeleton className="h-8 w-64 mt-1" />}
          actions={
            <>
              {d && d.status !== 'verified' ? (
                <Button icon={<RefreshCw size={16} className={verify.isPending || pending ? 'animate-spin' : undefined} />} loading={false} onClick={() => verify.mutate()} disabled={verify.isPending}>
                  {pending ? 'Verifying…' : 'Verify DNS records'}
                </Button>
              ) : null}
              <ApiDrawerButton examples={API.domain!} />
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
                <MenuItem disabled={!d} onClick={() => verify.mutate()}>
                  Verify DNS records
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    if (await copyText(id)) toast('Domain ID copied');
                  }}
                >
                  Copy domain ID
                </MenuItem>
                <MenuItem onClick={() => nav(`/emails?q=${encodeURIComponent('@' + (d?.name ?? ''))}`)}>View emails</MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled={!d} onClick={() => setConfirm(true)}>
                  Delete domain
                </MenuItem>
              </Menu>
            </>
          }
        />
        <div className="grid grid-cols-2 items-start gap-x-2 gap-y-8 pb-4 pt-10 md:auto-cols-fr md:grid-flow-col md:grid-cols-none">
          <MetaCell label="Created">
            {d ? (
              <Tooltip content={fullDateTime(d.created_at)}>
                <time className="cursor-auto text-current text-sm" dateTime={d.created_at}>
                  {timeAgoShort(d.created_at)}
                </time>
              </Tooltip>
            ) : (
              <Skeleton className="h-4 w-16" />
            )}
          </MetaCell>
          <MetaCell label="Status">
            {d ? (
              <Tooltip content={statusHint(d.status)}>
                <span>
                  <Badge tone={st.badge}>{st.label.toLowerCase()}</Badge>
                </span>
              </Tooltip>
            ) : (
              <Skeleton className="h-6 w-20" />
            )}
          </MetaCell>
          <MetaCell
            label="DNS"
            info={
              <Tooltip content="Domains whose DNS is hosted in the connected Cloudflare account get their records published automatically.">
                <Info size={14} className="text-default" role="img" aria-label="About DNS management" />
              </Tooltip>
            }
          >
            {cf.data ? (
              <Badge tone={cf.data.managed ? 'success' : 'neutral'} capitalize={false} className="cursor-default">
                {cf.data.managed ? 'Managed' : 'Manual'}
              </Badge>
            ) : (
              <Skeleton className="h-6 w-16" />
            )}
          </MetaCell>
          <MetaCell label="Provider">
            {cf.data?.managed ? (
              <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-emphasis hover:opacity-80">
                Cloudflare
                <ArrowUpRight size={12} aria-hidden />
              </a>
            ) : (
              <span className="text-sm text-default">{cf.data ? 'Other DNS provider' : '—'}</span>
            )}
          </MetaCell>
          <MetaCell label="Region">{d ? <RegionLabel region={d.region} /> : <Skeleton className="h-4 w-32" />}</MetaCell>
        </div>
        {d ? (
          <div className="mt-8 flex flex-col gap-2">
            <StatusBanner d={d} lastError={cf.data?.last_error ?? null} />
            {params.get('from') === 'onboarding' ? (
              <div className="flex flex-wrap items-center gap-2">
                <LinkButton to="/onboarding" variant={d.status === 'verified' ? 'primary' : 'secondary'}>
                  {d.status === 'verified' ? 'Continue onboarding' : 'Back to onboarding'}
                </LinkButton>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <PageBody>
        <Tabs
          value={tab}
          onChange={(v) => {
            const n = new URLSearchParams(params);
            if (v === 'records') n.delete('tab');
            else n.set('tab', v);
            setParams(n, { replace: true });
          }}
          listClassName="p-1 -ml-1 mb-4"
          tabs={[
            { value: 'records', label: 'Records' },
            { value: 'configuration', label: 'Configuration' },
          ]}
        />
        {!d ? (
          <Skeleton className="h-80 w-full rounded-3xl" />
        ) : tab === 'records' ? (
          <Records d={d} managed={!!cf.data?.managed} cloudflareConfigured={system.data?.cloudflareConfigured ?? false} />
        ) : (
          <Configuration d={d} />
        )}
      </PageBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete domain"
        description={
          <>
            Emails can no longer be sent from <span className="text-emphasis break-all">{d?.name}</span>. This can’t be undone.
          </>
        }
        typeToConfirm={d?.name}
        loading={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success('Domain deleted');
          nav('/domains', { replace: true });
        }}
      />
    </>
  );
}

function MetaCell({ label, info, children }: { label: string; info?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="text-xs text-default uppercase">{label}</span>
        {info}
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

const BANNER = {
  success: 'from-green-4 border-green-5 [&_.ic]:text-success',
  warning: 'from-yellow-4 border-yellow-5 [&_.ic]:text-warning',
  error: 'from-red-4 border-red-5 [&_.ic]:text-error',
  info: 'from-gray-a3 border-gray-a4 [&_.ic]:text-default',
} as const;

function StatusBanner({ d, lastError }: { d: Domain; lastError: string | null }) {
  const [tone, icon, title, body] = (() => {
    switch (d.status) {
      case 'verified':
        return ['success', <PartyPopper key="i" size={16} />, 'Domain verified:', `Your domain is ready to send${d.capabilities?.receiving === 'enabled' ? ' and receive' : ''} emails.`] as const;
      case 'pending':
        return ['warning', <Clock key="i" size={16} />, 'Verification in progress:', 'We’re checking your DNS records. This usually takes a few minutes, but can take up to 72 hours.'] as const;
      case 'failed':
      case 'partially_failed':
        return ['error', <CircleAlert key="i" size={16} />, 'Verification failed:', lastError ?? 'We couldn’t find some DNS records. Check them below and verify again.'] as const;
      case 'temporary_failure':
        return ['warning', <CircleAlert key="i" size={16} />, 'Records changed:', 'A record that was verified can’t be found right now. We’ll keep checking.'] as const;
      default:
        return ['info', <Info key="i" size={16} />, 'Add DNS records:', 'Add the records below at your DNS provider, then click Verify DNS records.'] as const;
    }
  })();
  return (
    <div role="alert" data-banner="" className={cn('bg-gradient-fade to-transparent flex items-center gap-4 border bg-clip-padding sm:gap-2 p-4 rounded-2xl', BANNER[tone])}>
      <span className="ic shrink-0 self-start translate-y-0.5">{icon}</span>
      <p className="text-sm text-default font-normal min-w-0 break-words">
        <span className="text-sm text-emphasis font-normal">{title}</span> {body}
      </p>
    </div>
  );
}

/** Bordered section card with the small accent bar on the left. */
function Card({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative rounded-3xl border border-gray-3 p-6">
      <div className="absolute left-0 top-[22px] h-8 w-1 rounded-br-md rounded-tr-md bg-gray-3" />
      <div className="mb-8 flex items-center justify-between gap-2 mt-0.5">
        <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

const GROUPS: { key: string; title: string; badge?: string; description: string; match: (r: DomainRecord) => boolean }[] = [
  { key: 'dkim', title: 'Domain Verification', badge: 'DKIM', description: 'Add a DKIM record to prove you own the domain and to sign your emails.', match: (r) => r.record === 'DKIM' },
  { key: 'spf', title: 'Enable Sending', badge: 'SPF', description: 'An MX and a TXT record on the Return-Path subdomain authorise 5050 Send to deliver for you and receive bounces.', match: (r) => r.record === 'SPF' },
  { key: 'dmarc', title: 'DMARC', badge: 'Recommended', description: 'A DMARC policy tells mailbox providers what to do with email that fails authentication.', match: (r) => r.record === 'DMARC' },
  { key: 'mx', title: 'Enable Receiving', badge: 'MX', description: 'Route incoming mail for this domain to 5050 Send. If the domain already receives email elsewhere, use a subdomain.', match: (r) => r.record === 'Receiving' || r.record === 'MX' },
  { key: 'tracking', title: 'Tracking', badge: 'CNAME', description: 'Point your tracking subdomain at 5050 Send so tracked links use your own domain.', match: (r) => r.record === 'Tracking' },
];

function recordTone(s: string) {
  return s === 'verified' ? 'success' : s === 'failed' ? 'error' : s === 'pending' || s === 'temporary_failure' ? 'warning' : 'neutral';
}

function Records({ d, managed, cloudflareConfigured }: { d: Domain; managed: boolean; cloudflareConfigured: boolean }) {
  const records = d.records ?? [];
  const connect = useTeamMutation((t, _v: void) => domainsApi.cloudflareConnect(t, d.id), [['domains']], {
    onSuccess: () => toast.success('DNS records published through Cloudflare'),
  });
  return (
    <Card title="DNS Records">
      {!managed && cloudflareConfigured && d.status !== 'verified' ? (
        <div className="mb-8 flex flex-col items-start justify-between gap-3 rounded-2xl border border-gray-3 bg-subtle p-4 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-emphasis">One-click setup with Cloudflare</p>
            <p className="text-sm text-default">If {d.name} uses DNS hosted in the connected Cloudflare account, we can publish these records for you.</p>
          </div>
          <Button variant="primary" onClick={() => connect.mutate()} loading={connect.isPending} className="shrink-0">
            Connect with Cloudflare
          </Button>
        </div>
      ) : managed ? (
        <p className="-mt-4 mb-8 flex items-center gap-2 text-sm text-default">
          <CircleCheck size={16} className="text-success shrink-0" /> These records are managed for you through Cloudflare.
        </p>
      ) : null}
      {records.length === 0 ? (
        <p className="text-sm text-default">No DNS records yet. Verify the domain to generate them.</p>
      ) : (
        <div className="flex flex-col gap-10">
          {GROUPS.map((g) => {
            const rs = records.filter(g.match);
            if (!rs.length) return null;
            return (
              <section key={g.key} aria-labelledby={`rec-${g.key}`}>
                <h2 id={`rec-${g.key}`} className="text-base text-emphasis font-bold mb-2 flex items-center gap-2">
                  {g.title}
                  {g.badge ? <Badge tone="neutral" capitalize={false}>{g.badge}</Badge> : null}
                </h2>
                <p className="mb-4 text-sm text-default">{g.description}</p>
                <RecordTable records={rs} />
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RecordTable({ records }: { records: DomainRecord[] }) {
  const hasPriority = records.some((r) => r.priority !== undefined);
  return (
    <div className="relative w-full overflow-x-auto max-md:-mx-6 max-md:w-auto max-md:px-6">
      <table className="m-0 w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-left">
        <thead className="h-8">
          <tr>
            {['Type', 'Name', 'Content', 'TTL', ...(hasPriority ? ['Priority'] : []), 'Status'].map((h, i, a) => (
              <th
                key={h}
                className={cn(
                  'h-8 border-b border-t border-interactive px-3 text-xs font-semibold text-default bg-interactive first:rounded-l-xl first:border-l last:rounded-r-xl last:border-r whitespace-nowrap',
                  h === 'Type' && 'w-[80px]',
                  h === 'Name' && 'w-[24%]',
                  h === 'TTL' && 'w-[70px]',
                  h === 'Priority' && 'w-[80px]',
                  i === a.length - 1 && 'w-[120px]',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.type}-${r.name}-${r.value}`}>
              <td className="border-subtle h-10 border-b px-3 py-3 text-sm text-emphasis font-mono">{r.type}</td>
              <td className="border-subtle h-10 border-b px-3 py-3 text-sm">
                <ValueCell value={r.name} />
              </td>
              <td className="border-subtle h-10 border-b px-3 py-3 text-sm">
                <ValueCell value={r.value} />
              </td>
              <td className="border-subtle h-10 border-b px-3 py-3 text-sm text-default">{r.ttl}</td>
              {hasPriority ? <td className="border-subtle h-10 border-b px-3 py-3 text-sm text-default">{r.priority ?? ''}</td> : null}
              <td className="border-subtle h-10 border-b px-3 py-3 text-sm">
                <Badge tone={recordTone(r.status)}>{r.status.replace(/_/g, ' ')}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueCell({ value }: { value: string }) {
  return (
    <div className="group/v flex min-w-0 items-center gap-1">
      <Tooltip content={<span className="font-mono break-all">{value}</span>} className="max-w-md">
        <span className="min-w-0 truncate font-mono text-[13px] text-emphasis" translate="no">
          {value}
        </span>
      </Tooltip>
      <CopyButton value={value} size={14} className="shrink-0 opacity-70 group-hover/v:opacity-100" />
    </div>
  );
}

function Configuration({ d }: { d: Domain }) {
  const [sub, setSub] = useState(d.tracking_subdomain ?? '');
  useEffect(() => setSub(d.tracking_subdomain ?? ''), [d.tracking_subdomain]);
  const update = useTeamMutation((t, b: Parameters<typeof domainsApi.update>[2]) => domainsApi.update(t, d.id, b), [['domains']], {
    onSuccess: () => toast.success('Domain updated'),
  });
  const subValid = !sub || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(sub.trim());
  const trackingReady = !!d.tracking_subdomain;
  return (
    <Card title="Configuration">
      <div className="flex w-full flex-col gap-8">
        <div>
          <h2 className="text-base text-emphasis font-bold mb-2 flex flex-auto">Enable tracking metrics</h2>
          <span className="text-sm text-default font-normal">
            To track clicks and email opens, configure a custom tracking subdomain to let those links match your sending domain and improve deliverability.
          </span>
          <form
            className="mt-3 flex max-w-md flex-col gap-2 sm:flex-row sm:items-start"
            onSubmit={(e) => {
              e.preventDefault();
              if (subValid) update.mutate({ tracking_subdomain: sub.trim() || null });
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Tracking subdomain"
                placeholder="links"
                value={sub}
                invalid={!subValid}
                onChange={(e) => setSub(e.target.value)}
                leftWidth={12}
                rightWidth={sub ? Math.min(220, 12 + (d.name.length + 1) * 7) : 12}
                right={sub ? <span className="pointer-events-none max-w-[200px] truncate pr-1.5 text-sm text-muted">.{d.name}</span> : undefined}
              />
              {!subValid ? <p className="mt-1 text-xs text-error">Use letters, numbers and dashes only.</p> : null}
            </div>
            <Button type="submit" loading={update.isPending} disabled={!subValid || sub.trim() === (d.tracking_subdomain ?? '')}>
              {d.tracking_subdomain ? 'Save' : 'Configure'}
            </Button>
          </form>
          <div className={cn('mt-5 flex flex-col gap-4', !trackingReady && 'opacity-50')}>
            <SwitchRow
              label="Click tracking"
              description="Rewrite links to count clicks."
              checked={!!d.click_tracking}
              disabled={!trackingReady || update.isPending}
              onChange={(v) => update.mutate({ click_tracking: v })}
            />
            <SwitchRow
              label="Open tracking"
              description="Add a 1×1 pixel to count opens. Opens can be inaccurate because of privacy features in mail apps."
              checked={!!d.open_tracking}
              disabled={!trackingReady || update.isPending}
              onChange={(v) => update.mutate({ open_tracking: v })}
            />
          </div>
        </div>
        <div>
          <h2 className="text-base text-emphasis font-bold mb-2 flex flex-auto gap-3">TLS (Transport Layer Security)</h2>
          <span className="text-sm text-default font-normal">
            "Opportunistic TLS" means that it always attempts to make a secure connection to the receiving mail server. If it can't establish a secure connection, it sends the message unencrypted. "Enforced
            TLS" on the other hand, requires that the email communication must use TLS no matter what.
          </span>
          <div className="mt-3 w-36">
            <Select
              ariaLabel="TLS"
              value={d.tls ?? 'opportunistic'}
              onChange={(v) => update.mutate({ tls: v })}
              options={[
                { value: 'opportunistic', label: 'Opportunistic' },
                { value: 'enforced', label: 'Enforced' },
              ]}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function SwitchRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 max-w-xl">
      <div className="min-w-0">
        <p className="text-sm text-emphasis">{label}</p>
        <p className="text-xs text-default">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </div>
  );
}
