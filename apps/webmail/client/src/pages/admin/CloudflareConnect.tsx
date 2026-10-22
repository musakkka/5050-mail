/** One-click domain setup UI: the live checklist and the domain page's "Sending" card. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/icons/Icon';
import { checklistComplete, cloudflareApi, connectChecklist, sendingHealth, type ChecklistStep, type ConnectResult } from '../../admin/cloudflare';
import { adminKeys, useAdmin, useCloudflareStatus } from '../../admin/state';
import type { Domain } from '../../admin/types';
import { useUi } from '../../state/ui';
import { Card, HealthChip } from './ui';
import '../../styles/admin-connect.css';

const STATE_TEXT: Record<ChecklistStep['state'], string> = {
  done: 'done',
  active: 'in progress',
  error: 'failed',
  skipped: 'skipped',
  waiting: 'waiting',
};

export function Checklist({ steps }: { steps: ChecklistStep[] }) {
  return (
    <ol className="adm-checklist" aria-label="Setup progress">
      {steps.map((s) => (
        <li key={s.id} className={`adm-checklist__item adm-checklist__item--${s.state}`} data-step={s.id} data-state={s.state}>
          <span className="adm-checklist__glyph" aria-hidden>
            {s.state === 'done' ? (
              <Icon name="check_circle" size={22} fill />
            ) : s.state === 'error' ? (
              <Icon name="error" size={22} fill />
            ) : s.state === 'active' ? (
              <span className="adm-spinner" />
            ) : s.state === 'skipped' ? (
              <Icon name="remove" size={22} />
            ) : (
              <Icon name="radio_button_unchecked" size={22} />
            )}
          </span>
          <span>
            {s.label}
            <span className="adm-sr">: {STATE_TEXT[s.state]}</span>
          </span>
          {s.detail ? <span className="adm-checklist__detail">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Live progress after "Add & connect": polls the domain, its DKIM/cert/task
 * status (x:Task, x:Certificate) and the Cloudflare status until everything is ready.
 */
export function ConnectProgress({
  domainName,
  domainId,
  createError,
  connect,
  onRetry,
  retrying,
}: {
  domainName: string;
  domainId: string | null;
  createError?: string;
  connect?: ConnectResult;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { api } = useAdmin();
  const [done, setDone] = useState(false);
  const poll = done ? false : 4000;
  const { data: domain } = useQuery({
    queryKey: adminKeys.domain(domainId ?? ''),
    queryFn: () => api.getDomain(domainId!),
    enabled: !!domainId,
    refetchInterval: poll,
  });
  const { data: status } = useQuery({
    queryKey: adminKeys.domainStatus(domainId ?? ''),
    queryFn: () => api.domainStatus(domainId!),
    enabled: !!domainId,
    refetchInterval: poll,
  });
  const { data: cf } = useCloudflareStatus(domainId ? domainName : undefined, { enabled: !!connect, refetchInterval: done ? false : 6000 });
  const steps = connectChecklist({
    created: !!domainId,
    createError,
    domain,
    signatures: status?.signatures,
    certificates: status?.certificates,
    tasks: status?.tasks,
    cf,
    connect,
  });
  if (!done && checklistComplete(steps)) setDone(true);
  const sendingFailed = steps.find((s) => s.id === 'sending')?.state === 'error';
  return (
    <div aria-live="polite">
      <Checklist steps={steps} />
      {sendingFailed ? (
        <div className="adm-sending__actions">
          <Button variant="outlined" icon="refresh" disabled={retrying} onClick={onRetry}>
            Retry Cloudflare setup
          </Button>
        </div>
      ) : null}
      {!done && domainId ? (
        <p className="adm-connect-summary">You can close this window: setup carries on in the background, and the domain page shows its progress.</p>
      ) : null}
    </div>
  );
}

/** Domain page card: Cloudflare Email Sending status, with a "Fix" button that re-runs connect. */
export function SendingCard({ domain }: { domain: Domain }) {
  const qc = useQueryClient();
  const showSnack = useUi((s) => s.showSnack);
  const { data, error, isFetching } = useCloudflareStatus(domain.name);
  const [busy, setBusy] = useState(false);
  const health = error ? { state: 'error' as const, label: "Couldn't check", detail: (error as Error).message } : sendingHealth(data);
  const bounce = data?.bounceRecords ?? [];
  const own = data?.stalwartRecords ?? [];
  const direct = data?.emailSending === false;
  const fix = async () => {
    setBusy(true);
    const r = await cloudflareApi.connect(domain.name);
    setBusy(false);
    if (r.ok) showSnack({ text: direct ? `DNS records published for ${domain.name}` : `Email sending is set up for ${domain.name}` });
    else showSnack({ text: r.steps.find((s) => s.status === 'error')?.detail ?? r.message ?? 'Cloudflare setup failed', duration: 0 });
    await qc.invalidateQueries({ queryKey: adminKeys.cfStatus(domain.name) });
  };
  return (
    <Card title={direct ? 'Cloudflare DNS' : 'Sending'} icon={direct ? 'cloud' : 'outgoing_mail'}>
      <HealthChip health={health} />
      {health.detail ? <p className="adm-detail">{health.detail}</p> : null}
      {data?.zone ? (
        <ul className="adm-kv">
          <li>
            <span>Cloudflare zone</span>
            <span className="adm-mono">{data.zone}</span>
          </li>
          {data.sending.returnPath ? (
            <li>
              <span>Return path</span>
              <span className="adm-mono">{data.sending.returnPath}</span>
            </li>
          ) : null}
          {bounce.length ? (
            <li>
              <span>Sending records</span>
              <span className="adm-sub">
                {bounce.filter((r) => r.present).length} of {bounce.length} present
              </span>
            </li>
          ) : null}
          {own.length ? (
            <li>
              <span>Domain records in Cloudflare</span>
              <span className="adm-sub">
                {own.filter((r) => r.present).length} of {own.length} present
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
      {data?.zone && !data.sendingReady ? (
        <div className="adm-sending__actions">
          <Button variant="filled" icon="sync" disabled={busy || isFetching} onClick={fix}>
            {busy ? (direct ? 'Publishing…' : 'Fixing…') : direct ? 'Publish records' : 'Fix'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
