import { useState } from 'react';
import { Dialog as D } from '@base-ui/react/dialog';
import { CodeXml, X } from 'lucide-react';
import { IconButton, iconButtonClass } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { Tabs } from '@/components/ui/Tabs';
import { Code } from '@/components/ui/Code';
import { CopyButton } from '@/components/ui/CopyButton';
import { API_BASE } from '@/lib/config';
import { cn } from '@/lib/cn';

export interface ApiExample {
  title: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** Node SDK call (inside an async function, `resend` already created). */
  node: string;
  body?: unknown;
}

const METHOD_TONE: Record<string, string> = {
  GET: 'text-info',
  POST: 'text-success',
  PATCH: 'text-warning',
  PUT: 'text-warning',
  DELETE: 'text-error',
};

function curl(e: ApiExample) {
  const lines = [`curl -X ${e.method} '${API_BASE}${e.path}' \\`, `     -H 'Authorization: Bearer re_xxxxxxxxx'${e.body ? ' \\' : ''}`];
  if (e.body) {
    lines.push(`     -H 'Content-Type: application/json' \\`);
    lines.push(`     -d $'${JSON.stringify(e.body, null, 2).replace(/'/g, "\\'")}'`);
  }
  return lines.join('\n');
}

function node(e: ApiExample) {
  return `import { Resend } from 'resend';\n\nconst resend = new Resend('re_xxxxxxxxx', { baseUrl: '${API_BASE}' });\n\n${e.node}`;
}

/**
 * The "</>" button in page headers: a right-hand drawer with the API calls behind
 * the page, in Node.js and cURL, pointed at 5050 Send.
 */
export function ApiDrawerButton({ examples, className }: { examples: ApiExample[]; className?: string }) {
  const [lang, setLang] = useState<'node' | 'curl'>('node');
  return (
    <D.Root>
      <Tooltip content="API">
        <D.Trigger aria-label="Open API drawer" className={iconButtonClass('secondary', '2', cn('!hidden md:!flex', className))}>
          <span className="inline-flex items-center justify-center opacity-100">
            <CodeXml size={18} className="text-default" />
          </span>
        </D.Trigger>
      </Tooltip>
      <D.Portal>
        <D.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <D.Popup className="fixed inset-y-2 right-2 z-50 flex w-[min(560px,calc(100vw-16px))] flex-col overflow-hidden rounded-3xl border border-default bg-background shadow-lg outline-none transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] data-starting-style:translate-x-8 data-starting-style:opacity-0 data-ending-style:translate-x-8 data-ending-style:opacity-0">
          <div className="flex items-center justify-between gap-2 border-b border-default px-5 py-4">
            <D.Title className="text-base font-semibold text-emphasis">API</D.Title>
            <div className="flex items-center gap-2">
              <Tabs value={lang} onChange={setLang} tabs={[{ value: 'node', label: 'Node.js' }, { value: 'curl', label: 'cURL' }]} />
              <D.Close render={<IconButton label="Close" variant="ghost" size="1"><X size={18} /></IconButton>} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <p className="mb-4 text-sm text-default">
              Base URL <code className="rounded-md bg-interactive px-1.5 py-0.5 font-mono text-[13px] text-emphasis">{API_BASE}</code>. Any Resend SDK works after changing the base URL.
            </p>
            <div className="flex flex-col gap-4">
              {examples.map((e) => {
                const code = lang === 'node' ? node(e) : curl(e);
                return (
                  <section key={e.title} className="overflow-hidden rounded-2xl border border-gray-3">
                    <header className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn('font-mono text-xs font-semibold', METHOD_TONE[e.method])}>{e.method}</span>
                        <span className="truncate font-mono text-xs text-default">{e.path}</span>
                        <span className="hidden truncate text-xs text-muted sm:inline">· {e.title}</span>
                      </div>
                      <CopyButton value={code} />
                    </header>
                    <Code code={code} lang={lang === 'node' ? 'javascript' : 'bash'} className="border-t border-gray-3 bg-gray-a1/20 [&_*]:text-[13px]" />
                  </section>
                );
              })}
            </div>
          </div>
        </D.Popup>
      </D.Portal>
    </D.Root>
  );
}

export const API: Record<string, ApiExample[]> = {
  emails: [
    { title: 'Send email', method: 'POST', path: '/emails', node: `await resend.emails.send({\n  from: 'Acme <onboarding@yourdomain.com>',\n  to: ['delivered@example.com'],\n  subject: 'Hello world',\n  html: '<p>It works!</p>',\n});`, body: { from: 'Acme <onboarding@yourdomain.com>', to: ['delivered@example.com'], subject: 'Hello world', html: '<p>It works!</p>' } },
    { title: 'List emails', method: 'GET', path: '/emails', node: `await resend.emails.list();` },
  ],
  email: [
    { title: 'Retrieve email', method: 'GET', path: '/emails/:id', node: `await resend.emails.get('email_id');` },
    { title: 'Cancel scheduled email', method: 'POST', path: '/emails/:id/cancel', node: `await resend.emails.cancel('email_id');` },
  ],
  receiving: [{ title: 'List received emails', method: 'GET', path: '/emails/receiving', node: `await resend.emails.receiving.list();` }],
  suppressions: [
    { title: 'List suppressions', method: 'GET', path: '/suppressions', node: `await fetch(base + '/suppressions');` },
    { title: 'Add suppression', method: 'POST', path: '/suppressions', node: `await fetch(base + '/suppressions', { method: 'POST', body: JSON.stringify({ email: 'user@example.com' }) });`, body: { email: 'user@example.com' } },
  ],
  domains: [
    { title: 'Create domain', method: 'POST', path: '/domains', node: `await resend.domains.create({ name: 'example.com' });`, body: { name: 'example.com' } },
    { title: 'List domains', method: 'GET', path: '/domains', node: `await resend.domains.list();` },
  ],
  domain: [
    { title: 'Retrieve domain', method: 'GET', path: '/domains/:id', node: `await resend.domains.get('domain_id');` },
    { title: 'Verify domain', method: 'POST', path: '/domains/:id/verify', node: `await resend.domains.verify('domain_id');` },
    { title: 'Update domain', method: 'PATCH', path: '/domains/:id', node: `await resend.domains.update({\n  id: 'domain_id',\n  openTracking: false,\n  clickTracking: true,\n  tls: 'enforced',\n});`, body: { open_tracking: false, click_tracking: true, tls: 'enforced' } },
  ],
  apiKeys: [
    { title: 'Create API key', method: 'POST', path: '/api-keys', node: `await resend.apiKeys.create({ name: 'Production' });`, body: { name: 'Production' } },
    { title: 'List API keys', method: 'GET', path: '/api-keys', node: `await resend.apiKeys.list();` },
    { title: 'Delete API key', method: 'DELETE', path: '/api-keys/:id', node: `await resend.apiKeys.remove('api_key_id');` },
  ],
  webhooks: [
    { title: 'Create webhook', method: 'POST', path: '/webhooks', node: `await resend.webhooks.create({\n  endpoint: 'https://example.com/webhooks',\n  events: ['email.delivered', 'email.bounced'],\n});`, body: { endpoint: 'https://example.com/webhooks', events: ['email.delivered', 'email.bounced'] } },
    { title: 'List webhooks', method: 'GET', path: '/webhooks', node: `await resend.webhooks.list();` },
  ],
  contacts: [
    { title: 'Create contact', method: 'POST', path: '/contacts', node: `await resend.contacts.create({\n  email: 'steve.wozniak@example.com',\n  firstName: 'Steve',\n  lastName: 'Wozniak',\n  unsubscribed: false,\n});`, body: { email: 'steve.wozniak@example.com', first_name: 'Steve', last_name: 'Wozniak', unsubscribed: false } },
    { title: 'List contacts', method: 'GET', path: '/contacts', node: `await resend.contacts.list();` },
  ],
  segments: [{ title: 'Create segment', method: 'POST', path: '/segments', node: `await resend.segments.create({ name: 'Registered users' });`, body: { name: 'Registered users' } }],
  topics: [{ title: 'Create topic', method: 'POST', path: '/topics', node: `await resend.topics.create({\n  name: 'Weekly newsletter',\n  defaultSubscription: 'opt_in',\n});`, body: { name: 'Weekly newsletter', default_subscription: 'opt_in' } }],
  properties: [{ title: 'Create contact property', method: 'POST', path: '/contact-properties', node: `await resend.contactProperties.create({ key: 'company_name', type: 'string' });`, body: { key: 'company_name', type: 'string' } }],
  broadcasts: [
    { title: 'Create broadcast', method: 'POST', path: '/broadcasts', node: `await resend.broadcasts.create({\n  segmentId: 'segment_id',\n  from: 'Acme <onboarding@yourdomain.com>',\n  subject: 'Hello world',\n  html: 'Hi {{{FIRST_NAME|there}}}',\n});`, body: { segment_id: 'segment_id', from: 'Acme <onboarding@yourdomain.com>', subject: 'Hello world', html: 'Hi {{{FIRST_NAME|there}}}' } },
    { title: 'Send broadcast', method: 'POST', path: '/broadcasts/:id/send', node: `await resend.broadcasts.send('broadcast_id', { scheduledAt: 'in 1 hour' });`, body: { scheduled_at: 'in 1 hour' } },
  ],
  templates: [
    { title: 'Create template', method: 'POST', path: '/templates', node: `await resend.templates.create({\n  name: 'order-confirmation',\n  html: '<p>Name: {{{PRODUCT}}}</p>',\n  variables: [{ key: 'PRODUCT', type: 'string', fallbackValue: 'item' }],\n});`, body: { name: 'order-confirmation', html: '<p>Name: {{{PRODUCT}}}</p>' } },
    { title: 'Publish template', method: 'POST', path: '/templates/:id/publish', node: `await resend.templates.publish('template_id');` },
  ],
  automations: [
    { title: 'Send event', method: 'POST', path: '/events/send', node: `await fetch(base + '/events/send', { method: 'POST', body: JSON.stringify({ event: 'user.signed_up', email: 'user@example.com' }) });`, body: { event: 'user.signed_up', email: 'user@example.com', data: { plan: 'pro' } } },
  ],
  logs: [{ title: 'List logs', method: 'GET', path: '/logs', node: `await fetch(base + '/logs');` }],
  metrics: [{ title: 'Email metrics', method: 'GET', path: '/emails/metrics?start_date=…&granularity=day', node: `await fetch(base + '/emails/metrics?granularity=day');` }],
  inboxes: [{ title: 'List received emails', method: 'GET', path: '/emails/receiving', node: `await resend.emails.receiving.list();` }],
};
