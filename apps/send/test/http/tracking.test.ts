import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import { applyCfEvents, mapCfEvent, pollAnalytics, analyticsState } from '../../src/services/analytics.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Track');
  await t.verifiedDomain(team, 'track.test', { open_tracking: true, click_tracking: true });
  await t.verifiedDomain(team, 'notrack.test');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('open and click tracking', () => {
  it('records opens and clicks and fires webhooks', async () => {
    const rx = await webhookReceiver();
    await resend.webhooks.create({ endpoint: rx.url, events: ['email.opened', 'email.clicked'] });
    const { data } = await resend.emails.send({ from: 'a@track.test', to: 'u@example.com', subject: 'T', html: '<html><body><a href="https://example.com/landing?x=1&amp;y=2">go</a></body></html>' });
    await t.drain();
    const raw = t.transport.sent.at(-1)!.raw.toString().replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    const pixel = /src="([^"]*\/t\/o\/[^"]+)"/.exec(raw)![1]!;
    const click = /href="([^"]*\/t\/c\/[^"]+)"/.exec(raw)![1]!;
    const p = await fetch(pixel);
    expect(p.headers.get('content-type')).toBe('image/gif');
    const c = await fetch(click, { redirect: 'manual', headers: { 'user-agent': 'TestBrowser/1.0' } });
    expect(c.status).toBe(302);
    expect(c.headers.get('location')).toBe('https://example.com/landing?x=1&y=2');
    const tampered = await fetch(click.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), { redirect: 'manual' });
    expect(tampered.status).toBe(404);
    await t.drain();
    const e = await resend.emails.get(data!.id);
    expect(e.data!.last_event).toBe('clicked');
    const types = rx.received.map((r) => JSON.parse(r.body).type);
    expect(types).toEqual(['email.opened', 'email.clicked']);
    const clicked = JSON.parse(rx.received[1]!.body);
    expect(clicked.data.click).toMatchObject({ link: 'https://example.com/landing?x=1&y=2', userAgent: 'TestBrowser/1.0', ipAddress: expect.any(String), timestamp: expect.any(String) });
    await rx.close();
  });

  it('does not track when the domain has tracking off', async () => {
    await resend.emails.send({ from: 'a@notrack.test', to: 'u@example.com', subject: 'T', html: '<a href="https://example.com">go</a>' });
    await t.drain();
    const raw = t.transport.sent.at(-1)!.raw.toString();
    expect(raw).not.toContain('/t/o/');
    expect(raw).not.toContain('/t/c/');
  });
});

describe('Cloudflare analytics poller', () => {
  it('maps Cloudflare statuses', () => {
    expect(mapCfEvent({ datetime: 'x', status: 'delivered' })!.type).toBe('delivered');
    expect(mapCfEvent({ datetime: 'x', status: 'deliveryFailed', errorDetail: '550 5.1.1 user unknown' })).toMatchObject({ type: 'bounced', extra: { bounce: { type: 'Permanent' } } });
    expect(mapCfEvent({ datetime: 'x', status: 'deliveryFailed', errorDetail: '451 4.2.0 mailbox busy' })!.type).toBe('delivery_delayed');
    expect(mapCfEvent({ datetime: 'x', status: 'rejected' })!.type).toBe('suppressed');
    expect(mapCfEvent({ datetime: 'x', status: 'sent' })).toBeNull();
  });

  it('handles "not authorized" gracefully, then works once authorized', async () => {
    const fake = t.ctx.cfFake!;
    fake.analyticsAuthorized = false;
    expect((await pollAnalytics(t.ctx)).status).toBe('unauthorized');
    let st = await analyticsState(t.ctx);
    expect(st.authorized).toBe(false);
    expect(st.last_error).toContain('not authorized');
    expect((await pollAnalytics(t.ctx)).status).toBe('skipped'); // backing off

    const { data } = await resend.emails.send({ from: 'a@notrack.test', to: 'bounce-me@example.com', subject: 'x', text: 'x' });
    t.transport.bounce.clear();
    await t.drain();
    const [row] = await t.ctx.sql`select provider_message_id from emails where id = ${data!.id}`;
    fake.analyticsAuthorized = true;
    fake.analyticsEvents = [{ datetime: new Date().toISOString(), messageId: row!.provider_message_id, status: 'deliveryFailed', errorDetail: '550 5.1.1 no such user', to: 'bounce-me@example.com' }];
    t.clock.advance(3600_000 + 1000);
    const r = await pollAnalytics(t.ctx);
    expect(r).toEqual({ status: 'ok', applied: 1 });
    st = await analyticsState(t.ctx);
    expect(st.authorized).toBe(true);
    // Duplicate polls are de-duplicated.
    expect((await applyCfEvents(t.ctx, fake.analyticsEvents as never)) ).toBe(0);
    t.clock.now = null;
    const e = await resend.emails.get(data!.id);
    expect(e.data!.last_event).toBe('bounced');
    expect((await resend.suppressions.get('bounce-me@example.com')).data!.origin).toBe('bounce');
  });
});

describe('inbound ingest', () => {
  it('POST /inbound stores the email and fires email.received', async () => {
    const tm = await t.createTeam('Inbound');
    const r2 = t.resend(await t.createKey(tm));
    const d = await r2.domains.create({ name: 'in.example', capabilities: { receiving: 'enabled', sending: 'disabled' } });
    expect(d.error).toBeNull();
    const rx = await webhookReceiver();
    await r2.webhooks.create({ endpoint: rx.url, events: ['email.received'] });
    const mime = ['From: Sender <s@example.org>', 'To: help@in.example', 'Subject: Help', 'Message-ID: <abc@example.org>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'hi there', '--b', 'Content-Type: text/plain; name=a.txt', 'Content-Disposition: attachment; filename=a.txt', '', 'file', '--b--', ''].join('\r\n');
    const unauth = await fetch(`${t.apiBase}/inbound`, { method: 'POST', body: mime });
    expect(unauth.status).toBe(401);
    const push = () => fetch(`${t.apiBase}/inbound`, { method: 'POST', body: mime, headers: { authorization: 'Bearer inbound-test-secret', 'content-type': 'message/rfc822' } });
    // Not routed until the receiving MX is verified.
    expect((await push()).status).toBe(404);
    expect((await r2.emails.receiving.list()).data!.data).toEqual([]);
    t.dns.set('in.example', { mx: [{ exchange: t.config.inboundMxHost, priority: 10 }] });
    await r2.domains.verify(d.data!.id);
    await t.drain();
    expect((await r2.domains.get(d.data!.id)).data!.status).toBe('verified');
    const res = await push();
    expect(res.status).toBe(200);
    await t.drain();
    const list = await r2.emails.receiving.list();
    expect(list.data!.data[0]).toMatchObject({ from: 's@example.org', to: ['help@in.example'], subject: 'Help', message_id: '<abc@example.org>' });
    const one = await r2.emails.receiving.get(list.data!.data[0]!.id);
    expect(one.data).toMatchObject({ object: 'email', text: 'hi there', attachments: [{ filename: 'a.txt' }] });
    const att = await r2.emails.receiving.attachments.list({ emailId: one.data!.id });
    expect(att.data!.data[0]!.download_url).toBeTruthy();
    const raw = await fetch(one.data!.raw!.download_url);
    expect(await raw.text()).toContain('Subject: Help');
    expect(JSON.parse(rx.received[0]!.body)).toMatchObject({ type: 'email.received', data: { from: 's@example.org', subject: 'Help', attachments: [{ filename: 'a.txt' }] } });
    await rx.close();
  });
});
