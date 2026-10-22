import { useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { domains as domainsApi } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { Domain } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/toast';
import { domainStatus } from '@/lib/status';
import { useSession } from '@/state/session';
import { DOMAIN_RE, DomainIcon, normalizeDomain } from '../domains/shared';

/**
 * Onboarding "Add a domain" step: an inline add form when the team has no domain yet,
 * otherwise the newest unverified domain with its DNS / verify actions, or the verified one.
 */
export function DomainStep({ list, loading }: { list: Domain[]; loading: boolean }) {
  const { canManage } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useTeamMutation((t, n: string) => domainsApi.create(t, { name: n, capabilities: { sending: 'enabled', receiving: 'disabled' } }), [['domains']], { silent: true });
  const verify = useTeamMutation((t, id: string) => domainsApi.verify(t, id), [['domains']], {
    onSuccess: () => toast('Checking your DNS records. This can take a few minutes.'),
  });

  if (loading) return <Skeleton className="h-10 w-full max-w-xl rounded-xl" />;

  const domain = list.find((d) => d.status === 'verified') ?? list[0];
  if (domain) {
    const st = domainStatus(domain.status);
    const verified = domain.status === 'verified';
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-default p-3">
          <DomainIcon tone={st.tone} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-sm text-emphasis font-medium" title={domain.name} translate="no">
                {domain.name}
              </span>
              <Badge tone={st.badge} className="shrink-0">
                {st.label.toLowerCase()}
              </Badge>
            </div>
            <span className="text-xs text-default">{verified ? 'Ready to send' : 'Add the DNS records at your DNS provider, then verify.'}</span>
          </div>
        </div>
        {!verified ? (
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton to={`/domains/${domain.id}?from=onboarding`} variant="primary">
              View DNS records
            </LinkButton>
            <Button
              icon={<RefreshCw size={16} className={verify.isPending || domain.status === 'pending' ? 'animate-spin' : undefined} />}
              disabled={verify.isPending || !canManage}
              onClick={() => verify.mutate(domain.id)}
            >
              {domain.status === 'pending' ? 'Verifying…' : 'Verify DNS records'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = normalizeDomain(name);
    if (!DOMAIN_RE.test(n)) {
      setError('Enter a domain you own, like updates.example.com');
      return;
    }
    setError(null);
    try {
      const d = await create.mutateAsync(n);
      toast.success(`${d.name} added. Add its DNS records to verify it.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the domain');
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex max-w-xl flex-col gap-2">
      <label htmlFor="onboarding-domain" className="text-sm text-default">
        Domain
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="onboarding-domain"
          wrapperClassName="min-w-0 flex-1"
          placeholder="updates.example.com"
          autoComplete="off"
          spellCheck={false}
          value={name}
          invalid={!!error}
          disabled={!canManage}
          aria-describedby={error ? 'onboarding-domain-error' : 'onboarding-domain-hint'}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim() || !canManage}>
          Add domain
        </Button>
      </div>
      {error ? (
        <p id="onboarding-domain-error" role="alert" className="text-xs text-error">
          {error}
        </p>
      ) : (
        <p id="onboarding-domain-hint" className="text-xs text-default">
          {canManage ? 'A subdomain (like updates.example.com) keeps your sending reputation separate from your root domain.' : 'Only team admins can add domains.'}
        </p>
      )}
    </form>
  );
}
