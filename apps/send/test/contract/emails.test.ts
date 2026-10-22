import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;
let KEY: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Acme');
  await t.verifiedDomain(team, 'acme.test', { open_tracking: true, click_tracking: true });
  KEY = await t.createKey(team);
  resend = t.resend(KEY);
});
afterAll(() => t.close());

describe('emails (official SDK)', () => {
  it('sends, delivers and retrieves an email', async () => {
    const { data, error, headers } = await resend.emails.send({
      from: 'Acme <hello@acme.test>',
      to: ['user@example.com'],
      cc: 'cc@example.com',
      bcc: ['bcc@example.com'],
      replyTo: 'support@acme.test',
      subject: 'Hello',
      html: '<p>Hi <a href="https://example.com/x?a=1">link</a></p>',
      tags: [{ name: 'category', value: 'welcome' }],
      headers: { 'X-Entity-Ref-ID': '123' },
    });
    expect(error).toBeNull();
    expect(data!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers!['ratelimit-limit']).toBe('1000');
    expect(headers!['x-resend-monthly-quota']).toBe('1');

    const before = await resend.emails.get(data!.id);
    expect(before.data!.last_event).toBe('queued');

    await t.drain();
    expect(t.transport.sent).toHaveLength(1);
    const msg = t.transport.sent[0]!;
    expect(msg.recipients.sort()).toEqual(['bcc@example.com', 'cc@example.com', 'user@example.com']);
    const raw = msg.raw.toString();
    expect(raw).toMatch(/^X-Entity-Ref-ID: 123/m);
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).toContain('/t/o/'); // open pixel
    expect(raw).toContain('/t/c/'); // click rewrite

    const { data: email } = await resend.emails.get(data!.id);
    expect(email).toMatchObject({
      object: 'email',
      id: data!.id,
      to: ['user@example.com'],
      from: 'Acme <hello@acme.test>',
      subject: 'Hello',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      reply_to: ['support@acme.test'],
      last_event: 'delivered',
      scheduled_at: null,
      tags: [{ name: 'category', value: 'welcome' }],
    });
    expect(email!.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/);
    expect(email!.text).toContain('Hi link');
  });

  it('lists emails with pagination', async () => {
    for (let i = 0; i < 3; i++) await resend.emails.send({ from: 'hello@acme.test', to: 'a@example.com', subject: `n${i}`, text: 'x' });
    const page1 = await resend.emails.list({ limit: 2 });
    expect(page1.data!.object).toBe('list');
    expect(page1.data!.data).toHaveLength(2);
    expect(page1.data!.has_more).toBe(true);
    const page2 = await resend.emails.list({ limit: 2, after: page1.data!.data[1]!.id });
    expect(page2.data!.data.map((e) => e.id)).not.toContain(page1.data!.data[0]!.id);
    const back = await resend.emails.list({ limit: 2, before: page2.data!.data[0]!.id });
    expect(back.data!.data.map((e) => e.id)).toEqual(page1.data!.data.map((e) => e.id));
  });

  it('schedules with natural language, reschedules and cancels', async () => {
    const { data } = await resend.emails.send({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x', scheduledAt: 'in 1 min' });
    let e = await resend.emails.get(data!.id);
    expect(e.data!.last_event).toBe('scheduled');
    expect(e.data!.scheduled_at).toBeTruthy();
    const upd = await resend.emails.update({ id: data!.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(upd.data).toEqual({ object: 'email', id: data!.id });
    const c = await resend.emails.cancel(data!.id);
    expect(c.data).toEqual({ object: 'email', id: data!.id });
    e = await resend.emails.get(data!.id);
    expect(e.data!.last_event).toBe('canceled');
    const again = await resend.emails.cancel(data!.id);
    expect(again.error!.name).toBe('validation_error');
  });

  it('sends batches (strict and permissive)', async () => {
    const ok = await resend.batch.send([
      { from: 'hello@acme.test', to: 'a@example.com', subject: '1', html: '<b>1</b>' },
      { from: 'hello@acme.test', to: 'b@example.com', subject: '2', html: '<b>2</b>' },
    ]);
    expect(ok.error).toBeNull();
    expect(ok.data!.data).toHaveLength(2);
    const strict = await resend.batch.send([
      { from: 'hello@acme.test', to: 'a@example.com', subject: '1', html: '<b>1</b>' },
      { from: 'hello@acme.test', to: 'not-an-email', subject: '2', html: '<b>2</b>' },
    ]);
    expect(strict.error!.name).toBe('validation_error');
    const perm = await resend.batch.send(
      [
        { from: 'hello@acme.test', to: 'a@example.com', subject: '1', html: '<b>1</b>' },
        { from: 'hello@acme.test', to: 'not-an-email', subject: '2', html: '<b>2</b>' },
      ],
      { batchValidation: 'permissive' },
    );
    expect(perm.data!.data).toHaveLength(1);
    expect((perm.data as unknown as { errors: { index: number }[] }).errors[0]!.index).toBe(1);
  });

  it('honours Idempotency-Key', async () => {
    const p = { from: 'hello@acme.test', to: 'a@example.com', subject: 'idem', text: 'x' };
    const a = await resend.emails.send(p, { idempotencyKey: 'welcome/1' });
    const b = await resend.emails.send(p, { idempotencyKey: 'welcome/1' });
    expect(b.data!.id).toBe(a.data!.id);
    const c = await resend.emails.send({ ...p, subject: 'changed' }, { idempotencyKey: 'welcome/1' });
    expect(c.error!.name).toBe('invalid_idempotent_request');
    expect(c.error!.statusCode).toBe(409);
  });

  it('stores attachments (content, inline cid) and serves them', async () => {
    const { data } = await resend.emails.send({
      from: 'hello@acme.test',
      to: 'a@example.com',
      subject: 'att',
      html: '<img src="cid:logo">',
      attachments: [
        { filename: 'hello.txt', content: Buffer.from('hello world') },
        { filename: 'logo.png', content: Buffer.from('png').toString('base64'), contentId: 'logo' },
      ],
    });
    const list = await resend.emails.attachments.list({ emailId: data!.id });
    expect(list.data!.data).toHaveLength(2);
    const inline = list.data!.data.find((a) => a.filename === 'logo.png')!;
    expect(inline.content_disposition).toBe('inline');
    expect(inline.content_id).toBe('logo');
    const one = await resend.emails.attachments.get({ emailId: data!.id, id: inline.id });
    expect(one.data!.object).toBe('attachment');
    const dl = await fetch(one.data!.download_url);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe('png');
    await t.drain();
    const raw = t.transport.sent.at(-1)!.raw.toString();
    expect(raw).toMatch(/Content-ID: <logo>/i);
  });

  it('shares an email', async () => {
    const { data } = await resend.emails.send({ from: 'hello@acme.test', to: 'a@example.com', subject: 'share me', html: '<p>shared</p>' });
    const s = await resend.emails.share(data!.id, { expiresIn: '2 hours' });
    expect(s.data!.object).toBe('email');
    const page = await fetch(s.data!.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('share me');
  });

  it('rejects unverified domains and bad payloads like Resend', async () => {
    const r1 = await resend.emails.send({ from: 'x@unverified.test', to: 'a@example.com', subject: 's', text: 'x' });
    expect(r1.error).toMatchObject({ statusCode: 403, name: 'validation_error' });
    const r2 = await resend.emails.send({ from: 'hello@acme.test', to: 'a@example.com', subject: 's' } as never);
    expect(r2.error!.statusCode).toBe(422);
    const r3 = await resend.emails.send({ to: 'a@example.com', subject: 's', text: 'x' } as never);
    expect(r3.error).toMatchObject({ statusCode: 422, name: 'missing_required_field', message: 'Missing `from` field.' });
  });

  it('supports Resend test addresses on resend.dev', async () => {
    const { data, error } = await resend.emails.send({ from: 'Acme <onboarding@resend.dev>', to: ['delivered@resend.dev', 'bounced@resend.dev'], subject: 'hello world', html: '<p>it works!</p>' });
    expect(error).toBeNull();
    await t.drain();
    const e = await resend.emails.get(data!.id);
    expect(['delivered', 'bounced']).toContain(e.data!.last_event);
    const denied = await resend.emails.send({ from: 'onboarding@resend.dev', to: 'stranger@example.com', subject: 'x', text: 'x' });
    expect(denied.error).toMatchObject({ statusCode: 403, name: 'validation_error' });
  });
  it('requires exactly one mailbox in from (no address-list spoofing)', async () => {
    const bad = await resend.emails.send({ from: 'ceo@bank.example, Me <hi@acme.test>', to: 'a@example.com', subject: 's', text: 'x' });
    expect(bad.error).toMatchObject({ statusCode: 422, name: 'validation_error' });
    const semi = await resend.emails.send({ from: 'a@b.example; Me <hi@acme.test>', to: 'a@example.com', subject: 's', text: 'x' });
    expect(semi.error!.statusCode).toBe(422);
    t.transport.clear();
    const quoted = await resend.emails.send({ from: '"Acme, Inc." <hi@acme.test>', to: 'a@example.com', subject: 's', text: 'x' });
    expect(quoted.error).toBeNull();
    await t.drain();
    const fromLine = t.transport.sent.at(-1)!.raw.toString().split(/\r?\n/).find((l) => /^From:/i.test(l));
    expect(fromLine).toBe('From: "Acme, Inc." <hi@acme.test>');
  });

  it('validates attachments like Resend (blocked types, content_id length, malformed paths)', async () => {
    const send = (attachments: unknown[]) =>
      t.fetch('/emails', { method: 'POST', key: KEY, body: JSON.stringify({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x', attachments }) });
    for (const filename of ['virus.exe', 'run.BAT', 'x.vbs', 'a.ps1']) {
      const r = await send([{ filename, content: 'aGk=' }]);
      expect(r.status, filename).toBe(422);
      expect(((await r.json()) as { name: string }).name).toBe('invalid_attachment');
    }
    expect((await send([{ path: 'https://example.com/files/setup.exe' }])).status).toBe(422);
    const pct = await send([{ path: 'https://example.com/%E0%A4%A' }]);
    expect(pct.status).toBe(422);
    expect((await send([{ filename: 'a.png', content: 'aGk=', content_id: 'x'.repeat(128) }])).status).toBe(422);
    expect((await send([{ filename: 'a.png', content: 'aGk=', content_id: 'x'.repeat(127) }])).status).toBe(200);
    expect((await send([{ filename: 'report.pdf', content: 'aGk=' }])).status).toBe(200);
  });
});
