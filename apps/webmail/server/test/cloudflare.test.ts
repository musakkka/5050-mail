import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { MemorySessionStore } from '../src/sessions';
import { CloudflareClient, CloudflareService, checkRecords, normalizeDomain, stalwartRecords, txtValue, type Zone } from '../src/cloudflare';
import { bounceRecordsFor, fakeCloudflareFetch, fakeState, type FakeCloudflareState } from '../src/cloudflareFake';

const UPSTREAM = 'http://stalwart.test:8080';
const USERS: Record<string, string> = { 'alice@dev.test': 'alice-pw', 'bob@dev.test': 'bob-pw', 'eve@dev.test': 'eve-pw' };
const ADMINS = new Set(['alice@dev.test']);
/** Custom role with only sysAccountQuery/sysAccountGet: can read accounts, can't change anything. */
const QUERY_ONLY = new Set(['eve@dev.test']);
const TOKEN = 'cf-secret-token-123';
const CSRF = { 'X-Requested-With': '5050' };
const JSONH = { 'Content-Type': 'application/json', ...CSRF };

const ZONE_FILE = [
  'v1-ed25519-20261021._domainkey.mail.cfzone.test. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=AAAA"',
  'v1-rsa-20261021._domainkey.mail.cfzone.test. IN TXT (',
  '    "v=DKIM1; k=rsa; h=sha256; p=BBBB"',
  '    "CCCC"',
  ')',
  'mail.cfzone.test. IN TXT "v=spf1 mx -all"',
  'mail.cfzone.test. IN MX 10 mail.example.com.',
  '_dmarc.mail.cfzone.test. IN TXT "v=DMARC1; p=reject; rua=mailto:postmaster@mail.cfzone.test"',
  '_imaps._tcp.mail.cfzone.test. IN SRV 0 1 993 mail.example.com.',
  '_smtp._tls.mail.cfzone.test. IN TXT "v=TLSRPTv1; rua=mailto:postmaster@mail.cfzone.test"',
].join('\n');

/** Fake Stalwart: session, admin detection (x:Account/query) and x:Domain/get. */
function fakeStalwart(counter: { adminChecks: number }) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const [user, pass] = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    if (!user || USERS[user] !== pass) return new Response('{}', { status: 401 });
    if (url.pathname === '/jmap/session')
      return Response.json({
        username: user,
        accounts: { a: { name: user, isPersonal: true, accountCapabilities: {} } },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a', 'urn:stalwart:jmap': 'a' },
        capabilities: {},
      });
    if (url.pathname === '/jmap/') {
      const { methodCalls } = (await req.json()) as { methodCalls: [string, unknown, string][] };
      const out = methodCalls.map(([name, , id]) => {
        if (name === 'x:Account/query') {
          counter.adminChecks++;
          return ADMINS.has(user) || QUERY_ONLY.has(user) ? [name, { ids: ['a'] }, id] : ['error', { type: 'forbidden' }, id];
        }
        if (!ADMINS.has(user)) return ['error', { type: 'forbidden' }, id];
        if (name === 'x:Domain/set' || name === 'x:Account/set') return [name, {}, id];
        if (name === 'x:Domain/query') return [name, { ids: ['d1'] }, id];
        if (name === 'x:Domain/get')
          return [
            name,
            {
              list: [
                {
                  id: 'd1',
                  name: 'mail.cfzone.test',
                  dnsZoneFile: ZONE_FILE,
                  dnsManagement: { '@type': 'Automatic', publishRecords: { mx: true, dkim: true, spf: true, dmarc: true, tlsRpt: true } },
                },
                { id: 'd2', name: 'mail.example.org', dnsZoneFile: '', dnsManagement: { '@type': 'Manual' } },
              ],
            },
            id,
          ];
        return [name, {}, id];
      });
      return Response.json({ methodResponses: out });
    }
    return new Response('nf', { status: 404 });
  };
}

describe('cloudflare helpers', () => {
  it('validates domains strictly', () => {
    expect(normalizeDomain('Mail.Example.COM.')).toBe('mail.example.com');
    for (const bad of ['', 'localhost', 'a..b.com', '-a.com', 'a.com/x', 'a b.com', 'x@a.com', '*.a.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 42, null])
      expect(normalizeDomain(bad)).toBeNull();
  });

  it('extracts the MX/TXT records Stalwart wants from its zone file', () => {
    const recs = stalwartRecords(ZONE_FILE);
    expect(recs.map((r) => `${r.kind} ${r.type} ${r.name}`)).toEqual([
      'dkim TXT v1-ed25519-20261021._domainkey.mail.cfzone.test',
      'dkim TXT v1-rsa-20261021._domainkey.mail.cfzone.test',
      'spf TXT mail.cfzone.test',
      'mx MX mail.cfzone.test',
      'dmarc TXT _dmarc.mail.cfzone.test',
      'tlsRpt TXT _smtp._tls.mail.cfzone.test',
    ]);
    expect(recs[1]!.content).toBe('v=DKIM1; k=rsa; h=sha256; p=BBBBCCCC');
    expect(recs[3]).toMatchObject({ content: 'mail.example.com', priority: 10 });
    expect(stalwartRecords(ZONE_FILE, new Set(['mx'])).length).toBe(1);
    expect(txtValue('"v=spf1 " "include:x ~all"')).toBe('v=spf1 include:x ~all');
  });
});

describe('CloudflareService (mocked fetch)', () => {
  let state: FakeCloudflareState;
  let svc: CloudflareService;
  const logs: string[] = [];
  beforeEach(() => {
    state = fakeState(['cfzone.test', 'other.test']);
    logs.length = 0;
    svc = new CloudflareService(new CloudflareClient({ token: TOKEN, fetch: fakeCloudflareFetch(state) }), (m) => logs.push(m));
  });
  const posts = () => state.calls.filter((c) => c.startsWith('POST'));

  it('onboards a subdomain in its parent zone, adds the cf-bounce records, and is idempotent', async () => {
    const first = await svc.connect('mail.cfzone.test', 'alice@dev.test');
    expect(first.ok).toBe(true);
    expect(first.zone).toBe('cfzone.test');
    expect(first.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:created', 'records:created', 'verify:ok']);
    expect(posts()).toEqual([
      'POST /zones/' + state.zones[0]!.id + '/email/sending/subdomains',
      ...Array(5).fill('POST /zones/' + state.zones[0]!.id + '/dns_records'),
    ]);
    expect(state.zones[0]!.records.map((r) => `${r.type} ${r.name}`).sort()).toEqual(
      bounceRecordsFor('mail.cfzone.test')
        .map((r) => `${r.type} ${r.name}`)
        .sort(),
    );
    expect(first.status).toMatchObject({ sendingReady: true, sending: { onboarded: true, enabled: true, returnPath: 'cf-bounce.mail.cfzone.test' } });

    state.calls.length = 0;
    const again = await svc.connect('mail.cfzone.test', 'alice@dev.test');
    expect(again.ok).toBe(true);
    expect(again.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:ok', 'records:ok', 'verify:ok']);
    expect(posts()).toEqual([]);
    expect(state.zones[0]!.records).toHaveLength(5);
  });

  it("doesn't recreate records Cloudflare already added on onboarding", async () => {
    state.autoCreateRecords = true;
    const r = await svc.connect('cfzone.test', 'alice@dev.test');
    expect(r.steps.find((s) => s.id === 'records')!.status).toBe('ok');
    expect(posts()).toHaveLength(1);
  });

  it('re-enables a disabled sending domain', async () => {
    await svc.connect('cfzone.test', 'a');
    state.zones[0]!.subdomains[0]!.enabled = false;
    const r = await svc.connect('cfzone.test', 'a');
    expect(r.steps.find((s) => s.id === 'sending')!.status).toBe('created');
    expect(state.zones[0]!.subdomains[0]!.enabled).toBe(true);
  });

  it('reports a zone that the token cannot see', async () => {
    const r = await svc.connect('example.org', 'a');
    expect(r).toMatchObject({ ok: false, zone: null });
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:error', 'sending:skipped', 'records:skipped', 'verify:skipped']);
    expect(posts()).toEqual([]);
    expect((await svc.status('example.org')).zone).toBeNull();
  });

  it('reports a partial failure per step, then completes on retry', async () => {
    state.failures.set('POST /zones/' + state.zones[0]!.id + '/dns_records', 500);
    const r = await svc.connect('cfzone.test', 'a');
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:created', 'records:error', 'verify:error']);
    expect(r.steps[2]!.detail).toContain('Injected failure');
    expect(r.status!.sending.enabled).toBe(true);
    expect(r.status!.bounceRecords.every((x) => !x.present)).toBe(true);

    state.failures.clear();
    const retry = await svc.connect('cfzone.test', 'a');
    expect(retry.ok).toBe(true);
    expect(retry.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:ok', 'records:created', 'verify:ok']);
  });

  it('stops before records when onboarding fails', async () => {
    state.failures.set('POST /zones/' + state.zones[0]!.id + '/email/sending', 403);
    const r = await svc.connect('cfzone.test', 'a');
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:error', 'records:skipped', 'verify:error']);
  });

  it('never overwrites or duplicates a conflicting SPF record', async () => {
    state.zones[0]!.records.push({ id: 'x', type: 'TXT', name: 'cf-bounce.cfzone.test', content: '"v=spf1 include:other.example -all"' });
    const r = await svc.connect('cfzone.test', 'a');
    const rec = r.steps.find((s) => s.id === 'records')!;
    expect(rec.status).toBe('error');
    expect(rec.detail).toContain('A different SPF1 record already exists');
    expect(state.zones[0]!.records.filter((x) => x.name === 'cf-bounce.cfzone.test' && x.type === 'TXT')).toHaveLength(1);
  });

  it('accepts whatever DMARC policy the zone already has instead of reporting a conflict', async () => {
    const cf = { dnsRecordsByName: async () => [{ id: 'd', type: 'TXT', name: '_dmarc.cfzone.test', content: '"v=DMARC1; p=reject; rua=mailto:postmaster@cfzone.test"' }] };
    const [dmarc, spf] = await checkRecords(cf as unknown as CloudflareClient, { id: 'z', name: 'cfzone.test' } as Zone, [
      { type: 'TXT', name: '_dmarc.cfzone.test', content: '"v=DMARC1; p=none;"' },
      { type: 'TXT', name: '_dmarc.cfzone.test', content: '"v=spf1 -all"' },
    ]);
    expect(dmarc).toMatchObject({ present: true });
    expect(dmarc!.conflict).toBeUndefined();
    expect(spf).toMatchObject({ present: false });
  });

  it('reports which Stalwart records exist in the zone', async () => {
    state.zones[0]!.records.push({ id: 'm', type: 'MX', name: 'mail.cfzone.test', content: 'mail.example.com.', priority: 10 });
    const st = await svc.status('mail.cfzone.test', stalwartRecords(ZONE_FILE));
    expect(st.zone).toBe('cfzone.test');
    expect(st.sending).toEqual({ onboarded: false, enabled: false });
    expect(st.stalwartRecords.filter((r) => r.present).map((r) => r.kind)).toEqual(['mx']);
  });

  it('lists zone names and never logs the token', async () => {
    expect(await svc.zoneNames()).toEqual(['cfzone.test', 'other.test']);
    await svc.connect('cfzone.test', 'alice@dev.test');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.some((l) => l.includes('cfzone.test') && l.includes('alice@dev.test'))).toBe(true);
  });
});

describe('/api/admin/cloudflare routes', () => {
  let store: MemorySessionStore;
  let state: FakeCloudflareState;
  const counter = { adminChecks: 0 };
  beforeEach(() => {
    store = new MemorySessionStore(3600_000, 86400_000);
    state = fakeState(['cfzone.test']);
    counter.adminChecks = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  const mk = (over: Partial<Config> = {}) =>
    createApp({
      config: { ...loadConfig({}), stalwartUrl: UPSTREAM, cloudflareApiToken: TOKEN, ...over },
      store,
      fetch: fakeStalwart(counter) as typeof fetch,
      cloudflareFetch: fakeCloudflareFetch(state),
    });

  async function signIn(app: ReturnType<typeof mk>, email: string) {
    const res = await app.request('/api/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email, password: USERS[email] }) });
    expect(res.status).toBe(200);
    return { Cookie: res.headers.get('set-cookie')!.split(';')[0]! };
  }

  it('requires a session', async () => {
    expect((await mk().request('/api/admin/cloudflare/zones')).status).toBe(401);
  });

  it('returns 403 to non-admins without touching Cloudflare', async () => {
    const app = mk();
    const bob = await signIn(app, 'bob@dev.test');
    expect((await app.request('/api/admin/cloudflare/zones', { headers: bob })).status).toBe(403);
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...bob }, body: JSON.stringify({ domain: 'cfzone.test' }) });
    expect(r.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('re-checks admin status at most once a minute per session', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const atLogin = counter.adminChecks;
    for (let i = 0; i < 3; i++) expect((await app.request('/api/admin/cloudflare/zones', { headers: alice })).status).toBe(200);
    expect(counter.adminChecks - atLogin).toBe(1);
  });

  it('lists zone names only, and never exposes the token', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const res = await app.request('/api/admin/cloudflare/zones', { headers: alice });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ zones: ['cfzone.test'] });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(state.zones[0]!.id);
  });

  it('rejects invalid domains', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    expect((await app.request('/api/admin/cloudflare/domain-status?domain=not_a..domain', { headers: alice })).status).toBe(400);
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'evil.com/../zones' }) });
    expect(r.status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('answers 404 zone_not_found for a Stalwart domain outside the Cloudflare account', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'mail.example.org' }) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('zone_not_found');
  });

  it('only acts on domains that exist in Stalwart (no records created for arbitrary names in a zone)', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'billing.cfzone.test' }) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('domain_not_found');
    expect((await app.request('/api/admin/cloudflare/domain-status?domain=billing.cfzone.test', { headers: alice })).status).toBe(404);
    expect(state.calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  });

  it('a read-only account-query role is not an admin', async () => {
    const app = mk();
    const eve = await signIn(app, 'eve@dev.test');
    const me = await (await app.request('/api/me', { headers: eve })).json();
    expect(me.isAdmin).toBe(false);
    expect((await app.request('/api/admin/cloudflare/zones', { headers: eve })).status).toBe(403);
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...eve }, body: JSON.stringify({ domain: 'mail.cfzone.test' }) });
    expect(r.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('re-checks admin status on every write, without the read cache', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    await app.request('/api/admin/cloudflare/zones', { headers: alice });
    const before = counter.adminChecks;
    for (let i = 0; i < 2; i++)
      await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'mail.cfzone.test' }) });
    expect(counter.adminChecks - before).toBe(2);
  });

  it('with Cloudflare Email Sending: connects, then reports status including the Stalwart records', async () => {
    const app = mk({ cloudflareEmailSending: true });
    const alice = await signIn(app, 'alice@dev.test');
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'mail.cfzone.test' }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    const st = await (await app.request('/api/admin/cloudflare/domain-status?domain=mail.cfzone.test', { headers: alice })).json();
    expect(st.sendingReady).toBe(true);
    expect(st.stalwartRecords).toHaveLength(6);
    expect(st.stalwartRecords.every((x: { present: boolean }) => !x.present)).toBe(true);
  });

  it('without Email Sending (direct delivery): one click publishes the domain\'s own records', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const before = await (await app.request('/api/admin/cloudflare/domain-status?domain=mail.cfzone.test', { headers: alice })).json();
    expect(before).toMatchObject({ emailSending: false, sendingReady: false });
    const r = await app.request('/api/admin/cloudflare/connect', { method: 'POST', headers: { ...JSONH, ...alice }, body: JSON.stringify({ domain: 'mail.cfzone.test' }) });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.steps.find((x: { id: string }) => x.id === 'records')).toMatchObject({ status: 'created' });
    expect(state.calls.some((c) => c.includes('email/sending'))).toBe(false);
    const st = await (await app.request('/api/admin/cloudflare/domain-status?domain=mail.cfzone.test', { headers: alice })).json();
    expect(st.sendingReady).toBe(true);
    expect(st.stalwartRecords.every((x: { present: boolean }) => x.present)).toBe(true);
    const types = state.zones[0]!.records.map((x) => x.type).sort();
    expect(types).toEqual(['MX', 'TXT', 'TXT', 'TXT', 'TXT', 'TXT']);
  });

  it('checks a hand-managed domain against public DNS (no Cloudflare needed)', async () => {
    const dns = new Map<string, string[][]>([
      ['mail.cfzone.test', [['v=spf1 mx -all']]],
      ['_dmarc.mail.cfzone.test', [['v=DMARC1; p=none']]],
      ['v1-rsa-20261021._domainkey.mail.cfzone.test', [['v=DKIM1; k=rsa; h=sha256; p=BBBB', 'CCCC']]],
    ]);
    const app = createApp({
      config: { ...loadConfig({}), stalwartUrl: UPSTREAM },
      store,
      fetch: fakeStalwart(counter) as typeof fetch,
      dnsLookup: { mx: async (n) => (n === 'mail.cfzone.test' ? [{ exchange: 'MAIL.example.com.', priority: 10 }] : []), txt: async (n) => dns.get(n) ?? [] },
    });
    const alice = await signIn(app, 'alice@dev.test');
    const bob = await signIn(app, 'bob@dev.test');
    expect((await app.request('/api/admin/dns/check?domain=mail.cfzone.test', { headers: bob })).status).toBe(403);
    const res = await app.request('/api/admin/dns/check?domain=mail.cfzone.test', { headers: alice });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    const byName = (n: string, t: string) => body.records.find((r: { name: string; type: string }) => r.name === n && r.type === t);
    expect(byName('mail.cfzone.test', 'MX').present).toBe(true);
    expect(byName('v1-rsa-20261021._domainkey.mail.cfzone.test', 'TXT').present).toBe(true);
    expect(byName('v1-ed25519-20261021._domainkey.mail.cfzone.test', 'TXT').present).toBe(false);
    expect(byName('_dmarc.mail.cfzone.test', 'TXT').present).toBe(true);
    expect(byName('_smtp._tls.mail.cfzone.test', 'TXT').present).toBe(false);
  });

  it('keeps CSRF and Origin checks on connect', async () => {
    const app = mk();
    const alice = await signIn(app, 'alice@dev.test');
    const noHeader = await app.request('/api/admin/cloudflare/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...alice },
      body: JSON.stringify({ domain: 'cfzone.test' }),
    });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await app.request('http://mail.local/api/admin/cloudflare/connect', {
      method: 'POST',
      headers: { ...JSONH, ...alice, Host: 'mail.local', Origin: 'https://evil.example' },
      body: JSON.stringify({ domain: 'cfzone.test' }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('hides the feature when no token is configured', async () => {
    const app = mk({ cloudflareApiToken: undefined });
    const alice = await signIn(app, 'alice@dev.test');
    const r = await app.request('/api/admin/cloudflare/zones', { headers: alice });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('not_configured');
  });

  it('refuses CLOUDFLARE_FAKE in production', () => {
    expect(() => loadConfig({ CLOUDFLARE_FAKE: '1', NODE_ENV: 'production' })).toThrow(/test-only/);
    expect(loadConfig({ CLOUDFLARE_FAKE: '1' }).cloudflareFake).toBe(true);
  });
});
