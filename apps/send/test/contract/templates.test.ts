import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Resend } from 'resend';
import { startTestServer, type TestServer } from '../helpers.js';

let t: TestServer;
let resend: Resend;

beforeAll(async () => {
  t = await startTestServer();
  const team = await t.createTeam('Tpl');
  await t.verifiedDomain(team, 'tpl.test');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('templates (official SDK)', () => {
  it('creates, reads, lists, updates, publishes, duplicates and deletes', async () => {
    const created = await resend.templates.create({
      name: 'order-confirmation',
      alias: 'order-confirmation',
      from: 'Shop <orders@tpl.test>',
      subject: 'Order {{{ORDER_ID}}}',
      html: '<p>Hi {{{NAME}}}, total {{{PRICE}}}</p>',
      replyTo: ['help@tpl.test'],
      variables: [
        { key: 'ORDER_ID', type: 'string' },
        { key: 'NAME', type: 'string', fallbackValue: 'there' },
        { key: 'PRICE', type: 'number', fallbackValue: 10 },
      ],
    });
    expect(created.error).toBeNull();
    expect(created.data).toEqual({ id: expect.any(String), object: 'template' });
    const id = created.data!.id;

    const got = await resend.templates.get(id);
    expect(got.data).toMatchObject({
      object: 'template', id, name: 'order-confirmation', alias: 'order-confirmation', status: 'draft', published_at: null,
      from: 'Shop <orders@tpl.test>', subject: 'Order {{{ORDER_ID}}}', reply_to: ['help@tpl.test'], text: null, has_unpublished_versions: false,
    });
    expect(got.data!.variables).toHaveLength(3);
    expect(got.data!.variables![1]).toMatchObject({ key: 'NAME', type: 'string', fallback_value: 'there', id: expect.any(String) });
    expect(got.data!.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/);

    const byAlias = await resend.templates.get('order-confirmation');
    expect(byAlias.data!.id).toBe(id);

    const listed = await resend.templates.list({ limit: 10 });
    expect(listed.data!.object).toBe('list');
    expect(listed.data!.data[0]).toEqual({
      id, name: 'order-confirmation', status: 'draft', published_at: null, created_at: expect.any(String), updated_at: expect.any(String), alias: 'order-confirmation',
    });

    // Not published yet → cannot send.
    const early = await resend.emails.send({ to: 'a@example.com', template: { id, variables: { ORDER_ID: '1' } } });
    expect(early.error).toMatchObject({ statusCode: 404, name: 'not_found' });

    const pub = await resend.templates.publish(id);
    expect(pub.data).toEqual({ object: 'template', id });
    const afterPub = await resend.templates.get(id);
    expect(afterPub.data!.status).toBe('published');
    expect(afterPub.data!.published_at).toBeTruthy();

    const upd = await resend.templates.update(id, { subject: 'Your order {{{ORDER_ID}}}' });
    expect(upd.data).toEqual({ object: 'template', id });
    const afterUpd = await resend.templates.get(id);
    expect(afterUpd.data!.has_unpublished_versions).toBe(true);
    expect(afterUpd.data!.current_version_id).not.toBe(afterPub.data!.current_version_id);

    const dup = await resend.templates.duplicate(id);
    expect(dup.data).toEqual({ object: 'template', id: expect.any(String) });
    const dupPub = await resend.templates.duplicate('order-confirmation').publish();
    expect(dupPub.data!.object).toBe('template');
    const d2 = await resend.templates.get(dupPub.data!.id);
    expect(d2.data).toMatchObject({ status: 'published', name: 'order-confirmation (Copy)', alias: null });

    const chained = await resend.templates.create({ name: 'chain', html: '<p>x</p>' }).publish();
    expect(chained.data!.object).toBe('template');

    const del = await resend.templates.remove(dup.data!.id);
    expect(del.data).toEqual({ object: 'template', id: dup.data!.id, deleted: true });
    const gone = await resend.templates.get(dup.data!.id);
    expect(gone.error).toMatchObject({ statusCode: 404, name: 'not_found' });
  });

  it('validates input like Resend', async () => {
    const noName = await resend.templates.create({ html: '<p>x</p>' } as never);
    expect(noName.error).toMatchObject({ statusCode: 422, name: 'missing_required_field', message: 'Missing `name` field.' });
    const noHtml = await resend.templates.create({ name: 'x' } as never);
    expect(noHtml.error).toMatchObject({ name: 'missing_required_field' });
    const reserved = await resend.templates.create({ name: 'x', html: 'x', variables: [{ key: 'FIRST_NAME', type: 'string' }] });
    expect(reserved.error).toMatchObject({ statusCode: 422, name: 'validation_error' });
    const tooMany = await resend.templates.create({ name: 'x', html: 'x', variables: Array.from({ length: 51 }, (_, i) => ({ key: `V${i}`, type: 'string' as const })) });
    expect(tooMany.error!.name).toBe('validation_error');
    const badFallback = await resend.templates.create({ name: 'x', html: 'x', variables: [{ key: 'N', type: 'number', fallbackValue: 'nope' as never }] });
    expect(badFallback.error!.name).toBe('validation_error');
  });

  it('sends with a published template (variables, fallbacks, errors)', async () => {
    const { data } = await resend.templates.create({
      name: 'welcome', alias: 'welcome', from: 'Team <hi@tpl.test>', subject: 'Welcome {{{NAME}}}',
      html: '<h1>Hello {{{NAME}}}</h1><p>Plan: {{{PLAN}}}</p>',
      variables: [{ key: 'NAME', type: 'string' }, { key: 'PLAN', type: 'string', fallbackValue: 'free' }],
    }).publish();
    const sent = await resend.emails.send({ to: 'u@example.com', template: { id: 'welcome', variables: { NAME: 'Ada <3' } } });
    expect(sent.error).toBeNull();
    const e = await resend.emails.get(sent.data!.id);
    expect(e.data).toMatchObject({ from: 'Team <hi@tpl.test>', subject: 'Welcome Ada <3' });
    expect(e.data!.html).toBe('<h1>Hello Ada &lt;3</h1><p>Plan: free</p>');
    expect(e.data!.text).toContain('Hello Ada <3');

    const override = await resend.emails.send({ from: 'Other <x@tpl.test>', subject: 'Custom', to: 'u@example.com', template: { id: data!.id, variables: { NAME: 'B' } } });
    const o = await resend.emails.get(override.data!.id);
    expect(o.data).toMatchObject({ from: 'Other <x@tpl.test>', subject: 'Custom' });

    const missing = await resend.emails.send({ to: 'u@example.com', template: { id: 'welcome' } });
    expect(missing.error).toMatchObject({ statusCode: 422, name: 'validation_error' });
    expect(missing.error!.message).toContain('NAME');

    const both = await resend.emails.send({ to: 'u@example.com', html: '<p>x</p>', template: { id: 'welcome', variables: { NAME: 'x' } } } as never);
    expect(both.error).toMatchObject({ statusCode: 422, name: 'validation_error' });

    await t.drain();
    expect(t.transport.sent.length).toBeGreaterThanOrEqual(2);
  });
});
