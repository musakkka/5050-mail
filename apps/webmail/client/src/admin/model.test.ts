import { describe, expect, it } from 'vitest';
import {
  aliasList,
  aliasMap,
  buildDomainCreate,
  certificatesFor,
  defaultDomainForm,
  defaultRemoteRoute,
  describeLinked,
  describeRoute,
  describeSetError,
  dkimHealth,
  dnsHealth,
  domainToForm,
  generatePassword,
  isSuspended,
  isZoneOf,
  matchesSearch,
  parseLocalAddress,
  parseZoneFile,
  quotaBytes,
  quotaGb,
  relativeName,
  suggestZoneApex,
  tlsHealth,
  validateDomainForm,
  validateDomainName,
  validateLocalPart,
  withSuspension,
} from './model';
import type { Account, Certificate, DkimSignature, Domain, DomainTask } from './types';

const ZONE = `v1-ed25519-20261021._domainkey.dev.test. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=SHL7y077MFeD7SPJvqEorCfkcS3Jg+pDPv48o4yELvs="
v1-rsa-20261021._domainkey.dev.test. IN TXT (
    "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkq"
    "omGxPjfx6IQWIMyOdGOF4A1"
)
dev.test. IN TXT "v=spf1 mx -all"
dev.test. IN MX 10 mx1.dev.test.
_dmarc.dev.test. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@dev.test"
_imaps._tcp.dev.test. IN SRV 0 1 993 mx1.dev.test.
mta-sts.dev.test. IN CNAME mx1.dev.test.
_smtp._tls.dev.test. IN TXT "v=TLSRPTv1; rua=mailto:postmaster@dev.test"
dev.test. IN CAA 0 issue "letsencrypt.org;accounturi=https://acme/acct/1"
autoconfig.dev.test. IN CNAME mx1.dev.test.
autodiscover.dev.test. IN CNAME mx1.dev.test.
`;

const domain = (over: Partial<Domain> = {}): Domain => ({
  id: 'b',
  name: 'example.com',
  description: null,
  isEnabled: true,
  createdAt: '2026-10-01T00:00:00Z',
  aliases: {},
  catchAllAddress: null,
  reportAddressUri: 'mailto:postmaster',
  certificateManagement: { '@type': 'Automatic', acmeProviderId: 'acme1' },
  dkimManagement: { '@type': 'Automatic' },
  dnsManagement: { '@type': 'Automatic', dnsServerId: 'cf', origin: 'example.com', publishRecords: { dkim: true } },
  ...over,
});

describe('domain names and zones', () => {
  it('validates domain names', () => {
    expect(validateDomainName('Example.COM.')).toBeNull();
    expect(validateDomainName('mail.example.com')).toBeNull();
    expect(validateDomainName('')).toMatch(/Enter a domain/);
    expect(validateDomainName('bob@example.com')).toMatch(/without a mailbox/);
    expect(validateDomainName('nodot')).toMatch(/valid domain/);
    expect(validateDomainName('-bad.com')).toMatch(/valid domain/);
  });

  it('guesses the zone apex, including two-label public suffixes', () => {
    expect(suggestZoneApex('mail.example.com')).toBe('example.com');
    expect(suggestZoneApex('example.com')).toBe('example.com');
    expect(suggestZoneApex('a.b.example.co.uk')).toBe('example.co.uk');
    expect(suggestZoneApex('shop.example.com.ng')).toBe('example.com.ng');
  });

  it('checks that the origin is the domain or a parent', () => {
    expect(isZoneOf('mail.example.com', 'example.com')).toBe(true);
    expect(isZoneOf('example.com', 'example.com.')).toBe(true);
    expect(isZoneOf('example.com', 'mail.example.com')).toBe(false);
    expect(isZoneOf('notexample.com', 'example.com')).toBe(false);
  });
});

describe('domain form', () => {
  const cf = { id: 'cf', '@type': 'Cloudflare', description: 'Cloudflare' };
  const tsig = { id: 'ts', '@type': 'Tsig', description: 'Other' };
  const acme = { id: 'acme1', directory: 'https://acme', challengeType: 'Dns01', contact: {} };

  it('defaults to automatic DNS on the Cloudflare server and automatic TLS', () => {
    const f = defaultDomainForm('mail.example.com', { dnsServers: [tsig, cf], acmeProviders: [acme] });
    expect(f.dns).toEqual({ mode: 'automatic', dnsServerId: 'cf', origin: 'example.com', records: ['dkim', 'mx', 'tlsRpt'] });
    expect(f.tls).toEqual({ mode: 'automatic', acmeProviderId: 'acme1' });
  });

  it('falls back to manual DNS and TLS when nothing is configured', () => {
    const f = defaultDomainForm('example.com', { dnsServers: [], acmeProviders: [acme] });
    expect(f.dns).toEqual({ mode: 'manual' });
    // DNS-01 needs automatic DNS, so TLS can't be automatic either.
    expect(f.tls).toEqual({ mode: 'manual' });
    expect(defaultDomainForm('example.com', { dnsServers: [], acmeProviders: [{ ...acme, challengeType: 'TlsAlpn01' }] }).tls.mode).toBe('automatic');
  });

  it('builds the exact x:Domain create object', () => {
    const f = defaultDomainForm('Mail.Example.com', { dnsServers: [cf], acmeProviders: [acme] });
    f.dns = { ...(f.dns as Extract<typeof f.dns, { mode: 'automatic' }>), records: ['dkim', 'mx', 'tlsRpt', 'spf'] };
    expect(buildDomainCreate(f)).toEqual({
      name: 'mail.example.com',
      description: null,
      isEnabled: true,
      dkimManagement: { '@type': 'Automatic', algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true } },
      certificateManagement: { '@type': 'Automatic', acmeProviderId: 'acme1', subjectAlternativeNames: {} },
      dnsManagement: { '@type': 'Automatic', dnsServerId: 'cf', origin: 'example.com', publishRecords: { dkim: true, mx: true, tlsRpt: true, spf: true } },
    });
    expect(buildDomainCreate({ name: 'x.org', description: ' Test ', dns: { mode: 'manual' }, tls: { mode: 'manual' } })).toMatchObject({
      description: 'Test',
      certificateManagement: { '@type': 'Manual' },
      dnsManagement: { '@type': 'Manual' },
    });
  });

  it('validates the form', () => {
    const ok = defaultDomainForm('mail.example.com', { dnsServers: [cf], acmeProviders: [acme] });
    expect(validateDomainForm(ok, [acme])).toEqual({});
    expect(validateDomainForm({ ...ok, dns: { mode: 'automatic', dnsServerId: 'cf', origin: 'other.com', records: [] } }, [acme])).toEqual({
      origin: 'The zone must be mail.example.com or one of its parent domains',
      records: 'Publish at least one record type',
    });
    expect(validateDomainForm({ ...ok, dns: { mode: 'manual' } }, [acme]).tls).toMatch(/need automatic DNS/);
  });

  it('reads a domain back into form choices', () => {
    const f = domainToForm(domain({ dnsManagement: { '@type': 'Automatic', dnsServerId: 'cf', origin: null, publishRecords: { dkim: true, srv: false } } }));
    expect(f.dns).toEqual({ mode: 'automatic', dnsServerId: 'cf', origin: 'example.com', records: ['dkim'] });
    expect(f.tls).toEqual({ mode: 'automatic', acmeProviderId: 'acme1' });
  });
});

describe('zone file', () => {
  const recs = parseZoneFile(ZONE);

  it('parses every record, joining multi-line TXT', () => {
    expect(recs).toHaveLength(11);
    const rsa = recs[1]!;
    expect(rsa.fqdn).toBe('v1-rsa-20261021._domainkey.dev.test');
    expect(rsa.type).toBe('TXT');
    expect(rsa.content).toBe('v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqomGxPjfx6IQWIMyOdGOF4A1');
    expect(rsa.kind).toBe('dkim');
  });

  it('splits MX priority and classifies records', () => {
    const mx = recs.find((r) => r.type === 'MX')!;
    expect(mx).toMatchObject({ fqdn: 'dev.test', priority: 10, content: 'mx1.dev.test.', kind: 'mx' });
    expect(recs.map((r) => r.kind)).toEqual(['dkim', 'dkim', 'spf', 'mx', 'dmarc', 'srv', 'mtaSts', 'tlsRpt', 'caa', 'autoConfigLegacy', 'autoDiscover']);
  });

  it('keeps quoted semicolons and parentheses inside TXT values', () => {
    const [r] = parseZoneFile('a.example. IN TXT "x=(1); y=2" ; trailing comment\n');
    expect(r!.content).toBe('x=(1); y=2');
  });

  it('handles empty input', () => {
    expect(parseZoneFile(undefined)).toEqual([]);
    expect(parseZoneFile('')).toEqual([]);
  });

  it('shows names relative to the zone', () => {
    expect(relativeName('dev.test', 'dev.test')).toBe('@');
    expect(relativeName('_dmarc.mail.example.com', 'example.com')).toBe('_dmarc.mail');
    expect(relativeName('other.org', 'example.com')).toBe('other.org');
  });
});

describe('suspension', () => {
  it('suspends by disabling the authenticate permission and restores Inherit', () => {
    const s = withSuspension({ '@type': 'Inherit' }, true);
    expect(s).toEqual({ '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } });
    expect(isSuspended(s)).toBe(true);
    expect(withSuspension(s, false)).toEqual({ '@type': 'Inherit' });
    expect(isSuspended({ '@type': 'Inherit' })).toBe(false);
  });

  it('keeps other custom permissions', () => {
    const p = { '@type': 'Merge' as const, enabledPermissions: { foo: true }, disabledPermissions: { bar: true } };
    const s = withSuspension(p, true);
    expect(s).toEqual({ '@type': 'Merge', enabledPermissions: { foo: true }, disabledPermissions: { bar: true, authenticate: true } });
    expect(withSuspension(s, false)).toEqual(p);
  });

  it('handles Replace permission sets', () => {
    const p = { '@type': 'Replace' as const, enabledPermissions: { authenticate: true, foo: true }, disabledPermissions: {} };
    const s = withSuspension(p, true);
    expect(s).toEqual({ '@type': 'Replace', enabledPermissions: { foo: true }, disabledPermissions: { authenticate: true } });
    expect(withSuspension(s, false)).toEqual(p);
  });
});

describe('accounts', () => {
  const domains = new Map([
    ['b', domain({ id: 'b', name: 'dev.test' })],
    ['c', domain({ id: 'c', name: 'example.test' })],
  ]);
  const acct = {
    name: 'dave',
    emailAddress: 'dave@example.test',
    description: 'Dave Grohl',
    aliases: { '1': { name: 'drums', domainId: 'b' }, '0': { name: 'd', domainId: 'c' } },
  } as unknown as Account;

  it('orders aliases and re-indexes them for writing', () => {
    expect(aliasList(acct).map((a) => a.name)).toEqual(['d', 'drums']);
    expect(aliasMap(aliasList(acct).slice(1))).toEqual({ '0': { name: 'drums', domainId: 'b', enabled: true, description: null } });
  });

  it('searches by substring across name, address, display name and aliases', () => {
    expect(matchesSearch(acct, 'grohl')).toBe(true);
    expect(matchesSearch(acct, 'DAV')).toBe(true);
    expect(matchesSearch(acct, 'drums@dev', domains)).toBe(true);
    expect(matchesSearch(acct, 'zzz')).toBe(false);
    expect(matchesSearch(acct, '  ')).toBe(true);
  });

  it('parses local addresses against hosted domains', () => {
    expect(parseLocalAddress('Sales@Example.test', [...domains.values()])).toEqual({ name: 'sales', domainId: 'c' });
    expect(parseLocalAddress('x@elsewhere.com', [...domains.values()])).toBeNull();
    expect(validateLocalPart('first.last')).toBeNull();
    expect(validateLocalPart('a b')).not.toBeNull();
    expect(validateLocalPart('a@b')).toMatch(/before @/);
  });

  it('converts quotas', () => {
    expect(quotaBytes('2')).toBe(2 * 1024 ** 3);
    expect(quotaBytes('0.5')).toBe(512 * 1024 ** 2);
    expect(quotaBytes('')).toBeNull();
    expect(quotaBytes('-1')).toBeNull();
    expect(quotaGb(1024 ** 3)).toBe('1');
    expect(quotaGb(undefined)).toBe('');
  });

  it('generates strong, readable passwords', () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).not.toMatch(/[01lIO]/);
    expect(new Set(Array.from({ length: 20 }, () => generatePassword())).size).toBe(20);
  });
});

describe('health', () => {
  const d = domain();
  const sig = (type: DkimSignature['@type'], stage = 'active'): DkimSignature => ({
    id: type,
    '@type': type,
    domainId: 'b',
    selector: 's',
    stage,
    createdAt: '',
    nextTransitionAt: null,
  });
  const task = (type: DomainTask['@type'], status: DomainTask['status']): DomainTask => ({ id: 't', '@type': type, domainId: 'b', due: null, status });

  it('summarises DKIM', () => {
    expect(dkimHealth(d, [], [])).toMatchObject({ state: 'pending' });
    expect(dkimHealth(d, [sig('Dkim1Ed25519Sha256'), sig('Dkim1RsaSha256')], [])).toEqual({ state: 'ok', label: 'Signing with Ed25519 + RSA' });
    const failing = task('DkimManagement', { '@type': 'Retry', failureReason: 'timed out' });
    expect(dkimHealth(d, [sig('Dkim1RsaSha256')], [failing])).toMatchObject({ state: 'warning', detail: expect.stringContaining('timed out') });
    expect(dkimHealth(domain({ dkimManagement: { '@type': 'Manual' } }), [], [])).toMatchObject({ state: 'off' });
  });

  it('summarises TLS', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const cert: Certificate = {
      id: 'x',
      subjectAlternativeNames: { 'mx1.example.com': true },
      notValidBefore: '2026-10-01T00:00:00Z',
      notValidAfter: '2026-12-30T00:00:00Z',
      issuer: 'R11',
    };
    expect(certificatesFor(d, [cert, { ...cert, subjectAlternativeNames: { 'example.org': true } }])).toHaveLength(1);
    expect(tlsHealth(d, [cert], [], now)).toMatchObject({ state: 'ok', detail: 'Issued by R11' });
    expect(tlsHealth(d, [], [], now)).toMatchObject({ state: 'pending' });
    expect(tlsHealth(d, [], [task('AcmeRenewal', { '@type': 'Failed', failureReason: 'rate limited' })], now)).toMatchObject({
      state: 'error',
      detail: 'rate limited',
    });
    expect(tlsHealth(domain({ certificateManagement: { '@type': 'Manual' } }), [], [], now)).toMatchObject({ state: 'off' });
  });

  it('summarises DNS', () => {
    const servers = [{ id: 'cf', '@type': 'Cloudflare', description: 'Cloudflare' }];
    expect(dnsHealth(d, [], servers)).toMatchObject({ state: 'ok', label: 'Automatic via Cloudflare' });
    expect(dnsHealth(d, [task('DnsManagement', { '@type': 'Pending' })], servers)).toMatchObject({ state: 'pending' });
    expect(dnsHealth(d, [task('DnsManagement', { '@type': 'Retry', failureReason: 'bad token' })], servers)).toMatchObject({
      state: 'error',
      detail: 'bad token',
    });
    expect(dnsHealth(domain({ dnsManagement: { '@type': 'Manual' } }), [])).toMatchObject({ state: 'off' });
  });
});

describe('relay and errors', () => {
  it('reads the default remote route from the outbound strategy', () => {
    expect(defaultRemoteRoute({ id: 'singleton', route: { match: {}, else: "'cloudflare'" } })).toBe('cloudflare');
    expect(defaultRemoteRoute(null)).toBeNull();
    expect(
      describeRoute({ id: 'r', '@type': 'Relay', name: 'cloudflare', description: null, address: 'smtp.mx.cloudflare.net', port: 465, implicitTls: true }),
    ).toBe('smtp.mx.cloudflare.net:465 · implicit TLS');
  });

  it('describes set errors', () => {
    expect(describeSetError({ type: 'primaryKeyViolation' })).toMatch(/already in use/);
    expect(
      describeSetError({
        type: 'objectIsLinked',
        linkedObjects: [
          { object: 'Account', id: 'a' },
          { object: 'Account', id: 'b' },
          { object: 'MailingList', id: 'c' },
        ],
      }),
    ).toBe("It's still in use by 2 accounts and 1 mailing list.");
    expect(describeLinked([{ object: 'DkimSignature' }])).toBe('1 DKIM key');
    expect(describeSetError({ type: 'invalidProperties', description: 'Bad name' })).toBe('Bad name');
  });
});
