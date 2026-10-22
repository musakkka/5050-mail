import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Resend } from 'resend';
import { startTestServer, type TestServer } from '../helpers.js';

let t: TestServer;
let resend: Resend;
let templateId: string;

beforeAll(async () => {
  t = await startTestServer();
  t.clock.now = new Date();
  const team = await t.createTeam('Auto');
  await t.verifiedDomain(team, 'auto.test');
  resend = t.resend(await t.createKey(team));
  const tpl = await resend.templates.create({
    name: 'welcome', from: 'Team <hi@auto.test>', subject: 'Welcome {{{NAME}}}',
    html: '<p>Hi {{{NAME}}} ({{{contact.first_name|friend}}})</p>', variables: [{ key: 'NAME', type: 'string', fallbackValue: 'you' }],
  }).publish();
  templateId = tpl.data!.id;
});
afterAll(() => t.close());

const welcome = () => ({
  name: 'Welcome series',
  steps: [
    { key: 'start', type: 'trigger' as const, config: { eventName: 'user.created' } },
    { key: 'wait', type: 'delay' as const, config: { duration: '1 hour' } },
    { key: 'mail', type: 'send_email' as const, config: { template: { id: templateId, variables: { NAME: { var: 'event.name' } } } } },
  ],
  connections: [{ from: 'start', to: 'wait' }, { from: 'wait', to: 'mail' }],
});

describe('events (official SDK)', () => {
  it('creates, reads by id and name, lists, updates and deletes events', async () => {
    const c = await resend.events.create({ name: 'user.created', schema: { name: 'string', age: 'number' } });
    expect(c.data).toEqual({ object: 'event', id: expect.any(String) });
    const byId = await resend.events.get(c.data!.id);
    expect(byId.data).toMatchObject({ object: 'event', id: c.data!.id, name: 'user.created', schema: { name: 'string', age: 'number' } });
    const byName = await resend.events.get('user.created');
    expect(byName.data!.id).toBe(c.data!.id);
    const l = await resend.events.list();
    expect(l.data!.data.map((e) => e.name)).toContain('user.created');
    const u = await resend.events.update('user.created', { schema: { name: 'string' } });
    expect(u.data).toEqual({ object: 'event', id: c.data!.id });
    const dup = await resend.events.create({ name: 'user.created' });
    expect(dup.error!.name).toBe('validation_error');
    const reserved = await resend.events.create({ name: 'resend:x' });
    expect(reserved.error!.statusCode).toBe(422);
    const tmp = await resend.events.create({ name: 'tmp.event' });
    const d = await resend.events.remove(tmp.data!.id);
    expect(d.data).toEqual({ object: 'event', id: tmp.data!.id, deleted: true });
  });

  it('validates send', async () => {
    const both = await resend.events.send({ event: 'x', email: 'a@example.com', contactId: '00000000-0000-0000-0000-000000000000' } as never);
    expect(both.error).toMatchObject({ statusCode: 422, name: 'validation_error' });
    const missing = await resend.events.send({ email: 'a@example.com' } as never);
    expect(missing.error).toMatchObject({ name: 'missing_required_field' });
    const ok = await resend.events.send({ event: 'nobody.listens', email: 'a@example.com' });
    expect(ok.data).toEqual({ object: 'event', event: 'nobody.listens' });
  });
});

describe('automations (official SDK)', () => {
  it('CRUD, duplicate, stop and list filters', async () => {
    const c = await resend.automations.create(welcome());
    expect(c.error).toBeNull();
    expect(c.data).toEqual({ object: 'automation', id: expect.any(String) });
    const g = await resend.automations.get(c.data!.id);
    expect(g.data).toMatchObject({
      object: 'automation', name: 'Welcome series', status: 'disabled',
      steps: [{ key: 'start', type: 'trigger', config: { event_name: 'user.created' } }, { key: 'wait', type: 'delay', config: { duration: '1 hour' } }, expect.anything()],
      connections: [{ from: 'start', to: 'wait', type: 'default' }, { from: 'wait', to: 'mail', type: 'default' }],
    });
    const u = await resend.automations.update(c.data!.id, { name: 'Renamed', status: 'enabled' });
    expect(u.data).toEqual({ object: 'automation', id: c.data!.id });
    const graphWhileEnabled = await resend.automations.update(c.data!.id, { steps: welcome().steps, connections: welcome().connections });
    expect(graphWhileEnabled.error!.name).toBe('validation_error');
    const enabled = await resend.automations.list({ status: 'enabled' });
    expect(enabled.data!.data.map((a) => a.id)).toContain(c.data!.id);
    const dup = await resend.automations.duplicate(c.data!.id);
    expect(dup.data).toEqual({ object: 'automation', id: expect.any(String) });
    const dg = await resend.automations.get(dup.data!.id);
    expect(dg.data).toMatchObject({ name: 'Renamed (Copy)', status: 'disabled' });
    const s = await resend.automations.stop(c.data!.id);
    expect(s.data).toEqual({ object: 'automation', id: c.data!.id, status: 'disabled' });
    const disabled = await resend.automations.list({ status: 'disabled' });
    expect(disabled.data!.data.length).toBeGreaterThanOrEqual(2);
    const del = await resend.automations.remove(dup.data!.id);
    expect(del.data).toEqual({ object: 'automation', id: dup.data!.id, deleted: true });
    await resend.automations.remove(c.data!.id);
  });

  it('rejects invalid graphs', async () => {
    const noTrigger = await resend.automations.create({ name: 'x', steps: [{ key: 'd', type: 'delay', config: { duration: '1 hour' } }], connections: [] });
    expect(noTrigger.error!.name).toBe('validation_error');
    const badConn = await resend.automations.create({ name: 'x', steps: [{ key: 's', type: 'trigger', config: { eventName: 'e' } }], connections: [{ from: 's', to: 'nope' }] });
    expect(badConn.error!.name).toBe('validation_error');
    const longDelay = await resend.automations.create({ name: 'x', steps: [{ key: 's', type: 'trigger', config: { eventName: 'e' } }, { key: 'd', type: 'delay', config: { duration: '31 days' } }], connections: [{ from: 's', to: 'd' }] });
    expect(longDelay.error!.name).toBe('validation_error');
    const noName = await resend.automations.create({ steps: [], connections: [] } as never);
    expect(noName.error!.name).toBe('missing_required_field');
  });

  it('runs trigger → delay → send_email and exposes runs', async () => {
    const c = await resend.automations.create({ ...welcome(), status: 'enabled' });
    const id = c.data!.id;
    const sent = await resend.events.send({ event: 'user.created', email: 'new@example.com', payload: { name: 'Ada' } });
    expect(sent.data).toEqual({ object: 'event', event: 'user.created' });
    await t.drain();
    let runs = await resend.automations.runs.list({ automationId: id });
    expect(runs.data!.data).toHaveLength(1);
    const runId = runs.data!.data[0]!.id;
    expect(runs.data!.data[0]!.status).toBe('running');
    let run = await resend.automations.runs.get({ automationId: id, runId });
    expect(run.data!.object).toBe('automation_run');
    expect(run.data!.steps.map((s) => [s.key, s.status])).toEqual([['start', 'completed'], ['wait', 'waiting']]);
    // contact was created automatically
    const contact = await resend.contacts.get({ email: 'new@example.com' });
    expect(contact.data!.email).toBe('new@example.com');

    t.clock.advance(3600_000 + 1000);
    await t.drain();
    run = await resend.automations.runs.get({ automationId: id, runId });
    expect(run.data!.status).toBe('completed');
    expect(run.data!.completed_at).toBeTruthy();
    const mail = run.data!.steps.find((s) => s.key === 'mail')!;
    expect(mail.status).toBe('completed');
    const emailId = (mail.output as { email_id: string }).email_id;
    const email = await resend.emails.get(emailId);
    expect(email.data).toMatchObject({ to: ['new@example.com'], subject: 'Welcome Ada', from: 'Team <hi@auto.test>' });
    expect(email.data!.html).toContain('Hi Ada (friend)');

    runs = await resend.automations.runs.list({ automationId: id, status: ['completed', 'failed'] });
    expect(runs.data!.data).toHaveLength(1);
    const none = await resend.automations.runs.list({ automationId: id, status: 'running' });
    expect(none.data!.data).toHaveLength(0);
    const bad = await resend.automations.runs.list({ automationId: id, status: 'nope' as never });
    expect(bad.error!.name).toBe('validation_error');
    await resend.automations.stop(id);
  });

  it('branches on conditions, waits for events (filter + timeout), updates contacts and segments', async () => {
    const seg = await resend.segments.create({ name: 'VIP' });
    await resend.contactProperties.create({ key: 'company', type: 'string' });
    const c = await resend.automations.create({
      name: 'Orders',
      status: 'enabled',
      steps: [
        { key: 'start', type: 'trigger', config: { eventName: 'order.created' } },
        { key: 'big', type: 'condition', config: { type: 'and', rules: [{ type: 'rule', field: 'event.amount', operator: 'gte', value: 100 }, { type: 'rule', field: 'contact.email', operator: 'ends_with', value: '@example.com' }] } },
        { key: 'vip', type: 'add_to_segment', config: { segmentId: seg.data!.id } },
        { key: 'upd', type: 'contact_update', config: { firstName: { var: 'event.first' }, properties: { company: { var: 'event.company' } } } },
        { key: 'paid', type: 'wait_for_event', config: { eventName: 'order.paid', timeout: '1 day', filterRule: { type: 'rule', field: 'event.order_id', operator: 'eq', value: { var: 'event.order_id' } } } as never },
        { key: 'thanks', type: 'send_email', config: { template: { id: templateId, variables: { NAME: { var: 'wait_events.order.paid.who' } } }, subject: 'Thanks' } },
        { key: 'bye', type: 'contact_delete', config: {} },
      ],
      connections: [
        { from: 'start', to: 'big' },
        { from: 'big', to: 'vip', type: 'condition_met' },
        { from: 'big', to: 'upd', type: 'condition_not_met' },
        { from: 'vip', to: 'upd' },
        { from: 'upd', to: 'paid' },
        { from: 'paid', to: 'thanks', type: 'event_received' },
        { from: 'paid', to: 'bye', type: 'timeout' },
      ],
    });
    expect(c.error).toBeNull();
    const id = c.data!.id;

    // Big order, paid (filter must match the same order_id).
    await resend.events.send({ event: 'order.created', email: 'big@example.com', payload: { amount: 150, order_id: 'o1', first: 'Grace', company: 'Acme' } });
    // Small order that will time out.
    await resend.events.send({ event: 'order.created', email: 'small@example.com', payload: { amount: 5, order_id: 'o2', first: 'Tim', company: 'Initech' } });
    await t.drain();
    const big = await resend.contacts.get({ email: 'big@example.com' });
    expect(big.data).toMatchObject({ first_name: 'Grace', properties: { company: { value: 'Acme', type: 'string' } } });
    const segs = await resend.contacts.segments.list({ email: 'big@example.com' });
    expect(segs.data!.data.map((s) => s.id)).toEqual([seg.data!.id]);
    const smallSegs = await resend.contacts.segments.list({ email: 'small@example.com' });
    expect(smallSegs.data!.data).toHaveLength(0);

    // Wrong order id doesn't resume.
    await resend.events.send({ event: 'order.paid', email: 'big@example.com', payload: { order_id: 'zzz', who: 'nobody' } });
    await t.drain();
    let runs = await resend.automations.runs.list({ automationId: id, status: 'running' });
    expect(runs.data!.data).toHaveLength(2);
    await resend.events.send({ event: 'order.paid', contactId: big.data!.id, payload: { order_id: 'o1', who: 'Grace!' } });
    await t.drain();
    runs = await resend.automations.runs.list({ automationId: id, status: 'completed' });
    expect(runs.data!.data).toHaveLength(1);
    const doneRun = await resend.automations.runs.get({ automationId: id, runId: runs.data!.data[0]!.id });
    const thanks = doneRun.data!.steps.find((s) => s.key === 'thanks')!;
    const em = await resend.emails.get((thanks.output as { email_id: string }).email_id);
    expect(em.data).toMatchObject({ subject: 'Thanks', to: ['big@example.com'] });
    expect(em.data!.html).toContain('Grace!');
    expect(doneRun.data!.steps.find((s) => s.key === 'big')!.output).toEqual({ result: true });

    // Timeout path deletes the small contact.
    t.clock.advance(86400_000 + 1000);
    await t.drain();
    runs = await resend.automations.runs.list({ automationId: id, status: 'completed' });
    expect(runs.data!.data).toHaveLength(2);
    const gone = await resend.contacts.get({ email: 'small@example.com' });
    expect(gone.error!.statusCode).toBe(404);

    // Stop cancels running runs.
    await resend.events.send({ event: 'order.created', email: 'third@example.com', payload: { amount: 1, order_id: 'o3' } });
    await t.drain();
    await resend.automations.stop(id);
    const cancelled = await resend.automations.runs.list({ automationId: id, status: 'cancelled' });
    expect(cancelled.data!.data).toHaveLength(1);
  });

  it('marks a run failed when a step fails', async () => {
    const c = await resend.automations.create({
      name: 'Broken', status: 'enabled',
      steps: [
        { key: 's', type: 'trigger', config: { eventName: 'break.me' } },
        { key: 'u', type: 'contact_update', config: { properties: { undefined_prop: 'x' } } },
      ],
      connections: [{ from: 's', to: 'u' }],
    });
    await resend.events.send({ event: 'break.me', email: 'x@example.com' });
    await t.drain();
    const runs = await resend.automations.runs.list({ automationId: c.data!.id });
    const run = await resend.automations.runs.get({ automationId: c.data!.id, runId: runs.data!.data[0]!.id });
    expect(run.data!.status).toBe('failed');
    expect(run.data!.steps.find((s) => s.key === 'u')).toMatchObject({ status: 'failed', error: { message: expect.any(String) } });
  });
});
