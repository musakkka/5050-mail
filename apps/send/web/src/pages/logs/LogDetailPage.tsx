import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { logs as logsApi, apiKeys, emails as emailsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import { useTitle } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Badge } from '@/components/ui/Badge';
import { IdPill, CopyButton } from '@/components/ui/CopyButton';
import { Code } from '@/components/ui/Code';
import { Tabs } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { LinkButton } from '@/components/ui/Button';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { LogIcon, shortUserAgent, statusTone } from './shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, children, className = 'basis-1/3' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex ${className} min-w-0 flex-col items-start gap-1 pr-4 max-md:basis-full max-md:[&:not(:last-child)]:mb-6`}>
      <span className="text-xs text-default uppercase">{label}</span>
      <div className="flex max-w-full min-w-0 items-center gap-2 text-sm text-emphasis">{children}</div>
    </div>
  );
}

function json(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

/** JSON block with a floating copy button (the reference's black code panes). */
function JsonPane({ value, className, empty = 'No body' }: { value: unknown; className?: string; empty?: string }) {
  const text = json(value);
  if (!text) return <p className="px-4 py-6 text-sm text-muted">{empty}</p>;
  return (
    <div className={`relative ${className ?? ''}`}>
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={text} />
      </div>
      <Code code={text} lang="json" wrap className="[&>div]:max-h-[560px] [&>pre]:max-h-[560px] [&>div]:pr-10" />
    </div>
  );
}

function Headers({ headers }: { headers: Record<string, string> | null | undefined }) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return <p className="px-7.5 py-8 text-sm text-muted">Headers aren't recorded for this request.</p>;
  return (
    <div>
      <div className="hidden gap-4 pt-8 pb-1 px-7.5 sm:flex">
        <div className="w-64 shrink-0">
          <p className="text-xs text-default font-normal">Name</p>
        </div>
        <div className="flex-1">
          <p className="text-xs text-default font-normal">Value</p>
        </div>
      </div>
      <dl className="grid divide-y divide-gray-2" translate="no">
        {entries.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 py-4 px-7.5 sm:flex-row sm:gap-4">
            <dt className="w-full shrink-0 sm:w-64">
              <span className="text-sm text-default font-normal font-mono break-all">{k}</span>
            </dt>
            <dd className="min-w-0 flex-1">
              <span className="text-sm text-emphasis font-normal font-mono break-all">{v}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type Tab = 'req' | 'reqh' | 'resh';

export function LogDetailPage() {
  const { id = '' } = useParams();
  const log = useTeamQuery(['log', id], (t) => logsApi.get(t, id), { enabled: UUID.test(id) });
  const keys = useTeamQuery(['api-keys'], (t) => apiKeys.list(t));
  const l = log.data;
  const respId = l && l.endpoint.startsWith('/emails') && l.response_status < 300 ? ((l.response_body as { id?: unknown } | null)?.id as string | undefined) : undefined;
  const emailId = respId && UUID.test(respId) ? respId : undefined;
  const email = useTeamQuery(['email', emailId], (t) => emailsApi.get(t, emailId!), { enabled: !!emailId });
  const [tab, setTab] = useState<Tab>('req');
  useTitle(l ? `${l.endpoint} · Logs` : 'Logs');

  if (!UUID.test(id) || (log.error instanceof ApiError && log.error.status === 404)) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <EmptyState compact title="Log not found" description="This log doesn't exist or is older than the 30-day retention." actions={<LinkButton to="/logs">Back to logs</LinkButton>} />
      </div>
    );
  }
  if (log.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      </div>
    );
  }

  const key = l?.api_key_id ? keys.data?.data.find((k) => k.id === l.api_key_id) : undefined;
  const tone = l ? statusTone(l.response_status) : null;
  const hasRespHeaders = !!l?.response_headers && Object.keys(l.response_headers).length > 0;

  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8 flex flex-col gap-y-8">
        <div className="flex items-center justify-between gap-4 max-md:flex-col">
          <div className="flex min-w-0 flex-col items-center gap-6 md:flex-row">
            {l ? <LogIcon status={l.response_status} size={80} /> : <Skeleton className="size-20 rounded-[25px]" />}
            <div className="min-w-0 text-center md:text-left">
              <span className="text-sm text-default font-semibold">Log</span>
              {l ? (
                <h1 className="text-xl tracking-[-0.16px] text-emphasis font-bold truncate" translate="no" title={`${l.method} ${l.endpoint}`}>
                  {l.method} {l.endpoint}
                </h1>
              ) : (
                <Skeleton className="mt-1 h-7 w-48" />
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-md:hidden">
            <ApiDrawerButton examples={API.logs!} />
          </div>
        </div>
        {l ? (
          <>
            <div className="flex flex-wrap">
              <Field label="Endpoint">
                <span className="truncate" translate="no" title={l.endpoint}>
                  {l.endpoint}
                </span>
              </Field>
              <Field label="Date">
                <Tooltip content={fullDateTime(l.created_at)}>
                  <time className="cursor-auto text-current text-sm" dateTime={l.created_at}>
                    {timeAgoShort(l.created_at)}
                  </time>
                </Tooltip>
              </Field>
              <Field label="Status">
                <Badge tone={tone!.badge} capitalize={false}>
                  {l.response_status}
                </Badge>
                {l.duration_ms != null ? <span className="text-xs text-muted">{l.duration_ms} ms</span> : null}
              </Field>
            </div>
            <div className="flex flex-wrap">
              <Field label="Method">{l.method}</Field>
              <Field label="User-Agent">
                <Tooltip content={l.user_agent ?? ''}>
                  <span translate="no" className="truncate">
                    {shortUserAgent(l.user_agent)}
                  </span>
                </Tooltip>
              </Field>
              <Field label="ID" className="basis-1/3 w-1/3">
                <IdPill value={l.id} />
              </Field>
            </div>
            {l.api_key_id || l.source ? (
              <div className="flex flex-wrap">
                {l.api_key_id ? (
                  <Field label="API key">
                    {key ? (
                      <>
                        <Link
                          to={`/api-keys/${key.id}`}
                          translate="no"
                          className="cursor-pointer truncate border-b border-dashed border-link transition duration-300 ease-in-out hover:border-link-hover"
                        >
                          <span className="text-sm text-emphasis font-normal">{key.name}</span>
                        </Link>
                        {key.permission ? <Badge capitalize={false}>{key.permission === 'full_access' ? 'Full access' : 'Sending access'}</Badge> : null}
                      </>
                    ) : (
                      <span className="text-sm text-muted">{keys.isPending ? '…' : 'Deleted key'}</span>
                    )}
                  </Field>
                ) : null}
                {l.source && l.source !== 'api' ? <Field label="Source">{l.source.toUpperCase()}</Field> : null}
                {l.ip ? <Field label="IP address">{l.ip}</Field> : null}
              </div>
            ) : null}
            {emailId ? (
              <div className="flex flex-wrap">
                <Field label="Email" className="basis-full">
                  <Link
                    to={`/emails/${emailId}`}
                    className="cursor-pointer min-w-0 truncate border-b border-dashed border-link transition duration-300 ease-in-out hover:border-link-hover"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-emphasis">
                      <Mail size={14} className="shrink-0" />
                      <span translate="no" className="truncate">
                        {email.data?.subject || (email.isPending ? emailId : '(no subject)')}
                      </span>
                    </span>
                  </Link>
                </Field>
              </div>
            ) : null}
          </>
        ) : (
          <div className="grid grid-cols-3 gap-8">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-full px-6 md:max-w-6xl">
        <h2 className="text-lg text-emphasis font-bold">Response body</h2>
        <div className="mb-12 mt-4">
          {l ? (
            <JsonPane value={l.response_body} className="overflow-hidden rounded-2xl border border-gray-2 bg-white dark:bg-black" />
          ) : (
            <Skeleton className="h-24 w-full rounded-2xl" />
          )}
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          className="overflow-hidden rounded-3xl border border-default"
          listClassName="p-4 pb-0"
          tabs={[
            { value: 'req', label: 'Request body' },
            { value: 'reqh', label: 'Request headers' },
            ...(hasRespHeaders ? [{ value: 'resh' as Tab, label: 'Response headers' }] : []),
          ]}
        >
          <div className="outline-hidden">
            {!l ? (
              <Skeleton className="m-4 h-40" />
            ) : tab === 'req' ? (
              <JsonPane value={l.request_body} empty={l.method === 'GET' || l.method === 'DELETE' ? 'This request has no body.' : 'No body recorded.'} />
            ) : tab === 'reqh' ? (
              <Headers headers={l.request_headers} />
            ) : (
              <Headers headers={l.response_headers} />
            )}
          </div>
        </Tabs>
      </div>
    </>
  );
}
