import { useNavigate } from 'react-router-dom';
import { Icon, type IconKey } from '../../components/icons/Icon';
import { LinearProgress } from '../../components/ui/Progress';
import { adminErrorMessage } from '../../admin/api';
import { defaultRemoteRoute, describeRoute } from '../../admin/model';
import { useDomainMap, useOverview } from '../../admin/state';
import { Banner, Card, Chip, PageHeader } from './ui';

function Stat({ icon, label, value, to }: { icon: IconKey; label: string; value: number | string; to?: string }) {
  const nav = useNavigate();
  return (
    <button type="button" className="adm-stat" onClick={() => to && nav(to)} disabled={!to}>
      <span className="adm-stat__icon">
        <Icon name={icon} size={24} fill />
      </span>
      <span className="adm-stat__value">{value}</span>
      <span className="adm-stat__label">{label}</span>
    </button>
  );
}

const TASK_LABEL: Record<string, string> = { DnsManagement: 'DNS publishing', DkimManagement: 'DKIM record', AcmeRenewal: 'TLS certificate' };

export function OverviewPage() {
  const { data, isLoading, error } = useOverview();
  const domains = useDomainMap();
  const nav = useNavigate();
  const remote = defaultRemoteRoute(data?.strategy);
  return (
    <div className="adm-page">
      <PageHeader title="Overview" subtitle="Domains, users and outbound mail on this server" />
      <LinearProgress active={isLoading} />
      {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : null}
      {data ? (
        <>
          <div className="adm-stats">
            <Stat icon="domain" label={data.domains === 1 ? 'Domain' : 'Domains'} value={data.domains} to="/admin/domains" />
            <Stat icon="person" label={data.users === 1 ? 'User' : 'Users'} value={data.users} to="/admin/users" />
            <Stat icon="groups" label={data.groups === 1 ? 'Group' : 'Groups'} value={data.groups} to="/admin/groups" />
            <Stat icon="forward_to_inbox" label={data.lists === 1 ? 'Mailing list' : 'Mailing lists'} value={data.lists} to="/admin/groups?tab=lists" />
          </div>

          {data.problems.length ? (
            <Card title="Needs attention" icon="warning">
              <ul className="adm-problems">
                {data.problems.map((t) => {
                  const d = domains.get(t.domainId);
                  return (
                    <li key={t.id}>
                      <button type="button" className="adm-problems__item" onClick={() => nav(`/admin/domains/${t.domainId}`)}>
                        <Icon name="error" size={20} fill className="adm-problems__icon" />
                        <span>
                          <strong>{d?.name ?? 'Unknown domain'}</strong> · {TASK_LABEL[t['@type']] ?? t['@type']}{' '}
                          {t.status['@type'] === 'Failed' ? 'failed' : 'is retrying'}
                          {'failureReason' in t.status && t.status.failureReason ? <span className="adm-problems__why">{t.status.failureReason}</span> : null}
                        </span>
                        <Icon name="chevron_right" size={20} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          <Card
            title="Outbound mail"
            icon="outbox"
            actions={
              <Chip tone={data.queued ? 'warning' : 'neutral'} icon="schedule_send">
                {data.queued === null ? 'Queue unavailable' : `${data.queued} queued`}
              </Chip>
            }
          >
            <p className="adm-muted">
              {remote ? (
                <>
                  Mail to other domains leaves through the <strong>{remote}</strong> route. Local recipients are delivered directly.
                </>
              ) : (
                'Routes this server can deliver through.'
              )}
            </p>
            <table className="adm-table adm-table--compact">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Type</th>
                  <th>Destination</th>
                </tr>
              </thead>
              <tbody>
                {data.routes.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="adm-strong">{r.name}</span>
                      {r.name === remote ? (
                        <Chip tone="primary" icon="check">
                          Default for remote mail
                        </Chip>
                      ) : null}
                      {r.description ? <div className="adm-sub">{r.description}</div> : null}
                    </td>
                    <td>{r['@type'] === 'Mx' ? 'Direct (MX)' : r['@type']}</td>
                    <td>{describeRoute(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="adm-footnote">Read-only. Routes and the relay are configured in the server plan (server/plan/relay.ndjson).</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
