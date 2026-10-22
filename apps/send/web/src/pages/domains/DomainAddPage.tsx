import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Collapsible } from '@base-ui/react/collapsible';
import { ArrowUpRight, ChevronDown, Lightbulb, Plus } from 'lucide-react';
import { domains as domainsApi } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import { H1_CLASS, useTitle } from '@/components/layout/Page';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { docsUrl } from '@/components/layout/docs';
import { ApiError } from '@/api/http';
import { cn } from '@/lib/cn';
import { DOMAIN_RE, DomainIcon, REGION_OPTIONS, RegionLabel, normalizeDomain } from './shared';

/** Timeline step card (same frame as onboarding steps). */
export function Step({ active, title, description, children, className }: { active: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('relative pl-6 transition duration-200 ease-in-out', !active && 'pointer-events-none select-none', className)}>
      <div className="bg-background absolute -left-[10px] top-7 z-10 h-[21px] w-[21px] flex rounded-full">
        <div className={cn('m-auto h-3 w-3 rounded-full border-2 transition duration-200 ease-in-out', active ? 'border-black dark:border-white' : 'border-gray-4')} />
      </div>
      <div className={cn('rounded-4xl p-0.5 transition duration-200 ease-in-out', !active && 'opacity-50')}>
        <div className="bg-background rounded-[30px]">
          <div className="rounded-[30px] p-6">
            <div className="flex items-center gap-2">
              <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold mb-1">{title}</h3>
            </div>
            {description ? <p className="text-sm text-default font-normal text-balance">{description}</p> : null}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DomainAddPage() {
  useTitle('Add domain');
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [returnPath, setReturnPath] = useState('');
  const [tracking, setTracking] = useState('');
  const [click, setClick] = useState(true);
  const [open, setOpen] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [tls, setTls] = useState<'opportunistic' | 'enforced'>('opportunistic');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useTeamMutation(
    async (t, _v: void) => {
      const d = await domainsApi.create(t, {
        name: normalizeDomain(name),
        region,
        custom_return_path: returnPath.trim() || undefined,
        capabilities: { sending: 'enabled', receiving: receiving ? 'enabled' : 'disabled' },
        tls,
        open_tracking: tracking.trim() ? open : false,
        click_tracking: tracking.trim() ? click : false,
      });
      // Resend's create endpoint has no tracking subdomain: set it with a follow-up PATCH.
      if (tracking.trim()) await domainsApi.update(t, d.id, { tracking_subdomain: tracking.trim() }).catch(() => null);
      return d;
    },
    [['domains']],
    { silent: true },
  );

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = normalizeDomain(name);
    if (!DOMAIN_RE.test(n)) {
      setError('Enter a domain you own, like updates.example.com');
      return;
    }
    if (returnPath && !/^[a-z0-9-]{1,63}$/i.test(returnPath.trim())) {
      setError('The Return-Path must be a single subdomain label, like "bounce"');
      return;
    }
    setError(null);
    try {
      const d = await create.mutateAsync();
      toast.success(`${d.name} added. Add the DNS records to verify it.`);
      nav(`/domains/${d.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the domain');
    }
  };

  const shown = normalizeDomain(name);
  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col items-center gap-6 md:flex-row">
        <DomainIcon tone="gray" size={80} />
        <div className="w-full overflow-hidden text-center md:text-left">
          <h1 className={H1_CLASS}>Add domain</h1>
          <span className="text-sm text-default font-semibold">Use a domain you own to send and receive emails.</span>
        </div>
      </div>
      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl">
        <div className="relative max-w-[1100px] py-12 sm:ml-10">
          <div className="steps-gradient absolute top-0 h-full w-px" />
          <div className="flex flex-col gap-5">
            <Step active title="Domain" description="Domain name and region for your sending and receiving." className="max-w-[30rem]">
              <div className="mt-6">
                <div className="relative">
                  <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
                    <div className="flex flex-col gap-2">
                      <label htmlFor="domain" className="text-sm text-default flex items-center">
                        Name
                      </label>
                      <Input
                        id="domain"
                        autoFocus
                        required
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="updates.example.com"
                        value={name}
                        invalid={!!error}
                        aria-describedby={error ? 'domain-error' : undefined}
                        onChange={(e) => {
                          setName(e.target.value);
                          if (error) setError(null);
                        }}
                        leftWidth={12}
                        rightWidth={28}
                        right={
                          <Tooltip content="We recommend a subdomain (like updates.example.com) to keep your sending reputation separate from your root domain.">
                            <IconButton type="button" label="Domain name recommendations" variant="ghost" size="1" className="-mr-2">
                              <Lightbulb size={16} aria-hidden />
                            </IconButton>
                          </Tooltip>
                        }
                      />
                      {error ? (
                        <p id="domain-error" role="alert" className="text-xs text-error">
                          {error}
                        </p>
                      ) : null}
                    </div>
                    <Collapsible.Root open={advanced} onOpenChange={setAdvanced} className="flex flex-col gap-4">
                      <Collapsible.Trigger className="flex items-center gap-1 cursor-pointer group self-start rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-focus">
                        <span className="text-sm text-default font-normal flex items-center">
                          <ChevronDown size={16} aria-hidden className="inline-block transition-[opacity,transform,rotate] duration-300 -rotate-90 group-data-[panel-open]:rotate-0 mr-2" />
                          Advanced options
                        </span>
                      </Collapsible.Trigger>
                      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-in-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 p-0.5">
                        <div className="flex flex-col gap-2 mt-4">
                          <label htmlFor="region" className="text-sm text-default flex items-center">
                            Region
                          </label>
                          <Select
                            id="region"
                            value={region}
                            onChange={setRegion}
                            options={REGION_OPTIONS.map((r) => ({ value: r.value, text: `${r.label} (${r.value})`, label: <RegionLabel region={r.value} /> }))}
                            className="max-w-[30rem]"
                          />
                        </div>
                        <div className="flex flex-col gap-2 mt-6">
                          <label htmlFor="customReturnPath" className="text-sm text-default flex items-center">
                            Custom Return-Path
                          </label>
                          <Input id="customReturnPath" autoComplete="off" placeholder="Add a Custom Return-Path value..." value={returnPath} onChange={(e) => setReturnPath(e.target.value)} leftWidth={12} />
                        </div>
                        <div className="flex flex-col gap-2 mt-6">
                          <label htmlFor="trackingSubdomain" className="text-sm text-default flex items-center">
                            Tracking Subdomain
                          </label>
                          <Input id="trackingSubdomain" autoComplete="off" placeholder="links" value={tracking} onChange={(e) => setTracking(e.target.value)} leftWidth={12} />
                        </div>
                        <div className={cn('flex flex-col gap-3 mt-4', !tracking.trim() && 'opacity-50 pointer-events-none')} aria-disabled={!tracking.trim()}>
                          <span className="text-sm text-default font-medium">Tracking options</span>
                          <label className="flex items-center gap-2">
                            <Checkbox checked={click} onChange={setClick} disabled={!tracking.trim()} label="Enable click tracking" />
                            <span className="text-sm text-default">Enable click tracking</span>
                          </label>
                          <div className="flex flex-col gap-1">
                            <label className="flex items-center gap-2">
                              <Checkbox checked={open} onChange={setOpen} disabled={!tracking.trim()} label="Enable open tracking" />
                              <span className="text-sm text-default">Enable open tracking</span>
                            </label>
                            <span className="text-xs text-default font-normal ml-7">
                              Open tracking can produce inaccurate results. Learn more and consider{' '}
                              <a href={docsUrl('/knowledge-base/open-tracking')} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-emphasis hover:opacity-80">
                                if open tracking is right for you
                                <ArrowUpRight size={12} aria-hidden />
                              </a>
                              .
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-3 mt-6">
                          <span className="text-sm text-default font-medium">Capabilities</span>
                          <label className="flex items-center gap-2">
                            <Checkbox checked onChange={() => {}} disabled label="Sending" />
                            <span className="text-sm text-default">Sending</span>
                          </label>
                          <label className="flex items-center gap-2">
                            <Checkbox checked={receiving} onChange={setReceiving} label="Receiving" />
                            <span className="text-sm text-default">Receiving (adds an MX record on the domain)</span>
                          </label>
                        </div>
                        <div className="flex flex-col gap-2 mt-6">
                          <label htmlFor="tls" className="text-sm text-default flex items-center">
                            TLS
                          </label>
                          <Select
                            id="tls"
                            value={tls}
                            onChange={setTls}
                            className="max-w-[30rem]"
                            options={[
                              { value: 'opportunistic', label: 'Opportunistic' },
                              { value: 'enforced', label: 'Enforced' },
                            ]}
                          />
                        </div>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                    <div className="flex gap-2">
                      <Button type="submit" variant="primary" icon={<Plus size={16} />} loading={create.isPending}>
                        Add domain
                      </Button>
                    </div>
                  </form>
                  <EmailPreview domain={shown} />
                </div>
              </div>
            </Step>
            <Step active={false} title="DNS Records" />
          </div>
        </div>
      </div>
    </>
  );
}

/** The inbox mock-up beside the form, filled in as the user types. */
function EmailPreview({ domain }: { domain: string }) {
  return (
    <div translate="no" className="absolute top-0 -right-[120%] w-[26rem] rounded-3xl hidden xl:block bg-linear-to-br from-gray-3 from-0% to-transparent to-50% text-balance z-10" aria-hidden="true">
      <div className="bg-background m-px min-h-56 p-5 rounded-3xl flex flex-col">
        <div className="pb-4 border-b border-gray-3">
          <div className="flex items-center gap-3">
            <span
              className="relative shrink-0 flex text-xs rounded-full border border-transparent font-medium uppercase text-default w-8 h-8"
              style={{ background: 'linear-gradient(42deg, var(--gray-1), var(--gray-2)) padding-box, linear-gradient(42deg, var(--gray-a2) 45%, var(--gray-a6)) border-box' }}
            >
              <span className="m-auto">Y</span>
            </span>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <span className="text-sm text-emphasis font-semibold">Your Name</span>
                <span className="text-sm text-default font-normal flex items-center max-w-full min-w-0">
                  &lt;youremail@
                  {domain ? <span className="truncate text-emphasis">{domain}</span> : <span className="inline-block h-3 w-24 bg-gray-2 rounded align-middle" />}&gt;
                </span>
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-sm text-default font-normal">to me</span>
                <ChevronDown size={12} className="text-gray-11" />
              </div>
            </div>
          </div>
        </div>
        <div className="pt-4 flex flex-col gap-3">
          <div className="h-3 bg-gray-2 rounded w-3/5" />
          <div className="h-3 bg-gray-2 rounded w-4/5" />
          <div className="h-3 bg-gray-2 rounded w-2/3" />
        </div>
      </div>
    </div>
  );
}
