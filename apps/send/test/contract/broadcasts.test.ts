import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';

let t: TestServer;
let resend: Resend;
let team: string;
let segmentId: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('News');
  await t.verifiedDomain(team, 'news.test', { click_tracking: true, open_tracking: true });
  resend = t.resend(await t.createKey(team));
  const seg = await resend.segments.create({ name: 'Subscribers' });
  segmentId = seg.data!.id;
  await resend.contactProperties.create({ key: 'plan', type: 'string', fallbackValue: 'free' });
  await resend.contacts.create({ email: 'ada@example.com', firstName: 'Ada', properties: { plan: 'pro' }, segments: [{ id: segmentId }] });
  await resend.contacts.create({ email: 'bob@example.com', segments: [{ id: segmentId }] });
  await resend.contacts.create({ email: 'gone@example.com', unsubscribed: true, segments: [{ id: segmentId }] });
});
afterAll(() => t.close());

const html = '<p>Hi {{{contact.first_name|there}}} ({{{contact.plan}}})</p><a href="https://example.com/pricing">Pricing</a><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>';

describe('broadcasts (official SDK)', () => {
  it('creates, gets, lists and updates a draft', async () => {
    const c = await resend.broadcasts.create({ name: 'Draft 1', segmentId, from: 'News <news@news.test>', subject: 'Hello', html });
    expect(c.error).toBeNull();
    expect(c.data).toEqual({ object: 'broadcast', id: expect.any(String) });
    const g = await resend.broadcasts.get(c.data!.id);
    expect(g.data).toMatchObject({ object: 'broadcast', id: c.data!.id, name: 'Draft 1', segment_id: segmentId, audience_id: segmentId, status: 'draft', from: 'News <news@news.test>', subject: 'Hello', scheduled_at: null, sent_at: null, reply_to: null });
    const u = await resend.broadcasts.update(c.data!.id, { subject: 'Hello again', previewText: 'Preview!' });
    expect(u.data).toEqual({ object: 'broadcast', id: c.data!.id });
    expect((await resend.broadcasts.get(c.data!.id)).data!.subject).toBe('Hello again');
    const l = await resend.broadcasts.list();
    expect(l.data!.object).toBe('list');
    expect(l.data!.data.find((b) => b.id === c.data!.id)).toMatchObject({ status: 'draft', segment_id: segmentId });
    const d = await resend.broadcasts.duplicate(c.data!.id);
    expect(d.data!.object).toBe('broadcast');
    expect((await resend.broadcasts.get(d.data!.id)).data!.name).toBe('Draft 1 (copy)');
    const del = await resend.broadcasts.remove(d.data!.id);
    expect(del.data).toEqual({ object: 'broadcast', id: d.data!.id, deleted: true });
    const missing = await resend.broadcasts.get(d.data!.id);
    expect(missing.error).toMatchObject({ statusCode: 404, name: 'not_found', message: 'Broadcast not found' });
  });

  it('validates like Resend', async () => {
    const r = await resend.broadcasts.create({ segmentId, subject: 'x', html: 'x' } as never);
    expect(r.error).toMatchObject({ statusCode: 422, name: 'missing_required_field', message: 'Missing `from` field.' });
    const r2 = await resend.broadcasts.create({ segmentId, from: 'nope', subject: 'x', html: 'x' });
    expect(r2.error!.name).toBe('invalid_parameter');
  });

  it('sends to subscribed contacts with personalization, preheader and unsubscribe', async () => {
    const c = await resend.broadcasts.create({ name: 'Launch', segmentId, from: 'News <news@news.test>', subject: 'Hi {{{contact.first_name|friend}}}', html, previewText: 'Big news', send: true });
    expect(c.error).toBeNull();
    expect((await resend.broadcasts.get(c.data!.id)).data!.status).toBe('queued');
    t.transport.clear();
    await t.drain();
    const b = await resend.broadcasts.get(c.data!.id);
    expect(b.data!.status).toBe('sent');
    expect(b.data!.sent_at).toBeTruthy();
    expect(t.transport.sent).toHaveLength(2);
    const ada = t.transport.sent.find((m) => m.recipients[0] === 'ada@example.com')!;
    const raw = ada.raw.toString().replace(/\r?\n[ \t]+/g, ' ').replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    expect(raw).toContain('Subject: Hi Ada');
    expect(raw).toContain('Hi Ada (pro)');
    expect(raw).toContain('Big news');
    expect(raw).toMatch(/List-Unsubscribe: <.*\/unsubscribe\//);
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    const bob = t.transport.sent.find((m) => m.recipients[0] === 'bob@example.com')!.raw.toString().replace(/=\r?\n/g, '');
    expect(bob).toContain('Hi there');

    const sent = await resend.broadcasts.recipients(c.data!.id, { type: 'sent' });
    expect(sent.data!.data.map((r) => r.email).sort()).toEqual(['ada@example.com', 'bob@example.com']);
    expect(sent.data!.data[0]!.id).toBe(Buffer.from('offset:0').toString('base64url'));
    const delivered = await resend.broadcasts.recipients(c.data!.id, { type: 'delivered', limit: 1 });
    expect(delivered.data!.data).toHaveLength(1);
    expect(delivered.data!.has_more).toBe(true);
    const next = await resend.broadcasts.recipients(c.data!.id, { type: 'delivered', limit: 1, after: delivered.data!.data[0]!.id });
    expect(next.data!.data).toHaveLength(1);
    expect(next.data!.has_more).toBe(false);

    // click the tracked link twice and unsubscribe through the one-click endpoint
    const href = /href="([^"]*\/t\/c\/[^"]+)"/.exec(raw)![1]!;
    for (let i = 0; i < 2; i++) await fetch(href, { redirect: 'manual' });
    const clicked = await resend.broadcasts.recipients(c.data!.id, { type: 'clicked' });
    expect(clicked.data!.data[0]).toMatchObject({ email: 'ada@example.com', count: 2, clicked_links: [{ url: 'https://example.com/pricing', clicks: 2 }] });
    const links = await resend.broadcasts.clickedLinks(c.data!.id);
    expect(links.data!.data[0]).toMatchObject({ url: 'https://example.com/pricing', clicks: 2, unique_clicks: 1 });
    const unsub = /List-Unsubscribe: <([^>]+)>/.exec(raw)![1]!;
    expect((await fetch(unsub, { method: 'POST' })).status).toBe(200);
    expect((await resend.contacts.get({ email: 'ada@example.com' })).data!.unsubscribed).toBe(true);
    const unsubscribed = await resend.broadcasts.recipients(c.data!.id, { type: 'unsubscribed' });
    expect(unsubscribed.data!.data.map((r) => r.email)).toEqual(['ada@example.com']);

    const delSent = await resend.broadcasts.remove(c.data!.id);
    expect(delSent.error!.statusCode).toBe(422);
    await resend.contacts.update({ email: 'ada@example.com', unsubscribed: false });
  });

  it('respects topics (opt-out skipped, default applies)', async () => {
    const topic = await resend.topics.create({ name: 'Product', defaultSubscription: 'opt_out' });
    await resend.contacts.topics.update({ email: 'bob@example.com', topics: [{ id: topic.data!.id, subscription: 'opt_in' }] });
    const c = await resend.broadcasts.create({ segmentId, from: 'news@news.test', subject: 'Topic', text: 'topic news', topicId: topic.data!.id });
    t.transport.clear();
    const s = await resend.broadcasts.send(c.data!.id);
    expect(s.data).toEqual({ id: c.data!.id });
    await t.drain();
    expect(t.transport.sent.map((m) => m.recipients[0])).toEqual(['bob@example.com']);
  });

  it('schedules, cancels back to draft, and deletes', async () => {
    const c = await resend.broadcasts.create({ segmentId, from: 'news@news.test', subject: 'Later', text: 'later' });
    const s = await resend.broadcasts.send(c.data!.id, { scheduledAt: 'in 1 hour' });
    expect(s.error).toBeNull();
    let b = await resend.broadcasts.get(c.data!.id);
    expect(b.data!.status).toBe('scheduled');
    expect(b.data!.scheduled_at).toBeTruthy();
    const x = await resend.broadcasts.cancel(c.data!.id);
    expect(x.data).toEqual({ object: 'broadcast', id: c.data!.id });
    b = await resend.broadcasts.get(c.data!.id);
    expect(b.data!.status).toBe('draft');
    expect(b.data!.scheduled_at).toBeNull();
    t.transport.clear();
    await t.drain();
    expect(t.transport.sent).toHaveLength(0);
    const again = await resend.broadcasts.cancel(c.data!.id);
    expect(again.error!.statusCode).toBe(422);
    // scheduled at create time with send:true
    const c2 = await resend.broadcasts.create({ segmentId, from: 'news@news.test', subject: 'S', text: 's', send: true, scheduledAt: 'tomorrow at 9am' });
    expect((await resend.broadcasts.get(c2.data!.id)).data!.status).toBe('scheduled');
    expect((await resend.broadcasts.remove(c2.data!.id)).data!.deleted).toBe(true);
  });

  it('rejects sending from an unverified domain', async () => {
    const c = await resend.broadcasts.create({ segmentId, from: 'x@unverified.test', subject: 'U', text: 'u' });
    const s = await resend.broadcasts.send(c.data!.id);
    expect(s.error).toMatchObject({ statusCode: 403, name: 'validation_error' });
  });

  it('fans out in batches', async () => {
    const seg = await resend.segments.create({ name: 'Big' });
    for (let i = 0; i < 5; i++) await resend.contacts.create({ email: `m${i}@example.com`, segments: [{ id: seg.data!.id }] });
    process.env.BROADCAST_FANOUT_BATCH = '2';
    try {
      const c = await resend.broadcasts.create({ segmentId: seg.data!.id, from: 'news@news.test', subject: 'B', text: 'b', send: true });
      t.transport.clear();
      await t.drain();
      expect(t.transport.sent.map((m) => m.recipients[0]).sort()).toEqual(['m0@example.com', 'm1@example.com', 'm2@example.com', 'm3@example.com', 'm4@example.com']);
      expect((await resend.broadcasts.get(c.data!.id)).data!.status).toBe('sent');
    } finally {
      delete process.env.BROADCAST_FANOUT_BATCH;
    }
  });

  it('supports the legacy audienceId', async () => {
    const c = await resend.broadcasts.create({ audienceId: segmentId, from: 'news@news.test', subject: 'A', text: 'a' } as never);
    expect((await resend.broadcasts.get(c.data!.id)).data!.audience_id).toBe(segmentId);
  });
});
