import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/api/http';
import { SessionProvider, useMe, useUnauthorizedRedirect } from '@/state/session';
import { Shell } from '@/components/layout/Shell';
import { Shortcuts } from '@/components/layout/Shortcuts';
import { AskAnything } from '@/components/layout/AskAnything';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { Toaster } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/EmptyState';
import { LoginPage } from '@/pages/LoginPage';
import { useQuery } from '@tanstack/react-query';
import { auth, teams } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { setDocsBase } from '@/components/layout/docs';
import { setSupportEmail } from '@/lib/config';
import { BrandMark } from '@/components/brand/BrandMark';

const p = <T extends Record<string, unknown>>(f: () => Promise<T>, name: keyof T) => lazy(() => f().then((m) => ({ default: m[name] as React.ComponentType })));

const Emails = p(() => import('@/pages/emails/EmailsPage'), 'EmailsPage');
const Receiving = p(() => import('@/pages/emails/ReceivingPage'), 'ReceivingPage');
const Suppressions = p(() => import('@/pages/emails/SuppressionsPage'), 'SuppressionsPage');
const EmailDetail = p(() => import('@/pages/emails/EmailDetailPage'), 'EmailDetailPage');
const ReceivedDetail = p(() => import('@/pages/emails/ReceivedDetailPage'), 'ReceivedDetailPage');
const SuppressionDetail = p(() => import('@/pages/emails/SuppressionDetailPage'), 'SuppressionDetailPage');
const Templates = p(() => import('@/pages/templates/TemplatesPage'), 'TemplatesPage');
const TemplateEditor = p(() => import('@/pages/templates/TemplateEditorPage'), 'TemplateEditorPage');
const Contacts = p(() => import('@/pages/audience/ContactsPage'), 'ContactsPage');
const ContactDetail = p(() => import('@/pages/audience/ContactDetailPage'), 'ContactDetailPage');
const Segments = p(() => import('@/pages/audience/SegmentsPage'), 'SegmentsPage');
const Topics = p(() => import('@/pages/audience/TopicsPage'), 'TopicsPage');
const Properties = p(() => import('@/pages/audience/PropertiesPage'), 'PropertiesPage');
const Inboxes = p(() => import('@/pages/inboxes/InboxesPage'), 'InboxesPage');
const Broadcasts = p(() => import('@/pages/broadcasts/BroadcastsPage'), 'BroadcastsPage');
const BroadcastEditor = p(() => import('@/pages/broadcasts/BroadcastEditorPage'), 'BroadcastEditorPage');
const Automations = p(() => import('@/pages/automations/AutomationsPage'), 'AutomationsPage');
const AutomationEvents = p(() => import('@/pages/automations/EventsPage'), 'EventsPage');
const AutomationBuilder = p(() => import('@/pages/automations/AutomationBuilderPage'), 'AutomationBuilderPage');
const Metrics = p(() => import('@/pages/metrics/MetricsPage'), 'MetricsPage');
const Domains = p(() => import('@/pages/domains/DomainsPage'), 'DomainsPage');
const DomainAdd = p(() => import('@/pages/domains/DomainAddPage'), 'DomainAddPage');
const DomainDetail = p(() => import('@/pages/domains/DomainDetailPage'), 'DomainDetailPage');
const Logs = p(() => import('@/pages/logs/LogsPage'), 'LogsPage');
const LogDetail = p(() => import('@/pages/logs/LogDetailPage'), 'LogDetailPage');
const ApiKeys = p(() => import('@/pages/api-keys/ApiKeysPage'), 'ApiKeysPage');
const ApiKeyDetail = p(() => import('@/pages/api-keys/ApiKeyDetailPage'), 'ApiKeyDetailPage');
const Webhooks = p(() => import('@/pages/webhooks/WebhooksPage'), 'WebhooksPage');
const WebhookDetail = p(() => import('@/pages/webhooks/WebhookDetailPage'), 'WebhookDetailPage');
const Usage = p(() => import('@/pages/settings/UsagePage'), 'UsagePage');
const Billing = p(() => import('@/pages/settings/BillingPage'), 'BillingPage');
const Team = p(() => import('@/pages/settings/TeamPage'), 'TeamPage');
const Smtp = p(() => import('@/pages/settings/SmtpPage'), 'SmtpPage');
const Integrations = p(() => import('@/pages/settings/IntegrationsPage'), 'IntegrationsPage');
const Mcp = p(() => import('@/pages/settings/McpPage'), 'McpPage');
const Unsubscribe = p(() => import('@/pages/settings/UnsubscribePage'), 'UnsubscribePage');
const Documents = p(() => import('@/pages/settings/DocumentsPage'), 'DocumentsPage');
const Labs = p(() => import('@/pages/settings/LabsPage'), 'LabsPage');
const Onboarding = p(() => import('@/pages/onboarding/OnboardingPage'), 'OnboardingPage');
const NotFound = p(() => import('@/pages/NotFoundPage'), 'NotFoundPage');

function PageFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-default" aria-busy="true">
      <Spinner size={20} />
    </div>
  );
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="fixed inset-0 flex items-center justify-center bg-background p-6">{children}</div>;
}

/** Suggested team name from the admin's mail domain ("ada@northwind.dev" → "northwind"). */
function suggestTeamName(email: string): string {
  const host = email.split('@')[1] ?? '';
  const label = host.split('.').find((p) => p && !/^(mail|www)$/i.test(p)) ?? '';
  return label.slice(0, 100);
}

/** A mail administrator with no team yet creates the first one (and joins it as admin), then lands on onboarding. */
function FirstTeam({ email, onCreated }: { email: string; onCreated: () => Promise<unknown> }) {
  const nav = useNavigate();
  const [name, setName] = useState(() => suggestTeamName(email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError('Enter a team name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const t = await teams.create({ name: n, members: [{ email, role: 'admin' }] });
      try {
        localStorage.setItem('send.team', t.id);
      } catch {
        /* storage blocked */
      }
      nav('/onboarding', { replace: true });
      await onCreated();
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the team');
      setBusy(false);
    }
  };
  const logout = async () => {
    await auth.logout().catch(() => null);
    window.location.assign('/login');
  };
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-120px] h-[340px] w-[min(720px,140vw)] -translate-x-1/2 rounded-full opacity-[0.12] blur-[90px]"
        style={{ background: 'linear-gradient(180deg, #D9D9D9 0%, #737373 100%)' }}
      />
      <main className="relative w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center gap-6 text-center">
          <BrandMark height={36} title="5050 Send" />
          <div>
            <h1 className="font-display effect-font-styling text-[28px] leading-[34px] tracking-[-0.045rem] text-emphasis font-medium">Create your team</h1>
            <p className="mt-2 text-sm text-default text-balance">Teams own domains, API keys and emails. You can rename it and invite developers later.</p>
          </div>
        </div>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="team-name" className="text-sm text-default">
              Team name
            </label>
            <Input
              id="team-name"
              value={name}
              placeholder="Acme"
              autoComplete="organization"
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError('');
              }}
              maxLength={100}
              invalid={!!error}
              aria-describedby={error ? 'team-error' : undefined}
              className="h-10"
              autoFocus
            />
          </div>
          {error ? (
            <p id="team-error" role="alert" className="rounded-xl border border-error-subtle bg-error px-3 py-2 text-sm text-error">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="3" loading={busy} className="w-full">
            Create team
          </Button>
        </form>
        <p className="mt-8 text-center text-xs text-default">
          Signed in as <span className="break-all text-emphasis">{email}</span>.{' '}
          <button type="button" onClick={() => void logout()} className="text-emphasis underline-offset-2 hover:underline">
            Log out
          </button>
        </p>
      </main>
    </div>
  );
}

function Authed() {
  useUnauthorizedRedirect();
  const me = useMe();
  const loc = useLocation();
  const system = useQuery({ queryKey: ['system'], queryFn: () => auth.system(), staleTime: 300_000, enabled: !!me.data });
  setDocsBase(system.data?.docsBase);
  setSupportEmail(system.data?.supportEmail);
  if (me.isPending) {
    return (
      <FullScreen>
        <Spinner size={22} className="text-default" />
      </FullScreen>
    );
  }
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return (
      <FullScreen>
        <ErrorState error={me.error} onRetry={() => void me.refetch()} className="w-full max-w-md" />
      </FullScreen>
    );
  }
  if (!me.data.teams.length) {
    if (me.data.isAdmin) return <FirstTeam email={me.data.email} onCreated={() => me.refetch()} />;
    return (
      <FullScreen>
        <ErrorState error="Your account is not a member of any 5050 Send team yet. Ask a team admin to invite you." className="w-full max-w-md" />
      </FullScreen>
    );
  }
  return (
    <SessionProvider me={me.data}>
      <Shell>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route index element={<Navigate to="/emails" replace />} />
            <Route path="onboarding" element={<Onboarding />} />
            <Route path="emails" element={<Emails />} />
            <Route path="emails/receiving" element={<Receiving />} />
            <Route path="emails/receiving/:id" element={<ReceivedDetail />} />
            <Route path="emails/suppressions" element={<Suppressions />} />
            <Route path="emails/suppressions/:id" element={<SuppressionDetail />} />
            <Route path="emails/:id" element={<EmailDetail />} />
            <Route path="templates" element={<Templates />} />
            <Route path="templates/:id" element={<TemplateEditor />} />
            <Route path="audience" element={<Contacts />} />
            <Route path="audience/contacts/:id" element={<ContactDetail />} />
            <Route path="audience/segments" element={<Segments />} />
            <Route path="audience/topics" element={<Topics />} />
            <Route path="audience/properties" element={<Properties />} />
            <Route path="inboxes" element={<Inboxes />} />
            <Route path="broadcasts" element={<Broadcasts />} />
            <Route path="broadcasts/:id" element={<BroadcastEditor />} />
            <Route path="automations" element={<Automations />} />
            <Route path="automations/events" element={<AutomationEvents />} />
            <Route path="automations/:id" element={<AutomationBuilder />} />
            <Route path="metrics" element={<Metrics />} />
            <Route path="domains" element={<Domains />} />
            <Route path="domains/add" element={<DomainAdd />} />
            <Route path="domains/new" element={<Navigate to="/domains/add" replace />} />
            <Route path="domains/:id" element={<DomainDetail />} />
            <Route path="logs" element={<Logs />} />
            <Route path="logs/:id" element={<LogDetail />} />
            <Route path="api-keys" element={<ApiKeys />} />
            <Route path="api-keys/:id" element={<ApiKeyDetail />} />
            <Route path="webhooks" element={<Webhooks />} />
            <Route path="webhooks/:id" element={<WebhookDetail />} />
            <Route path="settings" element={<Navigate to="/settings/usage" replace />} />
            <Route path="settings/usage" element={<Usage />} />
            <Route path="settings/billing" element={<Billing />} />
            <Route path="settings/team" element={<Team />} />
            <Route path="settings/smtp" element={<Smtp />} />
            <Route path="settings/integrations" element={<Integrations />} />
            <Route path="settings/integrations/mcp" element={<Mcp />} />
            <Route path="settings/unsubscribe-page" element={<Unsubscribe />} />
            <Route path="settings/documents" element={<Documents />} />
            <Route path="settings/labs" element={<Labs />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Shell>
      <Shortcuts />
      <AskAnything />
    </SessionProvider>
  );
}

export function App() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/*" element={<Authed />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
