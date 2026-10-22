import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Webhook } from 'svix';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Hooks');
  await t.verifiedDomain(team, 'hooks.test');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('webhooks (official SDK + svix)', () => {
  it('CRUD + signing secret', async () => {
    const created = await resend.webhooks.create({ endpoint: 'https://example.com/handler', events: ['email.sent'] });
    expect(created.data).toMatchObject({ object: 'webhook', signing_secret: expect.stringMatching(/^whsec_/) });
    const got = await resend.webhooks.get(created.data!.id);
    expect(got.data).toMatchObject({ object: 'webhook', status: 'enabled', endpoint: 'https://example.com/handler', events: ['email.sent'], signing_secret: created.data!.signing_secret });
    const list = await resend.webhooks.list();
    expect(list.data!.data[0]).toEqual({ id: created.data!.id, created_at: expect.any(String), status: 'enabled', endpoint: 'https://example.com/handler', events: ['email.sent'] });
    expect((await resend.webhooks.update(created.data!.id, { status: 'disabled', events: ['email.sent', 'email.delivered'] })).data).toEqual({ object: 'webhook', id: created.data!.id });
    const rotated = await resend.webhooks.rotateSigningSecret(created.data!.id);
    expect(rotated.data!.signing_secret).not.toBe(created.data!.signing_secret);
    expect((await resend.webhooks.remove(created.data!.id)).data).toEqual({ object: 'webhook', id: created.data!.id, deleted: true });
    expect((await resend.webhooks.create({ endpoint: 'https://x.test', events: ['email.nope' as never] })).error!.name).toBe('validation_error');
  });

  it('delivers signed events verifiable with svix and the Resend SDK, retries, replays', async () => {
    let fail = true;
    const rx = await webhookReceiver(() => (fail ? 500 : 200));
    const hook = await resend.webhooks.create({ endpoint: rx.url, events: ['email.sent', 'email.delivered', 'domain.created'] });
    const secret = hook.data!.signing_secret;

    const sent = await resend.emails.send({ from: 'Acme <hi@hooks.test>', to: 'u@example.com', subject: 'Hook', text: 'x', tags: [{ name: 'k', value: 'v' }] });
    await t.drain();
    expect(rx.received.length).toBe(2); // sent + delivered, first attempt failed with 500
    const first = rx.received[0]!;
    expect(first.headers['svix-id']).toMatch(/^msg_[0-9A-Za-z]{27}$/);
    const wh = new Webhook(secret);
    // svix v2 throws on a bad signature and returns nothing on success.
    expect(() => wh.verify(first.body, {
      'svix-id': first.headers['svix-id'] as string,
      'svix-timestamp': first.headers['svix-timestamp'] as string,
      'svix-signature': first.headers['svix-signature'] as string,
    })).not.toThrow();
    expect(() => wh.verify(first.body + ' ', { 'svix-id': first.headers['svix-id'] as string, 'svix-timestamp': first.headers['svix-timestamp'] as string, 'svix-signature': first.headers['svix-signature'] as string })).toThrow();
    const payload = JSON.parse(first.body) as { type: string; created_at: string; data: Record<string, unknown> };
    expect(payload.type).toBe('email.sent');
    expect(payload.data).toMatchObject({ email_id: sent.data!.id, from: 'Acme <hi@hooks.test>', to: ['u@example.com'], subject: 'Hook', tags: { k: 'v' } });
    expect(payload.created_at).toMatch(/Z$/);
    // The Resend SDK helper verifies the same headers.
    expect(resend.webhooks.verify({ payload: first.body, webhookSecret: secret, headers: { id: first.headers['svix-id'] as string, timestamp: first.headers['svix-timestamp'] as string, signature: first.headers['svix-signature'] as string } })).toBeTruthy();

    const events = await resend.webhooks.events.list({ webhookId: hook.data!.id });
    expect(events.data!.data.map((e) => e.status)).toEqual(['attempting', 'attempting']);
    const ev = events.data!.data.find((e) => e.type === 'email.sent')!;
    const detail = await resend.webhooks.events.get({ webhookId: hook.data!.id, eventId: ev.id });
    expect(detail.data).toMatchObject({ object: 'webhook_event', id: ev.id, status: 'attempting', payload: { type: 'email.sent' } });
    expect(detail.data!.next_attempt_at).toBeTruthy();

    // Retry after 5 seconds succeeds with the same svix-id.
    fail = false;
    t.clock.advance(6_000);
    await t.drain();
    expect(rx.received.length).toBe(4);
    expect(rx.received.filter((r) => r.headers['svix-id'] === first.headers['svix-id'])).toHaveLength(2);
    const ok = await resend.webhooks.events.get({ webhookId: hook.data!.id, eventId: ev.id });
    expect(ok.data!.status).toBe('success');
    expect(ok.data!.next_attempt_at).toBeNull();
    const attempts = await resend.webhooks.events.attempts.list({ webhookId: hook.data!.id, eventId: ev.id });
    expect(attempts.data!.data.map((a) => a.http_status_code)).toEqual([200, 500]);
    expect(attempts.data!.data[0]!.id).toMatch(/^atmpt_/);

    const rep = await resend.webhooks.events.replay({ webhookId: hook.data!.id, eventId: ev.id });
    expect(rep.data).toEqual({ object: 'webhook_event', id: ev.id });
    await t.drain();
    expect(rx.received.length).toBe(5);

    // Secret rotation: both secrets verify for 24h.
    const rot = await resend.webhooks.rotateSigningSecret(hook.data!.id);
    await resend.domains.create({ name: 'hooks-rotate.example' });
    await t.drain();
    const last = rx.received.at(-1)!;
    const hdr = { 'svix-id': last.headers['svix-id'] as string, 'svix-timestamp': last.headers['svix-timestamp'] as string, 'svix-signature': last.headers['svix-signature'] as string };
    expect(() => new Webhook(secret).verify(last.body, hdr)).not.toThrow();
    expect(() => new Webhook(rot.data!.signing_secret).verify(last.body, hdr)).not.toThrow();
    await rx.close();
  });

  it('gives up after the documented retry schedule', async () => {
    const rx = await webhookReceiver(() => 503);
    const hook = await resend.webhooks.create({ endpoint: rx.url, events: ['email.sent'] });
    await resend.emails.send({ from: 'hi@hooks.test', to: 'u@example.com', subject: 'x', text: 'x' });
    await t.drain();
    for (const ms of [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000]) {
      t.clock.advance(ms + 1000);
      await t.drain();
    }
    expect(rx.received.length).toBe(8);
    const events = await resend.webhooks.events.list({ webhookId: hook.data!.id });
    expect(events.data!.data[0]!.status).toBe('failed');
    await rx.close();
  });

  it('refuses private endpoints when not in test mode', async () => {
    t.config.allowPrivateWebhooks = false;
    const r = await resend.webhooks.create({ endpoint: 'http://127.0.0.1:8080/x', events: ['email.sent'] });
    expect(r.error!.name).toBe('validation_error');
    const r2 = await resend.webhooks.create({ endpoint: 'http://169.254.169.254/latest/meta-data', events: ['email.sent'] });
    expect(r2.error!.name).toBe('validation_error');
    t.config.allowPrivateWebhooks = true;
  });
});
