/**
 * Docker HEALTHCHECK for all three roles (ROLE=web|worker|smtp, default web):
 *   web    → GET /health (checks the database)
 *   worker → heartbeat file written by the worker loop is fresh (< 2 min)
 *   smtp   → TCP connect to the first configured SMTP port
 */
import { statSync } from 'node:fs';
import net from 'node:net';

const role = process.env.ROLE ?? 'web';
const done = (ok: boolean) => process.exit(ok ? 0 : 1);

if (role === 'worker') {
  try {
    done(Date.now() - statSync(process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/send-worker.heartbeat').mtimeMs < 120_000);
  } catch {
    done(false);
  }
} else if (role === 'smtp') {
  const port = Number((process.env.SMTP_PORTS_STARTTLS ?? process.env.SMTP_PORTS_TLS ?? '587').split(',')[0]);
  const s = net.connect({ host: '127.0.0.1', port, timeout: 3000 }, () => {
    s.end();
    done(true);
  });
  s.on('error', () => done(false));
  s.on('timeout', () => done(false));
} else {
  fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => done(r.ok))
    .catch(() => done(false));
}
