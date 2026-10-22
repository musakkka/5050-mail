import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { LinearProgress } from '../../components/ui/Progress';
import { adminErrorMessage } from '../../admin/api';
import {
  DEFAULT_PUBLISH,
  RECORD_LABELS,
  acmeNeedsAutoDns,
  defaultDomainForm,
  isZoneOf,
  normalizeDomain,
  pickDnsServer,
  suggestZoneApex,
  validateDomainForm,
  validateDomainName,
  type DomainForm,
} from '../../admin/model';
import { ONE_CLICK_RECORDS, cloudflareApi, zoneFor, type ConnectResult } from '../../admin/cloudflare';
import { useAdmin, useAutomation, useCloudflareZones, useDomains, useRefreshAdmin } from '../../admin/state';
import { ConnectProgress } from './CloudflareConnect';
import { useUi } from '../../state/ui';
import { DNS_RECORD_TYPES, type AcmeProvider, type DnsRecordType, type DnsServer, type Domain } from '../../admin/types';
import { Banner, Card, Chip, EmptyState, PageHeader, SelectField, TextField } from './ui';

export function acmeLabel(p: AcmeProvider): string {
  let host = p.directory;
  try {
    host = new URL(p.directory).host;
  } catch {
    /* keep raw */
  }
  if (/letsencrypt\.org$/.test(host)) return host.includes('staging') ? "Let's Encrypt (staging)" : "Let's Encrypt";
  if (/zerossl\.com$/.test(host)) return 'ZeroSSL';
  if (/pki\.goog$/.test(host)) return 'Google Trust Services';
  return host;
}

export const dnsServerLabel = (s: DnsServer) => s.description || s['@type'];

const MAIN_RECORDS: DnsRecordType[] = ['dkim', 'mx', 'tlsRpt', 'spf', 'dmarc'];
const RECORD_HELP: Partial<Record<DnsRecordType, string>> = {
  spf: "Leave off if the zone already has an SPF record. Stalwart's default only authorises this server's MX, not the outbound relay.",
  dmarc: 'Leave off if the zone already publishes a DMARC policy.',
  srv: 'Client auto-discovery records. Off by default.',
};

/** DNS / TLS / DKIM choices, shared by "Add domain" and "Edit automation". */
export function AutomationFields({
  form,
  setForm,
  errors,
  dnsServers,
  acmeProviders,
  knownZones,
}: {
  form: DomainForm;
  setForm: (f: DomainForm) => void;
  errors: Record<string, string>;
  dnsServers: DnsServer[];
  acmeProviders: AcmeProvider[];
  knownZones: string[];
}) {
  const [more, setMore] = useState(() => form.dns.mode === 'automatic' && form.dns.records.some((r) => !MAIN_RECORDS.includes(r)));
  const dns = form.dns;
  const tls = form.tls;
  const acme = tls.mode === 'automatic' ? acmeProviders.find((p) => p.id === tls.acmeProviderId) : acmeProviders[0];
  const setRecords = (r: DnsRecordType, on: boolean) => {
    if (dns.mode !== 'automatic') return;
    const records = on ? [...new Set([...dns.records, r])] : dns.records.filter((x) => x !== r);
    setForm({ ...form, dns: { ...dns, records: DNS_RECORD_TYPES.filter((t) => records.includes(t)) } });
  };
  const server = dns.mode === 'automatic' ? dnsServers.find((s) => s.id === dns.dnsServerId) : undefined;
  const isCloudflare = server?.['@type'] === 'Cloudflare';
  const tlsBlocked = dns.mode !== 'automatic' && acmeNeedsAutoDns(acme);

  return (
    <>
      <fieldset className="adm-fieldset">
        <legend>DNS records</legend>
        {dnsServers.length ? (
          <>
            <label className="adm-radio">
              <input
                type="radio"
                name="dns-mode"
                checked={dns.mode === 'automatic'}
                onChange={() =>
                  setForm({
                    ...form,
                    dns: { mode: 'automatic', dnsServerId: pickDnsServer(dnsServers)!.id, origin: suggestZoneApex(form.name), records: [...DEFAULT_PUBLISH] },
                  })
                }
              />
              <span>
                Publish automatically
                <span className="adm-radio__help">5050 Mail creates and updates the records through your DNS provider.</span>
              </span>
            </label>
            {dns.mode === 'automatic' ? (
              <div className="adm-indent">
                {dnsServers.length > 1 ? (
                  <SelectField
                    label="DNS provider"
                    value={dns.dnsServerId}
                    error={errors.dnsServerId}
                    onChange={(e) => setForm({ ...form, dns: { ...dns, dnsServerId: e.target.value } })}
                  >
                    {dnsServers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {dnsServerLabel(s)}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <p className="adm-muted adm-provider">
                    Provider: <strong>{server ? dnsServerLabel(server) : '—'}</strong>
                  </p>
                )}
                <TextField
                  label={isCloudflare ? 'Cloudflare zone' : 'DNS zone'}
                  value={dns.origin}
                  list="adm-known-zones"
                  spellCheck={false}
                  autoComplete="off"
                  error={errors.origin}
                  placeholder={form.name ? suggestZoneApex(form.name) : 'example.com'}
                  help={
                    <>
                      The zone that contains this domain, for example <code>example.com</code> for <code>mail.example.com</code>.
                      {isCloudflare ? ' It must be a zone in the Cloudflare account; for any other domain choose manual DNS.' : ''}
                    </>
                  }
                  onChange={(e) => setForm({ ...form, dns: { ...dns, origin: e.target.value } })}
                />
                <datalist id="adm-known-zones">
                  {knownZones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                <div className="adm-checks" role="group" aria-label="Records to publish">
                  {(more ? DNS_RECORD_TYPES : MAIN_RECORDS).map((r) => (
                    <label key={r} className="adm-check">
                      <input type="checkbox" checked={dns.records.includes(r)} onChange={(e) => setRecords(r, e.target.checked)} />
                      <span>
                        {RECORD_LABELS[r]}
                        {RECORD_HELP[r] ? <span className="adm-check__help">{RECORD_HELP[r]}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
                {errors.records ? <div className="adm-field__error">{errors.records}</div> : null}
                <button type="button" className="link-btn adm-more" onClick={() => setMore(!more)}>
                  {more ? 'Fewer record types' : 'More record types'}
                </button>
              </div>
            ) : null}
            <label className="adm-radio">
              <input
                type="radio"
                name="dns-mode"
                checked={dns.mode === 'manual'}
                onChange={() =>
                  // DNS-01 certificates can't be validated without automatic DNS.
                  setForm({ ...form, dns: { mode: 'manual' }, tls: tls.mode === 'automatic' && acmeNeedsAutoDns(acme) ? { mode: 'manual' } : tls })
                }
              />
              <span>
                I'll add the records myself
                <span className="adm-radio__help">For domains outside the DNS provider's account. You'll get the exact records to add.</span>
              </span>
            </label>
          </>
        ) : (
          <Banner>
            No DNS provider is configured on this server, so DNS records are added by hand. The exact records are shown once the domain is created.
          </Banner>
        )}
      </fieldset>

      <fieldset className="adm-fieldset">
        <legend>TLS certificate</legend>
        {acmeProviders.length ? (
          <>
            <label className={`adm-radio${tlsBlocked ? ' adm-radio--disabled' : ''}`}>
              <input
                type="radio"
                name="tls-mode"
                checked={tls.mode === 'automatic'}
                disabled={tlsBlocked}
                onChange={() => setForm({ ...form, tls: { mode: 'automatic', acmeProviderId: acme?.id ?? acmeProviders[0]!.id } })}
              />
              <span>
                Automatic{acme ? ` from ${acmeLabel(acme)}` : ''}
                <span className="adm-radio__help">
                  {tlsBlocked ? 'Needs automatic DNS: the certificate is validated with a DNS record.' : 'Requested and renewed by the server.'}
                </span>
              </span>
            </label>
            {tls.mode === 'automatic' && acmeProviders.length > 1 ? (
              <div className="adm-indent">
                <SelectField
                  label="Certificate provider"
                  value={tls.acmeProviderId}
                  onChange={(e) => setForm({ ...form, tls: { mode: 'automatic', acmeProviderId: e.target.value } })}
                >
                  {acmeProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {acmeLabel(p)}
                    </option>
                  ))}
                </SelectField>
              </div>
            ) : null}
            <label className="adm-radio">
              <input type="radio" name="tls-mode" checked={tls.mode === 'manual'} onChange={() => setForm({ ...form, tls: { mode: 'manual' } })} />
              <span>
                Manual
                <span className="adm-radio__help">Use a certificate managed outside 5050 Mail.</span>
              </span>
            </label>
            {errors.tls ? (
              <Banner tone="warning">{errors.tls}</Banner>
            ) : tls.mode === 'automatic' && acmeNeedsAutoDns(acme) ? (
              <p className="adm-footnote">Validated through DNS (DNS-01), using the provider above.</p>
            ) : null}
          </>
        ) : (
          <Banner>No certificate provider (ACME) is configured on this server, so the certificate is managed manually.</Banner>
        )}
      </fieldset>

      <fieldset className="adm-fieldset">
        <legend>DKIM signing</legend>
        <p className="adm-muted adm-dkim-note">Ed25519 and RSA keys are created, published and rotated automatically.</p>
      </fieldset>
    </>
  );
}

type SetupMode = 'cloudflare' | 'manual';

/**
 * "Add a domain". With Cloudflare configured on the BFF the default is one click:
 * create the Stalwart domain with automatic DNS/DKIM/TLS on the zone, then onboard
 * it for Cloudflare Email Sending, with a live checklist. Domains outside the
 * Cloudflare account use the manual form (zone file with copy buttons).
 */
function AddDomainDialog({ onClose, domains }: { onClose: () => void; domains: Domain[] }) {
  const { api } = useAdmin();
  const nav = useNavigate();
  const { data: options } = useAutomation();
  const { data: zones, isLoading: zonesLoading } = useCloudflareZones();
  const dnsServers = options?.dnsServers ?? [];
  const acmeProviders = options?.acmeProviders ?? [];
  const cfServer = dnsServers.find((s) => s['@type'] === 'Cloudflare') ?? pickDnsServer(dnsServers);
  const cloudflareAvailable = !!zones && !!cfServer;
  const [mode, setMode] = useState<SetupMode | null>(null);
  const effectiveMode: SetupMode = mode ?? (cloudflareAvailable ? 'cloudflare' : 'manual');
  const [form, setFormState] = useState<DomainForm>(() => defaultDomainForm('', { dnsServers, acmeProviders }));
  const [originTouched, setOriginTouched] = useState(false);
  const [cfZone, setCfZone] = useState('');
  const [cfZoneTouched, setCfZoneTouched] = useState(false);
  // The zone list can arrive after the name was typed; fill the zone in then too.
  useEffect(() => {
    if (!cfZoneTouched && zones) setCfZone((z) => z || (zoneFor(form.name, zones) ?? ''));
  }, [zones]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One-click progress.
  const [running, setRunning] = useState<{ name: string; id: string | null; createError?: string; connect?: ConnectResult } | null>(null);
  const refresh = useRefreshAdmin();
  const showSnack = useUi((s) => s.showSnack);
  const knownZones = useMemo(
    () => [...new Set(domains.flatMap((d) => (d.dnsManagement['@type'] === 'Automatic' && d.dnsManagement.origin ? [d.dnsManagement.origin] : [])))],
    [domains],
  );
  // Options may arrive after the first render.
  const [initialized, setInitialized] = useState(!!options);
  if (!initialized && options) {
    setInitialized(true);
    setFormState(defaultDomainForm(form.name, { dnsServers, acmeProviders }));
  }
  const errors = validateDomainForm(form, acmeProviders);
  const visibleErrors = showErrors ? errors : {};

  const nameError = validateDomainName(form.name);
  const zoneName = normalizeDomain(cfZone);
  const cfErrors: Record<string, string> = {};
  if (nameError) cfErrors.name = nameError;
  if (!zoneName) cfErrors.zone = 'Choose the Cloudflare zone';
  else if (!zones?.includes(zoneName)) cfErrors.zone = `${zoneName} isn't a zone in the Cloudflare account`;
  else if (!nameError && !isZoneOf(form.name, zoneName)) cfErrors.zone = `The zone must be ${normalizeDomain(form.name)} or one of its parent domains`;
  const cfVisible = showErrors ? cfErrors : {};

  const setName = (name: string) => {
    const next = { ...form, name };
    if (next.dns.mode === 'automatic' && !originTouched) {
      const known = knownZones.find((z) => isZoneOf(name, z));
      next.dns = { ...next.dns, origin: known ?? suggestZoneApex(name) };
    }
    setFormState(next);
    // Subdomains (mail.example.com) live in the containing zone (example.com).
    if (!cfZoneTouched) setCfZone(zoneFor(name, zones ?? []) ?? '');
  };
  const setForm = (f: DomainForm) => {
    if (f.dns.mode === 'automatic' && form.dns.mode === 'automatic' && f.dns.origin !== form.dns.origin) setOriginTouched(true);
    setFormState(f);
  };

  const submitManual = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.createDomain(form);
      await refresh();
      showSnack({ text: `${form.name.trim().toLowerCase()} added` });
      onClose();
      nav(`/admin/domains/${id}`);
    } catch (e) {
      setError(adminErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (name: string, id: string) => {
    setBusy(true);
    const result = await cloudflareApi.connect(name);
    setRunning({ name, id, connect: result });
    setBusy(false);
  };

  const submitOneClick = async () => {
    setShowErrors(true);
    if (Object.keys(cfErrors).length || !cfServer || !zoneName) return;
    const name = normalizeDomain(form.name);
    const acme = acmeProviders[0];
    const oneClick: DomainForm = {
      name,
      description: form.description,
      dns: { mode: 'automatic', dnsServerId: cfServer.id, origin: zoneName, records: [...ONE_CLICK_RECORDS] },
      tls: acme ? { mode: 'automatic', acmeProviderId: acme.id } : { mode: 'manual' },
    };
    setBusy(true);
    setError(null);
    setRunning({ name, id: null });
    let id: string;
    try {
      id = await api.createDomain(oneClick);
    } catch (e) {
      setRunning(null);
      setError(adminErrorMessage(e));
      setBusy(false);
      return;
    }
    setRunning({ name, id });
    void refresh();
    await connect(name, id);
  };

  if (running) {
    return (
      <Dialog
        title={`Setting up ${running.name}`}
        wide
        onClose={onClose}
        className="adm-dialog"
        actions={
          <>
            <Button variant="text" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="filled"
              disabled={!running.id}
              onClick={() => {
                onClose();
                nav(`/admin/domains/${running.id}`);
              }}
            >
              Open domain
            </Button>
          </>
        }
      >
        <ConnectProgress
          domainName={running.name}
          domainId={running.id}
          createError={running.createError}
          connect={running.connect}
          retrying={busy}
          onRetry={() => running.id && void connect(running.name, running.id)}
        />
      </Dialog>
    );
  }

  const cloudflare = effectiveMode === 'cloudflare';
  return (
    <Dialog
      title="Add a domain"
      wide
      onClose={onClose}
      className="adm-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          {cloudflare ? (
            <Button variant="filled" disabled={busy || !options} onClick={submitOneClick}>
              Add &amp; connect
            </Button>
          ) : (
            <Button variant="filled" disabled={busy || !options} onClick={submitManual}>
              Add domain
            </Button>
          )}
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (cloudflare ? submitOneClick() : submitManual());
        }}
      >
        {cloudflareAvailable ? (
          <div className="adm-setup-modes" role="radiogroup" aria-label="How is this domain's DNS hosted?">
            <label className={`adm-radio adm-setup-mode${cloudflare ? ' adm-setup-mode--on' : ''}`}>
              <input type="radio" name="setup-mode" checked={cloudflare} onChange={() => setMode('cloudflare')} />
              <span>
                Domain on Cloudflare
                <span className="adm-radio__help">One click: DNS, DKIM, sending and certificate set up for you.</span>
              </span>
            </label>
            <label className={`adm-radio adm-setup-mode${!cloudflare ? ' adm-setup-mode--on' : ''}`}>
              <input type="radio" name="setup-mode" checked={!cloudflare} onChange={() => setMode('manual')} />
              <span>
                Another DNS provider
                <span className="adm-radio__help">You add the records yourself; we show exactly which.</span>
              </span>
            </label>
          </div>
        ) : null}
        <TextField
          label="Domain name"
          value={form.name}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="example.com"
          error={cloudflare ? cfVisible.name : visibleErrors.name}
          onChange={(e) => setName(e.target.value)}
        />
        {cloudflare ? (
          <>
            <TextField
              label="Cloudflare zone"
              value={cfZone}
              list="adm-cf-zones"
              spellCheck={false}
              autoComplete="off"
              placeholder={zones?.[0] ?? 'example.com'}
              error={cfVisible.zone}
              help={
                <>
                  Filled in from the domain. For a subdomain like <code>mail.example.com</code> it's the zone that contains it, <code>example.com</code>.
                </>
              }
              onChange={(e) => {
                setCfZoneTouched(true);
                setCfZone(e.target.value);
              }}
            />
            <datalist id="adm-cf-zones">
              {(zones ?? []).map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <TextField label="Description (optional)" value={form.description} onChange={(e) => setFormState({ ...form, description: e.target.value })} />
            <p className="adm-connect-summary">
              Publishes MX, DKIM, SPF, DMARC and TLS reporting records in the zone, enables Cloudflare Email Sending for the domain, and requests a TLS
              certificate{acmeProviders[0] ? ` from ${acmeLabel(acmeProviders[0])}` : ''}.
            </p>
            {showErrors && cfErrors.zone && form.name && !zoneFor(form.name, zones ?? []) ? (
              <Banner>
                {normalizeDomain(form.name)} isn't in this server's Cloudflare account.{' '}
                <button type="button" className="link-btn" onClick={() => setMode('manual')}>
                  Set it up with another DNS provider
                </button>
              </Banner>
            ) : null}
          </>
        ) : (
          <>
            <TextField label="Description (optional)" value={form.description} onChange={(e) => setFormState({ ...form, description: e.target.value })} />
            {!options || zonesLoading ? <LinearProgress active /> : null}
            {cloudflareAvailable ? (
              <Banner>
                <strong>Connect Cloudflare automatically:</strong> one-click setup only works for domains whose DNS is in this server's Cloudflare account.
                To connect this domain, add it to that account (and switch its nameservers to Cloudflare), then add it again with “Domain on Cloudflare”.
              </Banner>
            ) : null}
            <AutomationFields form={form} setForm={setForm} errors={visibleErrors} dnsServers={dnsServers} acmeProviders={acmeProviders} knownZones={knownZones} />
          </>
        )}
        {error ? <Banner tone="error">{error}</Banner> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function modeChip(d: Domain, what: 'dns' | 'tls') {
  const auto = what === 'dns' ? d.dnsManagement['@type'] === 'Automatic' : d.certificateManagement['@type'] === 'Automatic';
  return (
    <Chip tone={auto ? 'ok' : 'neutral'} icon={auto ? 'sync' : 'edit'}>
      {auto ? 'Automatic' : 'Manual'}
    </Chip>
  );
}

export function DomainsPage() {
  const { data, isLoading, error } = useDomains();
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  return (
    <div className="adm-page">
      <PageHeader
        title="Domains"
        subtitle="Mail domains hosted on this server"
        actions={
          <Button variant="filled" icon="add" onClick={() => setAdding(true)}>
            Add a domain
          </Button>
        }
      />
      <LinearProgress active={isLoading} />
      {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : null}
      {data ? (
        data.length ? (
          <Card className="adm-card--table">
            <table className="adm-table adm-table--click">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>DNS</th>
                  <th>TLS certificate</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => nav(`/admin/domains/${d.id}`)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/domains/${d.id}`)}
                  >
                    <td>
                      <span className="adm-strong">{d.name}</span>
                      {d.description ? <div className="adm-sub">{d.description}</div> : null}
                    </td>
                    <td>
                      {d.isEnabled ? (
                        <Chip tone="ok" icon="check_circle">
                          Active
                        </Chip>
                      ) : (
                        <Chip tone="warning" icon="block">
                          Disabled
                        </Chip>
                      )}
                    </td>
                    <td>{modeChip(d, 'dns')}</td>
                    <td>{modeChip(d, 'tls')}</td>
                    <td className="adm-sub">{new Date(d.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <EmptyState
            icon="domain"
            title="No domains yet"
            action={
              <Button variant="filled" icon="add" onClick={() => setAdding(true)}>
                Add a domain
              </Button>
            }
          >
            Add the first domain to start creating mailboxes.
          </EmptyState>
        )
      ) : null}
      {adding ? <AddDomainDialog domains={data ?? []} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
