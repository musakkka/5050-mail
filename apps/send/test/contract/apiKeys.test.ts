import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Keys');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('api keys (official SDK)', () => {
  it('creates (token shown once), lists, updates, removes', async () => {
    const { data } = await resend.apiKeys.create({ name: 'Production' });
    expect(data!.token).toMatch(/^re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}$/);
    const [row] = await t.ctx.sql`select token_hash from api_keys where id = ${data!.id}`;
    expect(Buffer.isBuffer(row!.token_hash)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(data!.token);

    const list = await resend.apiKeys.list();
    const item = list.data!.data.find((k) => k.id === data!.id)!;
    expect(item).toEqual({ id: data!.id, name: 'Production', created_at: expect.stringMatching(/\+00$/), last_used_at: null });
    expect(JSON.stringify(list.data)).not.toContain('re_');

    const upd = await resend.apiKeys.update(data!.id, { name: 'Prod' });
    expect(upd.data).toEqual({ object: 'api_key', id: data!.id });

    // The new key works and updates last_used_at.
    const k = t.resend(data!.token);
    expect((await k.domains.list()).error).toBeNull();
    const after = await resend.apiKeys.list();
    expect(after.data!.data.find((x) => x.id === data!.id)!.last_used_at).not.toBeNull();

    const del = await resend.apiKeys.remove(data!.id);
    expect(del.data).toEqual({ object: 'api_key', id: data!.id, deleted: true });
    const gone = await k.domains.list();
    expect(gone.error).toMatchObject({ statusCode: 400, name: 'validation_error', message: 'API key is invalid' });
    const missing = await resend.apiKeys.remove('00000000-0000-0000-0000-000000000000');
    expect(missing.error).toEqual({ statusCode: 404, message: 'API key not found', name: 'not_found' });
  });

  it('empty names are allowed, missing names are not, max 50 chars', async () => {
    expect((await resend.apiKeys.create({ name: '' })).error).toBeNull();
    expect((await resend.apiKeys.create({} as never)).error!.name).toBe('missing_required_field');
    expect((await resend.apiKeys.create({ name: 'x'.repeat(51) })).error!.name).toBe('validation_error');
  });

  it('sending_access keys can only send; domain-scoped keys only from their domain', async () => {
    const d1 = await t.verifiedDomain(team, 'one.test');
    await t.verifiedDomain(team, 'two.test');
    const sending = t.resend((await resend.apiKeys.create({ name: 's', permission: 'sending_access' })).data!.token);
    expect((await sending.emails.send({ from: 'a@two.test', to: 'x@example.com', subject: 's', text: 't' })).error).toBeNull();
    const restricted = await sending.domains.list();
    expect(restricted.error).toEqual({ statusCode: 401, message: 'This API key is restricted to only send emails.', name: 'restricted_api_key' });
    expect((await sending.emails.list()).error!.name).toBe('restricted_api_key');
    expect((await sending.apiKeys.create({ name: 'x' })).error!.name).toBe('restricted_api_key');

    const scoped = t.resend((await resend.apiKeys.create({ name: 'd', permission: 'sending_access', domain_id: d1 })).data!.token);
    expect((await scoped.emails.send({ from: 'a@one.test', to: 'x@example.com', subject: 's', text: 't' })).error).toBeNull();
    const other = await scoped.emails.send({ from: 'a@two.test', to: 'x@example.com', subject: 's', text: 't' });
    expect(other.error).toMatchObject({ statusCode: 403, name: 'validation_error' });
    const batch = await scoped.batch.send([{ from: 'a@two.test', to: 'x@example.com', subject: 's', text: 't' }]);
    expect(batch.error!.statusCode).toBe(403);

    const fullWithDomain = await resend.apiKeys.create({ name: 'f', permission: 'full_access', domain_id: d1 });
    expect(fullWithDomain.error!.name).toBe('validation_error');
  });
});
