import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Contacts');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('segments / audiences', () => {
  it('CRUD with Resend shapes and quirks', async () => {
    const s = await resend.segments.create({ name: 'Registered' });
    expect(s.data).toEqual({ object: 'segment', id: expect.any(String), name: 'Registered' });
    const g = await resend.segments.get(s.data!.id);
    expect(g.data).toEqual({ object: 'segment', id: s.data!.id, name: 'Registered', created_at: expect.stringMatching(/\+00$/) });
    expect((await resend.segments.update(s.data!.id, { name: 'Reg' })).data).toEqual({ object: 'segment', id: s.data!.id });
    expect((await resend.segments.list()).data!.data[0]!.name).toBe('Reg');
    expect((await resend.segments.create({} as never)).error).toEqual({ statusCode: 422, message: 'Missing `name` field.', name: 'missing_required_field' });
    expect((await resend.segments.get('00000000-0000-0000-0000-000000000000')).error).toEqual({ statusCode: 404, message: 'Audience not found', name: 'not_found' });
    expect((await resend.segments.remove('00000000-0000-0000-0000-000000000000')).data).toEqual({ object: 'segment', id: '00000000-0000-0000-0000-000000000000', deleted: true });
    expect((await resend.audiences.list()).data!.object).toBe('list');
  });
});

describe('contacts', () => {
  it('create with segments, topics and properties; get by id and email; update; delete', async () => {
    const seg = await resend.segments.create({ name: 'S' });
    const topic = await resend.topics.create({ name: 'News', defaultSubscription: 'opt_out' });
    expect(topic.data).toEqual({ object: 'topic', id: expect.any(String) } as never);
    const prop = await resend.contactProperties.create({ key: 'company', type: 'string', fallbackValue: 'unknown' });
    expect(prop.data).toEqual({ object: 'contact_property', id: expect.any(String) });

    const c = await resend.contacts.create({
      email: 'steve@example.com', firstName: 'Steve', lastName: 'W', properties: { company: 'Acme' },
      segments: [{ id: seg.data!.id }], topics: [{ id: topic.data!.id, subscription: 'opt_in' }],
    });
    expect(c.data).toEqual({ object: 'contact', id: expect.any(String) });
    const byEmail = await resend.contacts.get({ email: 'steve@example.com' });
    expect(byEmail.data).toEqual({
      object: 'contact', id: c.data!.id, email: 'steve@example.com', first_name: 'Steve', last_name: 'W',
      created_at: expect.stringMatching(/\+00$/), unsubscribed: false, properties: { company: { value: 'Acme', type: 'string' } },
    });
    expect((await resend.contacts.get(c.data!.id)).data!.email).toBe('steve@example.com');

    const segs = await resend.contacts.segments.list({ contactId: c.data!.id });
    expect(segs.data!.data.map((x) => x.id)).toEqual([seg.data!.id]);
    const topics = await resend.contacts.topics.list({ email: 'steve@example.com' });
    expect(topics.data!.data[0]).toMatchObject({ id: topic.data!.id, name: 'News', subscription: 'opt_in' });
    const ut = await resend.contacts.topics.update({ id: c.data!.id, topics: [{ id: topic.data!.id, subscription: 'opt_out' }] });
    expect(ut.data).toEqual({ object: 'contact_topics', id: c.data!.id } as never);

    const up = await resend.contacts.update({ email: 'steve@example.com', firstName: null, unsubscribed: true });
    expect(up.data).toEqual({ object: 'contact', id: c.data!.id });
    const after = await resend.contacts.get(c.data!.id);
    expect(after.data).toMatchObject({ first_name: null, unsubscribed: true });

    const seg2 = await resend.segments.create({ name: 'S2' });
    expect((await resend.contacts.segments.add({ email: 'steve@example.com', segmentId: seg2.data!.id })).data).toEqual({ id: seg2.data!.id });
    expect((await resend.contacts.list({ segmentId: seg2.data!.id })).data!.data).toHaveLength(1);
    const rm = await resend.contacts.segments.remove({ contactId: c.data!.id, segmentId: seg2.data!.id });
    expect(rm.data).toMatchObject({ id: c.data!.id, deleted: true });

    const del = await resend.contacts.remove({ email: 'steve@example.com' });
    expect(del.data).toEqual({ object: 'contact', contact: 'steve@example.com', deleted: true });
    expect((await resend.contacts.get(c.data!.id)).error).toEqual({ statusCode: 404, message: 'Contact not found', name: 'not_found' });
  });

  it('legacy audience paths and upsert behaviour', async () => {
    const a = await resend.segments.create({ name: 'Legacy' });
    const c1 = await resend.contacts.create({ audienceId: a.data!.id, email: 'legacy@example.com', firstName: 'L' });
    const c2 = await resend.contacts.create({ email: 'legacy@example.com' });
    expect(c2.data!.id).toBe(c1.data!.id);
    const g = await resend.contacts.get({ audienceId: a.data!.id, email: 'legacy@example.com' });
    expect(g.data!.first_name).toBe('L');
    expect((await resend.contacts.update({ audienceId: a.data!.id, id: c1.data!.id, lastName: 'X' })).error).toBeNull();
    const list = await resend.contacts.list({ audienceId: a.data!.id, limit: 5 });
    expect(list.data!.data).toHaveLength(1);
    expect((await resend.contacts.remove({ audienceId: a.data!.id, id: '00000000-0000-0000-0000-000000000000' })).data!.deleted).toBe(true);
    expect((await resend.contacts.create({} as never)).error).toEqual({ statusCode: 422, message: 'Missing `email` field.', name: 'missing_required_field' });
    expect((await resend.contacts.create({ email: 'p@example.com', properties: { nope: 1 } })).error!.name).toBe('validation_error');
  });
});

describe('topics and contact properties', () => {
  it('topics CRUD', async () => {
    const t1 = await resend.topics.create({ name: 'Product', description: 'Updates', defaultSubscription: 'opt_in' });
    const g = await resend.topics.get(t1.data!.id);
    expect(g.data).toMatchObject({ object: 'topic', id: t1.data!.id, name: 'Product', description: 'Updates', default_subscription: 'opt_in', visibility: 'private' });
    expect((await resend.topics.update({ id: t1.data!.id, name: 'Product 2' })).data).toEqual({ object: 'topic', id: t1.data!.id } as never);
    const list = await resend.topics.list();
    expect((list.data as unknown as { object: string }).object).toBe('list');
    expect(list.data!.data.find((x) => x.id === t1.data!.id)!.name).toBe('Product 2');
    expect((await resend.topics.remove(t1.data!.id)).data).toEqual({ object: 'topic', id: t1.data!.id, deleted: true });
    expect((await resend.topics.create({ name: 'x' } as never)).error!.name).toBe('missing_required_field');
  });

  it('contact properties CRUD', async () => {
    const p = await resend.contactProperties.create({ key: 'plan_size', type: 'number', fallbackValue: 1 });
    const g = await resend.contactProperties.get(p.data!.id);
    expect(g.data).toEqual({ object: 'contact_property', id: p.data!.id, key: 'plan_size', type: 'number', fallbackValue: 1, createdAt: expect.any(String) });
    expect((await resend.contactProperties.update({ id: p.data!.id, fallbackValue: 5 })).data).toEqual({ object: 'contact_property', id: p.data!.id });
    const list = await resend.contactProperties.list();
    expect(list.data!.data.find((x) => x.id === p.data!.id)!.fallbackValue).toBe(5);
    expect((await resend.contactProperties.remove(p.data!.id)).data).toEqual({ object: 'contact_property', id: p.data!.id, deleted: true });
    expect((await resend.contactProperties.create({ key: 'bad key', type: 'string' })).error!.name).toBe('validation_error');
  });
});

describe('suppressions, logs, usage, metrics, oauth grants', () => {
  it('suppressions', async () => {
    const a = await resend.suppressions.add({ email: 'blocked@example.com' });
    expect(a.data).toEqual({ object: 'suppression', id: expect.any(String) });
    const g = await resend.suppressions.get('blocked@example.com');
    expect(g.data).toMatchObject({ object: 'suppression', email: 'blocked@example.com', origin: 'manual', source_id: null });
    const b = await resend.suppressions.batch.add({ emails: ['x1@example.com', 'x2@example.com'] });
    expect(b.data!.data).toHaveLength(2);
    const l = await resend.suppressions.list({ origin: 'manual' });
    expect(l.data!.data.length).toBe(3);
    const r = await resend.suppressions.batch.remove({ emails: ['x1@example.com'] });
    expect(r.data!.data[0]).toMatchObject({ object: 'suppression', deleted: true });
    expect((await resend.suppressions.remove(a.data!.id)).data).toEqual({ object: 'suppression', id: a.data!.id, deleted: true });

    // Suppressed recipients aren't sent to.
    await t.verifiedDomain(team, 'sup.test');
    const e = await resend.emails.send({ from: 'a@sup.test', to: 'x2@example.com', subject: 's', text: 't' });
    await t.drain();
    expect((await resend.emails.get(e.data!.id)).data!.last_event).toBe('suppressed');
  });

  it('logs capture requests with redaction', async () => {
    await resend.apiKeys.create({ name: 'logged' });
    const list = await resend.logs.list({ limit: 5 });
    expect(list.data!.data[0]).toMatchObject({ endpoint: expect.any(String), method: expect.any(String), response_status: expect.any(Number), user_agent: expect.stringContaining('resend-node') });
    const createLog = list.data!.data.find((l) => l.endpoint === '/api-keys' && l.method === 'POST')!;
    const one = await resend.logs.get(createLog.id);
    expect(one.data!.object).toBe('log');
    expect(JSON.stringify(one.data!.response_body)).toContain('[REDACTED]');
    expect(JSON.stringify(one.data!.response_body)).not.toMatch(/re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/);
  });

  it('usage', async () => {
    const u = await resend.usage.get();
    expect(u.data).toMatchObject({ object: 'usage', emails: { monthly: { limit: 3000 }, daily: { limit: null } }, rate_limit: { limit: 1000, duration: '1000ms' } });
  });

  it('metrics', async () => {
    const m = await resend.emails.metrics({ metrics: ['sent', 'delivered', 'delivery_rate'], dimensions: ['period', 'domain'] });
    expect(m.data).toMatchObject({ object: 'metrics', metrics: ['sent', 'delivered', 'delivery_rate'], dimensions: ['period', 'domain'], granularity: 'daily' });
    expect(Array.isArray(m.data!.data)).toBe(true);
    const totals = await resend.emails.metrics();
    expect(totals.data!.data).toBeUndefined();
    expect(Object.keys(totals.data!.totals)).toContain('complaint_rate');
    const bad = await resend.emails.metrics({ dimensions: ['email', 'broadcast'] as never });
    expect(bad.error!.name).toBe('validation_error');
  });

  it('oauth grants', async () => {
    const l = await resend.oauthGrants.list();
    expect(l.data).toEqual({ object: 'list', has_more: false, data: [] });
    expect((await resend.oauthGrants.revoke('00000000-0000-0000-0000-000000000000')).error!.name).toBe('not_found');
  });
});
