import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import { classifyBounce, mapStalwartEvent, parseEventsBody, type StalwartEvent } from '../../src/services/stalwartEvents.js';
import { parseQueueId } from '../../src/transport/index.js';

const SECRET = 'stalwart-events-test-secret';

/** Shape captured from Stalwart v0.16.27 (delivery.dsn-success); the failure events carry the same envelope. */
const ev = (type: string, queueId: string, data: Record<string, unknown> = {}, createdAt = '2026-10-22T23:11:35Z'): StalwartEvent => ({
  id: `${type}-${queueId}-${JSON.stringify(data)}`,
  createdAt,
  type,
  data: { spanId: 1, queueId, queueName: 'local', from: 'a@stw.test', size: 1659, total: 1, ...data },
});

describe('Stalwart event mapper (unit)', () => {
  it('keeps 64-bit queue ids exact', () => {
    const raw = '{"events":[{"id":"1","createdAt":"2026-10-22T23:10:58Z","type":"delivery.dsn-success","data":{"queueId":336447458712229376,"to":"admin@dev.test"}}]}';
    expect(JSON.parse(raw).events[0].data.queueId).not.toBe(336447458712229376n.toString()); // plain JSON.parse rounds it
    const [e] = parseEventsBody(raw);
    expect(e!.data.queueId).toBe('336447458712229376');
    expect(mapStalwartEvent(e!)).toMatchObject({ queueId: '336447458712229376', type: 'delivered', recipients: ['admin@dev.test'] });
  });

  it('reads the queue id from the 250 reply (hex) as the decimal Stalwart reports', () => {
    expect(parseQueueId('250 2.0.0 Message queued with id 4ab4d2e5e201600.')).toBe('336447458712229376');
    expect(parseQueueId('250 OK')).toBeUndefined();
  });

  it('maps outcomes', () => {
    expect(mapStalwartEvent(ev('delivery.dsn-success', '5', { to: 'u@x.com', code: 250 }))?.type).toBe('delivered');
    expect(mapStalwartEvent(ev('delivery.dsn-temp-fail', '5', { to: 'u@x.com', code: 451, details: '4.7.1 greylisted' }))).toMatchObject({ type: 'delivery_delayed', scope: 'recipient' });
    expect(mapStalwartEvent(ev('queue.rescheduled', '5', { to: ['a@x.com', 'b@x.com'] }))).toMatchObject({ type: 'delivery_delayed', scope: 'message', recipients: ['a@x.com', 'b@x.com'] });
    expect(mapStalwartEvent(ev('queue.blob-not-found', '5'))).toMatchObject({ type: 'failed' });
    expect(mapStalwartEvent(ev('delivery.attempt-start', '5', { to: ['a@x.com'] }))).toBeNull();
    expect(mapStalwartEvent(ev('delivery.dsn-success', 'abc', { to: 'u@x.com' }))).toBeNull();
    expect(mapStalwartEvent(ev('delivery.dsn-success', '5', {}))).toBeNull();
  });

  it('classifies bounces in Resend vocabulary', () => {
    expect(classifyBounce('550 5.1.1 User unknown', 550)).toMatchObject({ type: 'Permanent', subType: 'NoEmail' });
    expect(classifyBounce('552 5.2.2 Mailbox full', 552)).toMatchObject({ type: 'Transient', subType: 'MailboxFull' });
    expect(classifyBounce('552 5.3.4 Message too large', 552)).toMatchObject({ type: 'Transient', subType: 'MessageTooLarge' });
    expect(classifyBounce('550 5.7.1 Message rejected as spam', 550)).toMatchObject({ type: 'Transient', subType: 'ContentRejected' });
    expect(classifyBounce('Delivery expired after too many attempts')).toMatchObject({ type: 'Transient', subType: 'General' });
    expect(classifyBounce('550 5.0.0 Rejected', 550)).toMatchObject({ type: 'Permanent', subType: 'General' });
    expect(classifyBounce('')).toMatchObject({ type: 'Permanent', subType: 'General' });
  });
});

describe('POST /internal/stalwart-events', () => {
  let t: TestServer;
  let team: string;
  let key: string;
  let url: string;
  beforeAll(async () => {
    t = await startTestServer({ STALWART_EVENTS_SECRET: SECRET });
    t.transport.queueOnly = true; // like SMTP: accepted == queued, the mail server reports the outcome
    team = await t.createTeam('Stw');
    await t.verifiedDomain(team, 'stw.test');
    key = await t.createKey(team);
    url = `${t.root}/internal/stalwart-events`;
  });
  afterAll(() => t.close());

  const post = (events: StalwartEvent[], auth: string | null = `Bearer ${SECRET}`) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ events }) });
  const sendMail = async (to: string[], extra: Record<string, unknown> = {}) => {
    t.transport.clear();
    const r = await t.fetch('/emails', { method: 'POST', key, body: JSON.stringify({ from: 'a@stw.test', to, subject: 's', text: 't', ...extra }) });
    const { id } = (await r.json()) as { id: string };
    await t.drain();
    return { id, queueId: t.transport.sent.find((m) => m.emailId === id)!.queueId };
  };
  const timeline = async (id: string) =>
    (await t.ctx.sql`select type, recipient, data from email_events where email_id = ${id} order by created_at, id`).map((r) => ({ type: r.type as string, to: r.recipient as string | null, data: r.data as Record<string, any> }));
  const last = async (id: string) => (await t.ctx.sql`select last_event from emails where id = ${id}`)[0]!.last_event as string;

  it('rejects missing or wrong credentials, and is not served on the public hosts', async () => {
    expect((await post([], null)).status).toBe(401);
    expect((await post([], 'Bearer nope')).status).toBe(401);
    expect((await post([], `Basic ${SECRET}`)).status).toBe(401);
    expect((await post([])).status).toBe(200);
    for (const host of ['sendapi.test', 'send.test']) {
      const r = await new Promise<number>((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const u = new URL(url);
          const q = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          q.on('error', reject);
          q.end('{"events":[]}');
        });
      });
      expect(r).toBe(404);
    }
  });

  it('is disabled (503) when no secret is configured', async () => {
    const off = await startTestServer();
    try {
      const r = await fetch(`${off.root}/internal/stalwart-events`, { method: 'POST', headers: { authorization: 'Bearer anything' }, body: '{"events":[]}' });
      expect(r.status).toBe(503);
    } finally {
      await off.close();
    }
  });

  it('rejects malformed bodies', async () => {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: 'not json' });
    expect(r.status).toBe(400);
  });

  it('records the queue id and a stable Message-ID at submission', async () => {
    const { id, queueId } = await sendMail(['u1@example.com']);
    const [row] = await t.ctx.sql`select smtp_queue_id, message_id from emails where id = ${id}`;
    expect(row!.smtp_queue_id).toBe(queueId);
    expect(row!.message_id).toMatch(new RegExp(`^<${id}@stw\\.test>$`));
    expect(t.transport.sent[0]!.raw.toString()).toContain(`Message-ID: ${row!.message_id}`);
    expect(await last(id)).toBe('sent');
  });

  it('delivered: timeline, last_event, webhook, and idempotent on redelivery', async () => {
    const rx = await webhookReceiver();
    const hook = await t.resend(key).webhooks.create({ endpoint: rx.url, events: ['email.delivered', 'email.bounced', 'email.delivery_delayed', 'email.failed'] });
    const { id, queueId } = await sendMail(['u2@example.com']);
    const batch = [ev('delivery.dsn-success', queueId, { to: 'u2@example.com', hostname: 'mx.example.com', code: 250, details: 'OK' })];
    expect(await (await post(batch)).json()).toMatchObject({ ok: true, applied: 1 });
    await t.drain();
    expect(await last(id)).toBe('delivered');
    expect((await timeline(id)).map((e) => e.type)).toEqual(['queued', 'sent', 'delivered']);
    expect(rx.received).toHaveLength(1);
    const payload = JSON.parse(rx.received[0]!.body);
    expect(payload.type).toBe('email.delivered');
    expect(payload.data).toMatchObject({ email_id: id, to: ['u2@example.com'] });
    // Stalwart retries a batch: nothing new.
    expect(await (await post(batch)).json()).toMatchObject({ applied: 0 });
    await t.drain();
    expect(rx.received).toHaveLength(1);
    expect((await timeline(id)).filter((e) => e.type === 'delivered')).toHaveLength(1);
    await t.resend(key).webhooks.remove(hook.data!.id);
    await rx.close();
  });

  it('hard bounce: bounce type/subType/message, suppression list, webhook', async () => {
    const rx = await webhookReceiver();
    const hook = await t.resend(key).webhooks.create({ endpoint: rx.url, events: ['email.bounced', 'suppression.added'] });
    const { id, queueId } = await sendMail(['gone@example.com']);
    await post([ev('delivery.dsn-perm-fail', queueId, { to: 'gone@example.com', hostname: 'mx.example.com', code: 550, details: '550 5.1.1 User unknown' })]);
    await t.drain();
    expect(await last(id)).toBe('bounced');
    const b = (await timeline(id)).find((e) => e.type === 'bounced')!;
    expect(b.to).toBe('gone@example.com');
    expect(b.data.bounce).toMatchObject({ type: 'Permanent', subType: 'NoEmail', message: expect.stringContaining('User unknown') });
    const sup = await t.ctx.sql`select origin, source_id from suppressions where team_id = ${team} and lower(email) = 'gone@example.com'`;
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ origin: 'bounce', source_id: id });
    const types = rx.received.map((r) => JSON.parse(r.body).type).sort();
    expect(types).toEqual(['email.bounced', 'suppression.added']);
    // The next email to that address is suppressed, not sent.
    t.transport.clear();
    const r2 = await t.fetch('/emails', { method: 'POST', key, body: JSON.stringify({ from: 'a@stw.test', to: ['gone@example.com'], subject: 's', text: 't' }) });
    const again = (await r2.json()) as { id: string };
    await t.drain();
    expect(t.transport.sent).toHaveLength(0);
    expect(await last(again.id)).toBe('suppressed');
    await t.resend(key).webhooks.remove(hook.data!.id);
    await rx.close();
  });

  it('a transient bounce does not suppress', async () => {
    const { id, queueId } = await sendMail(['full@example.com']);
    await post([ev('delivery.dsn-perm-fail', queueId, { to: 'full@example.com', code: 552, details: '552 5.2.2 Mailbox full' })]);
    expect((await timeline(id)).find((e) => e.type === 'bounced')!.data.bounce).toMatchObject({ type: 'Transient', subType: 'MailboxFull' });
    expect(await t.ctx.sql`select 1 from suppressions where team_id = ${team} and lower(email) = 'full@example.com'`).toHaveLength(0);
  });

  it('delivery_delayed fires once per recipient and never after the outcome', async () => {
    const { id, queueId } = await sendMail(['slow@example.com']);
    await post([ev('delivery.dsn-temp-fail', queueId, { to: 'slow@example.com', code: 451, details: '451 4.7.1 try later' })]);
    await post([ev('queue.rescheduled', queueId, { to: ['slow@example.com'] }, '2026-10-22T23:12:00Z')]);
    expect(await last(id)).toBe('delivery_delayed');
    expect((await timeline(id)).filter((e) => e.type === 'delivery_delayed')).toHaveLength(1);
    await post([ev('delivery.dsn-success', queueId, { to: 'slow@example.com', code: 250 }, '2026-10-22T23:30:00Z')]);
    expect(await last(id)).toBe('delivered');
    await post([ev('queue.rescheduled', queueId, { to: ['slow@example.com'] }, '2026-10-22T23:40:00Z')]);
    expect(await last(id)).toBe('delivered');
    expect((await timeline(id)).map((e) => e.type)).toEqual(['queued', 'sent', 'delivery_delayed', 'delivered']);
  });

  it('multiple recipients: one event per recipient, outcomes independent, newest wins', async () => {
    const { id, queueId } = await sendMail(['ok@example.com', 'bad@example.com'], { cc: ['late@example.com'] });
    await post([
      ev('delivery.dsn-success', queueId, { to: 'ok@example.com', code: 250 }, '2026-10-22T23:11:00Z'),
      ev('delivery.dsn-perm-fail', queueId, { to: 'bad@example.com', code: 550, details: '550 5.1.1 no such user' }, '2026-10-22T23:11:05Z'),
      // rescheduled lists every recipient: only the one without an outcome is delayed
      ev('queue.rescheduled', queueId, { to: ['ok@example.com', 'bad@example.com', 'late@example.com'] }, '2026-10-22T23:11:10Z'),
    ]);
    const tl = await timeline(id);
    expect(tl.filter((e) => e.type === 'sent')[0]!.data.recipients).toHaveLength(3);
    expect(tl.filter((e) => e.type !== 'sent' && e.type !== 'queued').map((e) => `${e.type}:${e.to}`)).toEqual(['delivered:ok@example.com', 'bounced:bad@example.com', 'delivery_delayed:late@example.com']);
    expect(await last(id)).toBe('delivery_delayed');
    await post([ev('delivery.dsn-success', queueId, { to: 'LATE@example.com', code: 250 }, '2026-10-22T23:20:00Z')]);
    expect(await last(id)).toBe('delivered');
    const sup = await t.ctx.sql`select lower(email) as e from suppressions where team_id = ${team} and source_id = ${id}`;
    expect(sup.map((r) => r.e)).toEqual(['bad@example.com']);
  });

  it('events that beat the queue id bookkeeping are parked and applied once it is stored', async () => {
    const queueId = '336447999999999999';
    expect(await (await post([ev('delivery.dsn-success', queueId, { to: 'early@example.com', code: 250 })])).json()).toMatchObject({ applied: 0, parked: 1 });
    t.transport.clear();
    t.transport.queueOnly = true;
    const r = await t.fetch('/emails', { method: 'POST', key, body: JSON.stringify({ from: 'a@stw.test', to: ['early@example.com'], subject: 's', text: 't' }) });
    const { id } = (await r.json()) as { id: string };
    await t.ctx.sql`update emails set smtp_queue_id = null where id = ${id}`; // (not yet sent)
    // Simulate the worker storing the id: pending events replay, `sent` stays first in the timeline.
    const { replayPendingStalwartEvents } = await import('../../src/services/stalwartEvents.js');
    await t.ctx.sql`update emails set smtp_queue_id = ${queueId}, sent_at = now(), last_event = 'sent' where id = ${id}`;
    expect(await replayPendingStalwartEvents(t.ctx, queueId)).toBe(1);
    expect(await last(id)).toBe('delivered');
  });

  it('events for mail Send did not submit are ignored quietly', async () => {
    const res = await (await post([ev('delivery.dsn-success', '336447555555555555', { to: 'x@y.com' })])).json();
    expect(res).toMatchObject({ ok: true, applied: 0 });
  });
});
