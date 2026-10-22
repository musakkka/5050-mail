import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from '../helpers.js';
import { processSendEmail } from '../../src/services/delivery.js';
import { TransportError } from '../../src/transport/index.js';

let t: TestServer;
let key: string;

beforeAll(async () => {
  t = await startTestServer();
  const team = await t.createTeam('Delivery');
  await t.verifiedDomain(team, 'deliv.test');
  key = await t.createKey(team);
});
afterAll(() => t.close());

const send = async (extra: Record<string, unknown> = {}) => {
  const r = await t.fetch('/emails', { method: 'POST', key, body: JSON.stringify({ from: 'a@deliv.test', to: 'x@example.com', subject: 's', text: 't', ...extra }) });
  return { status: r.status, json: (await r.json()) as { id: string; name?: string } };
};
const lastEvent = async (id: string) => (await t.ctx.sql`select last_event, failed_reason from emails where id = ${id}`)[0]!;

describe('delivery is at most once per email', () => {
  it('a duplicate or re-claimed job never sends the same email twice', async () => {
    t.transport.clear();
    const { json } = await send();
    await Promise.all([processSendEmail(t.ctx, json.id), processSendEmail(t.ctx, json.id), processSendEmail(t.ctx, json.id)]);
    expect(t.transport.sent.filter((m) => m.emailId === json.id)).toHaveLength(1);
    await processSendEmail(t.ctx, json.id);
    expect(t.transport.sent.filter((m) => m.emailId === json.id)).toHaveLength(1);
    expect((await lastEvent(json.id)).last_event).toBe('delivered');
  });

  it('an attempt that died mid-send (stale claim) is reported, not resent', async () => {
    t.transport.clear();
    const { json } = await send();
    await t.ctx.sql`update emails set send_claimed_at = now() - interval '11 minutes' where id = ${json.id}`;
    await t.drain();
    expect(t.transport.sent).toHaveLength(0);
    expect(await lastEvent(json.id)).toMatchObject({ last_event: 'failed', failed_reason: 'send_interrupted' });
  });

  it('a retryable transport error releases the claim so the retry sends once', async () => {
    t.transport.clear();
    const { json } = await send();
    t.transport.failNext = new TransportError('temporarily unavailable', true);
    await expect(processSendEmail(t.ctx, json.id, 1, 6)).rejects.toThrow(/temporarily/);
    expect((await t.ctx.sql`select send_claimed_at from emails where id = ${json.id}`)[0]!.send_claimed_at).toBeNull();
    await processSendEmail(t.ctx, json.id, 2, 6);
    expect(t.transport.sent.filter((m) => m.emailId === json.id)).toHaveLength(1);
  });
});

describe('Cloudflare 5 MiB message limit', () => {
  let cf: TestServer;
  let cfKey: string;
  beforeAll(async () => {
    cf = await startTestServer({ TRANSPORT: 'cloudflare' });
    const team = await cf.createTeam('CF');
    await cf.verifiedDomain(team, 'cf-size.test');
    cfKey = await cf.createKey(team);
  });
  afterAll(() => cf.close());

  it('rejects emails over 5 MiB up front with a clear 422', async () => {
    const post = (bytes: number) =>
      cf.fetch('/emails', { method: 'POST', key: cfKey, body: JSON.stringify({ from: 'a@cf-size.test', to: 'x@example.com', subject: 's', text: 't', attachments: [{ filename: 'a.bin', content: Buffer.alloc(bytes).toString('base64') }] }) });
    const big = await post(4 * 1024 * 1024);
    expect(big.status).toBe(422);
    expect(((await big.json()) as { message: string }).message).toMatch(/5MB/);
    expect((await post(1024 * 1024)).status).toBe(200);
    expect(cf.config.smtpMaxMessageBytes).toBe(5 * 1024 * 1024);
  });
});
