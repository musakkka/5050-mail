import { ArrowUpRight, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import { teams } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { CopyButton, IdPill } from '@/components/ui/CopyButton';
import { ErrorState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip } from '@/components/ui/Tooltip';
import { docsUrl } from '@/components/layout/docs';
import { formatBytes } from '@/lib/format';
import { SettingsLayout } from './SettingsLayout';

function ReadOnly({ id, label, value, copy = true, info }: { id: string; label: string; value: string; copy?: boolean; info?: string }) {
  return (
    <div className="mt-6 flex flex-col space-y-2 first:mt-0">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-default flex items-center">
          {label}
        </label>
        {info ? (
          <Tooltip content={info}>
            <span tabIndex={0} aria-label={info} className="inline-flex rounded outline-hidden focus-visible:ring-2 focus-visible:ring-focus">
              <Info size={12} className="text-gray-10" />
            </span>
          </Tooltip>
        ) : null}
      </div>
      <Input
        id={id}
        value={value}
        readOnly
        leftWidth={12}
        right={copy ? <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} /> : undefined}
        rightWidth={copy ? 36 : 12}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}

export function SmtpPage() {
  const smtp = useTeamQuery(['smtp'], (t) => teams.smtp(t));
  const s = smtp.data;
  const tls = s?.ports.filter((p) => p.security === 'tls') ?? [];
  const starttls = s?.ports.filter((p) => p.security !== 'tls') ?? [];
  const primary = tls[0] ?? s?.ports[0];
  const others = s ? s.ports.filter((p) => p !== primary) : [];
  return (
    <SettingsLayout title="SMTP">
      <div className="flex">
        <section className="w-full rounded-3xl border border-gray-3 lg:w-1/2">
          <div className="p-4 pb-2">
            <h2 className="text-base text-emphasis font-bold">SMTP</h2>
          </div>
          <div className="p-4">
            <p className="text-sm text-default font-normal mb-1">Send emails using SMTP instead of the REST API.</p>
            <p className="text-sm text-default font-normal">
              <a
                href={docsUrl('/send-with-smtp')}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex cursor-pointer items-center gap-1 text-sm text-emphasis transition-opacity duration-300 ease-in-out hover:opacity-80"
              >
                See documentation
                <ArrowUpRight size={12} className="shrink-0" />
              </a>{' '}
              for more information.
            </p>
            {smtp.error ? (
              <ErrorState className="mt-6" error={smtp.error} onRetry={() => void smtp.refetch()} />
            ) : !s ? (
              <div className="mt-6 flex flex-col gap-6" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-8 w-full rounded-xl" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-6">
                <ReadOnly id="host" label="Host" value={s.host} />
                {primary ? <ReadOnly id="port" label="Port" value={String(primary.port)} /> : null}
                {others.length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-y-1">
                    <span className="text-default font-normal mx-1 text-sm">For encrypted/TLS connections use</span>
                    {others.map((p, i) => (
                      <span key={p.port} className="inline-flex items-center">
                        <IdPill value={String(p.port)} className="mr-1" />
                        {i < others.length - 2 ? <span className="text-default font-normal mr-1 text-sm">,</span> : i === others.length - 2 ? <span className="text-default font-normal mr-1 text-sm">or</span> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 mx-1 text-xs text-muted">
                  {tls.map((p) => p.port).join(', ')}
                  {tls.length ? ' use implicit TLS' : ''}
                  {tls.length && starttls.length ? '; ' : ''}
                  {starttls.map((p) => p.port).join(', ')}
                  {starttls.length ? ' use STARTTLS' : ''}.
                </p>
                <div className="mt-4">
                  <ReadOnly id="user" label="User" value={s.username} />
                </div>
                <ReadOnly id="password" label="Password" value={s.password || 'YOUR_API_KEY'} copy={false} info="Use an API key as the password. Sending-access keys work too." />
                <p className="mt-2 text-xs text-muted">
                  Create a key in <Link to="/api-keys" className="text-emphasis hover:opacity-80">API keys</Link>
                  {s.max_message_bytes ? ` · Max message size ${formatBytes(s.max_message_bytes)}` : ''}
                </p>
                {s.notes?.length ? (
                  <ul className="mt-6 flex list-disc flex-col gap-1 pl-5 text-xs text-default">
                    {s.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
        </section>
      </div>
    </SettingsLayout>
  );
}

