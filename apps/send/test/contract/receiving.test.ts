import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Resend } from 'resend';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';
import { JmapInboundPoller, envelopeFromHeaders } from '../../src/services/inboundJmap.js';

let t: TestServer;
let resend: Resend;
let team: string;
let hook: Awaited<ReturnType<typeof webhookReceiver>>;

const mime = (o: { to: string; subject: string; extraHeaders?: Record<string, string> }) =>
  new MailComposer({
    from: 'Sender <sender@example.org>',
    to: o.to,
    cc: 'cc@example.org',
    subject: o.subject,
    text: 'Plain body',
    html: '<p>Hello <img src="cid:img001"></p>',
    headers: o.extraHeaders,
    attachments: [
      { filename: 'avatar.png', content: Buffer.from('PNGDATA'), cid: 'img001', contentType: 'image/png' },
      { filename: 'document.pdf', content: Buffer.from('%PDF doc'), contentType: 'application/pdf' },
    ],
  }).compile().build();

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Recv');
  await t.ctx.sql`insert into domains (team_id, name, status, cf_enabled, sending, receiving, records) values (${team}, 'recv.test', 'verified', true, 'enabled', 'enabled', '[]')`;
  resend = t.resend(await t.createKey(team));
  hook = await webhookReceiver();
  await t.ctx.sql`insert into webhooks (team_id, endpoint, events, signing_secret) values (${team}, ${hook.url}, ${['email.received']}, 'whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0')`;
});
afterAll(async () => {
  await hook.close();
  await t.close();
});

describe('receiving (official SDK)', () => {
  let emailId: string;

  it('POST /inbound rejects bad secrets and unknown domains', async () => {
    const raw = await mime({ to: 'hello@recv.test', subject: 'x' });
    const bad = await fetch(`${t.apiBase}/inbound`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: raw });
    expect(bad.status).toBe(401);
    const unknown = await fetch(`${t.apiBase}/inbound`, { method: 'POST', headers: { authorization: 'Bearer inbound-test-secret', 'x-envelope-to': 'a@nowhere.test' }, body: raw });
    expect(unknown.status).toBe(404);
  });

  it('ingests and fires email.received', async () => {
    const raw = await mime({ to: 'hello@recv.test', subject: 'Inbound one' });
    const r = await fetch(`${t.apiBase}/inbound`, { method: 'POST', headers: { authorization: 'Bearer inbound-test-secret', 'x-envelope-to': 'hello@recv.test' }, body: raw });
    expect(r.status).toBe(200);
    emailId = ((await r.json()) as { ids: string[] }).ids[0]!;
    await t.drain();
    const ev = JSON.parse(hook.received.at(-1)!.body);
    expect(ev.type).toBe('email.received');
    expect(ev.data).toMatchObject({ email_id: emailId, from: 'sender@example.org', to: ['hello@recv.test'], cc: ['cc@example.org'], bcc: [], subject: 'Inbound one' });
    expect(ev.data.attachments).toHaveLength(2);
    expect(ev.data.attachments[0]).toMatchObject({ filename: 'avatar.png', content_type: 'image/png', content_id: 'img001' });
  });

  it('lists, gets (data_uri / cid) and downloads raw', async () => {
    const l = await resend.emails.receiving.list();
    expect(l.data!.object).toBe('list');
    expect(l.data!.data[0]).toMatchObject({ id: emailId, from: 'sender@example.org', subject: 'Inbound one', attachments: expect.any(Array) });
    const g = await resend.emails.receiving.get(emailId);
    expect(g.data).toMatchObject({ object: 'email', id: emailId, to: ['hello@recv.test'], cc: ['cc@example.org'], bcc: [], text: expect.stringContaining('Plain body') });
    expect(g.data!.html).toContain('data:image/png;base64,');
    expect((g.data as unknown as { authentication: unknown }).authentication).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none' });
    const cid = await resend.emails.receiving.get(emailId, { html_format: 'cid' });
    expect(cid.data!.html).toContain('cid:img001');
    const raw = await fetch(g.data!.raw!.download_url);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain('Subject: Inbound one');
  });

  it('lists and gets attachments with signed download URLs', async () => {
    const l = await resend.emails.receiving.attachments.list({ emailId });
    expect(l.data!.data).toHaveLength(2);
    const pdf = l.data!.data.find((a) => a.filename === 'document.pdf')!;
    const one = await resend.emails.receiving.attachments.get({ emailId, id: pdf.id });
    expect(one.data).toMatchObject({ object: 'attachment', id: pdf.id, content_type: 'application/pdf', size: 8, content_id: null });
    expect(l.data!.data.find((a) => a.filename === 'avatar.png')).toMatchObject({ content_id: 'img001' });
    const dl = await fetch(one.data!.download_url);
    expect(await dl.text()).toBe('%PDF doc');
    const nf = await resend.emails.receiving.get('00000000-0000-0000-0000-000000000000');
    expect(nf.error).toMatchObject({ statusCode: 404, name: 'not_found' });
  });

  it('forwards a received email with the SDK helper (passthrough)', async () => {
    const f = await resend.emails.receiving.forward({ emailId, to: 'someone@example.com', from: 'fwd@recv.test' });
    expect(f.error).toBeNull();
    await t.drain();
    const raw = t.transport.sent.at(-1)!.raw.toString();
    expect(raw).toMatch(/^Subject: Inbound one/m);
    expect(raw).toContain('document.pdf');
  });

  it('reports SPF/DKIM/DMARC from the topmost Authentication-Results header', async () => {
    const raw = await mime({ to: 'hello@recv.test', subject: 'Authed', extraHeaders: { 'Authentication-Results': 'mx.recv.test; dkim=pass header.d=example.org; spf=softfail smtp.mailfrom=example.org; dmarc=fail' } });
    const r = await fetch(`${t.apiBase}/inbound`, { method: 'POST', headers: { authorization: 'Bearer inbound-test-secret', 'x-envelope-to': 'hello@recv.test' }, body: raw });
    const id = ((await r.json()) as { ids: string[] }).ids[0]!;
    const g = await resend.emails.receiving.get(id);
    expect((g.data as unknown as { authentication: unknown }).authentication).toEqual({ spf: 'softfail', dkim: 'pass', dmarc: 'fail' });
  });

  it('extracts envelope recipients from delivery headers', () => {
    const raw = Buffer.from('Delivered-To: a@recv.test\r\nX-Original-To: b@recv.test\r\nSubject: x\r\n\r\nbody');
    expect(envelopeFromHeaders(raw)).toEqual(['a@recv.test', 'b@recv.test']);
    const rcv = Buffer.from('Received: from x by mail-1 with ESMTP\r\n  for <c@recv.test>; Tue, 1 Jan 2026\r\nSubject: x\r\n\r\nb');
    expect(envelopeFromHeaders(rcv)).toEqual(['c@recv.test']);
  });
});

// Real Stalwart (the local 5050-dev container). Uses a dedicated mailbox in bob's account so
// the dev inbox is never touched; skipped when Stalwart isn't running.
const STALWART = process.env.STALWART_TEST_URL ?? 'http://localhost:18090';
const BOB = { user: 'bob@dev.test', password: 'Demo-Bob-Granite-2026' };
const stalwartUp = await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: 'Basic ' + Buffer.from(`${BOB.user}:${BOB.password}`).toString('base64') }, signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!stalwartUp)('JMAP inbound poller (5050-dev Stalwart)', () => {
  const auth = 'Basic ' + Buffer.from(`${BOB.user}:${BOB.password}`).toString('base64');
  const MAILBOX = `5050-send-test-${Date.now()}`;
  let accountId = '';
  let mailboxId = '';
  const jmap = async (methodCalls: unknown[]) => {
    const r = await fetch(`${STALWART}/jmap/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls }) });
    return ((await r.json()) as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
  };

  beforeAll(async () => {
    const s = (await (await fetch(`${STALWART}/jmap/session`, { headers: { Authorization: auth } })).json()) as { primaryAccounts: Record<string, string> };
    accountId = s.primaryAccounts['urn:ietf:params:jmap:mail']!;
    const [r] = await jmap([['Mailbox/set', { accountId, create: { m: { name: MAILBOX, parentId: null } } }, 'c']]);
    mailboxId = (r![1].created as Record<string, { id: string }>).m.id;
  });
  afterAll(async () => {
    if (mailboxId) await jmap([['Mailbox/set', { accountId, destroy: [mailboxId], onDestroyRemoveEmails: true }, 'd']]);
  });

  it('imports a message into the catch-all mailbox, polls it, ingests it and fires email.received', async () => {
    const raw = await mime({ to: 'jmap@recv.test', subject: 'Via JMAP poller', extraHeaders: { 'Delivered-To': 'jmap@recv.test' } });
    const up = await fetch(`${STALWART}/jmap/upload/${accountId}/`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'message/rfc822' }, body: raw });
    const { blobId } = (await up.json()) as { blobId: string };
    const [imp] = await jmap([['Email/import', { accountId, emails: { e: { blobId, mailboxIds: { [mailboxId]: true } } } }, 'i']]);
    expect(imp![1].created).toBeTruthy();

    const before = hook.received.length;
    const poller = new JmapInboundPoller(t.ctx, { url: STALWART, user: BOB.user, password: BOB.password, mode: 'destroy', mailbox: MAILBOX });
    expect(await poller.pollOnce()).toBe(1);
    expect(await poller.pollOnce()).toBe(0); // destroyed after ingest
    await t.drain();
    const ev = hook.received.slice(before).map((h) => JSON.parse(h.body)).find((e) => e.data.subject === 'Via JMAP poller');
    expect(ev).toBeTruthy();
    expect(ev.type).toBe('email.received');
    expect(ev.data.to).toEqual(['jmap@recv.test']);
    const g = await resend.emails.receiving.get(ev.data.email_id);
    expect(g.data!.subject).toBe('Via JMAP poller');
  });
});
