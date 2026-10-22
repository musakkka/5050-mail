/** Load: ~1000 sends through the fake transport; look for duplicate sends, errors, cross-team leaks. */
import { startServer, ok, bad, info, check, j } from '../lib/harness.js';

const s = await startServer({ DEFAULT_RATE_LIMIT: '100000' });
try {
  const A = await s.team('A', { monthly_quota: 100000, rate_limit: 100000 });
  const B = await s.team('B', { monthly_quota: 100000, rate_limit: 100000 });
  await s.domain(A, 'load-a.test');
  await s.domain(B, 'load-b.test');
  const kA = (await s.key(A)).token;
  const kB = (await s.key(B)).token;

  const N = 1000;
  const t0 = Date.now();
  // Bounded concurrency so we don't exhaust local ephemeral sockets (this is an in-process server).
  const results: { status: number; json: any; text: string }[] = new Array(N);
  const CONC = 50;
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (let i = next++; i < N; i = next++) {
      const team = i % 2 === 0 ? { k: kA, d: 'load-a.test' } : { k: kB, d: 'load-b.test' };
      results[i] = await s.req('POST', '/emails', { key: team.k, body: { from: `u@${team.d}`, to: `rcpt${i}@example.com`, subject: `load ${i}`, text: 'x', tags: [{ name: 'i', value: String(i) }] } });
    }
  }));
  const bad200 = results.filter((r) => r.status !== 200);
  check('load.all-accepted', bad200.length === 0, `${bad200.length}/${N} non-200; sample ${j(bad200[0]?.text)?.slice(0, 120)}`);
  const ids = results.map((r) => r.json?.id);
  check('load.unique-ids', new Set(ids).size === N, `${new Set(ids).size} unique of ${N}`);

  // idempotency under concurrency: same key hammered 200x -> at most one email
  const conc = await Promise.all(Array.from({ length: 50 }, () => s.req('POST', '/emails', { key: kA, body: { from: 'u@load-a.test', to: 'dedupe@example.com', subject: 'dup', text: 'x' }, headers: { 'idempotency-key': 'load-dedupe' } })));
  const concIds = new Set(conc.filter((r) => r.status === 200).map((r) => r.json.id));
  const concNames = conc.map((r) => r.json?.name).filter(Boolean);
  check('load.idempotency-concurrency', concIds.size === 1, `distinct ids=${concIds.size}; non-200 names: ${[...new Set(concNames)].join(',')}`);

  // drain the worker and check: each email handed to transport exactly once, correct team, no cross-team recipients
  let rounds = 0;
  while ((await s.drain()) > 0 && rounds < 200) rounds++;
  const sent = s.transport.sent;
  const byEmail = new Map<string, number>();
  for (const m of sent) byEmail.set(m.emailId, (byEmail.get(m.emailId) ?? 0) + 1);
  const dupes = [...byEmail.entries()].filter(([, n]) => n > 1);
  check('load.no-duplicate-transport', dupes.length === 0, `${dupes.length} emails sent more than once: ${j(dupes.slice(0, 5))}`);
  const [{ n: queued }] = await s.ctx.sql`select count(*)::int n from emails where last_event in ('queued','scheduled')`;
  check('load.all-processed', queued === 0, `${queued} emails still queued after drain`);
  const [{ n: sentEvents }] = await s.ctx.sql`select count(*)::int n from emails where last_event = 'sent' or last_event = 'delivered'`;
  info('load.sent-count', `${sent.length} transport sends; ${sentEvents} emails at sent/delivered; ${rounds} drain rounds in handled`);

  // Cross-team: no message for team A carried a team B domain sender, and vice-versa
  let mix = 0;
  for (const m of sent) {
    const dom = m.from.split('@')[1];
    if (m.teamId === A && dom !== 'load-a.test') mix++;
    if (m.teamId === B && dom !== 'load-b.test') mix++;
  }
  check('load.no-team-mixup', mix === 0, `${mix} messages with a sender domain not matching their team`);

  // jobs table drained, no orphaned locks
  const [{ n: jobsLeft }] = await s.ctx.sql`select count(*)::int n from jobs`;
  check('load.jobs-drained', jobsLeft === 0, `${jobsLeft} jobs left`);

  // error log scan
  const logs = (s.ctx as any).__logs as string[];
  const errs = logs.filter((l) => /error|failed|unhandled/i.test(l) && !/log write failed/.test(l));
  check('load.no-worker-errors', errs.length === 0, `${errs.length} error log lines; sample: ${errs.slice(0, 3).join(' || ').slice(0, 300)}`);
  info('load.timing', `${N} POST /emails accepted in ${Date.now() - t0}ms`);
} finally {
  await s.close();
}
