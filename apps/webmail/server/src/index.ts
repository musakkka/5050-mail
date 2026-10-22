import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from './config.js';
import { MemorySessionStore } from './sessions.js';
import { PgSessionStore } from './pgSessions.js';
import { createApp } from './app.js';
import { MailWorker } from './worker.js';

const config = loadConfig();
if (config.redisUrl) {
  console.warn('[webmail] REDIS_URL is set but the Redis session store is not implemented yet; using in-memory sessions.');
}
const store = config.databaseUrl
  ? new PgSessionStore(config.databaseUrl, config.sessionSecret, config.sessionIdleMs, config.sessionMaxMs)
  : new MemorySessionStore(config.sessionIdleMs, config.sessionMaxMs);

// In cluster mode only the first process runs the mail worker.
const worker = config.workerEnabled && (process.env.CLUSTER_SLOT ?? '0') === '0'
  ? new MailWorker({
      fetch,
      stalwartUrl: config.stalwartUrl,
      intervalMs: config.workerIntervalMs,
      sessions: async () => (await store.all()).map((s) => ({ email: s.email, authorization: s.authorization })),
      log: (m) => console.log(m),
    })
  : undefined;
worker?.start();

const app = createApp({
  config,
  store,
  worker,
  peerIp: (c) => {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  },
  mountStatic: (app) => {
    const root = relative(process.cwd(), config.staticDir) || '.';
    const indexPath = join(config.staticDir, 'index.html');
    if (!existsSync(indexPath)) {
      console.warn(`[webmail] no SPA build at ${config.staticDir}; only API/proxy routes are served`);
      return;
    }
    app.use(
      '/assets/*',
      serveStatic({
        root,
        onFound: (_p, c) => {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.use('*', serveStatic({ root }));
    // SPA fallback for client-side routes.
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(readFileSync(indexPath, 'utf8'));
    });
  },
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[webmail] web listening on :${info.port}, Stalwart at ${config.stalwartUrl}`);
});

// SSE connections are long-lived: don't let Node's default timeouts cut them.
const s = server as unknown as { requestTimeout: number; headersTimeout: number; keepAliveTimeout: number };
s.requestTimeout = 0;
s.headersTimeout = 65_000;
s.keepAliveTimeout = 65_000;

const shutdown = () => {
  console.log('[webmail] shutting down');
  worker?.stop();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
