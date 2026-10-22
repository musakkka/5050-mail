import { computeMetrics } from '../../services/metrics.js';
import { teamId, type Router } from '../router.js';

export function registerMetricsRoutes(r: Router) {
  r.get('/emails/metrics', async (c, ctx) => {
    const q = c.req.queries();
    const one = (k: string) => q[k]?.[0];
    return c.json(
      await computeMetrics(ctx, teamId(c), {
        start_date: one('start_date'),
        end_date: one('end_date'),
        timezone: one('timezone'),
        granularity: one('granularity'),
        metrics: q.metrics,
        dimensions: q.dimensions,
        domain_id: q.domain_id,
        email_id: q.email_id,
        broadcast_id: q.broadcast_id,
      }),
    );
  });
}
