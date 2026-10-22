/**
 * Dashboard hardening against a local mock Stalwart (users "<name>@mock.test" / password "pw";
 * users containing "admin" are Stalwart admins): forged X-Forwarded-Host, encoded-path role
 * bypass, and the global login limiter not locking everyone out.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';

const mock = http.createServer((req, res) => {
  const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
  const [user, pw] = [auth.slice(0, auth.indexOf(':')), auth.slice(auth.indexOf(':') + 1)];
  if (pw !== 'pw' || !user.endsWith('@mock.test')) {
    res.writeHead(401);
    return res.end();
  }
  if (req.url === '/jmap/session') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ username: user, accounts: { a: { name: user, isPersonal: true, accountCapabilities: {} } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' }, capabilities: {} }));
  }
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const isAdmin = user.includes('admin');
    res.end(JSON.stringify({ methodResponses: [[isAdmin ? 'x:Account/query' : 'error', isAdmin ? { ids: [] } : { type: 'forbidden' }, '0']] }));
  });
});

let t: TestServer;
let teamId: string;

async function req(method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-requested-with': 'fetch', ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${t.root}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, any> | null, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
}
const login = async (email: string, extra: Record<string, string> = {}) => req('POST', '/api/internal/login', { body: { email, password: 'pw' }, headers: extra });

beforeAll(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  t = await startTestServer({ STALWART_URL: url, LOGIN_RATE_LIMIT: '5', LOGIN_GLOBAL_FAIL_LIMIT: '10' });
  teamId = await t.createTeam('Sec Co', { members: [{ email: 'boss@mock.test', role: 'admin' }, { email: 'member@mock.test', role: 'member' }] });
});
afterAll(async () => {
  await t?.close();
  mock.close();
});

describe('dashboard security', () => {
  it('ignores X-Forwarded-Host for the Origin check unless TRUST_PROXY is on', async () => {
    const { cookie } = await login('boss@mock.test');
    const evil = { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' };
    const r = await req('POST', `/api/internal/teams/${teamId}/resend/api-keys`, { cookie, body: { name: 'csrf' }, headers: evil });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'csrf' });
    t.config.trustProxy = true;
    try {
      const behindProxy = await req('POST', `/api/internal/teams/${teamId}/resend/api-keys`, { cookie, body: { name: 'proxied' }, headers: evil });
      expect(behindProxy.status).toBe(201);
    } finally {
      t.config.trustProxy = false;
    }
  });

  it('members cannot create API keys through encoded or non-canonical paths', async () => {
    const { cookie, status } = await login('member@mock.test');
    expect(status).toBe(200);
    for (const p of ['api-keys', '%61pi-keys', '%61%70%69-keys', '/api-keys', 'x/../api-keys', '%2e/api-keys', 'API-KEYS']) {
      const r = await req('POST', `/api/internal/teams/${teamId}/resend/${p}`, { cookie, body: { name: 'm' } });
      expect([403, 404], p).toContain(r.status);
      expect(r.json?.token, p).toBeUndefined();
    }
    expect((await req('POST', `/api/internal/teams/${teamId}/resend/%E0%A4%A`, { cookie, body: {} })).status).toBe(400);
    expect((await req('GET', `/api/internal/teams/${teamId}/resend/%61pi-keys`, { cookie })).status).toBe(200);
  });

  it('a failure spray across many IPs slows logins down but does not lock out valid users', async () => {
    t.config.trustProxy = true;
    try {
      for (let i = 0; i < 15; i++) {
        const r = await req('POST', '/api/internal/login', { body: { email: `x${i}@mock.test`, password: 'bad' }, headers: { 'cf-connecting-ip': `203.0.113.${i}` } });
        expect(r.status).toBe(401);
      }
      const started = Date.now();
      const ok = await login('boss@mock.test', { 'cf-connecting-ip': '198.51.100.7' });
      expect(ok.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      // Per-account limit still blocks a targeted account.
      for (let i = 0; i < 5; i++) await req('POST', '/api/internal/login', { body: { email: 'member@mock.test', password: 'bad' }, headers: { 'cf-connecting-ip': `192.0.2.${i}` } });
      expect((await login('member@mock.test', { 'cf-connecting-ip': '192.0.2.200' })).status).toBe(429);
    } finally {
      t.config.trustProxy = false;
    }
  });
  it('only platform admins can add operator-zone domains or use one-click Cloudflare', async () => {
    const { cookie } = await login('boss@mock.test');
    const T = `/api/internal/teams/${teamId}`;
    expect((await req('POST', `${T}/resend/domains`, { cookie, body: { name: 'sub.acmedemo.test' } })).status).toBe(403);
    const ext = await req('POST', `${T}/resend/domains`, { cookie, body: { name: 'boss-owned.example' } });
    expect(ext.status).toBe(201);
    expect((await req('POST', `${T}/domains/${ext.json!.id}/cloudflare`, { cookie, body: { action: 'connect' } })).status).toBe(403);
    const admin = await login('admin@mock.test');
    const d = await req('POST', `${T}/resend/domains`, { cookie: admin.cookie, body: { name: 'acmedemo.test' } });
    expect(d.status).toBe(201);
    const cf = await req('POST', `${T}/domains/${d.json!.id}/cloudflare`, { cookie: admin.cookie, body: { action: 'connect' } });
    expect(cf.json).toMatchObject({ zone: 'acmedemo.test', managed: true, sending_enabled: true });
  });
});
