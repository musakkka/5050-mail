import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import { startSmtp, type SmtpHandle } from '../../src/smtp/server.js';
import { selfSigned } from './certs.js';

let t: TestServer;
let smtp: SmtpHandle;
let tlsPort: number;
let starttlsPort: number;
let team: string;
let fullKey: string;
let sendKey: string;
let restrictedKey: string;

const transport = (port: number, secure: boolean, pass: string, extra: Record<string, unknown> = {}) =>
  nodemailer.createTransport({ host: '127.0.0.1', port, secure, auth: { user: 'resend', pass }, tls: { rejectUnauthorized: false }, ...extra });

beforeAll(async () => {
  t = await startTestServer();
  t.config.smtpMaxMessageBytes = 300 * 1024;
  team = await t.createTeam('SMTP team');
  await t.verifiedDomain(team, 'acme.test');
  const other = await t.verifiedDomain(team, 'other.test');
  fullKey = await t.createKey(team, 'full_access');
  sendKey = await t.createKey(team, 'sending_access');
  restrictedKey = await t.createKey(team, 'sending_access', other);
  const c = selfSigned('smtp.test');
  smtp = await startSmtp(t.ctx, { listen: [{ port: 0, implicitTls: true, host: '127.0.0.1' }, { port: 0, implicitTls: false, host: '127.0.0.1' }], tls: { key: c.key, cert: c.cert } });
  tlsPort = smtp.servers.find((s) => s.listen.implicitTls)!.port;
  starttlsPort = smtp.servers.find((s) => !s.listen.implicitTls)!.port;
});
afterAll(async () => {
  await smtp?.close();
  await t?.close();
});

const lastEmail = async () => (await t.ctx.sql`select * from emails where team_id = ${team} order by created_at desc limit 1`)[0]!;

describe('SMTP relay', () => {
  it('accepts a message over implicit TLS and runs the normal pipeline', async () => {
    const hook = await webhookReceiver();
    await t.resend(fullKey).webhooks.create({ endpoint: hook.url, events: ['email.sent', 'email.delivered'] });
    const info = await transport(tlsPort, true, fullKey).sendMail({
      from: 'Acme <hello@acme.test>',
      to: 'User <user@example.com>',
      cc: 'cc@example.com',
      bcc: 'hidden@example.com',
      subject: 'Over SMTP',
      text: 'plain body',
      html: '<p>html body <img src="cid:logo"></p>',
      headers: { 'X-Entity-Ref-ID': 'abc-123', 'X-Resend-Tags': 'category=welcome, plan=free' },
      attachments: [
        { filename: 'note.txt', content: 'attached text' },
        { filename: 'logo.png', content: Buffer.from('png-bytes'), cid: 'logo' },
      ],
    });
    expect(info.response).toMatch(/^250 2\.0\.0 OK [0-9a-f-]{36}$/);
    const id = info.response.split(' ').pop()!;
    const e = await lastEmail();
    expect(e.id).toBe(id);
    expect(e.source).toBe('smtp');
    expect(e.from_addr).toBe('Acme <hello@acme.test>');
    expect(e.to_addrs).toEqual(['User <user@example.com>']);
    expect(e.cc).toEqual(['cc@example.com']);
    expect(e.bcc).toEqual(['hidden@example.com']);
    expect((e.headers as Record<string, string>)['X-Entity-Ref-ID']).toBe('abc-123');
    expect(e.tags).toEqual([{ name: 'category', value: 'welcome' }, { name: 'plan', value: 'free' }]);
    const atts = await t.ctx.sql`select filename, content_id, disposition from email_attachments where email_id = ${id} order by filename`;
    expect(atts.map((a) => [a.filename, a.content_id, a.disposition])).toEqual([['logo.png', 'logo', 'inline'], ['note.txt', null, 'attachment']]);

    await t.drain();
    const sent = t.transport.sent.find((m) => m.emailId === id)!;
    expect(sent.recipients.sort()).toEqual(['cc@example.com', 'hidden@example.com', 'user@example.com']);
    expect(sent.raw.toString()).toMatch(/^X-Entity-Ref-ID: abc-123/m);
    expect(sent.raw.toString()).not.toMatch(/^Bcc:/m);
    const got = await t.resend(fullKey).emails.get(id);
    expect(got.data!.last_event).toBe('delivered');
    expect(hook.received.map((r) => JSON.parse(r.body).type)).toEqual(['email.sent', 'email.delivered']);
    const [log] = await t.ctx.sql`select method, endpoint, response_status, source from api_logs where team_id = ${team} and source = 'smtp' order by created_at desc limit 1`;
    expect(log).toMatchObject({ method: 'SMTP', endpoint: '/smtp', response_status: 200, source: 'smtp' });
    await hook.close();
  });

  it('works over STARTTLS with a sending_access key', async () => {
    const info = await transport(starttlsPort, false, sendKey, { requireTLS: true }).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x' });
    expect(info.response).toMatch(/^250/);
  });

  it('requires STARTTLS before AUTH on the submission ports', async () => {
    await expect(transport(starttlsPort, false, fullKey, { ignoreTLS: true }).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 538 });
  });

  it('rejects wrong usernames and keys', async () => {
    await expect(nodemailer.createTransport({ host: '127.0.0.1', port: tlsPort, secure: true, auth: { user: 'admin', pass: fullKey }, tls: { rejectUnauthorized: false } }).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 535 });
    await expect(transport(tlsPort, true, ('re_' + 'A'.repeat(8) + '_' + 'B'.repeat(24))).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 535 });
  });

  it('enforces domain-restricted keys and verified domains', async () => {
    await expect(transport(tlsPort, true, restrictedKey).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 's', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 550 });
    const ok = await transport(tlsPort, true, restrictedKey).sendMail({ from: 'hello@other.test', to: 'a@example.com', subject: 's', text: 'x' });
    expect(ok.response).toMatch(/^250/);
    await expect(transport(tlsPort, true, fullKey).sendMail({ from: 'x@unverified.test', to: 'a@example.com', subject: 's', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 550 });
  });

  it('rejects messages over the size limit', async () => {
    await expect(transport(tlsPort, true, fullKey).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 'big', text: 'x', attachments: [{ filename: 'big.bin', content: Buffer.alloc(400 * 1024, 1) }] }))
      .rejects.toMatchObject({ responseCode: 552 });
  });

  it('honours Resend-Idempotency-Key', async () => {
    const send = (subject: string) => transport(tlsPort, true, fullKey).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject, text: 'x', headers: { 'Resend-Idempotency-Key': 'smtp-key-1' } });
    const a = await send('idem');
    const b = await send('idem');
    expect(b.response).toBe(a.response);
    await expect(send('changed')).rejects.toMatchObject({ responseCode: 550 });
    const [{ n }] = (await t.ctx.sql`select count(*)::int as n from emails where team_id = ${team} and subject = 'idem'`) as unknown as { n: number }[];
    expect(n).toBe(1);
  });

  it('maps quota errors to 452', async () => {
    await t.ctx.sql`update teams set monthly_quota = 0 where id = ${team}`;
    try {
      await expect(transport(tlsPort, true, fullKey).sendMail({ from: 'hello@acme.test', to: 'a@example.com', subject: 'q', text: 'x' })).rejects.toMatchObject({ responseCode: 452 });
    } finally {
      await t.ctx.sql`update teams set monthly_quota = 3000 where id = ${team}`;
    }
  });
  it('carries up to 150 envelope recipients (to ≤ 50 plus cc/bcc) and refuses the whole message beyond that', async () => {
    const to = Array.from({ length: 50 }, (_, i) => `to${i}@example.com`);
    const bcc = Array.from({ length: 100 }, (_, i) => `bcc${i}@example.com`);
    const ok = await transport(tlsPort, true, fullKey).sendMail({ from: 'hello@acme.test', to, bcc, subject: 'many', text: 'x' });
    expect(ok.response).toMatch(/^250/);
    expect(ok.accepted).toHaveLength(150);
    const e = await lastEmail();
    expect((e.to_addrs as string[]).length + (e.bcc as string[]).length).toBe(150);
    // 151 recipients: the extra RCPT gets 452 and DATA is refused too (no silent partial delivery).
    await expect(transport(tlsPort, true, fullKey).sendMail({ from: 'hello@acme.test', to, bcc: [...bcc, 'one-too-many@example.com'], subject: 'too many', text: 'x' }))
      .rejects.toMatchObject({ responseCode: 452 });
    const [{ n }] = (await t.ctx.sql`select count(*)::int as n from emails where team_id = ${team} and subject = 'too many'`) as unknown as { n: number }[];
    expect(n).toBe(0);
  });
});
