/** Role: web (public API + dashboard). `node dist/index.js` */
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate } from './db.js';
import { createServerApp } from './server.js';
import { startWorker } from './worker/runner.js';
import './features.js';

const config = loadConfig();
const ctx = createContext(config);
if (process.env.MIGRATE_ON_START !== '0') await migrate(ctx.sql, undefined, (m) => ctx.log('migrate', m));
const { app } = createServerApp(ctx);
const server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '0.0.0.0' }, (i) =>
  ctx.log('server', `listening on :${i.port}`, { apiHost: config.apiHost, dashboardHost: config.dashboardHost, transport: ctx.transport.name }),
);
const worker = config.workerInline ? startWorker(ctx) : null;

const shutdown = async () => {
  ctx.log('server', 'shutting down');
  server.close();
  await worker?.stop();
  await ctx.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
