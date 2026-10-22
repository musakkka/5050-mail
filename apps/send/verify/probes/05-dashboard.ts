/**
 * Dashboard internal API: login (real 5050-dev Stalwart for alice; a local mock Stalwart for
 * member / non-member users), CSRF + Origin, session fixation, login rate limits, cross-team access.
 */
import http from 'node:http';
import { startServer, ok, bad, info, check, j } from '../lib/harness.js';

// Mock Stalwart: users "<name>@mock.test" / password "pw"; "*admin*" users are admins.
const mock = http.createServer((req, res) => {
  const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
  const [user, pw] = [auth.slice(0, auth.indexOf(':')), auth.slice(auth.indexOf(':') + 1)];
  if (pw !== 'pw' || !user.endsWith('@mock.test')) { res.writeHead(401); return res.end(); }
  if (req.url === '/jmap/session') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ username: user, accounts: { a: { name: user, isPersonal: true, accountCapabilities: {} } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' }, capabilities: {} }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const isAdmin = user.includes('admin');
    res.end(JSON.stringify({ methodResponses: [[isAdmin ? 'x:Account/query' : 'error', isAdmin ? { ids: [] } : { type: 'forbidden' }, '0']] }));
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
const mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

async function run(stalwart: string, label: string, fn: (s: Awaited<ReturnType<typeof startServer>>) => Promise<void>) {
  const s = await startServer({ STALWART_URL: stalwart, LOGIN_RATE_LIMIT: '5', LOGIN_GLOBAL_FAIL_LIMIT: '30' });
  try { await fn(s); } catch (e) { bad(`${label}.crash`, (e as Error).stack ?? String(e)); } finally { await s.close(); }
}

const dash = (s: { root: string }) => async (method: string, path: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'user-agent': 'verify', 'x-requested-with': 'XMLHttpRequest', ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
  const r = await fetch(`${s.root}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, headers: r.headers, json, text, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
};

// ---------------- real Stalwart (5050-dev): alice is a Stalwart admin
await run('http://localhost:18090', 'real', async (s) => {
  const d = dash(s);
  const A = await s.team('A', { members: [{ email: 'alice@dev.test', role: 'admin' }] });
  let r = await d('POST', '/api/internal/login', { body: { email: 'alice@dev.test', password: 'Demo-Alice-Orchid-2026' } });
  check('dash.login-alice', r.status === 200 && r.json?.isAdmin === true, `${r.status} ${r.text}`);
  const setCookie = r.headers.get('set-cookie') ?? '';
  info('dash.cookie-flags', setCookie.replace(/=[^;]+;/, '=<sid>;'));
  check('dash.cookie-httponly', /HttpOnly/i.test(setCookie) && /SameSite=Lax|SameSite=Strict/i.test(setCookie), setCookie);
  const cookie = r.cookie;
  r = await d('GET', '/api/internal/me', { cookie });
  check('dash.me', r.status === 200, `${r.status}`);
  // CSRF: missing X-Requested-With
  r = await d('POST', `/api/internal/teams/${A}/resend/api-keys`, { cookie, body: { name: 'csrf' }, headers: { 'x-requested-with': '' } });
  check('csrf.no-xrw', r.status === 403, `${r.status} ${r.text}`);
  r = await d('POST', `/api/internal/teams/${A}/resend/api-keys`, { cookie, body: { name: 'csrf' }, headers: { origin: 'https://evil.example' } });
  check('csrf.cross-origin', r.status === 403, `${r.status} ${r.text}`);
  r = await d('POST', `/api/internal/teams/${A}/resend/api-keys`, { cookie, body: { name: 'csrf' }, headers: { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' } });
  check('csrf.spoofed-xfh', r.status === 403, `Origin evil + X-Forwarded-Host evil (TRUST_PROXY off) -> ${r.status} ${r.text.slice(0, 120)}`);
  // CORS preflight answered?
  const pf = await fetch(`${s.root}/api/internal/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with' } });
  check('cors.no-allow', !pf.headers.get('access-control-allow-origin'), `ACAO=${pf.headers.get('access-control-allow-origin')}`);
  // Session fixation: login with a pre-set cookie gets a fresh one
  r = await d('POST', '/api/internal/login', { cookie: 'send_sid=attacker-chosen-value', body: { email: 'alice@dev.test', password: 'Demo-Alice-Orchid-2026' } });
  check('session.fixation', r.cookie && !r.cookie.includes('attacker-chosen-value'), r.cookie);
  // Logout invalidates
  const c2 = r.cookie;
  await d('POST', '/api/internal/logout', { cookie: c2 });
  r = await d('GET', '/api/internal/me', { cookie: c2 });
  check('session.logout', r.status === 401, `${r.status}`);
  // Wrong password
  r = await d('POST', '/api/internal/login', { body: { email: 'alice@dev.test', password: 'wrong' } });
  check('dash.wrong-password', r.status === 401, `${r.status} ${r.text}`);
  // Stalwart password checked on every minute? (admin flag re-check) — informational
  // Dashboard passthrough not rate-limited and not logged
  const t0 = Date.now();
  const many = await Promise.all(Array.from({ length: 30 }, () => d('GET', `/api/internal/teams/${A}/resend/domains`, { cookie })));
  info('dash.passthrough-ratelimit', `30 parallel passthrough GETs: statuses ${[...new Set(many.map((m) => m.status))]} in ${Date.now() - t0}ms (team rate_limit=1000 here; dashboard calls skip the limiter entirely)`);
  // log redaction: password not in logs
  const logs = ((s.ctx as any).__logs as string[]).join('\n');
  check('logs.no-password', !logs.includes('Demo-Alice-Orchid-2026'), 'password found in server logs');
  const [sess] = await s.ctx.sql`select credential from dashboard_sessions limit 1`;
  check('session.credential-encrypted', !!sess && !String(sess.credential).includes('Acme-Alice') && !Buffer.from(String(sess.credential), 'base64url').toString().includes('Acme-Alice'), 'credential stored in clear');
});

// ---------------- mock Stalwart: member, non-member, admin-in-team scoping
await run(mockUrl, 'mock', async (s) => {
  const d = dash(s);
  const A = await s.team('A', { members: [{ email: 'member@mock.test', role: 'member' }, { email: 'teamadmin@mock.test', role: 'admin' }] });
  const B = await s.team('B', { members: [{ email: 'bob@mock.test', role: 'admin' }] });
  await s.domain(B, 'b.dash.test');
  let r = await d('POST', '/api/internal/login', { body: { email: 'nobody@mock.test', password: 'pw' } });
  check('dash.non-member-refused', r.status === 403 && !r.cookie.startsWith('send_sid='), `${r.status} ${r.text} cookie=${r.cookie}`);
  r = await d('POST', '/api/internal/login', { body: { email: 'MEMBER@mock.test', password: 'pw' } });
  check('dash.member-login', r.status === 200, `${r.status} ${r.text}`);
  const mc = r.cookie;
  // member -> team B (IDOR) across every surface
  for (const p of [`/api/internal/teams/${B}`, `/api/internal/teams/${B}/members`, `/api/internal/teams/${B}/logs`, `/api/internal/teams/${B}/emails`, `/api/internal/teams/${B}/usage`, `/api/internal/teams/${B}/resend/domains`, `/api/internal/teams/${B}/resend/api-keys`, `/api/internal/teams/${B}/overview`]) {
    r = await d('GET', p, { cookie: mc });
    check(`dash.idor GET ${p.replace(B, ':B')}`, r.status === 404 || r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
  }
  r = await d('POST', `/api/internal/teams/${B}/members`, { cookie: mc, body: { email: 'member@mock.test', role: 'admin' } });
  check('dash.idor add-self-to-B', r.status === 404 || r.status === 403, `${r.status} ${r.text}`);
  // member privilege limits inside own team
  r = await d('POST', `/api/internal/teams/${A}/resend/api-keys`, { cookie: mc, body: { name: 'x' } });
  check('dash.member-cannot-create-key', r.status === 403, `${r.status} ${r.text}`);
  r = await d('POST', `/api/internal/teams/${A}/members`, { cookie: mc, body: { email: 'member@mock.test', role: 'admin' } });
  check('dash.member-cannot-promote-self', r.status === 403, `${r.status} ${r.text}`);
  r = await d('PATCH', `/api/internal/teams/${A}`, { cookie: mc, body: { rate_limit: 100000 } });
  check('dash.member-cannot-change-quota', r.status === 403, `${r.status} ${r.text}`);
  r = await d('GET', `/api/internal/teams/${A}/resend/webhooks`, { cookie: mc });
  info('dash.member-sees-webhook-secrets', `member GET webhooks -> ${r.status}`);
  // path tricks on passthrough
  r = await d('POST', `/api/internal/teams/${A}/resend/%61pi-keys`, { cookie: mc, body: { name: 'x' } });
  check('dash.member-key-create-encoded-path', r.status === 403 || r.status === 404, `encoded /%61pi-keys -> ${r.status} ${r.text.slice(0, 120)}`);
  r = await d('POST', `/api/internal/teams/${A}/resend//api-keys`, { cookie: mc, body: { name: 'x' } });
  check('dash.member-key-create-double-slash', r.status === 403 || r.status === 404, `//api-keys -> ${r.status} ${r.text.slice(0, 120)}`);
  r = await d('POST', `/api/internal/teams/${A}/resend/API-KEYS`, { cookie: mc, body: { name: 'x' } });
  check('dash.member-key-create-uppercase', r.status === 403 || r.status === 404, `/API-KEYS -> ${r.status} ${r.text.slice(0, 120)}`);
  r = await d('POST', `/api/internal/teams/${A}/resend/api-keys/`, { cookie: mc, body: { name: 'x' } });
  check('dash.member-key-create-trailing-slash', r.status === 403 || r.status === 404, `/api-keys/ -> ${r.status} ${r.text.slice(0, 120)}`);
  // removed member's existing session
  await s.ctx.sql`delete from team_members where email = 'member@mock.test'`;
  r = await d('GET', `/api/internal/teams/${A}/resend/domains`, { cookie: mc });
  check('dash.removed-member', r.status === 404 || r.status === 403, `${r.status}`);
  // team admin removes last admin / demotes self
  r = await d('POST', '/api/internal/login', { body: { email: 'teamadmin@mock.test', password: 'pw' } });
  const tc = r.cookie;
  r = await d('DELETE', `/api/internal/teams/${A}/members/teamadmin%40mock.test`, { cookie: tc });
  info('dash.last-admin-delete', `last admin removes self -> ${r.status} ${r.text}`);
  // ---- login rate limiting
  let codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await d('POST', '/api/internal/login', { body: { email: 'victim@mock.test', password: `bad${i}` } })).status);
  check('login.per-account-limit', codes.includes(429), `8 bad passwords for one account: ${codes.join(',')}`);
  r = await d('POST', '/api/internal/login', { body: { email: 'victim@mock.test', password: 'pw' } });
  info('login.lockout-after-limit', `correct password after limit -> ${r.status}`);
  codes = [];
  for (let i = 0; i < 40; i++) codes.push((await d('POST', '/api/internal/login', { body: { email: `spray${i}@mock.test`, password: 'bad' } })).status);
  info('login.ip-limit', `40 different accounts from one IP: ${[...new Set(codes)].join(',')} first429@${codes.indexOf(429)}`);
  r = await d('POST', '/api/internal/login', { body: { email: 'bob@mock.test', password: 'pw' } });
  info('login.global-lockout', `legit user after spray (same IP) -> ${r.status} ${r.text.slice(0, 80)}`);
});

// global fail limiter is shared by all clients: a DoS across IPs (TRUST_PROXY on, varying CF-Connecting-IP)
await run(mockUrl, 'global', async (s) => {
  s.config.trustProxy = true;
  const d = dash(s);
  await s.team('A', { members: [{ email: 'legit@mock.test', role: 'admin' }] });
  for (let i = 0; i < 35; i++) await d('POST', '/api/internal/login', { body: { email: `x${i}@mock.test`, password: 'bad' }, headers: { 'cf-connecting-ip': `203.0.113.${i}` } });
  const r = await d('POST', '/api/internal/login', { body: { email: 'legit@mock.test', password: 'pw' }, headers: { 'cf-connecting-ip': '198.51.100.7' } });
  check('login.global-dos', r.status === 200, `after 35 failures from 35 IPs, a legitimate user from a fresh IP gets ${r.status} ${r.text.slice(0, 100)}`);
});
mock.close();
