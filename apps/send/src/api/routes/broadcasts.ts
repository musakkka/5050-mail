import type { AppContext } from '../../context.js';
import { ApiError, E } from '../../lib/errors.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import {
  broadcastListItem, broadcastObject, cancelBroadcast, createBroadcast, duplicateBroadcast, listClickedLinks, listRecipients,
  pageByOffset, RECIPIENT_TYPES, sendBroadcast, updateBroadcast, type BroadcastRow,
} from '../../services/broadcasts.js';
import { cancelJob } from '../../services/jobs.js';
import { body, query, teamId, uuidParam, type Router } from '../router.js';

async function load(ctx: AppContext, team: string, id: string): Promise<BroadcastRow> {
  const [b] = await ctx.sql`select * from broadcasts where id = ${id} and team_id = ${team}`;
  if (!b) throw E.notFound('Broadcast not found');
  return b as unknown as BroadcastRow;
}

export function registerBroadcastRoutes(r: Router) {
  r.post('/broadcasts', async (c, ctx) => {
    const b = await createBroadcast(ctx, c.get('auth'), body(c));
    return c.json({ object: 'broadcast', id: b.id }, 201);
  });

  r.get('/broadcasts', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'broadcasts', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map((b) => broadcastListItem(b as unknown as BroadcastRow)), hasMore));
  });

  r.get('/broadcasts/:id', async (c, ctx) => c.json(broadcastObject(await load(ctx, teamId(c), uuidParam(c, 'id')))));

  r.patch('/broadcasts/:id', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    await updateBroadcast(ctx, c.get('auth'), bc, body(c));
    return c.json({ object: 'broadcast', id: bc.id });
  });

  r.delete('/broadcasts/:id', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    if (bc.status !== 'draft' && bc.status !== 'scheduled') throw E.validation(`Broadcasts with status \`${bc.status}\` cannot be deleted. Only draft or scheduled broadcasts can be deleted.`);
    await cancelJob(ctx.sql, `broadcast:${bc.id}`);
    await ctx.sql`delete from broadcasts where id = ${bc.id}`;
    return c.json({ object: 'broadcast', id: bc.id, deleted: true });
  });

  r.post('/broadcasts/:id/send', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    await sendBroadcast(ctx, c.get('auth'), bc, body<{ scheduled_at?: unknown }>(c).scheduled_at);
    return c.json({ id: bc.id });
  });

  r.post('/broadcasts/:id/cancel', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    await cancelBroadcast(ctx, bc);
    return c.json({ object: 'broadcast', id: bc.id });
  });

  r.post('/broadcasts/:id/duplicate', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    return c.json({ object: 'broadcast', id: await duplicateBroadcast(ctx, bc) }, 201);
  });

  r.get('/broadcasts/:id/recipients', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    const q = query(c);
    if (!q.type) throw new ApiError(422, 'missing_required_parameter', 'Missing `type` parameter.');
    if (!(RECIPIENT_TYPES as readonly string[]).includes(q.type)) throw E.validation(`Invalid \`type\` parameter. It must be one of ${RECIPIENT_TYPES.join(', ')}.`);
    if (q.bounce_type !== undefined) {
      if (q.type !== 'bounced') throw E.validation('The `bounce_type` parameter can only be used with `type=bounced`.');
      if (!['permanent', 'transient', 'undetermined'].includes(q.bounce_type)) throw E.validation('Invalid `bounce_type` parameter. It must be `permanent`, `transient` or `undetermined`.');
    }
    const page = parsePage(q, 20, { uuidCursor: false });
    const rows = await listRecipients(ctx, bc, q.type, q.email, q.bounce_type);
    const p = pageByOffset(rows, page);
    return c.json(list(p.data, p.hasMore));
  });

  r.get('/broadcasts/:id/clicked-links', async (c, ctx) => {
    const bc = await load(ctx, teamId(c), uuidParam(c, 'id'));
    const page = parsePage(query(c), 20, { uuidCursor: false });
    const p = pageByOffset(await listClickedLinks(ctx, bc), page);
    return c.json(list(p.data, p.hasMore));
  });
}
