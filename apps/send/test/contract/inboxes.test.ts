import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Resend } from 'resend';
import { startTestServer, webhookReceiver, type TestServer } from '../helpers.js';

let t: TestServer;
let resend: Resend;
let team: string;
let domainId: string;
let hook: Awaited<ReturnType<typeof webhookReceiver>>;

async function inbound(opts: { from?: string; to: string; subject: string; text: string; inReplyTo?: string; messageId?: string; attach?: boolean }) {
  const raw = await new MailComposer({
    from: opts.from ?? 'Ada Lovelace <ada@example.org>',
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: `<p>${opts.text}</p>`,
    messageId: opts.messageId ?? `<${Math.random().toString(36).slice(2)}@example.org>`,
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo, references: [opts.inReplyTo] } : {}),
    ...(opts.attach ? { attachments: [{ filename: 'receipt.pdf', content: Buffer.from('%PDF-1.4 receipt') }] } : {}),
  }).compile().build();
  const res = await fetch(`${t.apiBase}/inbound`, { method: 'POST', headers: { authorization: 'Bearer inbound-test-secret', 'x-envelope-to': opts.to }, body: raw });
  expect(res.status).toBe(200);
  return ((await res.json()) as { ids: string[] }).ids[0]!;
}

const types = async () => {
  await t.drain();
  return hook.received.map((r) => JSON.parse(r.body).type as string);
};

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Acme');
  const [d] = await t.ctx.sql`insert into domains (team_id, name, status, cf_enabled, sending, receiving, records) values (${team}, 'acme.test', 'verified', true, 'enabled', 'enabled', '[]') returning id`;
  domainId = d!.id as string;
  resend = t.resend(await t.createKey(team));
  hook = await webhookReceiver();
  await t.ctx.sql`insert into webhooks (team_id, endpoint, events, signing_secret) values (${team}, ${hook.url}, null, 'whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0')`;
});
afterAll(async () => {
  await hook.close();
  await t.close();
});

describe('inboxes (official SDK)', () => {
  let inboxId: string;
  let threadId: string;
  let firstEmailId: string;
  let labelId: string;

  it('creates, gets, lists, updates an inbox', async () => {
    const c = await resend.inboxes.create({ emailAddress: 'Support@Acme.test', name: 'Customer Support', fromName: 'Ada from Support' });
    expect(c.error).toBeNull();
    expect(c.data).toEqual({ object: 'inbox', id: expect.any(String) });
    inboxId = c.data!.id;
    const g = await resend.inboxes.get('support@acme.test');
    expect(g.data).toMatchObject({ object: 'inbox', id: inboxId, name: 'Customer Support', email_address: 'support@acme.test', domain_id: domainId, receiving_address: null, from_name: 'Ada from Support', unread: 0, drafts: 0, last_received: null });
    expect(g.data!.created_at).toMatch(/T.*Z$/);
    const l = await resend.inboxes.list();
    expect(l.data!.data[0]).toMatchObject({ id: inboxId, email_address: 'support@acme.test', unread: 0 });
    expect(l.data!.data[0]).not.toHaveProperty('domain_id');
    const u = await resend.inboxes.update(inboxId, { name: 'Support' });
    expect(u.data).toEqual({ object: 'inbox', id: inboxId });
    const dup = await resend.inboxes.create({ emailAddress: 'support@acme.test' });
    expect(dup.error!.statusCode).toBe(409);
    const bad = await resend.inboxes.create({ emailAddress: 'x@other.test' });
    expect(bad.error!.statusCode).toBe(422);
    const nf = await resend.inboxes.get('nobody@acme.test');
    expect(nf.error).toMatchObject({ statusCode: 404, name: 'not_found', message: 'Inbox not found.' });
  });

  it('agent settings', async () => {
    const g = await resend.inboxes.agent.get({ inboxId });
    expect(g.data).toEqual({ object: 'inbox_agent', instructions: null, tone: null, actions: [] });
    const u = await resend.inboxes.agent.update({ inboxId, instructions: 'Be nice', tone: 'concise_casual', actions: ['add_labels', 'draft_reply'] });
    expect(u.data).toEqual({ object: 'inbox_agent', id: inboxId });
    const g2 = await resend.inboxes.agent.get({ emailAddress: 'support@acme.test' });
    expect(g2.data).toEqual({ object: 'inbox_agent', instructions: 'Be nice', tone: 'concise_casual', actions: ['draft_reply', 'add_labels'] });
  });

  it('labels CRUD', async () => {
    const c = await resend.inboxes.labels.create({ inboxId, name: 'Urgent', color: '#e93d82' });
    expect(c.data).toEqual({ object: 'inbox_label', id: expect.any(String) });
    labelId = c.data!.id;
    const dup = await resend.inboxes.labels.create({ inboxId, name: 'urgent' });
    expect(dup.error!.statusCode).toBe(422);
    const u = await resend.inboxes.labels.update({ inboxId, labelId, name: 'Very urgent' });
    expect(u.data).toEqual({ object: 'inbox_label', id: labelId });
    const l = await resend.inboxes.labels.list({ inboxId });
    expect(l.data).toEqual({ object: 'list', data: [{ id: labelId, name: 'Very urgent', color: '#E93D82', created_at: expect.any(String) }] });
  });

  it('receives inbound mail into a thread', async () => {
    firstEmailId = await inbound({ to: 'support@acme.test', subject: 'Refund for order 1041', text: 'Could I get a refund?', messageId: '<1041@example.org>', attach: true });
    await t.drain();
    const l = await resend.inboxes.threads.list({ inboxId });
    expect(l.data!.data).toHaveLength(1);
    const th = l.data!.data[0]!;
    threadId = th.id;
    expect(th).toMatchObject({ subject: 'Refund for order 1041', from: 'Ada Lovelace <ada@example.org>', to: ['support@acme.test'], email_count: 1, has_attachment: true, has_draft: false, read: false, folder: 'inbox', labels: [] });
    const g = await resend.inboxes.get(inboxId);
    expect(g.data!.unread).toBe(1);
    expect(await types()).toEqual(expect.arrayContaining(['inbox.created', 'email.received', 'inbox.thread.created', 'inbox.email.received']));
    const ev = hook.received.map((r) => JSON.parse(r.body)).find((e) => e.type === 'inbox.email.received');
    expect(ev.data).toMatchObject({ source: 'system', inbox_id: inboxId, thread_id: threadId, email_id: firstEmailId, thread: { object: 'inbox_thread', id: threadId }, email: { id: firstEmailId, direction: 'inbound' } });
    expect(ev.data.email).not.toHaveProperty('html');
    const em = await resend.inboxes.threads.emails.list({ inboxId, threadId });
    expect(em.data!.data[0]).toMatchObject({ id: firstEmailId, direction: 'inbound', subject: 'Refund for order 1041', message_id: '<1041@example.org>', read: false, attachments: [{ filename: 'receipt.pdf', size: expect.any(Number) }] });
    const one = await resend.inboxes.threads.emails.get({ inboxId, threadId, emailId: firstEmailId });
    expect(one.data!.text).toContain('Could I get a refund?');
  });

  it('thread get/update/labels', async () => {
    const g = await resend.inboxes.threads.get({ inboxId, threadId });
    expect(g.data).toEqual({ object: 'inbox_thread', id: threadId, subject: 'Refund for order 1041', folder: 'inbox', labels: [], read: false });
    const a = await resend.inboxes.threads.labels.add({ inboxId, threadId, labels: [labelId] });
    expect(a.data).toEqual({ object: 'list', data: [{ id: labelId, name: 'Very urgent', color: '#E93D82' }] });
    const s = await resend.inboxes.threads.labels.set({ inboxId, threadId, labels: [] });
    expect(s.data).toEqual({ object: 'list', data: [] });
    await resend.inboxes.threads.labels.add({ inboxId, threadId, labels: [labelId] });
    const r = await resend.inboxes.threads.labels.remove({ inboxId, threadId, labelId });
    expect(r.data!.data).toEqual([]);
    const u = await resend.inboxes.threads.update({ inboxId, threadId, read: true });
    expect(u.data).toMatchObject({ object: 'inbox_thread', read: true, folder: 'inbox' });
    const byLabel = await resend.inboxes.threads.list({ inboxId, read: true });
    expect(byLabel.data!.data.map((x) => x.id)).toEqual([threadId]);
    expect(await types()).toContain('inbox.thread.labels.updated');
  });

  it('replies (In-Reply-To) and a reply comes back into the same thread', async () => {
    const before = t.transport.sent.length;
    const r = await resend.inboxes.threads.emails.reply({ inboxId, threadId, emailId: firstEmailId, text: 'Refund issued.' }, { idempotencyKey: 'reply-1' });
    expect(r.error).toBeNull();
    const again = await resend.inboxes.threads.emails.reply({ inboxId, threadId, emailId: firstEmailId, text: 'Refund issued.' }, { idempotencyKey: 'reply-1' });
    expect(again.data!.id).toBe(r.data!.id);
    expect(again.headers!['idempotent-replayed']).toBe('true');
    await t.drain();
    expect(t.transport.sent.length).toBe(before + 1);
    const raw = t.transport.sent.at(-1)!.raw.toString();
    expect(raw).toMatch(/^In-Reply-To: <1041@example.org>/m);
    expect(raw).toMatch(/^Subject: Re: Refund for order 1041/m);
    expect(raw).toMatch(/^From: Ada from Support <support@acme.test>/m);
    expect(t.transport.sent.at(-1)!.recipients).toEqual(['ada@example.org']);
    const sent = await resend.emails.get(r.data!.id);
    expect(sent.data!.to).toEqual(['Ada Lovelace <ada@example.org>']);
    const [m] = await t.ctx.sql`select message_id from emails where id = ${r.data!.id}`;
    await inbound({ to: 'support@acme.test', subject: 'Re: Refund for order 1041', text: 'Thanks!', inReplyTo: m!.message_id as string });
    const em = await resend.inboxes.threads.emails.list({ inboxId, threadId });
    expect(em.data!.data.map((x) => x.direction)).toEqual(['inbound', 'outbound', 'inbound']);
    expect(await types()).toContain('inbox.email.sent');
  });

  it('forwards with the original attachments', async () => {
    const f = await resend.inboxes.threads.emails.forward({ inboxId, threadId, emailId: firstEmailId, to: 'finance@example.com', text: 'FYI' });
    expect(f.error).toBeNull();
    await t.drain();
    const raw = t.transport.sent.at(-1)!.raw.toString();
    expect(raw).toMatch(/^Subject: Fwd: Refund for order 1041/m);
    expect(raw).toContain('receipt.pdf');
  });

  it('search', async () => {
    const s = await resend.inboxes.threads.search({ inboxId, query: 'refund -legal', from: ['ada@example.org'] });
    expect(s.data!.data).toHaveLength(1);
    expect(s.data!.data[0]!.matched_email_id).toBeTruthy();
    const none = await resend.inboxes.threads.search({ inboxId, query: '"no such phrase"' });
    expect(none.data!.data).toHaveLength(0);
    const bad = await resend.inboxes.threads.search({ inboxId, startDate: 'nope' });
    expect(bad.error).toMatchObject({ statusCode: 422, message: 'The `start_date` must be a valid ISO 8601 date.' });
  });

  it('drafts: create, list, get, update, send, remove', async () => {
    const c = await resend.inboxes.drafts.create({ inboxId, to: 'bob@example.com', subject: 'Hello', text: 'Draft body', attachments: [{ content: Buffer.from('hello'), filename: 'note.txt', contentType: 'text/plain' }] });
    expect(c.data).toEqual({ object: 'inbox_draft', id: expect.any(String) });
    const draftId = c.data!.id;
    const l = await resend.inboxes.drafts.list({ inboxId });
    expect(l.data!.data[0]).toMatchObject({ id: draftId, type: 'standalone', to: ['bob@example.com'], snippet: 'Draft body', attachments: [{ filename: 'note.txt', content_type: 'text/plain', size: 5 }] });
    const u = await resend.inboxes.drafts.update({ inboxId, draftId, subject: 'Hello again' });
    expect(u.data).toEqual({ object: 'inbox_draft', id: draftId });
    const g = await resend.inboxes.drafts.get({ inboxId, draftId });
    expect(g.data).toMatchObject({ object: 'inbox_draft', subject: 'Hello again', email_id: null, thread_id: null, reply_to_email_id: null });
    const s = await resend.inboxes.drafts.send({ inboxId, draftId, headers: { 'X-Ticket-Id': '4821' } });
    expect(s.data!.id).toBeTruthy();
    const resent = await resend.inboxes.drafts.send({ inboxId, draftId });
    expect(resent.error!.statusCode).toBe(409);
    const g2 = await resend.inboxes.drafts.get({ inboxId, draftId });
    expect(g2.data!.email_id).toBe(s.data!.id);
    const sentThreads = await resend.inboxes.threads.list({ inboxId, folders: ['sent'] });
    expect(sentThreads.data!.data.some((x) => x.subject === 'Hello again')).toBe(true);

    const reply = await resend.inboxes.drafts.create({ inboxId, threadId, replyToEmailId: firstEmailId, text: 'Working on it' });
    const same = await resend.inboxes.drafts.create({ inboxId, threadId, replyToEmailId: firstEmailId, text: 'again' });
    expect(same.data!.id).toBe(reply.data!.id);
    const rg = await resend.inboxes.drafts.get({ inboxId, draftId: reply.data!.id });
    expect(rg.data).toMatchObject({ type: 'reply', to: ['Ada Lovelace <ada@example.org>'], thread_id: threadId });
    const th = await resend.inboxes.threads.list({ inboxId });
    expect(th.data!.data.find((x) => x.id === threadId)!.has_draft).toBe(true);
    const rm = await resend.inboxes.drafts.remove({ inboxId, draftId: reply.data!.id });
    expect(rm.data).toEqual({ object: 'inbox_draft', id: reply.data!.id, deleted: true });
    expect(await types()).toEqual(expect.arrayContaining(['inbox.draft.created', 'inbox.draft.updated', 'inbox.draft.sent', 'inbox.draft.deleted']));
  });

  it('enforces sending_access and domain-restricted keys', async () => {
    const sending = t.resend(await t.createKey(team, 'sending_access'));
    const ok = await sending.inboxes.threads.emails.reply({ inboxId, threadId, emailId: firstEmailId, text: 'via sending key' });
    expect(ok.error).toBeNull();
    const denied = await sending.inboxes.threads.list({ inboxId });
    expect(denied.error).toMatchObject({ statusCode: 401, name: 'restricted_api_key' });
    const [other] = await t.ctx.sql`insert into domains (team_id, name, status, cf_enabled, records) values (${team}, 'other.test', 'verified', true, '[]') returning id`;
    const scoped = t.resend(await t.createKey(team, 'sending_access', other!.id as string));
    const forbidden = await scoped.inboxes.drafts.create({ inboxId, to: 'x@example.com', text: 'x' });
    expect(forbidden.error!.statusCode).toBe(403);
  });

  it('delete thread (trash), delete label, delete inbox', async () => {
    const d = await resend.inboxes.threads.remove({ inboxId, threadId });
    expect(d.data).toEqual({ object: 'inbox_thread', id: threadId, deleted: true });
    const d2 = await resend.inboxes.threads.remove({ inboxId, threadId });
    expect(d2.data!.deleted).toBe(false);
    const trash = await resend.inboxes.threads.list({ inboxId, folders: ['trash'] });
    expect(trash.data!.data.map((x) => x.id)).toContain(threadId);
    const restore = await resend.inboxes.threads.update({ inboxId, threadId, folder: 'archive' });
    expect(restore.data!.folder).toBe('archive');
    const dl = await resend.inboxes.labels.remove({ inboxId, labelId });
    expect(dl.data).toEqual({ object: 'inbox_label', id: labelId, deleted: true });
    const di = await resend.inboxes.remove(inboxId);
    expect(di.data).toEqual({ object: 'inbox', id: inboxId, deleted: true });
    await t.drain();
    expect(await types()).toEqual(expect.arrayContaining(['inbox.thread.folder.updated', 'inbox.deleted']));
  });
});
