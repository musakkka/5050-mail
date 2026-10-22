import { describe, expect, it, vi } from 'vitest';
import { capabilityFor, JmapAuthError, JmapClient, JmapMethodError, JmapRequestError } from './client';
import { CAP } from './types';

const SESSION = {
  capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500, maxSizeUpload: 50_000_000 } },
  accounts: { acc1: { name: 'alice@dev.test', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} } } },
  primaryAccounts: { [CAP.mail]: 'acc1', [CAP.submission]: 'acc1', [CAP.vacation]: 'acc1' },
  username: 'alice@dev.test',
  apiUrl: '/jmap/',
  downloadUrl: '/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  uploadUrl: '/jmap/upload/{accountId}/',
  eventSourceUrl: '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
  state: 's0',
};

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(String(input), init));
}

async function connected(handler: (body: { using: string[]; methodCalls: [string, Record<string, unknown>, string][] }, init: RequestInit) => unknown) {
  const fetch = mockFetch(async (url, init) => {
    if (url.endsWith('/jmap/session')) return Response.json(SESSION);
    return Response.json(await handler(JSON.parse(String(init.body)), init));
  });
  const client = new JmapClient({ fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: 'http://app.test', headers: { 'X-Requested-With': '5050' } });
  await client.connect();
  return { client, fetch };
}

describe('JmapClient', () => {
  it('maps methods to capabilities', () => {
    expect(capabilityFor('Email/query')).toEqual([CAP.mail]);
    expect(capabilityFor('EmailSubmission/set')).toEqual([CAP.mail, CAP.submission]);
    expect(capabilityFor('VacationResponse/get')).toEqual([CAP.mail, CAP.vacation]);
    expect(capabilityFor('x:Account/query')).toEqual([CAP.stalwart]);
  });

  it('batches calls, fills accountId and the using set, and resolves back-references', async () => {
    let sent: { using: string[]; methodCalls: [string, Record<string, unknown>, string][] } | undefined;
    const { client, fetch } = await connected((body) => {
      sent = body;
      return {
        methodResponses: [
          ['Email/query', { ids: ['e1', 'e2'], total: 2, position: 0, queryState: 'q', canCalculateChanges: false, accountId: 'acc1' }, 'c0'],
          ['Email/get', { list: [{ id: 'e1' }, { id: 'e2' }], state: 's', notFound: [], accountId: 'acc1' }, 'c1'],
          ['Identity/get', { list: [{ id: 'i1', email: 'alice@dev.test' }], state: 's', notFound: [], accountId: 'acc1' }, 'c2'],
        ],
        sessionState: 's0',
      };
    });
    const b = client.batch();
    const q = b.call('Email/query', { filter: { inMailbox: 'inbox' }, limit: 2 });
    const g = b.call('Email/get', { '#ids': q.ref('/ids'), properties: ['subject'] });
    const i = b.call('Identity/get', {});
    const r = await b.send();
    expect(sent!.using.sort()).toEqual([CAP.core, CAP.mail, CAP.submission].sort());
    expect(sent!.methodCalls[0]).toEqual(['Email/query', { accountId: 'acc1', filter: { inMailbox: 'inbox' }, limit: 2 }, 'c0']);
    expect(sent!.methodCalls[1]![1]['#ids']).toEqual({ resultOf: 'c0', name: 'Email/query', path: '/ids' });
    expect(r.get(q).total).toBe(2);
    expect(r.get(g).list.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(r.get(i).list[0]!.email).toBe('alice@dev.test');
    // CSRF header on every API POST
    const apiCall = fetch.mock.calls.find((c) => String(c[0]).endsWith('/jmap/'))!;
    expect((apiCall[1]!.headers as Record<string, string>)['X-Requested-With']).toBe('5050');
    expect(String(apiCall[0])).toBe('http://app.test/jmap/');
  });

  it('throws JmapMethodError for method-level errors', async () => {
    const { client } = await connected(() => ({
      methodResponses: [['error', { type: 'invalidArguments', description: 'bad filter' }, 'c0']],
      sessionState: 's0',
    }));
    await expect(client.emailQuery({ filter: { nope: 1 } })).rejects.toMatchObject({
      name: 'JmapMethodError',
      type: 'invalidArguments',
      method: 'Email/query',
    });
    await expect(client.emailQuery({})).rejects.toBeInstanceOf(JmapMethodError);
  });

  it('surfaces HTTP problem details as JmapRequestError and 401 as JmapAuthError', async () => {
    const onUnauthorized = vi.fn();
    let status = 400;
    const fetch = mockFetch(async (url) => {
      if (url.endsWith('/jmap/session')) return Response.json(SESSION);
      return new Response(JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', status, detail: 'too big' }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
      });
    });
    const client = new JmapClient({ fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: 'http://app.test', onUnauthorized });
    await client.connect();
    await expect(client.emailQuery({})).rejects.toMatchObject({
      name: 'JmapRequestError',
      status: 400,
      type: 'urn:ietf:params:jmap:error:limit',
      message: 'too big',
    });
    status = 401;
    await expect(client.emailQuery({})).rejects.toBeInstanceOf(JmapAuthError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('refuses batches above maxCallsInRequest', async () => {
    const { client } = await connected(() => ({ methodResponses: [], sessionState: 's0' }));
    const b = client.batch();
    for (let n = 0; n < 17; n++) b.call('Core/echo', {});
    await expect(b.send()).rejects.toThrow(/Too many calls/);
  });

  it('builds download URLs from the session template', async () => {
    const { client } = await connected(() => ({}));
    expect(client.downloadUrl('B 1', 'my file.pdf', 'application/pdf')).toBe('/jmap/download/acc1/B%201/my%20file.pdf?accept=application%2Fpdf');
    expect(client.downloadUrl('b', 'x.png', 'image/png', { inline: true })).toBe('/jmap/download/acc1/b/x.png?accept=image%2Fpng&inline=1');
  });

  it('uploads blobs to the account upload URL with the CSRF header', async () => {
    const fetch = mockFetch(async (url, init) => {
      if (url.endsWith('/jmap/session')) return Response.json(SESSION);
      expect(url).toBe('http://app.test/jmap/upload/acc1/');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
      expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('5050');
      return Response.json({ blobId: 'blob1', type: 'text/plain', size: 5 });
    });
    const client = new JmapClient({ fetch: fetch as unknown as typeof globalThis.fetch, baseUrl: 'http://app.test', headers: { 'X-Requested-With': '5050' } });
    await client.connect();
    await expect(client.upload(new Blob(['hello'], { type: 'text/plain' }))).resolves.toEqual({ blobId: 'blob1', type: 'text/plain', size: 5 });
  });

  it('wraps network failures', async () => {
    const client = new JmapClient({ fetch: (async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch, baseUrl: 'http://app.test' });
    await expect(client.connect()).rejects.toBeInstanceOf(JmapRequestError);
  });
});
