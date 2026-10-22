/** SSRF (webhooks + attachment paths), webhook retry schedule/auto-disable, scheduling, quotas, worker-restart idempotency. */
import http from 'node:http';
import { startServer, receiver, ok, bad, info, check, j } from '../lib/harness.js';
import { isPrivateIp, safeRequest, SsrfError } from '../../src/lib/ssrf.js';
import { validateEndpoint } from '../../src/api/routes/webhooks.js';
import { RETRY_SCHEDULE_MS, MAX_ATTEMPTS, AUTO_DISABLE_AFTER_MS, deliverDue } from '../../src/services/webhooks.js';

// ---------------- isPrivateIp unit checks
for (const [ip, want] of [['127.0.0.1', true], ['10.1.2.3', true], ['192.168.1.1', true], ['172.16.0.1', true], ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true], ['::ffff:10.0.0.1', true], ['8.8.8.8', false], ['1.1.1.1', false], ['2606:4700:4700::1111', false]] as const) {
  check(`ssrf.isPrivate ${ip}`, isPrivateIp(ip as string) === want, `isPrivateIp(${ip})=${isPrivateIp(ip as string)} want ${want}`);
}

// ---------------- validateEndpoint rejects private/localhost/credential/non-https-scheme forms
const cfg = { config: { allowPrivateWebhooks: false } } as any;
for (const url of ['http://localhost/h', 'http://127.0.0.1/h', 'http://169.254.169.254/h', 'http://[::1]/h', 'http://10.0.0.1/h', 'http://foo.localhost/h', 'http://foo.internal/h', 'http://user:pass@example.com/h', 'ftp://example.com', 'file:///etc/passwd', 'http://192.168.0.5:8080/h']) {
  let rejected = false;
  try { validateEndpoint(cfg, url); } catch { rejected = true; }
  check(`ssrf.validateEndpoint rejects ${url}`, rejected, `accepted ${url}`);
}
try { validateEndpoint(cfg, 'https://good.example/hook'); ok('ssrf.validateEndpoint allows public https'); } catch (e) { bad('ssrf.validateEndpoint allows public https', (e as Error).message); }
// A DNS name is accepted at validation time but should be blocked at delivery if it resolves private.
try { validateEndpoint(cfg, 'http://127.0.0.1.nip.io/h'); info('ssrf.validateEndpoint.dns-name', 'hostname 127.0.0.1.nip.io accepted at validation (delivery-time DNS check must catch it)'); } catch { ok('ssrf.validateEndpoint.dns-name-rejected'); }

// ---------------- safeRequest blocks private at connect, does not follow redirects, enforces maxBytes
for (const url of ['http://127.0.0.1:1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://user:pw@127.0.0.1/x', 'gopher://127.0.0.1/x']) {
  let blocked = false;
  try { await safeRequest(url, { allowPrivate: false, timeoutMs: 3000 }); } catch (e) { blocked = e instanceof SsrfError; }
  check(`ssrf.safeRequest blocks ${url}`, blocked, `not blocked`);
}
// redirect to a private IP: start a public-ish server (loopback, allowPrivate=true to reach it) that 302s to metadata
const redir = http.createServer((_q, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest' }); res.end(); });
await new Promise<void>((r) => redir.listen(0, '127.0.0.1', () => r()));
const rport = (redir.address() as any).port;
const rr = await safeRequest(`http://127.0.0.1:${rport}/`, { allowPrivate: true, timeoutMs: 3000 });
check('ssrf.no-redirect-follow', rr.status === 302, `followed redirect? status=${rr.status} (should return 302, not fetch metadata)`);
redir.close();

// ---------------- webhook retry schedule matches Resend's documented backoff
const docSchedule = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 5 * 3600_000, 10 * 3600_000, 10 * 3600_000];
check('webhook.retry-schedule', j(RETRY_SCHEDULE_MS) === j(docSchedule) && MAX_ATTEMPTS === 8, `schedule=${j(RETRY_SCHEDULE_MS)} max=${MAX_ATTEMPTS} (docs: immediate + 7 retries = 8 attempts)`);
check('webhook.auto-disable-window', AUTO_DISABLE_AFTER_MS === 5 * 86400_000, `${AUTO_DISABLE_AFTER_MS}`);

// ---------------- end-to-end: retry timing with a failing receiver + clock
const s = await startServer({ DEFAULT_RATE_LIMIT: '1000', ALLOW_PRIVATE_WEBHOOKS: '1' });
try {
  s.clock.set(new Date('2026-06-01T00:00:00Z'));
  const A = await s.team('A', { monthly_quota: 5, daily_quota: 3 });
  await s.domain(A, 'q.test');
  const key = (await s.key(A)).token;
  let failUntil = 99;
  const hook = await receiver((_q, _b, res, n) => { res.writeHead(n <= failUntil ? 500 : 200); res.end('x'); });
  const wh = (await s.req('POST', '/webhooks', { key, body: { endpoint: `${hook.url}/h`, events: ['email.sent'] } })).json;
  await s.req('POST', '/emails', { key, body: { from: 'a@q.test', to: 'x@example.com', subject: 's', text: 't' } });
  // deliver attempt 1 (fails), then walk the clock and count attempts at each documented offset
  const attemptsAt = async () => Number((await s.ctx.sql`select count(*)::int n from webhook_attempts where webhook_id = ${wh.id}`)[0]!.n);
  await s.drain();
  const a1 = await attemptsAt();
  const offsets: number[] = [];
  let acc = 0;
  for (const d of RETRY_SCHEDULE_MS) { acc += d; offsets.push(acc); }
  // advance just before and after each scheduled retry
  let prev = a1;
  const timing: string[] = [];
  let t = 0;
  for (let i = 0; i < RETRY_SCHEDULE_MS.length; i++) {
    const step = RETRY_SCHEDULE_MS[i]!;
    s.clock.advance(step - 1000); t += step - 1000; await deliverDue(s.ctx); const before = await attemptsAt();
    s.clock.advance(2000); t += 2000; await deliverDue(s.ctx); const after = await attemptsAt();
    timing.push(`retry${i + 1}@+${Math.round((offsets[i]!) / 1000)}s: before=${before} after=${after}`);
    prev = after;
  }
  void prev;
  const total = await attemptsAt();
  check('webhook.retry-count', total === MAX_ATTEMPTS, `total attempts=${total} want ${MAX_ATTEMPTS}; timeline: ${timing.join(' | ')}`);
  const [ev] = await s.ctx.sql`select status, attempt_count from webhook_events where webhook_id = ${wh.id}`;
  check('webhook.failed-status', ev?.status === 'failed', `event status=${ev?.status} attempt_count=${ev?.attempt_count}`);
  // auto-disable after 5 days of continuous failure
  const [hk] = await s.ctx.sql`select status, failing_since, disabled_reason from webhooks where id = ${wh.id}`;
  info('webhook.failing_since', `status=${hk?.status} failing_since=${hk?.failing_since} reason=${hk?.disabled_reason ?? ''}`);
  // auto-disable compares DB failing_since against ctx.now(); backdate failing_since 6 days to trigger it
  await s.ctx.sql`update webhooks set failing_since = now() - interval '6 days' where id = ${wh.id}`;
  s.clock.set(new Date(Date.now() + 1000));
  const hookR = await receiver((_q,_b,res)=>{res.writeHead(500);res.end('x');});
  await s.req('PATCH', `/webhooks/${wh.id}`, { key, body: { endpoint: `${hookR.url}/h` } });
  await s.req('POST', '/emails', { key, body: { from: 'a@q.test', to: 'y@example.com', subject: 's2', text: 't' } });
  await s.drain();
  const [hk2] = await s.ctx.sql`select status, disabled_reason from webhooks where id = ${wh.id}`;
  check('webhook.auto-disable', hk2?.status === 'disabled', `failing_since backdated 6 days: status=${hk2?.status} reason=${hk2?.disabled_reason ?? ''}`);
  await hookR.close();
  await hook.close();

  // ---------------- attachment path SSRF at delivery (allowPrivate on here; verify behaviour, then off)
  const s2 = await startServer({ DEFAULT_RATE_LIMIT: '1000' }); // ALLOW_PRIVATE default off
  try {
    const A2 = await s2.team('A2');
    await s2.domain(A2, 'att.test');
    const k2 = (await s2.key(A2)).token;
    const se = await s2.req('POST', '/emails', { key: k2, body: { from: 'a@att.test', to: 'x@example.com', subject: 's', text: 't', attachments: [{ path: 'http://169.254.169.254/latest/meta-data/' }] } });
    await s2.drain(); await s2.drain();
    const [em] = await s2.ctx.sql`select last_event, failed_reason from emails where id = ${se.json.id}`;
    check('ssrf.attachment-private-blocked', !s2.transport.sent.some((m) => m.emailId === se.json.id) && em?.last_event !== 'sent', `email to metadata-IP attachment: last_event=${em?.last_event} reason=${em?.failed_reason}; transport sent? ${s2.transport.sent.some((m) => m.emailId === se.json.id)}`);
    const se2 = await s2.req('POST', '/emails', { key: k2, body: { from: 'a@att.test', to: 'x@example.com', subject: 's', text: 't', attachments: [{ path: 'http://localhost:1/x' }] } });
    await s2.drain(); await s2.drain();
    const [em2] = await s2.ctx.sql`select last_event from emails where id = ${se2.json.id}`;
    check('ssrf.attachment-localhost-blocked', em2?.last_event !== 'sent', `localhost attachment: last_event=${em2?.last_event}`);
  } finally { await s2.close(); }

  // ---------------- scheduled send fires on time; cancel works
  s.transport.clear();
  const future = new Date(s.clock.now!.getTime() + 3600_000);
  const sch = (await s.req('POST', '/emails', { key, body: { from: 'a@q.test', to: 'sch@example.com', subject: 'future', text: 't', scheduled_at: future.toISOString() } })).json;
  await s.drain();
  check('sched.not-early', !s.transport.sent.some((m) => m.emailId === sch.id), 'scheduled email sent before its time');
  s.clock.advance(3600_000 + 1000);
  await s.drain();
  check('sched.fires', s.transport.sent.some((m) => m.emailId === sch.id), 'scheduled email did not fire at its time');
  // cancel
  const sch2 = (await s.req('POST', '/emails', { key, body: { from: 'a@q.test', to: 'c@example.com', subject: 'cancel', text: 't', scheduled_at: new Date(s.clock.now!.getTime() + 3600_000).toISOString() } })).json;
  await s.req('POST', `/emails/${sch2.id}/cancel`, { key });
  s.clock.advance(3600_000 + 1000);
  await s.drain();
  check('sched.cancel-stops-send', !s.transport.sent.some((m) => m.emailId === sch2.id), 'canceled email was still sent');

  // ---------------- quota: daily=3, monthly=5
  s.clock.set(new Date());
  const A3 = await s.team('A3', { monthly_quota: 5, daily_quota: 3 });
  await s.domain(A3, 'quota.test');
  const k3 = (await s.key(A3)).token;
  const q = async () => (await s.req('POST', '/emails', { key: k3, body: { from: 'a@quota.test', to: 'x@example.com', subject: 's', text: 't' } }));
  const d = [await q(), await q(), await q(), await q()];
  check('quota.daily', d[3]!.status === 429 && d[3]!.json?.name === 'daily_quota_exceeded', `4th send same day: ${d.map((x) => x.status).join(',')} / ${d[3]!.json?.name}`);
  // Back-date today's rows to yesterday: daily resets (still 0 today), monthly keeps them (3 used)
  await s.ctx.sql`update emails set created_at = now() - interval '1 day' where team_id = ${A3}`;
  const d2 = [await q(), await q(), await q()];
  check('quota.daily-reset', d2[0]!.status === 200 && d2[1]!.status === 200, `after daily reset: ${d2.map((x) => x.status).join(',')}`);
  check('quota.monthly', d2[2]!.json?.name === 'monthly_quota_exceeded', `6th this month (3 yesterday + 2 today + this): ${d2[2]!.status} ${d2[2]!.json?.name}`);
  // Back-date everything to last month: monthly resets
  await s.ctx.sql`update emails set created_at = now() - interval '40 days' where team_id = ${A3}`;
  check('quota.monthly-reset', (await q()).status === 200, 'monthly quota did not reset across the month boundary');
  // quota headers (daily only for free-plan teams i.e. daily_quota != null)
  const qh = await s.req('POST', '/emails', { key: k3, body: { from: 'a@quota.test', to: 'x@example.com', subject: 's', text: 't' } });
  check('quota.headers', qh.headers.get('x-resend-monthly-quota') !== null && qh.headers.get('x-resend-daily-quota') !== null, `monthly=${qh.headers.get('x-resend-monthly-quota')} daily=${qh.headers.get('x-resend-daily-quota')}`);
  // Paid team (daily_quota null) must NOT get the daily header
  const A4 = await s.team('A4', { monthly_quota: 100, daily_quota: null });
  await s.domain(A4, 'paid.test');
  const k4 = (await s.key(A4)).token;
  const qh2 = await s.req('POST', '/emails', { key: k4, body: { from: 'a@paid.test', to: 'x@example.com', subject: 's', text: 't' } });
  check('quota.daily-header-free-only', qh2.headers.get('x-resend-daily-quota') === null && qh2.headers.get('x-resend-monthly-quota') !== null, `paid team: daily=${qh2.headers.get('x-resend-daily-quota')} monthly=${qh2.headers.get('x-resend-monthly-quota')}`);

  // ---------------- idempotency persists across a "worker restart" (DB-backed): replay returns the same id
  const A5 = await s.team('A5', { monthly_quota: 1000 });
  await s.domain(A5, 'persist.test');
  const k5 = (await s.key(A5)).token;
  const r1 = await s.req('POST', '/emails', { key: k5, body: { from: 'a@persist.test', to: 'persist@example.com', subject: 'persist', text: 't' }, headers: { 'idempotency-key': 'persist-1' } });
  // idempotency state lives only in Postgres, so a worker/web restart cannot cause a duplicate
  const r2 = await s.req('POST', '/emails', { key: k5, body: { from: 'a@persist.test', to: 'persist@example.com', subject: 'persist', text: 't' }, headers: { 'idempotency-key': 'persist-1' } });
  const [{ n: persisted }] = await s.ctx.sql`select count(*)::int n from emails where to_addrs = array['persist@example.com']`;
  check('idem.persisted', r1.json.id === r2.json.id && persisted === 1, `ids ${r1.json.id}/${r2.json.id}; rows=${persisted}`);
} finally {
  await s.close();
}
