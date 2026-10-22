import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import type { Resend } from 'resend';
import { createDomain, startVerification } from '../../src/services/domains.js';

let t: TestServer;
let resend: Resend;
let team: string;

beforeAll(async () => {
  t = await startTestServer();
  team = await t.createTeam('Domains');
  resend = t.resend(await t.createKey(team));
});
afterAll(() => t.close());

describe('domains (official SDK)', () => {
  it('teams cannot add names inside the operator\'s Cloudflare zones', async () => {
    for (const name of ['cfzone.test', 'anything.acmedemo.test', 'ACMEDEMO.test']) {
      const r = await resend.domains.create({ name });
      expect(r.error, name).toMatchObject({ statusCode: 403, name: 'validation_error' });
      const send = await resend.emails.send({ from: `ceo@${name.toLowerCase()}`, to: 'victim@example.com', subject: 's', text: 'x' });
      expect(send.error!.statusCode).toBe(403);
    }
    expect(t.ctx.cfFake!.zones.flatMap((z) => z.records)).toEqual([]);
    expect((await t.ctx.sql`select count(*)::int as n from domains`)[0]!.n).toBe(0);
  });

  it('a domain registered by a team is not trusted from the operator zone it later shows up in', async () => {
    const other = await t.createTeam('Early');
    // Registered before any zone existed (fake has no zone for it): DNS-only.
    const d = await createDomain(t.ctx, other, { name: 'late.example' });
    expect(d.cf_managed).toBe(false);
    t.ctx.cfFake!.zones.push({ id: 'late-zone', name: 'late.example', records: [], subdomains: [] });
    await startVerification(t.ctx, d);
    await t.drain();
    const [row] = await t.ctx.sql`select status, cf_enabled, last_error from domains where id = ${d.id}`;
    expect(row!.status).not.toBe('verified');
    expect(row!.cf_enabled).toBe(false);
    expect(row!.last_error).toMatch(/operator/);
    expect(t.ctx.cfFake!.zones.find((z) => z.name === 'late.example')!.records).toEqual([]);
    // A subdomain of another team's domain is refused too.
    const sub = await resend.domains.create({ name: 'mail.late.example' });
    expect(sub.error).toMatchObject({ statusCode: 403 });
    await t.ctx.sql`delete from domains where id = ${d.id}`;
    t.ctx.cfFake!.zones = t.ctx.cfFake!.zones.filter((z) => z.name !== 'late.example');
  });

  it('one-click onboarding for a zone in our Cloudflare account (platform admins)', async () => {
    const created = await createDomain(t.ctx, team, { name: 'cfzone.test' }, { platformAdmin: true });
    const { data, error } = await resend.domains.get(created.id);
    expect(error).toBeNull();
    expect(data).toMatchObject({ name: 'cfzone.test', region: 'us-east-1', capabilities: { sending: 'enabled', receiving: 'disabled' } });
    expect(data!.created_at).toMatch(/\+00$/);
    // Cloudflare fake onboarded the subdomain and we published the records into the zone.
    const zone = t.ctx.cfFake!.zones.find((z) => z.name === 'cfzone.test')!;
    expect(zone.subdomains.map((s) => s.name)).toContain('cfzone.test');
    expect(zone.records.some((r) => r.name === 'cf-bounce.cfzone.test' && r.type === 'MX')).toBe(true);
    expect(zone.records.some((r) => r.name === '_dmarc.cfzone.test')).toBe(true);
    const kinds = data!.records.map((r) => `${r.record}:${r.type}:${r.name}`);
    expect(kinds).toContain('DKIM:TXT:cf-bounce._domainkey');
    expect(kinds).toContain('SPF:MX:cf-bounce');
    expect(kinds).toContain('SPF:TXT:cf-bounce');
    for (const r of data!.records) expect(r.ttl).toBe('Auto');

    await t.drain();
    const got = await resend.domains.get(data!.id);
    expect(got.data!.object).toBe('domain');
    expect(got.data!.status).toBe('verified');
    for (const r of got.data!.records.filter((x) => x.record !== 'DMARC' as never)) expect(r.status).toBe('verified');
  });

  it('external domain: shows records, verify checks DNS', async () => {
    const { data } = await resend.domains.create({ name: 'external.example', openTracking: true, trackingSubdomain: 'links' });
    expect(data!.status).toBe('not_started');
    expect(data!.records.find((r) => r.record === 'Tracking')).toMatchObject({ type: 'CNAME', name: 'links' });
    const v = await resend.domains.verify(data!.id);
    expect(v.data).toEqual({ object: 'domain', id: data!.id });
    let d = await resend.domains.get(data!.id);
    expect(d.data!.status).toBe('pending');
    await t.drain();
    d = await resend.domains.get(data!.id);
    expect(['pending', 'failed']).toContain(d.data!.status);
  });

  it('rejects duplicates, bad names and regions', async () => {
    const dup = await resend.domains.create({ name: 'cfzone.test' });
    expect(dup.error).toMatchObject({ statusCode: 403, name: 'validation_error', message: 'The cfzone.test domain has been registered already.' });
    const bad = await resend.domains.create({ name: 'not a domain' });
    expect(bad.error!.statusCode).toBe(422);
    const region = await resend.domains.create({ name: 'r.example', region: 'mars-1' as never });
    expect(region.error!.name).toBe('invalid_region');
    const missing = await resend.domains.create({} as never);
    expect(missing.error).toMatchObject({ name: 'missing_required_field', message: 'Missing `name` field.' });
  });

  it('lists, updates and deletes', async () => {
    const created = await resend.domains.create({ name: 'third.example' });
    const list = await resend.domains.list();
    expect(list.data!.object).toBe('list');
    expect(list.data!.has_more).toBe(false);
    expect(list.data!.data.map((d) => d.name)).toEqual(expect.arrayContaining(['cfzone.test', 'external.example', 'third.example']));
    expect((list.data!.data[0] as unknown as Record<string, unknown>).records).toBeUndefined();
    const paged = await resend.domains.list({ limit: 1 });
    expect(paged.data!.data).toHaveLength(1);
    expect(paged.data!.has_more).toBe(true);

    const upd = await resend.domains.update({ id: created.data!.id, clickTracking: true, openTracking: true, tls: 'enforced' });
    expect(upd.data).toEqual({ object: 'domain', id: created.data!.id });
    const g = await resend.domains.get(created.data!.id);
    expect(g.data!.click_tracking).toBe(true);
    const caps = await resend.domains.update({ id: created.data!.id, capabilities: { sending: 'disabled', receiving: 'disabled' } });
    expect(caps.error!.name).toBe('validation_error');

    const del = await resend.domains.remove(created.data!.id);
    expect(del.data).toEqual({ object: 'domain', id: created.data!.id, deleted: true });
    const gone = await resend.domains.get(created.data!.id);
    expect(gone.error).toMatchObject({ statusCode: 404, name: 'not_found' });
    const badId = await resend.domains.get('nope');
    expect(badId.error).toMatchObject({ statusCode: 422, name: 'invalid_parameter' });
  });

  it('receiving capability adds the Receiving MX record', async () => {
    const { data } = await resend.domains.create({ name: 'inbound.example', capabilities: { receiving: 'enabled' } });
    expect(data!.records.find((r) => r.record === 'Receiving')).toMatchObject({ type: 'MX', priority: 10 });
  });

  it('domain claims', async () => {
    const other = await t.createTeam('Other');
    const otherResend = t.resend(await t.createKey(other));
    const claim = await otherResend.domains.claims.create({ name: 'cfzone.test' });
    expect(claim.data).toMatchObject({ object: 'domain_claim', name: 'cfzone.test', status: 'pending', record: { type: 'TXT', ttl: 'Auto' } });
    const pending = await otherResend.domains.claims.verify(claim.data!.domain_id!);
    expect(pending.data!.status).toBe('pending');
    t.dns.set('cfzone.test', { txt: [claim.data!.record.value] });
    const done = await otherResend.domains.claims.verify(claim.data!.domain_id!);
    expect(done.data!.status).toBe('completed');
    const got = await otherResend.domains.claims.get(claim.data!.domain_id!);
    expect(got.data!.status).toBe('completed');
    const moved = await otherResend.domains.get(claim.data!.domain_id!);
    expect(moved.data!.name).toBe('cfzone.test');
    const original = await resend.domains.list();
    expect(original.data!.data.map((d) => d.name)).not.toContain('cfzone.test');
  });
});
