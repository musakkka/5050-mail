/** Role: worker (scheduled sends, broadcast fan-out, webhooks, analytics, rollups). `node dist/worker.js` */
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate } from './db.js';
import { startWorker } from './worker/runner.js';
import './features.js';

const config = loadConfig();
const ctx = createContext(config);
if (process.env.MIGRATE_ON_START !== '0') await migrate(ctx.sql, undefined, (m) => ctx.log('migrate', m));
const worker = startWorker(ctx);
ctx.log('worker', 'started', { transport: ctx.transport.name, cloudflare: !!ctx.cf });

const shutdown = async () => {
  ctx.log('worker', 'shutting down');
  await worker.stop();
  await ctx.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
