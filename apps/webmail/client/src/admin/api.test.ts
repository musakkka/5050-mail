import { describe, expect, it, vi } from 'vitest';
import { JmapClient } from '../jmap/client';
import { CAP } from '../jmap/types';
import { AdminApi, AdminSetError, adminErrorMessage } from './api';
import { defaultDomainForm } from './model';

type Call = [string, Record<string, unknown>, string];
type Handler = (method: string, args: Record<string, unknown>, all: Call[]) => Record<string, unknown> | ['error', Record<string, unknown>];

const SESSION = {
  capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500 } },
  accounts: { c: { name: 'alice@dev.test', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAP.mail]: {}, [CAP.stalwart]: {} } } },
  primaryAccounts: { [CAP.mail]: 'c', [CAP.stalwart]: 'c' },
  username: 'alice@dev.test',
  apiUrl: '/jmap/',
  downloadUrl: '/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: '/jmap/upload/{accountId}/',
  eventSourceUrl: '/jmap/eventsource/',
  state: 's0',
};

/** A tiny JMAP server: resolves `#ids` back-references and lets the test answer each call. */
async function fakeServer(handler: Handler) {
  const requests: { using: string[]; methodCalls: Call[] }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/jmap/session')) return Response.json(SESSION);
    const body = JSON.parse(String(init.body)) as { using: string[]; methodCalls: Call[] };
    requests.push(body);
    const responses: Call[] = [];
    for (const [method, rawArgs, id] of body.methodCalls) {
      const args = { ...rawArgs };
      const ref = args['#ids'] as { resultOf: string; path: string } | undefined;
      if (ref) {
        const src = responses.find((r) => r[2] === ref.resultOf)!;
        args.ids = (src[1] as { ids: string[] }).ids;
        delete args['#ids'];
      }
      const out = handler(method, args, body.methodCalls);
      responses.push(Array.isArray(out) ? ['error', out[1], id] : [method, { accountId: 'c', ...out }, id]);
    }
    return Response.json({ methodResponses: responses, sessionState: 's0' });
  });
  const client = new JmapClient({ fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: 'http://app.test', headers: { 'X-Requested-With': '5050' } });
  await client.connect();
  return { api: new AdminApi(client), requests, calls: () => requests.flatMap((r) => r.methodCalls) };
}

describe('AdminApi', () => {
  it('creates a domain with automatic DKIM, TLS and DNS through x:Domain/set', async () => {
    const { api, requests } = await fakeServer((m) => (m === 'x:Domain/set' ? { created: { new: { id: 'd1' } } } : {}));
    const form = defaultDomainForm('example.test', {
      dnsServers: [{ id: 'cf', '@type': 'Cloudflare', description: 'CF' }],
      acmeProviders: [{ id: 'le', directory: 'https://acme', challengeType: 'Dns01', contact: {} }],
    });
    expect(await api.createDomain(form)).toBe('d1');
    const req = requests[0]!;
    expect(req.using).toEqual([CAP.core, CAP.stalwart]);
    const [method, args] = req.methodCalls[0]!;
    expect(method).toBe('x:Domain/set');
    expect(args.accountId).toBe('c');
    expect((args.create as Record<string, unknown>).new).toEqual({
      name: 'example.test',
      description: null,
      isEnabled: true,
      dkimManagement: { '@type': 'Automatic', algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true } },
      certificateManagement: { '@type': 'Automatic', acmeProviderId: 'le', subjectAlternativeNames: {} },
      dnsManagement: { '@type': 'Automatic', dnsServerId: 'cf', origin: 'example.test', publishRecords: { dkim: true, mx: true, tlsRpt: true } },
    });
  });

  it('turns notCreated into a readable AdminSetError', async () => {
    const { api } = await fakeServer(() => ({ notCreated: { new: { type: 'primaryKeyViolation', properties: ['name'] } } }));
    const err = await api.createDomain({ name: 'dup.test', description: '', dns: { mode: 'manual' }, tls: { mode: 'manual' } }).catch((e) => e);
    expect(err).toBeInstanceOf(AdminSetError);
    expect(adminErrorMessage(err)).toBe('That address or name is already in use.');
  });

  it('removes a domain together with its DKIM keys', async () => {
    let attempts = 0;
    const { api, calls } = await fakeServer((m, args) => {
      if (m === 'x:Domain/set') {
        attempts++;
        if (attempts === 1)
          return {
            notDestroyed: {
              d1: {
                type: 'objectIsLinked',
                linkedObjects: [
                  { object: 'DkimSignature', id: 'k1' },
                  { object: 'DkimSignature', id: 'k2' },
                ],
              },
            },
          };
        return { destroyed: args.destroy };
      }
      if (m === 'x:DkimSignature/set') return { destroyed: args.destroy };
      return {};
    });
    await api.removeDomain('d1');
    expect(calls().map((c) => [c[0], c[1].destroy])).toEqual([
      ['x:Domain/set', ['d1']],
      ['x:DkimSignature/set', ['k1', 'k2']],
      ['x:Domain/set', ['d1']],
    ]);
  });

  it('refuses to remove a domain that still has accounts, without touching its DKIM keys', async () => {
    const { api, calls } = await fakeServer(() => ({
      notDestroyed: {
        d1: {
          type: 'objectIsLinked',
          linkedObjects: [
            { object: 'Account', id: 'u1' },
            { object: 'DkimSignature', id: 'k1' },
          ],
        },
      },
    }));
    await expect(api.removeDomain('d1')).rejects.toThrow("It's still in use by 1 account.");
    expect(calls()).toHaveLength(1);
  });

  it('pages users on the server when there is no search term', async () => {
    const { api, calls } = await fakeServer((m) =>
      m === 'x:Account/query'
        ? { ids: ['u2', 'u1'], total: 42, position: 50 }
        : {
            list: [
              { id: 'u1', name: 'a' },
              { id: 'u2', name: 'b' },
            ],
          },
    );
    const page = await api.listAccounts({ kind: 'User', position: 50, limit: 50 });
    expect(page.total).toBe(42);
    expect(page.items.map((a) => a.id)).toEqual(['u2', 'u1']);
    const [q] = calls();
    expect(q![1]).toMatchObject({
      filter: { '@type': 'User' },
      sort: [{ property: 'name', isAscending: true }],
      position: 50,
      limit: 50,
      calculateTotal: true,
    });
  });

  it('searches users by substring client-side', async () => {
    const accounts = [
      { id: 'u1', name: 'alice', emailAddress: 'alice@dev.test', description: 'Alice Example', aliases: {} },
      { id: 'u2', name: 'bob', emailAddress: 'bob@dev.test', description: 'Bob Builder', aliases: {} },
      { id: 'u3', name: 'dave', emailAddress: 'dave@example.test', description: null, aliases: { '0': { name: 'ali', domainId: 'b' } } },
    ];
    const { api, calls } = await fakeServer((m) => (m === 'x:Account/query' ? { ids: ['u1', 'u2', 'u3'] } : { list: accounts }));
    const page = await api.listAccounts({ kind: 'User', search: 'ALI', limit: 1, domainId: 'b' });
    expect(page.total).toBe(2);
    expect(page.items.map((a) => a.id)).toEqual(['u1']);
    expect(calls()[0]![1].filter).toEqual({ '@type': 'User', domainId: 'b' });
  });

  it('resets the password credential in place', async () => {
    const { api, calls } = await fakeServer(() => ({ updated: { u1: null } }));
    await api.setPassword({ id: 'u1', credentials: { '0': { '@type': 'AppPassword' }, '1': { '@type': 'Password' } } }, 'New-Pass-1234');
    await api.setPassword({ id: 'u1', credentials: { '0': { '@type': 'AppPassword' } } }, 'New-Pass-5678');
    expect(calls().map((c) => (c[1].update as Record<string, unknown>).u1)).toEqual([
      { 'credentials/1/secret': 'New-Pass-1234' },
      { 'credentials/1': { '@type': 'Password', secret: 'New-Pass-5678' } },
    ]);
  });

  it('suspends, sets role, quota, aliases and group membership with partial updates', async () => {
    const { api, calls } = await fakeServer(() => ({ updated: { u1: null } }));
    await api.setSuspended({ id: 'u1', permissions: { '@type': 'Inherit' } }, true);
    await api.setRole('u1', 'Admin');
    await api.setQuota({ id: 'u1', quotas: { maxEmails: 10 } }, 2 * 1024 ** 3);
    await api.setQuota({ id: 'u1', quotas: { maxEmails: 10, maxDiskQuota: 5 } }, null);
    await api.setAliases('u1', [{ name: 'sales', domainId: 'c' }]);
    await api.setMembership('u1', 'g1', true);
    await api.setMembership('u1', 'g1', false);
    expect(calls().map((c) => (c[1].update as Record<string, unknown>).u1)).toEqual([
      { permissions: { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true } } },
      { roles: { '@type': 'Admin' } },
      { quotas: { maxEmails: 10, maxDiskQuota: 2 * 1024 ** 3 } },
      { quotas: { maxEmails: 10 } },
      { aliases: { '0': { name: 'sales', domainId: 'c', enabled: true, description: null } } },
      { 'memberGroupIds/g1': true },
      { 'memberGroupIds/g1': null },
    ]);
  });

  it('deletes a group after removing its members', async () => {
    const { api, calls } = await fakeServer((m, args) => {
      if (m === 'x:Account/query') return { ids: ['u1', 'u2'] };
      if (args.update) return { updated: { u1: null, u2: null } };
      return { destroyed: args.destroy };
    });
    await api.deleteGroup('g1');
    const c = calls();
    expect(c[0]![1].filter).toEqual({ '@type': 'User', memberGroupIds: 'g1' });
    expect(c[1]![1].update).toEqual({ u1: { 'memberGroupIds/g1': null }, u2: { 'memberGroupIds/g1': null } });
    expect(c[2]![1].destroy).toEqual(['g1']);
  });

  it('creates users with a password credential and role', async () => {
    const { api, calls } = await fakeServer(() => ({ created: { new: { id: 'u9' } } }));
    await api.createUser({ name: 'Dave', domainId: 'd1', description: 'Dave', password: 'Pw-1234567890', role: 'User', quotaBytes: null });
    expect((calls()[0]![1].create as Record<string, unknown>).new).toEqual({
      '@type': 'User',
      name: 'dave',
      domainId: 'd1',
      description: 'Dave',
      credentials: { '0': { '@type': 'Password', secret: 'Pw-1234567890' } },
      roles: { '@type': 'User' },
      quotas: {},
    });
  });

  it('builds the overview in one request and tolerates an unreadable queue', async () => {
    const { api, requests } = await fakeServer((m, args) => {
      if (m === 'x:QueuedMessage/query') return ['error', { type: 'forbidden' }];
      if (m.endsWith('/query')) {
        const f = (args.filter ?? {}) as Record<string, string>;
        if (m === 'x:Task/query') return { ids: f['@type'] === 'DnsManagement' ? ['t1', 't2', 't3'] : [] };
        if (m === 'x:Domain/query') return { ids: ['b'], total: 5 };
        return { ids: [], total: f['@type'] === 'Group' ? 2 : 5 };
      }
      if (m === 'x:MtaRoute/get') return { list: [{ id: 'r', '@type': 'Relay', name: 'cloudflare' }] };
      if (m === 'x:MtaOutboundStrategy/get') return { list: [{ id: 'singleton', route: { match: {}, else: "'cloudflare'" } }] };
      if (m === 'x:Task/get')
        return {
          // t1 pending, t2 retrying, t3 retrying for a domain that no longer exists
          list: (args.ids as string[]).map((id) => ({
            id,
            '@type': 'DnsManagement',
            domainId: id === 't3' ? 'gone' : 'b',
            status: { '@type': id === 't1' ? 'Pending' : 'Retry' },
          })),
        };
      return { list: [] };
    });
    const o = await api.overview();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.methodCalls.length).toBeLessThanOrEqual(16);
    expect(o).toMatchObject({ domains: 5, users: 5, groups: 2, lists: 5, queued: null });
    expect(o.routes[0]!.name).toBe('cloudflare');
    expect(o.strategy?.route.else).toBe("'cloudflare'");
    expect(o.problems.map((t) => t.id)).toEqual(['t2']);
  });

  it('reports a non-admin session as forbidden', async () => {
    const { api } = await fakeServer(() => ['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }]);
    const err = await api.listDomains().catch((e) => e);
    expect(adminErrorMessage(err)).toBe("You don't have permission to do that.");
  });

  it('collects domain status: DKIM keys, certificates and that domain’s tasks', async () => {
    const { api, requests } = await fakeServer((m, args) => {
      if (m === 'x:DkimSignature/query') return { ids: ['k1'] };
      if (m === 'x:DkimSignature/get') return { list: [{ id: 'k1', domainId: 'b', selector: 'v1-rsa', stage: 'active' }] };
      if (m === 'x:Certificate/get') return { list: [] };
      if (m === 'x:Task/query') return { ids: [(args.filter as Record<string, string>)['@type']] };
      if (m === 'x:Task/get')
        return {
          list: (args.ids as string[]).map((id) => ({ id, '@type': id, domainId: id === 'AcmeRenewal' ? 'other' : 'b', status: { '@type': 'Pending' } })),
        };
      return {};
    });
    const s = await api.domainStatus('b');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.methodCalls[0]![1].filter).toEqual({ domainId: 'b' });
    expect(s.signatures).toHaveLength(1);
    expect(s.tasks.map((t) => t['@type']).sort()).toEqual(['DkimManagement', 'DnsManagement']);
  });
});
