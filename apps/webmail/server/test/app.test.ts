import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { MemorySessionStore } from '../src/sessions';

const UPSTREAM = 'http://stalwart.test:8080';
const GOOD = { 'alice@dev.test': 'right-password', 'bob@dev.test': 'bob-password' } as Record<string, string>;
const ADMINS = new Set(['alice@dev.test']);

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/** Minimal fake Stalwart. */
function fakeStalwart(seen: Seen[], overrides: Partial<Record<string, (req: Request) => Response | Promise<Response>>> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init as RequestInit);
    const url = new URL(req.url);
    const body = req.method !== 'GET' && req.body && !url.pathname.startsWith('/jmap/upload') ? await req.clone().text() : undefined;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    const o = overrides[url.pathname];
    if (o) return o(req);
    const auth = req.headers.get('authorization') ?? '';
    const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    if (!user || GOOD[user] !== pass) {
      return new Response(JSON.stringify({ status: 401 }), {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="x"', 'content-type': 'application/problem+json' },
      });
    }
    if (url.pathname === '/jmap/session') {
      return Response.json({
        capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:websocket': { url: 'wss://localhost/jmap/ws' } },
        accounts: {
          a: {
            name: user,
            isPersonal: true,
            isReadOnly: false,
            accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:websocket': {} },
          },
        },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a', 'urn:ietf:params:jmap:submission': 'a', 'urn:stalwart:jmap': 'a' },
        username: user,
        apiUrl: 'https://localhost/jmap/',
        downloadUrl: 'https://localhost/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
        uploadUrl: 'https://localhost/jmap/upload/{accountId}/',
        eventSourceUrl: 'https://localhost/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
        state: 's1',
      });
    }
    if (url.pathname === '/jmap/' && req.method === 'POST') {
      const json = JSON.parse(body ?? '{}') as { methodCalls: [string, unknown, string][] };
      const responses = json.methodCalls.map(([name, , id]) => {
        if (name === 'x:Account/query') return ADMINS.has(user) ? [name, { ids: ['a'] }, id] : ['error', { type: 'forbidden' }, id];
        if (name === 'Identity/get') return [name, { list: [{ id: 'i', name: user === 'alice@dev.test' ? 'Alice Example' : '', email: user }] }, id];
        return [name, { ok: true }, id];
      });
      return Response.json({ methodResponses: responses, sessionState: 's1' });
    }
    if (url.pathname.startsWith('/jmap/download/')) {
      const type = url.searchParams.get('accept') ?? 'application/octet-stream';
      return new Response('BLOBDATA', { headers: { 'content-type': type, 'content-disposition': 'attachment; filename="a.png"' } });
    }
    if (url.pathname.startsWith('/jmap/upload/')) {
      const buf = await req.arrayBuffer();
      return Response.json({ blobId: 'b1', size: buf.byteLength, type: req.headers.get('content-type') });
    }
    return new Response('not found', { status: 404 });
  };
}

function config(over: Partial<Config> = {}): Config {
  return { ...loadConfig({}), stalwartUrl: UPSTREAM, loginRateLimit: 5, ...over };
}

const CSRF = { 'X-Requested-With': '5050' };
const JSONH = { 'Content-Type': 'application/json', ...CSRF };

function cookieFrom(res: Response): string {
  const set = res.headers.get('set-cookie') ?? '';
  return set.split(';')[0]!;
}

describe('BFF auth', () => {
  let store: MemorySessionStore;
  let seen: Seen[];
  beforeEach(() => {
    store = new MemorySessionStore(3600_000, 86400_000);
    seen = [];
  });
  afterEach(() => store.close());

  const mk = (over: Partial<Config> = {}, overrides = {}, peer = '127.0.0.1') =>
    createApp({ config: config({ loginSlowdownMs: 0, ...over }), store, fetch: fakeStalwart(seen, overrides) as typeof fetch, peerIp: () => peer });

  it('serves /health and a CSP header', async () => {
    const res = await mk().request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('logs in, sets an httpOnly SameSite=Lax cookie and never returns the password', async () => {
    const app = mk();
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: JSONH,
      body: JSON.stringify({ email: 'alice@dev.test', password: 'right-password' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('right-password');
    expect(JSON.parse(text)).toMatchObject({ email: 'alice@dev.test', name: 'Alice Example', isAdmin: true });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).not.toMatch(/Secure/i); // plain http in tests
    // Credentials were verified against Stalwart's session endpoint with Basic auth.
    expect(seen[0]!.url).toBe(`${UPSTREAM}/jmap/session`);
    expect(seen[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('alice@dev.test:right-password').toString('base64')}`);

    const me = await app.request('/api/me', { headers: { Cookie: cookieFrom(res) } });
    expect(await me.json()).toMatchObject({ email: 'alice@dev.test', name: 'Alice Example', isAdmin: true });
  });

  it('marks non-admins (forbidden on x:Account/query) as isAdmin=false and falls back to local part for the name', async () => {
    const res = await mk().request('/api/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email: 'bob@dev.test', password: 'bob-password' }) });
    expect(await res.json()).toMatchObject({ email: 'bob@dev.test', name: 'bob', isAdmin: false });
  });

  it('sets Secure on the cookie behind https', async () => {
    const res = await mk({ trustProxy: true }).request('/api/login', {
      method: 'POST',
      headers: { ...JSONH, 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'alice@dev.test', password: 'right-password' }),
    });
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('rejects wrong passwords with 401 and no cookie', async () => {
    const res = await mk().request('/api/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email: 'alice@dev.test', password: 'nope' }) });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('requires the CSRF header and same-origin Origin on login', async () => {
    const app = mk();
    const body = JSON.stringify({ email: 'alice@dev.test', password: 'right-password' });
    const noHeader = await app.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await app.request('http://mail.example/api/login', {
      method: 'POST',
      headers: { ...JSONH, Origin: 'https://evil.example', Host: 'mail.example' },
      body,
    });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await app.request('http://mail.example/api/login', {
      method: 'POST',
      headers: { ...JSONH, Origin: 'http://mail.example', Host: 'mail.example' },
      body,
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('rate-limits login attempts per IP (right-most X-Forwarded-For when TRUST_PROXY)', async () => {
    const app = mk({ loginRateLimit: 3, trustProxy: true });
    const attempt = (xff: string, email = 'nobody@dev.test') =>
      app.request('/api/login', {
        method: 'POST',
        headers: { ...JSONH, 'X-Forwarded-For': xff },
        body: JSON.stringify({ email, password: 'wrong' }),
      });
    // A client can't dodge the limit by prepending fake addresses: the proxy-appended (right-most) one counts.
    for (let i = 0; i < 3; i++) expect((await attempt(`10.0.0.${i}, 1.2.3.4`, `u${i}@dev.test`)).status).toBe(401);
    const blocked = await attempt('9.9.9.9, 1.2.3.4', 'other@dev.test');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await attempt('5.6.7.8', 'u9@dev.test')).status).toBe(401);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is set', async () => {
    const app = mk({ loginRateLimit: 2 });
    const attempt = (ip: string, i: number) =>
      app.request('/api/login', {
        method: 'POST',
        headers: { ...JSONH, 'X-Forwarded-For': ip },
        body: JSON.stringify({ email: `x${i}@dev.test`, password: 'wrong' }),
      });
    expect((await attempt('1.1.1.1', 1)).status).toBe(401);
    expect((await attempt('2.2.2.2', 2)).status).toBe(401);
    expect((await attempt('3.3.3.3', 3)).status).toBe(429);
  });

  it('limits failed logins per account, but a browser that signed in before is not locked out', async () => {
    const app = mk({ loginRateLimit: 2, trustProxy: true });
    const login = (ip: string, email: string, password: string, cookie = '') =>
      app.request('/api/login', {
        method: 'POST',
        headers: { ...JSONH, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify({ email, password }),
      });
    // The owner signs in once from their browser: it becomes a known device for alice.
    const ok = await login('7.7.7.7', 'alice@dev.test', 'right-password');
    const device = ok.headers.getSetCookie().find((c) => c.startsWith('mail_device='))!.split(';')[0]!;
    expect(ok.headers.getSetCookie().find((c) => c.startsWith('mail_device='))).toMatch(/HttpOnly.*|Path=\/api\/login/i);
    // An attacker sprays alice's account from several IPs and locks it for unknown browsers…
    expect((await login('1.0.0.1', 'alice@dev.test', 'wrong')).status).toBe(401);
    expect((await login('1.0.0.2', 'alice@dev.test', 'wrong')).status).toBe(401);
    expect((await login('1.0.0.3', 'alice@dev.test', 'right-password')).status).toBe(429);
    // A forged device cookie doesn't help…
    expect((await login('1.0.0.4', 'alice@dev.test', 'right-password', 'mail_device=YWxpY2VAZGV2LnRlc3Q.9999999999.forged')).status).toBe(429);
    // …but the owner's browser still gets in.
    expect((await login('7.7.7.7', 'alice@dev.test', 'right-password', device)).status).toBe(200);
  });

  it('a global failure spike slows logins down but never refuses a correct one', async () => {
    const app = mk({ loginRateLimit: 100, loginGlobalFailLimit: 3, trustProxy: true, loginSlowdownMs: 50 });
    const login = (ip: string, email: string, password: string) =>
      app.request('/api/login', { method: 'POST', headers: { ...JSONH, 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password }) });
    for (let i = 0; i < 5; i++) expect((await login(`2.0.0.${i}`, `g${i}@dev.test`, 'wrong')).status).toBe(401);
    const t = Date.now();
    expect((await login('3.0.0.1', 'alice@dev.test', 'right-password')).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });

  it('ignores forwarding headers from peers outside TRUSTED_PROXIES, and CF-Connecting-IP unless TRUST_CF_HEADER', async () => {
    const attempt = (app: ReturnType<typeof mk>, headers: Record<string, string>, i: number) =>
      app.request('/api/login', { method: 'POST', headers: { ...JSONH, ...headers }, body: JSON.stringify({ email: `z${i}@dev.test`, password: 'wrong' }) });
    // TRUST_PROXY on, but the socket peer is a random internet host: XFF is ignored, the peer counts.
    const direct = mk({ loginRateLimit: 2, trustProxy: true }, {}, '203.0.113.9');
    expect((await attempt(direct, { 'X-Forwarded-For': '1.1.1.1' }, 1)).status).toBe(401);
    expect((await attempt(direct, { 'X-Forwarded-For': '2.2.2.2' }, 2)).status).toBe(401);
    expect((await attempt(direct, { 'X-Forwarded-For': '3.3.3.3' }, 3)).status).toBe(429);
    // Behind a trusted (non-Cloudflare) proxy a client-set CF-Connecting-IP doesn't dodge the per-IP limit.
    const nginx = mk({ loginRateLimit: 2, trustProxy: true });
    for (let i = 0; i < 2; i++) expect((await attempt(nginx, { 'CF-Connecting-IP': `9.9.9.${i}`, 'X-Forwarded-For': '4.4.4.4' }, 10 + i)).status).toBe(401);
    expect((await attempt(nginx, { 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '4.4.4.4' }, 19)).status).toBe(429);
    // With TRUST_CF_HEADER, Cloudflare's header is the client IP.
    const cf = mk({ loginRateLimit: 1, trustProxy: true, trustCfHeader: true });
    expect((await attempt(cf, { 'CF-Connecting-IP': '5.5.5.1' }, 20)).status).toBe(401);
    expect((await attempt(cf, { 'CF-Connecting-IP': '5.5.5.2' }, 21)).status).toBe(401);
  });

  it('honours X-Forwarded-Host in the CSRF check only from a trusted proxy, and guards every unsafe method', async () => {
    const forged = { ...CSRF, Origin: 'http://evil.test', 'X-Forwarded-Host': 'evil.test' };
    expect((await mk().request('http://mail.local/api/logout', { method: 'POST', headers: forged })).status).toBe(403);
    expect((await mk({ trustProxy: true }, {}, '203.0.113.9').request('http://mail.local/api/logout', { method: 'POST', headers: forged })).status).toBe(403);
    expect((await mk({ trustProxy: true }).request('http://mail.local/api/logout', { method: 'POST', headers: forged })).status).toBe(200);
    expect((await mk().request('/jmap/', { method: 'PROPFIND' })).status).toBe(403);
  });

  it('sends HSTS over https and uses a __Host- Secure cookie in production', async () => {
    const res = await mk({ trustProxy: true }).request('/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect((await mk().request('/health')).headers.get('strict-transport-security')).toBeNull();
    const prod = loadConfig({ NODE_ENV: 'production' });
    expect(prod.cookieSecure).toBe(true);
    expect(prod.cookieName).toBe('__Host-mail_sid');
    expect(loadConfig({}).cookieName).toBe('mail_sid');
  });

  it('logs out and destroys the session', async () => {
    const app = mk();
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: JSONH,
      body: JSON.stringify({ email: 'alice@dev.test', password: 'right-password' }),
    });
    const cookie = cookieFrom(res);
    expect(store.size()).toBe(1);
    const out = await app.request('/api/logout', { method: 'POST', headers: { ...CSRF, Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(store.size()).toBe(0);
    expect((await app.request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe('BFF JMAP proxy', () => {
  let store: MemorySessionStore;
  let seen: Seen[];
  let cookie: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    store = new MemorySessionStore(3600_000, 86400_000);
    seen = [];
    app = createApp({
      config: config(),
      store,
      fetch: fakeStalwart(seen, {
        '/jmap/eventsource/': () => {
          let i = 0;
          const stream = new ReadableStream({
            pull(ctrl) {
              i++;
              if (i <= 2) ctrl.enqueue(new TextEncoder().encode(`event: state\ndata: {"@type":"StateChange","changed":{"a":{"Email":"s${i}"}}}\n\n`));
              else ctrl.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        },
      }) as typeof fetch,
    });
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: JSONH,
      body: JSON.stringify({ email: 'alice@dev.test', password: 'right-password' }),
    });
    cookie = cookieFrom(res);
    seen.length = 0;
  });
  afterEach(() => store.close());

  it('rejects unauthenticated JMAP calls', async () => {
    const res = await app.request('/jmap/session');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rewrites session URLs to same-origin paths and hides the websocket capability', async () => {
    for (const path of ['/jmap/session', '/.well-known/jmap']) {
      const res = await app.request(path, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      const s = (await res.json()) as Record<string, unknown> & {
        capabilities: Record<string, unknown>;
        accounts: Record<string, { accountCapabilities: Record<string, unknown> }>;
      };
      expect(s.apiUrl).toBe('/jmap/');
      expect(s.downloadUrl).toBe('/jmap/download/{accountId}/{blobId}/{name}?accept={type}');
      expect(s.uploadUrl).toBe('/jmap/upload/{accountId}/');
      expect(s.eventSourceUrl).toBe('/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}');
      expect(s.capabilities['urn:ietf:params:jmap:websocket']).toBeUndefined();
      expect(s.accounts.a!.accountCapabilities['urn:ietf:params:jmap:websocket']).toBeUndefined();
    }
  });

  it('forwards API calls with Basic auth, without the browser cookie', async () => {
    const res = await app.request('/jmap/', {
      method: 'POST',
      headers: { ...JSONH, Cookie: cookie },
      body: JSON.stringify({ using: [], methodCalls: [['Core/echo', {}, '0']] }),
    });
    expect(res.status).toBe(200);
    const call = seen.at(-1)!;
    expect(call.url).toBe(`${UPSTREAM}/jmap/`);
    expect(call.headers.get('authorization')).toMatch(/^Basic /);
    expect(call.headers.get('cookie')).toBeNull();
    expect(JSON.parse(call.body!).methodCalls[0][0]).toBe('Core/echo');
  });

  it('requires the CSRF header on JMAP POSTs', async () => {
    const res = await app.request('/jmap/', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('streams uploads through', async () => {
    const data = new Uint8Array(256 * 1024).fill(7);
    const res = await app.request('/jmap/upload/a/', { method: 'POST', headers: { ...CSRF, Cookie: cookie, 'Content-Type': 'image/png' }, body: data });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blobId: 'b1', size: data.byteLength, type: 'image/png' });
  });

  it('serves downloads as attachments with a sandbox CSP; inline only for safe types', async () => {
    const att = await app.request('/jmap/download/a/b1/a.html?accept=text%2Fhtml&inline=1', { headers: { Cookie: cookie } });
    expect(att.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(att.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(seen.at(-1)!.url).not.toContain('inline=1');
    const img = await app.request('/jmap/download/a/b1/a.png?accept=image%2Fpng&inline=1', { headers: { Cookie: cookie } });
    expect(img.headers.get('content-disposition')).toMatch(/^inline/);
    expect(await img.text()).toBe('BLOBDATA');
  });

  it('streams EventSource responses without buffering', async () => {
    const res = await app.request('/jmap/eventsource/?types=*&closeafter=no&ping=60', { headers: { Cookie: cookie } });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"Email":"s1"');
    await reader.cancel();
  });

  it('refuses non-JMAP and traversal paths without contacting Stalwart', async () => {
    for (const p of [
      '/jmap/..%2fapi/principal',
      '/jmap/%2e%2e/admin',
      '/jmap/api/principal',
      '/jmap/download/a/..%2f..%2fapi/x',
      '/jmap/foo\\bar',
      '/jmap/upload/a/b/c',
    ]) {
      const res = await app.request(p, { headers: { Cookie: cookie } });
      expect(res.status, p).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('re-encodes download file names so they cannot act as paths', async () => {
    const res = await app.request('/jmap/download/a/b1/..%2F..%2Fapi%2Fx?accept=image%2Fpng', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(new URL(seen.at(-1)!.url).pathname).toBe('/jmap/download/a/b1/__.._api_x');
  });

  it('refuses uploads, downloads and API calls addressed to an account the session does not own', async () => {
    const before = seen.length;
    const up = await app.request('/jmap/upload/c/', { method: 'POST', headers: { ...CSRF, Cookie: cookie, 'Content-Type': 'text/plain' }, body: 'x' });
    expect(up.status).toBe(403);
    expect((await app.request('/jmap/download/c/b1/a.png?accept=image%2Fpng', { headers: { Cookie: cookie } })).status).toBe(403);
    const call = (accountId: string, extra: Record<string, unknown> = {}) =>
      app.request('/jmap/', {
        method: 'POST',
        headers: { ...CSRF, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ using: ['urn:ietf:params:jmap:core'], methodCalls: [['Email/get', { accountId, ...extra }, '0']] }),
      });
    expect((await call('c')).status).toBe(403);
    expect((await call('a', { fromAccountId: 'c' })).status).toBe(403);
    expect(seen.length).toBe(before);
    const ok = await call('a');
    expect(ok.status).toBe(200);
    expect(JSON.parse(seen.at(-1)!.body!).methodCalls[0][1].accountId).toBe('a');
  });

  it('lets only administrators query the directory (Principal/*)', async () => {
    const call = (ck: string) =>
      app.request('/jmap/', {
        method: 'POST',
        headers: { ...CSRF, Cookie: ck, 'Content-Type': 'application/json' },
        body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:principals'], methodCalls: [['Principal/query', { accountId: 'a' }, '0']] }),
      });
    const bobLogin = await app.request('/api/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email: 'bob@dev.test', password: 'bob-password' }) });
    const bob = bobLogin.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call(bob)).status).toBe(403);
    expect((await call(cookie)).status).toBe(200); // alice is an admin
  });

  it('serves inline PDFs only into a same-origin frame, never as a top-level page', async () => {
    const url = '/jmap/download/a/b1/a.pdf?accept=application%2Fpdf&inline=1';
    const framed = await app.request(url, { headers: { Cookie: cookie, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin' } });
    expect(framed.headers.get('content-disposition')).toMatch(/^inline/);
    expect(framed.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const variants: Record<string, string>[] = [{ 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' }, {}];
    for (const h of variants) {
      const r = await app.request(url, { headers: { Cookie: cookie, ...h } });
      expect(r.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(r.headers.get('content-security-policy')).toMatch(/sandbox/);
    }
  });

  it('signs out when Stalwart refuses the stored credentials with 403 (suspended account)', async () => {
    const res = await createApp({
      config: config(),
      store,
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
    }).request('/jmap/session', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    expect(store.size()).toBe(0);
  });

  it('drops the session when Stalwart rejects the stored credentials', async () => {
    const res = await createApp({
      config: config(),
      store,
      fetch: (async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Basic' } })) as unknown as typeof fetch,
    }).request('/jmap/session', { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(store.size()).toBe(0);
  });
});
