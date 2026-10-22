/**
 * Process supervisor: `node dist/cluster.js web|worker|smtp`.
 *
 * Runs one process per CPU core by default (WEB_CONCURRENCY=auto|<n>; 1 = no
 * cluster). The primary applies migrations once, then forks; the children share
 * the listening sockets (node:cluster round-robin) and the Postgres database.
 * Only the first worker-role child runs periodic tasks (analytics, rollups,
 * retention); jobs are claimed with FOR UPDATE SKIP LOCKED so any number of
 * children can drain the queue. In-memory rate limits are per process.
 */
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const ROLES = { web: './index.js', worker: './worker.js', smtp: './smtp.js' } as const;
type Role = keyof typeof ROLES;

const role = (process.argv[2] ?? process.env.ROLE ?? 'web') as Role;
if (!(role in ROLES)) {
  console.error(`unknown role "${role}" (web|worker|smtp)`);
  process.exit(2);
}

export function concurrency(v = process.env.WEB_CONCURRENCY): number {
  if (!v || v === 'auto') return Math.max(1, availableParallelism());
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

const n = concurrency(role === 'worker' ? (process.env.WORKER_CONCURRENCY ?? '1') : undefined);

if (n <= 1 || !cluster.isPrimary) {
  await import(ROLES[role]);
} else {
  const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), scope: 'cluster', msg, role, ...extra }));
  if (process.env.MIGRATE_ON_START !== '0') {
    const { loadConfig } = await import('./config.js');
    const { createSql, migrate } = await import('./db.js');
    const sql = createSql(loadConfig().databaseUrl, { max: 1 });
    await migrate(sql, undefined, (m) => log(`migrate: ${m}`));
    await sql.end({ timeout: 5 });
  }
  let stopping = false;
  const fork = (slot: number) => {
    const w = cluster.fork({ MIGRATE_ON_START: '0', CLUSTER_SLOT: String(slot), WORKER_PERIODIC: slot === 0 ? (process.env.WORKER_PERIODIC ?? '1') : '0' });
    w.on('exit', (code, signal) => {
      if (stopping) return;
      log('child exited, restarting', { slot, code, signal });
      setTimeout(() => fork(slot), 1000);
    });
  };
  for (let i = 0; i < n; i++) fork(i);
  log(`started ${n} processes`);
  const stop = () => {
    stopping = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 8000).unref();
    cluster.on('exit', () => {
      if (!Object.keys(cluster.workers ?? {}).length) process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
