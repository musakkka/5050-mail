/**
 * `node dist/server/cluster.js`: one BFF process per CPU core (WEB_CONCURRENCY=auto|<n>).
 * More than one process needs shared sessions, so without DATABASE_URL it runs a
 * single process. The children share the listening socket (node:cluster).
 */
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const v = process.env.WEB_CONCURRENCY;
let n = !v || v === 'auto' ? availableParallelism() : Math.max(1, Number(v) || 1);
if (n > 1 && !process.env.DATABASE_URL) {
  console.warn('[webmail] WEB_CONCURRENCY > 1 needs DATABASE_URL for shared sessions; running one process');
  n = 1;
}

if (n <= 1 || !cluster.isPrimary) {
  await import('./index.js');
} else {
  let stopping = false;
  const fork = (slot: number) => {
    cluster.fork({ CLUSTER_SLOT: String(slot) }).on('exit', (code, signal) => {
      if (stopping) return;
      console.warn(`[webmail] process ${slot} exited (${signal ?? code}); restarting`);
      setTimeout(() => fork(slot), 1000);
    });
  };
  for (let i = 0; i < n; i++) fork(i);
  console.log(`[webmail] cluster: ${n} processes`);
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
