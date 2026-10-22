/** Worker handlers for broadcast fan-out and contact imports. */
import { extraHandlers } from '../worker/runner.js';
import { runFanout } from '../services/broadcasts.js';
import { runImport } from '../services/imports.js';

extraHandlers.broadcast_fanout = async (ctx, job) => runFanout(ctx, job.payload as { broadcastId: string; after?: string });
extraHandlers.contact_import = async (ctx, job) => runImport(ctx, job.payload.importId as string);
