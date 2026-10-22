import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, PartyPopper } from 'lucide-react';
import { domains as domainsApi, emails as emailsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton, buttonClass } from '@/components/ui/Button';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { useTitle } from '@/components/layout/Page';
import { docsUrl } from '@/components/layout/docs';
import { API_BASE } from '@/lib/config';
import { SDKS, sendSnippet, type SdkId } from '@/lib/snippets';
import { useSession } from '@/state/session';
import { Step, Steps, type StepState } from './Stepper';
import { TabbedCode } from './TabbedCode';
import { ApiKeyStep } from './ApiKeyStep';
import { DomainStep } from './DomainStep';

const HTML = '<p>Congrats on sending your <strong>first email</strong>!</p>';

function agentPrompt(from: string, to: string) {
  return `Add email sending to this project with 5050 Send (a Resend-compatible API).
- Install the official "resend" SDK for this language.
- Point it at the base URL ${API_BASE} (Node: new Resend(key, { baseUrl }); Python: resend.api_url; others: RESEND_BASE_URL).
- Read the API key from the RESEND_API_KEY environment variable; never hard-code it.
- Send a test email from ${from} to ${to} with the subject "Hello World".`;
}

function ExploreCard({ title, badge, description, action }: { title: string; badge?: string; description: string; action: React.ReactNode }) {
  return (
    <div className="relative w-full rounded-3xl border border-default">
      <div
        aria-hidden="true"
        className="absolute right-0 top-0 hidden h-px w-[200px] dark:block"
        style={{ background: 'linear-gradient(90deg, rgba(56,189,248,0) 0%, rgba(232,232,232,0.2) 33%, rgba(143,143,143,0.67) 64%, rgba(236,72,153,0) 99%)' }}
      />
      <div className="flex justify-between border-b border-default p-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base text-emphasis font-semibold">{title}</h3>
            {badge ? (
              <Badge tone="success" capitalize={false}>
                {badge}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-default font-normal">{description}</p>
        </div>
      </div>
      <div className="p-4">{action}</div>
    </div>
  );
}

export function OnboardingPage() {
  useTitle('Onboarding');
  const nav = useNavigate();
  const { me } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [sdk, setSdk] = useState<SdkId>('node');
  const [sent, setSent] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const domains = useTeamQuery(['domains'], (t) => domainsApi.list(t), { refetchInterval: polling ? 5000 : false });
  const domainList = domains.data?.data ?? [];
  const verified = domainList.find((d) => d.status === 'verified');
  const checking = !verified && domainList.some((d) => d.status === 'pending');
  useEffect(() => setPolling(checking), [checking]);
  // The domain step shows only for teams that start without a verified domain (Resend's own
  // onboarding has a shared sender; 5050 Send needs the team's own domain).
  const [needsDomain, setNeedsDomain] = useState<boolean | null>(null);
  useEffect(() => {
    if (needsDomain === null && domains.data) setNeedsDomain(!verified);
  }, [needsDomain, domains.data, verified]);
  const from = verified ? `onboarding@${verified.name}` : 'onboarding@yourdomain.com';
  const sample = { apiKey: token ?? 're_xxxxxxxxx', from, to: me.email, subject: 'Hello World', html: HTML };
  const tabs = useMemo(() => SDKS.map((s) => ({ id: s.id, label: s.label, lang: s.lang, code: sendSnippet(s.id, sample) })), [token, from, me.email]);
  const send = useTeamMutation((t) => emailsApi.send(t, { from, to: [me.email], subject: 'Hello World', html: HTML }), [['emails']], {
    onSuccess: (r) => {
      setSent(r.id);
      toast.success(`Email sent to ${me.email}`);
    },
  });
  const keyState: StepState = token ? 'done' : 'active';
  const sendState: StepState = sent ? 'done' : token && verified ? 'active' : 'upcoming';

  return (
    <>
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end justify-between gap-4 px-6 pt-2 pb-8 md:max-w-5xl md:pt-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-display effect-font-styling text-[28px] leading-[34px] tracking-[-0.045rem] text-emphasis font-medium">Send your first email</h1>
          <span className="text-sm text-default font-normal">Follow the steps to send an email using the 5050 Send API.</span>
        </div>
        <div className="md:mr-6.5">
          <Menu
            align="end"
            className="w-64"
            trigger={
              <button type="button" aria-label="Set up with your agent" className={buttonClass('secondary', '2', 'pr-2')}>
                <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">Set up with your agent</span>
                <span className="opacity-100">
                  <ChevronDown size={16} className="text-default shrink-0" />
                </span>
              </button>
            }
          >
            <MenuItem
              onClick={async () => {
                if (await copyText(agentPrompt(from, me.email))) toast('Prompt copied. Paste it into your coding agent.');
              }}
            >
              Copy prompt for your agent
            </MenuItem>
            <MenuItem onClick={() => nav('/settings/integrations/mcp')}>Connect the MCP server</MenuItem>
            <MenuItem onClick={() => window.open(docsUrl('/introduction'), '_blank', 'noopener,noreferrer')}>Open the docs</MenuItem>
          </Menu>
        </div>
      </div>
      <div className="relative mx-auto w-full max-w-full px-6 py-4 md:max-w-5xl">
        <Steps lineClassName={needsDomain ? 'h-[900px] max-h-full' : 'h-[700px] max-h-full'}>
          {needsDomain ? (
            <Step state={verified ? 'done' : 'active'} title="Add a domain" description="Verify a domain you own to send emails from it">
              <DomainStep list={domainList} loading={domains.isPending} />
            </Step>
          ) : null}
          <Step state={keyState} title="Add an API key" description="Use the following generated key to authenticate requests">
            <ApiKeyStep name="Onboarding" token={token} onToken={setToken} />
          </Step>
          <Step interactive state={sendState} title="Send an email" description="Implement or run the code below to send your first email">
            <TabbedCode
              tabs={tabs}
              value={sdk}
              onChange={(v) => setSdk(v as SdkId)}
              footer={
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" icon={<PartyPopper size={16} />} loading={send.isPending} disabled={!verified || !token} onClick={() => send.mutate(undefined)}>
                    Send email
                  </Button>
                  {!domains.isPending && !verified ? (
                    <span className="text-xs text-default">
                      {needsDomain ? 'Verify your domain above to send from it.' : 'Verify a domain first to send from it. '}
                      {needsDomain ? null : (
                        <Link to="/domains/add" className="text-emphasis hover:opacity-80">
                          Add a domain
                        </Link>
                      )}
                    </span>
                  ) : !token ? (
                    <span className="text-xs text-default">Add an API key above first.</span>
                  ) : sent ? (
                    <Link to={`/emails/${sent}`} className="text-xs text-emphasis hover:opacity-80">
                      View the email →
                    </Link>
                  ) : verified ? (
                    <span className="min-w-0 truncate text-xs text-default">
                      Sends from {from} to {me.email}
                    </span>
                  ) : null}
                </div>
              }
            />
          </Step>
        </Steps>
        <section className={`relative mt-12 flex flex-col gap-6 transition duration-200 ease-in-out ${sent ? '' : 'opacity-50'}`}>
          <div className="flex flex-col">
            <h2 className="text-lg text-emphasis font-bold">Explore more</h2>
            <p className="mt-1 text-sm text-default font-normal">Finish setting up and unlock everything 5050 Send can do.</p>
          </div>
          <div className="grid gap-6 md:grid-cols-3 md:gap-8">
            {needsDomain ? (
              <ExploreCard title="Invite your team" badge="Recommended" description="Add developers so they can manage domains, keys and emails." action={<LinkButton to="/settings/team">Invite members</LinkButton>} />
            ) : (
              <ExploreCard title="Add a domain" badge="Recommended" description="Verify and send emails from your own custom domains." action={<LinkButton to="/domains/add">Add domain</LinkButton>} />
            )}
            <ExploreCard title="Install MCP" description="Connect your AI tools and agents to send emails with 5050 Send." action={<LinkButton to="/settings/integrations/mcp">Install MCP</LinkButton>} />
            <ExploreCard title="Deliverability tips" description="Avoiding the spam folder and reaching the inbox." action={<LinkButton href={docsUrl('/dashboard/emails/deliverability-insights')}>Learn more</LinkButton>} />
          </div>
        </section>
      </div>
    </>
  );
}
