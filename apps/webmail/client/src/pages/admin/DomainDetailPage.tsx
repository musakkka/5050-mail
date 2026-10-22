import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { LinearProgress } from '../../components/ui/Progress';
import { Icon } from '../../components/icons/Icon';
import { adminErrorMessage } from '../../admin/api';
import {
  RECORD_LABELS,
  certificateManagementOf,
  certificatesFor,
  dkimAlgorithmLabel,
  dkimHealth,
  dnsHealth,
  dnsManagementOf,
  domainToForm,
  parseZoneFile,
  relativeName,
  suggestZoneApex,
  tlsHealth,
  validateDomainForm,
  type DnsRecord,
  type DomainForm,
} from '../../admin/model';
import { useAdmin, useAdminAction, useAutomation, useCloudflareZones, useDomain, useDomainStatus, useDomains } from '../../admin/state';
import { SendingCard } from './CloudflareConnect';
import { dnsApi, type DnsCheckRecord, type DnsCheckResult } from '../../admin/cloudflare';
import type { Domain } from '../../admin/types';
import { AutomationFields, acmeLabel, dnsServerLabel } from './DomainsPage';
import { Banner, Card, Chip, ConfirmDeleteDialog, CopyButton, HealthChip, PageHeader, copyText } from './ui';
import { useUi } from '../../state/ui';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function EditAutomationDialog({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const { api } = useAdmin();
  const { data: options } = useAutomation();
  const { data: domains } = useDomains();
  const [form, setForm] = useState<DomainForm>(() => domainToForm(domain));
  const { run, busy } = useAdminAction();
  const errors = validateDomainForm(form, options?.acmeProviders ?? []);
  const knownZones = [
    ...new Set((domains ?? []).flatMap((d) => (d.dnsManagement['@type'] === 'Automatic' && d.dnsManagement.origin ? [d.dnsManagement.origin] : []))),
  ];
  return (
    <Dialog
      title={`DNS & certificate for ${domain.name}`}
      wide
      onClose={onClose}
      className="adm-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            disabled={busy || Object.keys(errors).length > 0}
            onClick={async () => {
              const ok = await run(
                () => api.updateDomain(domain.id, { dnsManagement: dnsManagementOf(form.dns), certificateManagement: certificateManagementOf(form.tls) }),
                'Domain settings saved',
              );
              if (ok) onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <AutomationFields
        form={form}
        setForm={setForm}
        errors={errors}
        dnsServers={options?.dnsServers ?? []}
        acmeProviders={options?.acmeProviders ?? []}
        knownZones={knownZones}
      />
    </Dialog>
  );
}

const checkKey = (fqdn: string, type: string) => `${fqdn.toLowerCase().replace(/\.$/, '')}|${type}`;

function RecordsTable({
  records,
  origin,
  published,
  checks,
}: {
  records: DnsRecord[];
  origin: string;
  published: Set<string> | null;
  checks?: Map<string, DnsCheckRecord>;
}) {
  return (
    <table className="adm-table adm-records">
      <thead>
        <tr>
          <th className="adm-records__type">Type</th>
          <th className="adm-records__name">Name</th>
          <th>Content</th>
          {published ? <th className="adm-records__auto">Published</th> : null}
          {checks ? <th className="adm-records__auto">In DNS</th> : null}
          <th className="adm-records__copy" aria-label="Copy" />
        </tr>
      </thead>
      <tbody>
        {records.map((r, i) => {
          const name = relativeName(r.fqdn, origin);
          const isPublished = !!(published && r.kind && published.has(r.kind));
          return (
            <tr key={`${r.fqdn}-${r.type}-${i}`}>
              <td className="adm-records__typecell">
                <span className="adm-rtype">{r.type}</span>
              </td>
              <td className="adm-mono adm-records__namecol" title={r.fqdn}>
                <span className="adm-records__namecell">
                  {name}
                  <CopyButton text={name === '@' ? r.fqdn : name} label="Copy name" what="Name" />
                </span>
              </td>
              <td className="adm-mono adm-records__content">
                <div className="adm-records__line">
                  {r.priority !== undefined ? (
                    <span className="adm-records__prio" title="Priority">
                      {r.priority}
                    </span>
                  ) : null}
                  <span className="adm-records__value">{r.content}</span>
                </div>
              </td>
              {published ? (
                <td className="adm-records__auto">
                  {isPublished ? (
                    <span className="adm-auto" title={`Published automatically (${RECORD_LABELS[r.kind!]})`}>
                      <Icon name="sync" size={18} /> Auto
                    </span>
                  ) : (
                    <span
                      className="adm-manual"
                      title={r.kind ? `${RECORD_LABELS[r.kind]} isn't published automatically` : "5050 Mail doesn't publish this record type"}
                    >
                      Manual
                    </span>
                  )}
                </td>
              ) : null}
              {checks ? (
                <td className="adm-records__auto">
                  {(() => {
                    const c = checks.get(checkKey(r.fqdn, r.type));
                    if (!c) return <span className="adm-manual">Not checked</span>;
                    return c.present ? (
                      <span className="adm-auto" data-dns="found" title="Found in public DNS">
                        <Icon name="check_circle" size={18} /> Found
                      </span>
                    ) : (
                      <span className="adm-manual" data-dns="missing" title={c.found.length ? `DNS has: ${c.found.join(' | ')}` : 'Nothing published at this name yet'}>
                        Missing
                      </span>
                    );
                  })()}
                </td>
              ) : null}
              <td className="adm-records__copy">
                <CopyButton text={r.content} label="Copy value" what={`${r.type} value`} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DomainDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { api } = useAdmin();
  const { data: domain, isLoading, error } = useDomain(id);
  const { data: status } = useDomainStatus(id);
  const { data: options } = useAutomation();
  const { data: cfZones } = useCloudflareZones();
  const { run, busy } = useAdminAction();
  const showSnack = useUi((s) => s.showSnack);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [dnsCheck, setDnsCheck] = useState<DnsCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const records = useMemo(() => parseZoneFile(domain?.dnsZoneFile), [domain?.dnsZoneFile]);

  if (isLoading) return <LinearProgress active />;
  if (error || !domain)
    return (
      <div className="adm-page">
        <PageHeader title="Domain" back={() => nav('/admin/domains')} />
        <Banner tone="error">{error ? adminErrorMessage(error) : 'This domain no longer exists.'}</Banner>
      </div>
    );

  const auto = domain.dnsManagement['@type'] === 'Automatic' ? domain.dnsManagement : null;
  const origin = auto?.origin ?? suggestZoneApex(domain.name);
  const published = auto ? new Set(Object.entries(auto.publishRecords).flatMap(([k, v]) => (v ? [k] : []))) : null;
  const server = auto ? options?.dnsServers.find((s) => s.id === auto.dnsServerId) : undefined;
  const acme =
    domain.certificateManagement['@type'] === 'Automatic'
      ? options?.acmeProviders.find((p) => p.id === (domain.certificateManagement as { acmeProviderId: string }).acmeProviderId)
      : undefined;
  const tasks = status?.tasks ?? [];
  const signatures = (status?.signatures ?? []).filter((s) => s.domainId === domain.id).sort((a, b) => a.selector.localeCompare(b.selector));
  const certs = certificatesFor(domain, status?.certificates ?? []);
  const dkim = dkimHealth(domain, signatures, tasks);
  const tlsH = tlsHealth(domain, status?.certificates ?? [], tasks);
  const dnsH = dnsHealth(domain, tasks, options?.dnsServers);
  // The essentials first; discovery/autoconfig records on demand.
  const essential = records.filter((r) => r.kind && ['dkim', 'mx', 'spf', 'dmarc', 'tlsRpt', 'mtaSts', 'caa', 'tlsa'].includes(r.kind));
  const shown = showAll ? records : essential;
  const checks = dnsCheck ? new Map(dnsCheck.records.map((c) => [checkKey(c.name, c.type), c])) : undefined;
  const verifyDns = async () => {
    setChecking(true);
    try {
      const r = await dnsApi.check(domain.name);
      setDnsCheck(r);
      const missing = r.records.filter((x) => !x.present).length;
      showSnack({ text: r.ok ? `All ${r.records.length} records found in DNS` : `${missing} of ${r.records.length} records not found yet. DNS changes can take a few minutes.`, duration: 6000 });
    } catch (e) {
      showSnack({ text: (e as Error).message, duration: 0 });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="adm-page">
      <PageHeader
        back={() => nav('/admin/domains')}
        title={domain.name}
        subtitle={
          <>
            {domain.isEnabled ? (
              <Chip tone="ok" icon="check_circle">
                Active
              </Chip>
            ) : (
              <Chip tone="warning" icon="block">
                Disabled
              </Chip>
            )}{' '}
            Added {fmtDate(domain.createdAt)}
            {domain.description ? ` · ${domain.description}` : ''}
          </>
        }
        actions={
          <>
            <Button
              variant="outlined"
              icon={domain.isEnabled ? 'block' : 'check_circle'}
              disabled={busy}
              onClick={() =>
                run(
                  () => api.updateDomain(domain.id, { isEnabled: !domain.isEnabled }),
                  domain.isEnabled ? `${domain.name} disabled` : `${domain.name} enabled`,
                )
              }
            >
              {domain.isEnabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="outlined" icon="delete" className="btn--danger-outline" onClick={() => setRemoving(true)}>
              Remove domain
            </Button>
          </>
        }
      />

      <div className="adm-grid3">
        <Card title="DKIM" icon="key">
          <HealthChip health={dkim} />
          {dkim.detail ? <p className="adm-detail">{dkim.detail}</p> : null}
          {signatures.length ? (
            <ul className="adm-kv">
              {signatures.map((s) => (
                <li key={s.id}>
                  <span className="adm-mono">{s.selector}</span>
                  <span className="adm-sub">
                    {dkimAlgorithmLabel(s['@type'])} · {s.stage}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card title="TLS certificate" icon="verified_user">
          <HealthChip health={tlsH} />
          {tlsH.detail ? <p className="adm-detail">{tlsH.detail}</p> : null}
          <ul className="adm-kv">
            <li>
              <span>Management</span>
              <span className="adm-sub">{acme ? `Automatic · ${acmeLabel(acme)}` : domain.certificateManagement['@type']}</span>
            </li>
            {certs.slice(0, 2).map((c) => (
              <li key={c.id}>
                <span className="adm-mono">{Object.keys(c.subjectAlternativeNames).join(', ')}</span>
                <span className="adm-sub">until {fmtDate(c.notValidAfter)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card
          title="DNS"
          icon="dns"
          actions={
            <Button variant="text" dense icon="edit" onClick={() => setEditing(true)}>
              Edit
            </Button>
          }
        >
          <HealthChip health={dnsH} />
          {dnsH.detail ? <p className="adm-detail">{dnsH.detail}</p> : null}
          {auto ? (
            <ul className="adm-kv">
              <li>
                <span>Zone</span>
                <span className="adm-mono">{auto.origin ?? '—'}</span>
              </li>
              <li>
                <span>Publishes</span>
                <span className="adm-sub">
                  {Object.entries(auto.publishRecords)
                    .filter(([, v]) => v)
                    .map(([k]) => RECORD_LABELS[k as keyof typeof RECORD_LABELS] ?? k)
                    .join(', ')}
                </span>
              </li>
            </ul>
          ) : null}
        </Card>
      </div>

      {cfZones ? <SendingCard domain={domain} /> : null}

      <Card
        title="DNS records"
        icon="dns"
        className="adm-card--table"
        actions={
          domain.dnsZoneFile ? (
            <>
              <Button variant="text" dense icon="verified_user" disabled={checking} onClick={verifyDns}>
                {checking ? 'Checking…' : 'Check DNS'}
              </Button>
              <Button
                variant="text"
                dense
                icon="content_copy"
                onClick={async () => {
                  await copyText(domain.dnsZoneFile!);
                  showSnack({ text: 'Zone file copied to clipboard', duration: 4000 });
                }}
              >
                Copy zone file
              </Button>
            </>
          ) : null
        }
      >
        <div className="adm-card__pad">
          {auto ? (
            <Banner>
              Records marked <strong>Auto</strong> are published to the <strong>{auto.origin}</strong> zone{server ? ` through ${dnsServerLabel(server)}` : ''}.
              Domains outside the Cloudflare account can't be published automatically: add these records by hand at that domain's DNS provider, then use{' '}
              <strong>Check DNS</strong>.
            </Banner>
          ) : (
            <Banner tone="warning">
              DNS for this domain is managed by hand. Add these records at the domain's DNS provider, then use <strong>Check DNS</strong> to confirm they are
              live; mail won't be delivered to or accepted from this domain reliably until they're in place.
            </Banner>
          )}
        </div>
        {records.length ? (
          <>
            <RecordsTable records={shown} origin={origin} published={published} checks={checks} />
            {records.length > essential.length ? (
              <div className="adm-card__pad adm-card__foot">
                <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show only the essential records' : `Show all ${records.length} records (including client discovery)`}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="adm-card__pad adm-muted">The server hasn't produced records for this domain yet. They appear once its DKIM keys are generated.</p>
        )}
      </Card>

      {editing ? <EditAutomationDialog domain={domain} onClose={() => setEditing(false)} /> : null}
      {removing ? (
        <ConfirmDeleteDialog
          title={`Remove ${domain.name}?`}
          actionLabel="Remove domain"
          confirmText={domain.name}
          body={
            <>
              The domain and its DKIM keys are removed from this server. Users, groups and lists on the domain must be deleted first. DNS records already
              published are left in place.
            </>
          }
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            const ok = await run(() => api.removeDomain(domain.id), `${domain.name} removed`);
            if (ok) nav('/admin/domains');
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}
