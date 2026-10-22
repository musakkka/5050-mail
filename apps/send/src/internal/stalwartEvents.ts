/** POST /internal/stalwart-events: delivery and queue events from the local Stalwart (webhook). */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { applyStalwartEvents, parseEventsBody } from '../services/stalwartEvents.js';

export const STALWART_EVENTS_PATH = '/internal/stalwart-events';
const MAX_BODY = 2 * 1024 * 1024;

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createStalwartEventsApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.post(STALWART_EVENTS_PATH, async (c) => {
    const secret = ctx.config.stalwartEventsSecret;
    if (!secret) return c.json({ error: 'disabled', message: 'STALWART_EVENTS_SECRET is not configured' }, 503);
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m || !secretMatches(m[1]!, secret)) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: 'too_large' }, 413);
    let events;
    try {
      events = parseEventsBody(raw);
    } catch {
      return c.json({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    try {
      return c.json({ ok: true, ...(await applyStalwartEvents(ctx, events)) });
    } catch (e) {
      // 5xx makes Stalwart retry the batch; every step is idempotent.
      ctx.log('stalwart-events', 'failed to apply events', { error: (e as Error).message });
      return c.json({ error: 'internal' }, 500);
    }
  });
  return app;
}
