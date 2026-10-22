import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, Blocks, Braces, Cable, Mail } from 'lucide-react';
import { teams } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { IntegrationSnippet } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { CodeCard, type CodeLang } from '@/components/ui/Code';
import { Dialog } from '@/components/ui/Dialog';
import { ErrorState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsLayout } from './SettingsLayout';

const LANGS = new Set<CodeLang>(['javascript', 'typescript', 'php', 'python', 'ruby', 'go', 'rust', 'elixir', 'java', 'csharp', 'bash', 'json', 'html']);
function lang(s: IntegrationSnippet): CodeLang {
  const l = (s.language ?? 'text') as CodeLang;
  if (l === ('shell' as CodeLang) || l === ('sh' as CodeLang)) return 'bash';
  return LANGS.has(l) ? l : 'text';
}

function IntegrationCard({ icon, title, badge, description, children }: { icon: ReactNode; title: string; badge?: ReactNode; description: ReactNode; children: ReactNode }) {
  return (
    <div className="w-full rounded-3xl border border-default p-6">
      <div className="flex gap-4">
        <div className="shrink-0 pt-1 text-emphasis">{icon}</div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold">{title}</h3>
            {badge}
          </div>
          <p className="text-sm text-default font-normal">{description}</p>
          <div className="mt-2 flex flex-wrap gap-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Dialog with a picker and the ready-to-copy snippet (host, ports, base URL already filled in). */
function SnippetDialog({ open, onOpenChange, title, items }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; items: IntegrationSnippet[] }) {
  const [id, setId] = useState(items[0]?.id ?? '');
  useEffect(() => {
    if (open && !items.some((i) => i.id === id)) setId(items[0]?.id ?? '');
  }, [open, items, id]);
  const cur = items.find((i) => i.id === id) ?? items[0];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="lg">
      {cur ? (
        <div className="mt-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              ariaLabel="Integration"
              value={cur.id}
              onChange={setId}
              options={items.map((i) => ({ value: i.id, label: i.name }))}
              className="w-full sm:w-64"
            />
            <a
              href={cur.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-emphasis transition-opacity hover:opacity-80"
            >
              {cur.name} docs
              <ArrowUpRight size={12} />
            </a>
          </div>
          <CodeCard
            header={<span className="text-sm font-semibold text-emphasis">{cur.name}</span>}
            code={cur.snippet}
            lang={lang(cur)}
            wrap
            className="[&_.code-block]:max-h-[50vh] [&_.code-block>div]:max-h-[50vh]"
          />
          {cur.notes ? <p className="text-xs text-default">{cur.notes}</p> : null}
          <p className="text-xs text-muted">Replace YOUR_API_KEY with a key from the API keys page.</p>
        </div>
      ) : (
        <p className="mt-6 text-sm text-default">Nothing to show yet.</p>
      )}
    </Dialog>
  );
}

type Group = 'sdk' | 'smtp' | 'platform';

export function IntegrationsPage() {
  const data = useTeamQuery(['integrations'], (t) => teams.integrations(t));
  const [open, setOpen] = useState<Group | null>(null);
  const groups = useMemo(() => {
    const s = data.data?.snippets ?? [];
    return {
      sdk: s.filter((x) => x.category === 'sdk' || x.category === 'framework'),
      smtp: s.filter((x) => x.category === 'smtp'),
      platform: s.filter((x) => x.category === 'platform'),
    };
  }, [data.data]);
  const names = (g: IntegrationSnippet[]) => {
    const n = g.map((x) => x.name);
    return n.length > 4 ? `${n.slice(0, 4).join(', ')} and ${n.length - 4} more` : n.join(', ');
  };
  const btn = (g: Group, label: string) =>
    data.isPending ? (
      <Skeleton className="h-8 w-40 rounded-xl" />
    ) : (
      <Button onClick={() => setOpen(g)} disabled={!groups[g].length}>
        {label}
      </Button>
    );
  return (
    <SettingsLayout title="Integrations">
      <div className="flex flex-col gap-6">
        <IntegrationCard
          icon={<Cable size={20} />}
          title="MCP server"
          badge={
            <Badge tone="info" capitalize={false}>
              New
            </Badge>
          }
          description="Send emails, manage contacts, and more from your AI tools."
        >
          <LinkButton to="/settings/integrations/mcp">Configure MCP</LinkButton>
        </IntegrationCard>
        {data.error ? <ErrorState error={data.error} onRetry={() => void data.refetch()} /> : null}
        <IntegrationCard
          icon={<Braces size={20} />}
          title="SDKs and frameworks"
          description={groups.sdk.length ? `Point any Resend SDK at 5050 Send by changing its base URL: ${names(groups.sdk)}.` : 'Point any Resend SDK at 5050 Send by changing its base URL.'}
        >
          {btn('sdk', 'View SDK setup')}
        </IntegrationCard>
        <IntegrationCard
          icon={<Mail size={20} />}
          title="SMTP libraries"
          description={groups.smtp.length ? `Send through the 5050 Send SMTP relay from ${names(groups.smtp)}.` : 'Send through the 5050 Send SMTP relay from any SMTP library.'}
        >
          {btn('smtp', 'View SMTP snippets')}
        </IntegrationCard>
        <IntegrationCard
          icon={<Blocks size={20} />}
          title="Platforms with custom SMTP"
          description={groups.platform.length ? `Send auth and notification emails from ${names(groups.platform)} via SMTP.` : 'Send auth and notification emails from platforms that support custom SMTP.'}
        >
          {btn('platform', 'View platform settings')}
        </IntegrationCard>
      </div>
      <SnippetDialog open={open === 'sdk'} onOpenChange={(o) => setOpen(o ? 'sdk' : null)} title="SDKs and frameworks" items={groups.sdk} />
      <SnippetDialog open={open === 'smtp'} onOpenChange={(o) => setOpen(o ? 'smtp' : null)} title="SMTP libraries" items={groups.smtp} />
      <SnippetDialog open={open === 'platform'} onOpenChange={(o) => setOpen(o ? 'platform' : null)} title="Platforms with custom SMTP" items={groups.platform} />
    </SettingsLayout>
  );
}
