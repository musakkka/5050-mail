/** Worker registrations for Inboxes and Receiving. */
import type { AppContext } from '../context.js';
import { extraPeriodic } from '../worker/runner.js';
import { JmapInboundPoller, jmapInboundConfig } from '../services/inboundJmap.js';

let poller: JmapInboundPoller | null = null;

extraPeriodic.push({
  name: 'inbound_jmap',
  every: Number(process.env.INBOUND_JMAP_INTERVAL_SEC ?? 15) * 1000,
  fn: async (ctx: AppContext) => {
    const cfg = jmapInboundConfig();
    if (!cfg) return;
    poller ??= new JmapInboundPoller(ctx, cfg);
    return poller.pollOnce();
  },
});

// Trashed threads are deleted 30 days after they were moved to trash.
extraPeriodic.push({
  name: 'inbox_trash',
  every: 3600_000,
  fn: async (ctx: AppContext) => ctx.sql`delete from inbox_threads where folder = 'trash' and trash_at is not null and trash_at < now()`,
});
