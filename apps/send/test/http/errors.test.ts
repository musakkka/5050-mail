import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';

let t: TestServer;
let team: string;
let key: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Errors');
  await t.verifiedDomain(team, 'err.test');
  key = await t.createKey(team);
});
afterAll(() => t.close());

const json = async (r: Response) => ({ status: r.status, body: await r.json() });

describe('auth errors', () => {
  it('missing, malformed and unknown keys', async () => {
    expect(await json(await t.fetch('/domains'))).toEqual({ status: 401, body: { statusCode: 401, name: 'missing_api_key', message: expect.stringContaining('Missing API key') } });
    expect(await json(await t.fetch('/domains', { headers: { authorization: 'Basic abc' } }))).toMatchObject({ status: 400, body: { name: 'validation_error', message: 'API key is invalid' } });
    expect(await json(await t.fetch('/domains', { key: 're_garbage' }))).toMatchObject({ status: 400, body: { name: 'validation_error' } });
    const unknown = ('re_' + 'A'.repeat(8) + '_' + 'B'.repeat(24));
    expect((await json(await t.fetch('/domains', { key: unknown }))).status).toBe(400);
    const send = await t.fetch('/emails', { key: unknown, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't' }) });
    expect(await json(send)).toMatchObject({ status: 401, body: { name: 'validation_error', message: 'API key is invalid' } });
  });

  it('requires a User-Agent (Cloudflare 1010)', async () => {
    const r = await fetch(`${t.apiBase}/domains`, { headers: { authorization: `Bearer ${key}`, 'user-agent': '' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('error code: 1010');
  });

  it('unknown endpoints and methods', async () => {
    expect(await json(await t.fetch('/nope', { key }))).toEqual({ status: 404, body: { statusCode: 404, message: 'The requested endpoint does not exist.', name: 'not_found' } });
    expect(await json(await t.fetch('/api-keys/00000000-0000-0000-0000-000000000000', { key, method: 'GET' }))).toEqual({ status: 405, body: { statusCode: 405, message: 'Method is not allowed for the requested path.', name: 'method_not_allowed' } });
  });

  it('invalid JSON and invalid UUIDs', async () => {
    expect((await t.fetch('/emails', { key, method: 'POST', body: '{nope' })).status).toBe(400);
    expect(await json(await t.fetch('/emails/abc', { key }))).toMatchObject({ status: 422, body: { name: 'invalid_parameter', message: 'The `id` must be a valid UUID.' } });
  });
});

describe('pagination validation', () => {
  it('limit range and after+before', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc']) {
      expect(await json(await t.fetch(`/emails?${q}`, { key }))).toMatchObject({ status: 422, body: { name: 'validation_error', message: expect.stringContaining('between 1 and 100') } });
    }
    const both = await t.fetch('/emails?after=00000000-0000-0000-0000-000000000000&before=00000000-0000-0000-0000-000000000000', { key });
    expect((await json(both)).status).toBe(422);
  });
});

describe('rate limits and quotas', () => {
  it('2 requests per second by default with ratelimit-* headers', async () => {
    const tm = await t.createTeam('RL', { rate_limit: 2 });
    const k = await t.createKey(tm);
    // Start right after a window boundary so the three requests share one 1s window.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 20));
    const rs = await Promise.all([1, 2, 3].map(() => t.fetch('/domains', { key: k })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([200, 200, 429]);
    const limited = rs.find((r) => r.status === 429)!;
    expect(limited.headers.get('ratelimit-limit')).toBe('2');
    expect(limited.headers.get('ratelimit-policy')).toBe('2;w=1');
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await limited.json()) as { name: string }).name).toBe('rate_limit_exceeded');
    const ok = rs.find((r) => r.status === 200)!;
    expect(ok.headers.get('ratelimit-reset')).toMatch(/^\d+$/);
  });

  it('monthly and daily quotas', async () => {
    const tm = await t.createTeam('Q', { monthly_quota: 2, daily_quota: null });
    await t.verifiedDomain(tm, 'q.test');
    const k = await t.createKey(tm);
    const send = () => t.fetch('/emails', { key: k, method: 'POST', body: JSON.stringify({ from: 'a@q.test', to: 'b@example.com', subject: 's', text: 't' }) });
    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.headers.get('x-resend-monthly-quota')).toBe('2');
    expect(second.headers.get('x-resend-daily-quota')).toBeNull();
    expect(await json(await send())).toMatchObject({ status: 429, body: { name: 'monthly_quota_exceeded' } });

    const td = await t.createTeam('D', { daily_quota: 1 });
    await t.verifiedDomain(td, 'd.test');
    const kd = await t.createKey(td);
    const s2 = () => t.fetch('/emails', { key: kd, method: 'POST', body: JSON.stringify({ from: 'a@d.test', to: 'b@example.com', subject: 's', text: 't' }) });
    const first = await s2();
    expect(first.headers.get('x-resend-daily-quota')).toBe('1');
    expect(await json(await s2())).toMatchObject({ status: 429, body: { name: 'daily_quota_exceeded' } });
  });
});

describe('sending limits', () => {
  it('40MB per email and idempotency key length', async () => {
    const big = Buffer.alloc(31 * 1024 * 1024).toString('base64'); // ~41MB after base64
    const r = await t.fetch('/emails', { key, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't', attachments: [{ filename: 'a.bin', content: big }] }) });
    expect(await json(r)).toMatchObject({ status: 422, body: { name: 'validation_error' } });
    const idem = await t.fetch('/emails', { key, method: 'POST', headers: { 'idempotency-key': 'x'.repeat(257) }, body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't' }) });
    expect(await json(idem)).toMatchObject({ status: 400, body: { name: 'invalid_idempotency_key' } });
    const att = await t.fetch('/emails', { key, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't', attachments: [{ filename: 'x' }] }) });
    expect(await json(att)).toMatchObject({ status: 422, body: { name: 'invalid_attachment' } });
    const many = await t.fetch('/emails', { key, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`), subject: 's', text: 't' }) });
    expect((await json(many)).status).toBe(422);
    const past = await t.fetch('/emails', { key, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't', scheduled_at: '2001-01-01T00:00:00Z' }) });
    expect((await json(past)).status).toBe(422);
    const far = await t.fetch('/emails', { key, method: 'POST', body: JSON.stringify({ from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't', scheduled_at: 'in 40 days' }) });
    expect((await json(far)).status).toBe(422);
  });

  it('batch rejects attachments and more than 100 emails', async () => {
    const one = { from: 'a@err.test', to: 'b@example.com', subject: 's', text: 't' };
    const att = await t.fetch('/emails/batch', { key, method: 'POST', body: JSON.stringify([{ ...one, attachments: [{ filename: 'a', content: 'aGk=' }] }]) });
    expect((await json(att)).status).toBe(422);
    const lots = await t.fetch('/emails/batch', { key, method: 'POST', body: JSON.stringify(Array.from({ length: 101 }, () => one)) });
    expect((await json(lots)).status).toBe(422);
  });
});
