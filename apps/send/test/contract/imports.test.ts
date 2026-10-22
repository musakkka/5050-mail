import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import { parseCsv } from '../../src/services/imports.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;

beforeAll(async () => {
  t = await startTestServer();
  resend = t.resend(await t.createKey(await t.createTeam('Imports')));
});
afterAll(() => t.close());

describe('contact imports (official SDK)', () => {
  it('parses quoted CSV', () => {
    expect(parseCsv('a,b\r\n"x, ""y""",2\n"multi\nline",3\n')).toEqual([['a', 'b'], ['x, "y"', '2'], ['multi\nline', '3']]);
  });

  it('imports with column map, segments, topics and conflict handling', async () => {
    const hook = await webhookReceiver();
    await resend.webhooks.create({ endpoint: hook.url, events: ['contact.created', 'contact.updated'] });
    const seg = await resend.segments.create({ name: 'Imported' });
    const topic = await resend.topics.create({ name: 'News', defaultSubscription: 'opt_out' });
    await resend.contacts.create({ email: 'existing@example.com', firstName: 'Old' });
    await t.drain();
    hook.received.length = 0;

    const csv = 'Email,First Name,Company,Seats\nnew@example.com,New,"Acme, Inc",5\nexisting@example.com,Updated,,\nnot-an-email,X,,\n';
    const r = await resend.contacts.imports.create({
      file: new Blob([csv], { type: 'text/csv' }),
      columnMap: { email: 'Email', firstName: 'First Name', properties: { company: { column: 'Company' }, seats: { column: 'Seats', type: 'number' } } },
      onConflict: 'upsert',
      segments: [{ id: seg.data!.id }],
      topics: [{ id: topic.data!.id, subscription: 'opt_in' }],
    });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ object: 'contact_import', id: expect.any(String) });
    const queued = await resend.contacts.imports.get(r.data!.id);
    expect(queued.data).toMatchObject({ object: 'contact_import', status: 'queued', completed_at: null });
    await t.drain();
    const done = await resend.contacts.imports.get(r.data!.id);
    expect(done.data).toMatchObject({ status: 'completed', counts: { total: 3, created: 1, updated: 1, skipped: 0, failed: 1 } });
    expect(done.data!.completed_at).toBeTruthy();

    const c = await resend.contacts.get({ email: 'new@example.com' });
    expect(c.data).toMatchObject({ first_name: 'New', properties: { company: { value: 'Acme, Inc', type: 'string' }, seats: { value: 5, type: 'number' } } });
    expect((await resend.contacts.get({ email: 'existing@example.com' })).data!.first_name).toBe('Updated');
    const members = await resend.contacts.list({ segmentId: seg.data!.id });
    expect(members.data!.data.map((m) => m.email).sort()).toEqual(['existing@example.com', 'new@example.com']);
    const topics = await resend.contacts.topics.list({ email: 'new@example.com' });
    expect(topics.data!.data[0]!.subscription).toBe('opt_in');
    expect(hook.received).toHaveLength(0); // imports don't emit contact webhooks

    const skip = await resend.contacts.imports.create({ file: new Blob(['email\nexisting@example.com\n']), onConflict: 'skip' });
    await t.drain();
    expect((await resend.contacts.imports.get(skip.data!.id)).data!.counts).toMatchObject({ total: 1, skipped: 1, updated: 0 });

    const list = await resend.contacts.imports.list({ status: 'completed' });
    expect(list.data!.object).toBe('list');
    expect(list.data!.data.length).toBe(2);
    const page = await resend.contacts.imports.list({ limit: 1 });
    expect(page.data!.has_more).toBe(true);
    await hook.close();
  });

  it('validates the request', async () => {
    const fd = new FormData();
    fd.append('on_conflict', 'skip');
    const missing = await fetch(`${t.apiBase}/contacts/imports`, { method: 'POST', body: fd, headers: { authorization: `Bearer ${await t.createKey(await t.createTeam('x'))}`, 'user-agent': 'test' } });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ name: 'missing_required_field', message: 'Missing `file` field.' });
    const bad = await resend.contacts.imports.create({ file: new Blob(['email\n']), onConflict: 'replace' as never });
    expect(bad.error!.name).toBe('validation_error');
    const nf = await resend.contacts.imports.get('00000000-0000-0000-0000-000000000000');
    expect(nf.error!.statusCode).toBe(404);
  });
});
