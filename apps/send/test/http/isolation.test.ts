/** Team A's data must never be visible to (or modifiable by) team B's keys or members. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let a: Resend;
let b: Resend;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await startTestServer();
  const ta = await t.createTeam('A');
  const tb = await t.createTeam('B');
  await t.verifiedDomain(ta, 'a.test');
  a = t.resend(await t.createKey(ta));
  b = t.resend(await t.createKey(tb));
  ids.email = (await a.emails.send({ from: 'x@a.test', to: 'u@example.com', subject: 'secret', html: '<p>secret</p>', attachments: [{ filename: 'f.txt', content: 'aGk=' }], scheduledAt: 'in 1 hour' })).data!.id;
  ids.attachment = (await a.emails.attachments.list({ emailId: ids.email })).data!.data[0]!.id;
  ids.domain = (await a.domains.create({ name: 'iso-a.example' })).data!.id;
  ids.key = (await a.apiKeys.create({ name: 'a-key' })).data!.id;
  ids.webhook = (await a.webhooks.create({ endpoint: 'https://example.com/h', events: ['email.sent'] })).data!.id;
  ids.segment = (await a.segments.create({ name: 'a-seg' })).data!.id;
  ids.contact = (await a.contacts.create({ email: 'person@example.com', segments: [{ id: ids.segment }] })).data!.id;
  ids.topic = (await a.topics.create({ name: 'a-topic', defaultSubscription: 'opt_in' })).data!.id;
  ids.prop = (await a.contactProperties.create({ key: 'a_prop', type: 'string' })).data!.id;
  ids.suppression = (await a.suppressions.add({ email: 'sup@example.com' })).data!.id;
});
afterAll(() => t.close());

describe('team isolation', () => {
  it('B cannot read A resources by id', async () => {
    const checks = await Promise.all([
      b.emails.get(ids.email), b.emails.attachments.get({ emailId: ids.email, id: ids.attachment }), b.emails.attachments.list({ emailId: ids.email }),
      b.domains.get(ids.domain), b.webhooks.get(ids.webhook), b.segments.get(ids.segment), b.contacts.get(ids.contact),
      b.contacts.get({ email: 'person@example.com' }), b.topics.get(ids.topic), b.contactProperties.get(ids.prop), b.suppressions.get(ids.suppression),
      b.suppressions.get('sup@example.com'), b.contacts.segments.list({ contactId: ids.contact }),
    ]);
    for (const r of checks) expect(r.error?.statusCode).toBe(404);
  });

  it('B cannot modify or delete A resources', async () => {
    expect((await b.emails.cancel(ids.email)).error!.statusCode).toBe(404);
    expect((await b.emails.update({ id: ids.email, scheduledAt: 'in 2 hours' })).error!.statusCode).toBe(404);
    expect((await b.domains.update({ id: ids.domain, openTracking: true })).error!.statusCode).toBe(404);
    expect((await b.domains.remove(ids.domain)).error!.statusCode).toBe(404);
    expect((await b.domains.verify(ids.domain)).error!.statusCode).toBe(404);
    expect((await b.apiKeys.remove(ids.key)).error!.statusCode).toBe(404);
    expect((await b.apiKeys.update(ids.key, { name: 'pwn' })).error!.statusCode).toBe(404);
    expect((await b.webhooks.update(ids.webhook, { status: 'disabled' })).error!.statusCode).toBe(404);
    expect((await b.webhooks.remove(ids.webhook)).error!.statusCode).toBe(404);
    expect((await b.topics.remove(ids.topic)).error!.statusCode).toBe(404);
    expect((await b.contactProperties.remove(ids.prop)).error!.statusCode).toBe(404);
    expect((await b.contacts.update({ id: ids.contact, firstName: 'pwn' })).error!.statusCode).toBe(404);
    await b.segments.remove(ids.segment); // answers deleted:true like Resend, but must not delete A's segment
    await b.contacts.remove(ids.contact);
    await b.suppressions.remove(ids.suppression);
    expect((await a.segments.get(ids.segment)).data!.id).toBe(ids.segment);
    expect((await a.contacts.get(ids.contact)).data!.id).toBe(ids.contact);
    expect((await a.suppressions.get(ids.suppression)).data!.id).toBe(ids.suppression);
    expect((await a.emails.get(ids.email)).data!.last_event).toBe('scheduled');
  });

  it('B lists contain none of A data', async () => {
    const lists = await Promise.all([b.emails.list(), b.domains.list(), b.apiKeys.list(), b.webhooks.list(), b.segments.list(), b.contacts.list(), b.topics.list(), b.contactProperties.list(), b.suppressions.list()]);
    const blob = JSON.stringify(lists.map((l) => l.data));
    for (const id of Object.values(ids)) expect(blob).not.toContain(id);
    expect(blob).not.toContain('person@example.com');
    // B's own request log only holds B's requests (which mention A's ids in paths), never A's.
    const logs = await b.logs.list({ limit: 100 });
    const aLogs = await a.logs.list({ limit: 100 });
    const bIds = new Set(logs.data!.data.map((l) => l.id));
    expect(aLogs.data!.data.some((l) => bIds.has(l.id))).toBe(false);
  });

  it('B cannot send from A domain', async () => {
    const r = await b.emails.send({ from: 'x@a.test', to: 'u@example.com', subject: 's', text: 't' });
    expect(r.error).toMatchObject({ statusCode: 403, name: 'validation_error' });
  });
});
