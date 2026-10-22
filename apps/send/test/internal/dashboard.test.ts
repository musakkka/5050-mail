/**
 * Dashboard internal API against a local dev Stalwart (STALWART_TEST_URL, default
 * http://localhost:18090) seeded with `npm run seed -- --users-only` from apps/webmail:
 * alice@dev.test is a Stalwart admin, bob@dev.test is not.
 * Skipped when that server isn't running or doesn't know alice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';

const STALWART = process.env.STALWART_TEST_URL ?? 'http://localhost:18090';
const ALICE = { email: 'alice@dev.test', password: 'Demo-Alice-Orchid-2026' };
const BOB = { email: 'bob@dev.test', password: 'Demo-Bob-Granite-2026' };
const up = await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: 'Basic ' + Buffer.from(`${ALICE.email}:${ALICE.password}`).toString('base64') }, signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

let t: TestServer;

class Browser {
  cookie = '';
  constructor(private base: string) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-requested-with': 'fetch', ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0]!;
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json: json as Record<string, any>, headers: r.headers };
  }
}

beforeAll(async () => {
  t = await startTestServer({ STALWART_URL: STALWART });
});
afterAll(() => t?.close());

describe.skipIf(!up)('dashboard internal API', () => {
  let teamId = '';
  const alice = () => new Browser(t.root);

  it('rejects non-members and wrong passwords; admins always get in', async () => {
    const bob = new Browser(t.root);
    expect((await bob.req('POST', '/api/internal/login', BOB)).json).toMatchObject({ error: 'no_team' });
    expect((await bob.req('POST', '/api/internal/login', { ...BOB, password: 'wrong-password' })).status).toBe(401);
    const a = alice();
    const r = await a.req('POST', '/api/internal/login', ALICE);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ email: 'alice@dev.test', isAdmin: true });
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await a.req('GET', '/api/internal/me')).json).toMatchObject({ email: 'alice@dev.test', isAdmin: true, teams: [] });
  });

  it('CSRF: custom header and same origin required', async () => {
    const a = alice();
    await a.req('POST', '/api/internal/login', ALICE);
    const r = await fetch(`${t.root}/api/internal/teams`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' }, body: '{"name":"x"}' });
    expect(r.status).toBe(403);
    const o = await a.req('POST', '/api/internal/teams', { name: 'x' }, { origin: 'https://evil.example' });
    expect(o.status).toBe(403);
  });

  it('admins create teams and manage members; members get in and use the API as their team', async () => {
    const a = alice();
    await a.req('POST', '/api/internal/login', ALICE);
    const created = await a.req('POST', '/api/internal/teams', { name: 'Bob Co', members: [{ email: 'bob@dev.test', role: 'member' }] });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Bob Co', monthly_quota: 3000, rate_limit: t.config.defaultRateLimit });
    teamId = created.json.id;
    const other = await a.req('POST', '/api/internal/teams', { name: 'Other Co' });

    const bob = new Browser(t.root);
    expect((await bob.req('POST', '/api/internal/login', BOB)).status).toBe(200);
    const me = await bob.req('GET', '/api/internal/me');
    expect(me.json.teams).toEqual([expect.objectContaining({ id: teamId, role: 'member' })]);
    expect((await bob.req('POST', '/api/internal/teams', { name: 'nope' })).status).toBe(403);
    expect((await bob.req('GET', `/api/internal/teams/${other.json.id}`)).status).toBe(404);
    expect((await bob.req('GET', `/api/internal/teams/${other.json.id}/resend/domains`)).status).toBe(404);

    // Public API through the dashboard, as the team (Resend shapes).
    const d = await bob.req('POST', `/api/internal/teams/${teamId}/resend/domains`, { name: 'bobco.example' });
    expect(d.status).toBe(201);
    expect(d.json).toMatchObject({ name: 'bobco.example', status: 'not_started' });
    const list = await bob.req('GET', `/api/internal/teams/${teamId}/resend/domains`);
    expect(list.json).toMatchObject({ object: 'list', data: [expect.objectContaining({ name: 'bobco.example' })] });
    // Members can't mint API keys; admins can, and the token is shown once.
    expect((await bob.req('POST', `/api/internal/teams/${teamId}/resend/api-keys`, { name: 'k' })).status).toBe(403);
    expect((await a.req('PATCH', `/api/internal/teams/${teamId}/members/bob@dev.test`, { role: 'admin' })).json).toEqual({ email: 'bob@dev.test', role: 'admin' });
    const key = await bob.req('POST', `/api/internal/teams/${teamId}/resend/api-keys`, { name: 'k' });
    expect(key.status).toBe(201);
    expect(key.json.token).toMatch(/^re_/);
    // Dashboard calls are not rate limited or logged as API requests.
    expect(key.headers.get('ratelimit-limit')).toBeNull();
    const logs = await bob.req('GET', `/api/internal/teams/${teamId}/logs`);
    expect(logs.json.data).toEqual([]);

    // Members can't change quotas; Stalwart admins can.
    expect((await bob.req('PATCH', `/api/internal/teams/${teamId}`, { monthly_quota: 999999 })).status).toBe(403);
    expect((await a.req('PATCH', `/api/internal/teams/${teamId}`, { monthly_quota: 5000, daily_quota: 100 })).json).toMatchObject({ monthly_quota: 5000, daily_quota: 100 });
    const usage = await bob.req('GET', `/api/internal/teams/${teamId}/usage`);
    expect(usage.json).toMatchObject({ object: 'usage', emails: { monthly: { limit: 5000 }, daily: { limit: 100 } } });

    const members = await a.req('GET', `/api/internal/teams/${teamId}/members`);
    expect(members.json.data.map((m: { email: string }) => m.email)).toEqual(['bob@dev.test']);
    for (const p of ['overview', 'metrics?days=7', 'stats/daily', 'smtp', 'integrations']) {
      expect((await bob.req('GET', `/api/internal/teams/${teamId}/${p}`)).status, p).toBe(200);
    }
    expect((await a.req('GET', '/api/internal/system')).json).toMatchObject({ transport: 'fake', cloudflareConfigured: true });

    // Removing bob locks him out of the team.
    expect((await a.req('DELETE', `/api/internal/teams/${teamId}/members/bob@dev.test`)).json).toEqual({ email: 'bob@dev.test', deleted: true });
    expect((await bob.req('GET', `/api/internal/teams/${teamId}/resend/domains`)).status).toBe(404);
    expect((await bob.req('POST', '/api/internal/logout')).json).toEqual({ ok: true });
    expect((await bob.req('GET', '/api/internal/me')).status).toBe(401);
  });

  it('dashboard-needs endpoints', async () => {
    const a = alice();
    await a.req('POST', '/api/internal/login', ALICE);
    const team = (await a.req('POST', '/api/internal/teams', { name: 'Needs Co' })).json.id as string;
    const T = `/api/internal/teams/${team}`;
    // 4. settings merge
    const st = await a.req('PATCH', T, { settings: { labs: { inboxes: true } } });
    expect(st.json.settings).toEqual({ labs: { inboxes: true } });
    // 5. docsBase
    expect((await a.req('GET', '/api/internal/system')).json.docsBase).toMatch(/\/docs$/);
    // 3. keys with preview
    const k = await a.req('POST', `${T}/resend/api-keys`, { name: 'k', permission: 'sending_access' });
    const keys = await a.req('GET', `${T}/api-keys`);
    expect(keys.json.data[0]).toMatchObject({ id: k.json.id, permission: 'sending_access', token_preview: k.json.token.slice(0, 11), created_by: 'alice@dev.test' });
    // 1. filtered emails + 2. raw + email extras
    await t.verifiedDomain(team, 'needs.test');
    const r = t.resend(k.json.token);
    const sent = await r.emails.send({ from: 'a@needs.test', to: 'zed@example.com', subject: 'Invoice 42', text: 'x' });
    await r.emails.send({ from: 'a@needs.test', to: 'other@example.com', subject: 'Other', text: 'y' });
    const f = await a.req('GET', `${T}/emails?q=invoice`);
    expect(f.json.data.map((e: { id: string }) => e.id)).toEqual([sent.data!.id]);
    expect(f.json.data[0].api_key_id).toBe(k.json.id);
    expect((await a.req('GET', `${T}/emails?status=delivered`)).json.data).toEqual([]);
    const raw = await a.req('GET', `${T}/emails/${sent.data!.id}/raw`);
    expect(raw.json.raw).toContain('Subject: Invoice 42');
    const one = await a.req('GET', `${T}/resend/emails/${sent.data!.id}`);
    expect(one.json).toMatchObject({ api_key_id: k.json.id, log_id: expect.any(String) });
    // 10. event diagnostics
    await t.drain();
    const ev = await a.req('GET', `${T}/emails/${sent.data!.id}/events`);
    expect(ev.json.data.map((e: { type: string }) => e.type)).toContain('delivered');
    // 6. one-click Cloudflare
    const d = await a.req('POST', `${T}/resend/domains`, { name: 'acmedemo.test' });
    const cf = await a.req('POST', `${T}/domains/${d.json.id}/cloudflare`, { action: 'connect' });
    expect(cf.json).toMatchObject({ zone: 'acmedemo.test', managed: true, sending_enabled: true });
    // 7. JSON import
    const seg = await a.req('POST', `${T}/resend/segments`, { name: 'S' });
    const imp = await a.req('POST', `${T}/resend/contacts/imports`, { contacts: [{ email: 'x1@example.com', first_name: 'X' }, { email: 'bad' }, { email: 'x1@example.com' }], segment_id: seg.json.id });
    expect(imp.json).toMatchObject({ imported: 1, skipped: 2 });
    expect((await a.req('GET', `${T}/resend/segments/${seg.json.id}/contacts`)).json.data).toHaveLength(1);
    // 9. suppression filters + details
    await a.req('POST', `${T}/resend/suppressions`, { email: 'blocked@example.com' });
    await a.req('POST', `${T}/resend/suppressions`, { email: 'nope@example.com' });
    const sup = await a.req('GET', `${T}/resend/suppressions?q=block&reason=manual`);
    expect(sup.json.data).toEqual([expect.objectContaining({ email: 'blocked@example.com', details: null, email_id: null })]);
  });

  it('no session → 401; placeholder page on other paths', async () => {
    expect((await new Browser(t.root).req('GET', '/api/internal/me')).status).toBe(401);
    const page = await fetch(`${t.root}/`);
    expect(await page.text()).toContain('5050 Send');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });
});
