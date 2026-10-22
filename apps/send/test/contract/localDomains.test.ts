/**
 * Self-hosted domains (DOMAIN_RECORDS=local, the default with TRANSPORT=smtp):
 * own DKIM key, SPF authorising MAIL_HOSTNAME, verification against public DNS,
 * and the SMTP transport DKIM-signs before handing mail to the mail server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { startTestServer, type TestServer } from '../helpers.js';
import { createDomain, startVerification } from '../../src/services/domains.js';
import { signingKeyFor } from '../../src/services/localDomains.js';
import { SmtpTransport } from '../../src/transport/index.js';

let t: TestServer;
let team: string;

beforeAll(async () => {
  process.env.MAIL_HOSTNAME = 'mail.acme.test';
  t = await startTestServer({ DOMAIN_RECORDS: 'local' });
  team = await t.createTeam('Local');
});
afterAll(() => t.close());

describe('self-hosted domains', () => {
  it('creates DKIM/SPF/DMARC records and verifies them from public DNS', async () => {
    const d = await createDomain(t.ctx, team, { name: 'shop.example' });
    const dkim = d.records.find((r) => r.record === 'DKIM')!;
    expect(dkim.name).toBe('send5050._domainkey');
    expect(dkim.value).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{300,}$/);
    expect(d.records.find((r) => r.record === 'SPF')).toMatchObject({ name: '@', type: 'TXT', value: 'v=spf1 a:mail.acme.test ~all' });
    expect(d.records.some((r) => /cloudflare/.test(r.value))).toBe(false);
    const [raw] = await t.ctx.sql`select dkim_private_key from domains where id = ${d.id}`;
    expect(String(raw!.dkim_private_key)).not.toContain('PRIVATE KEY'); // encrypted at rest

    t.dns.set('send5050._domainkey.shop.example', { txt: [dkim.value] });
    t.dns.set('shop.example', { txt: ['v=spf1 include:_spf.google.com a:mail.acme.test ~all'] });
    t.dns.set('_dmarc.shop.example', { txt: ['v=DMARC1; p=none'] });
    await startVerification(t.ctx, d);
    await t.drain();
    const [row] = await t.ctx.sql`select status from domains where id = ${d.id}`;
    expect(row!.status).toBe('verified');
  });

  it('signs outgoing mail with the domain key when submitting over SMTP', async () => {
    const got: string[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _s, cb) {
        let buf = '';
        stream.on('data', (c: Buffer) => (buf += c.toString()));
        stream.on('end', () => {
          got.push(buf);
          cb();
        });
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.server.address() as { port: number }).port;
    try {
      const tr = new SmtpTransport(`smtp://127.0.0.1:${port}`, undefined, (from) => signingKeyFor(t.ctx, from));
      const raw = Buffer.from('From: hi@shop.example\r\nTo: you@example.com\r\nSubject: hi\r\nMessage-ID: <x@shop.example>\r\n\r\nhello\r\n');
      const r = await tr.send({ emailId: 'e1', teamId: team, from: 'hi@shop.example', recipients: ['you@example.com'], raw });
      expect(r.queued).toEqual(['you@example.com']);
      expect(got[0]).toMatch(/DKIM-Signature: .*d=shop\.example/s);
      expect(got[0]).toMatch(/s=send5050/);
    } finally {
      server.close();
    }
  });
});
