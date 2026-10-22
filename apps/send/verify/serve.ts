/**
 * Long-running local stack for curl / openssl / nodemailer / SDK probes:
 * web (API at :PORT/v, dashboard at :PORT), inline worker, SMTP relay (implicit TLS + STARTTLS).
 * Fresh database, fake transport, fake Cloudflare. Writes fixtures to $STATE (JSON).
 *
 *   PORT=3900 SMTP_TLS_PORT=3465 SMTP_STARTTLS_PORT=3587 STATE=/tmp/state.json npx tsx verify/serve.ts
 */
import { writeFileSync } from 'node:fs';
import { startServer } from './lib/harness.js';
import { startWorker } from '../src/worker/runner.js';
import { startSmtp } from '../src/smtp/server.js';
import { serve } from '@hono/node-server';
import { createServerApp } from '../src/server.js';

const port = Number(process.env.PORT ?? 3900);
const env: Record<string, string> = {
  DEFAULT_RATE_LIMIT: process.env.RATE ?? '2',
  ALLOW_PRIVATE_WEBHOOKS: process.env.ALLOW_PRIVATE_WEBHOOKS ?? '0',
  WORKER_POLL_MS: '200',
  ...(process.env.EXTRA_ENV ? JSON.parse(process.env.EXTRA_ENV) : {}),
};
const s = await startServer(env);
// Second listener on a fixed port, same ctx (the harness one is on a random port).
const { app } = createServerApp(s.ctx);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
s.config.publicApiBase = `http://127.0.0.1:${port}/v`;
s.config.publicTrackingBase = s.config.publicApiBase;
s.config.dashboardBase = `http://127.0.0.1:${port}`;

const worker = process.env.NO_WORKER ? null : startWorker(s.ctx);
const smtp = await startSmtp(s.ctx, {
  listen: [
    { port: Number(process.env.SMTP_TLS_PORT ?? 3465), implicitTls: true, host: '127.0.0.1' },
    { port: Number(process.env.SMTP_STARTTLS_PORT ?? 3587), implicitTls: false, host: '127.0.0.1' },
  ],
});

const rate = Number(env.DEFAULT_RATE_LIMIT);
const A = await s.team('Team A', { rate_limit: rate, members: [{ email: 'alice@dev.test', role: 'admin' }] });
const B = await s.team('Team B', { rate_limit: rate, members: [{ email: 'bob@dev.test', role: 'admin' }] });
const domA = await s.domain(A, 'a.verify.test');
const domA2 = await s.domain(A, 'a2.verify.test');
const domB = await s.domain(B, 'b.verify.test');
const fixtures = {
  api: s.config.publicApiBase, root: s.config.dashboardBase, dbUrl: s.dbUrl,
  A, B, domA, domA2, domB,
  keyA: (await s.key(A)).token,
  keyA_send: (await s.key(A, 'sending_access')).token,
  keyA_send_dom: (await s.key(A, 'sending_access', domA)).token,
  keyB: (await s.key(B)).token,
};
writeFileSync(process.env.STATE ?? 'verify-state.json', JSON.stringify(fixtures, null, 2));
console.log('READY', JSON.stringify(fixtures));

// Expose the fake transport outbox for probes.
const outbox = serve({
  port: Number(process.env.OUTBOX_PORT ?? port + 1), hostname: '127.0.0.1',
  fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/clear') { s.transport.clear(); return new Response('ok'); }
    if (u.pathname === '/logs') return Response.json(((s.ctx as any).__logs as string[]).slice(-500));
    return Response.json(s.transport.sent.map((m) => ({ emailId: m.emailId, teamId: m.teamId, from: m.from, recipients: m.recipients, at: m.at, raw: m.raw.toString('utf8').slice(0, Number(u.searchParams.get('raw') ?? 4000)) })));
  },
});

const stop = async () => { await worker?.stop(); await smtp.close(); outbox.close(); await s.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
