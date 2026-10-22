/**
 * Bench harness for 5050 Send. Runs the compiled app (APP_DIR/dist) with roles split across
 * processes so single-process and one-process-per-core layouts can be compared.
 *
 *   WEB_PROCS     HTTP API processes (node:cluster, shared port PORT)      default 1
 *   WORKER_PROCS  job worker processes (FOR UPDATE SKIP LOCKED queue)     default 0
 *   SMTP_PROCS    SMTP relay processes (shared port SMTP_PORT, STARTTLS)  default 0
 *   POOL_MAX      Postgres pool per process                               default 5 (as in compose)
 *   SEED=1        drop + recreate the bench database and seed a team/domain/key
 *
 * Transport is a counting no-op (like the app's FakeTransport but without retaining messages),
 * Cloudflare is faked. Nothing leaves the machine. Fixture is written to FIXTURE (JSON).
 */
import cluster from 'node:cluster';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';

const APP = process.env.APP_DIR ?? '/app';
const D = `${APP}/dist`;
const env = (k, d) => process.env[k] ?? d;
const WEB = Number(env('WEB_PROCS', 1));
const WORKERS = Number(env('WORKER_PROCS', 0));
const SMTP = Number(env('SMTP_PROCS', 0));
const POOL = Number(env('POOL_MAX', 5)); // deploy/docker-compose.yml uses PG_POOL_MAX=5
const PORT = Number(env('PORT', 3000));
const SMTP_PORT = Number(env('SMTP_PORT', 2587));
const PG_ADMIN = env('PG_ADMIN', 'postgres://send:sendpw@bench-pg:5432/postgres');
const DB = env('BENCH_DB', 'send_bench');
const DATABASE_URL = PG_ADMIN.replace(/\/[^/]*$/, `/${DB}`);

const appEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  API_HOST: 'api.bench.test',
  DASHBOARD_HOST: 'dash.bench.test',
  DEFAULT_SURFACE: 'dashboard',
  TRANSPORT: 'fake',
  CLOUDFLARE_FAKE: '1',
  CLOUDFLARE_ACCOUNT_ID: 'acct-bench',
  SESSION_SECRET: 'bench-secret-bench-secret-bench-secret-00001',
  INBOUND_SECRET: 'bench-inbound',
  DEFAULT_RATE_LIMIT: '1000000',
  ALLOW_PRIVATE_WEBHOOKS: '1',
  WORKER_POLL_MS: env('WORKER_POLL_MS', '200'),
  ANALYTICS_POLL_INTERVAL_SEC: '86400',
  MIGRATE_ON_START: '0',
};

async function context() {
  const { loadConfig } = await import(`${D}/config.js`);
  const { createContext } = await import(`${D}/context.js`);
  const { createSql } = await import(`${D}/db.js`);
  await import(`${D}/features.js`);
  const config = loadConfig({ ...process.env, ...appEnv });
  let sent = 0;
  const transport = {
    name: 'fake',
    async send(msg) {
      sent++;
      return { providerMessageId: `<bench-${msg.emailId}@bench>`, delivered: msg.recipients, queued: [], permanentBounces: [], suppressed: [] };
    },
  };
  const ctx = createContext(config, { sql: createSql(DATABASE_URL, { max: POOL }), transport, log: () => {} });
  return { ctx, config, sent: () => sent };
}

async function seed() {
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists "${DB}" with (force)`);
  await admin.unsafe(`create database "${DB}"`);
  await admin.end();
  const { migrate, createSql } = await import(`${D}/db.js`);
  const { createApiKey } = await import(`${D}/services/apiKeys.js`);
  const sql = createSql(DATABASE_URL, { max: 2 });
  await migrate(sql);
  const [t] = await sql`insert into teams (name, monthly_quota, daily_quota, rate_limit)
    values ('Bench', 2000000000, null, 1000000) returning id`;
  await sql`insert into team_members (team_id, email, role) values (${t.id}, 'owner@bench.example.com', 'admin')`;
  const [d] = await sql`insert into domains (team_id, name, status, cf_enabled, open_tracking, click_tracking, records)
    values (${t.id}, 'bench.example.com', 'verified', true, false, false, '[]') returning id`;
  const key = await createApiKey(sql, t.id, 'bench', 'full_access', null, null);
  await sql.end();
  return { teamId: t.id, domainId: d.id, key: key.token, from: 'Bench <bench@bench.example.com>' };
}

if (cluster.isPrimary) {
  const fixture = env('SEED', '0') === '1' ? await seed() : null;
  if (fixture) writeFileSync(env('FIXTURE', '/out/fixture.json'), JSON.stringify(fixture, null, 2));
  const roles = [...Array(WEB).fill('web'), ...Array(WORKERS).fill('worker'), ...Array(SMTP).fill('smtp')];
  for (const role of roles) cluster.fork({ ROLE: role });
  let up = 0;
  cluster.on('message', (_w, m) => { if (m === 'up' && ++up === roles.length) console.log(`READY web=${WEB} worker=${WORKERS} smtp=${SMTP} pool=${POOL}`); });
  cluster.on('exit', (w, code) => console.error(`child ${w.process.pid} exited ${code}`));
  const stop = () => { for (const w of Object.values(cluster.workers ?? {})) w?.kill(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  const role = process.env.ROLE;
  const { ctx } = await context();
  if (role === 'web') {
    const { serve } = await import('@hono/node-server');
    const { createServerApp } = await import(`${D}/server.js`);
    const { app } = createServerApp(ctx);
    serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => process.send('up'));
  } else if (role === 'worker') {
    const { startWorker } = await import(`${D}/worker/runner.js`);
    startWorker(ctx);
    process.send('up');
  } else if (role === 'smtp') {
    const { startSmtp } = await import(`${D}/smtp/server.js`);
    await startSmtp(ctx, { listen: [{ port: SMTP_PORT, implicitTls: false, host: '0.0.0.0' }] });
    process.send('up');
  }
}
