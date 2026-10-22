import type { AppContext } from '../../context.js';
import { E } from '../../lib/errors.js';
import { UUID_RE } from '../../lib/ids.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { RUN_STATUSES, sendEvent, stopAutomation, validateGraph, validateSchema, type Connection, type Step } from '../../services/automations.js';
import { body, param, query, teamId, uuidParam, type Router } from '../router.js';

const automationItem = (a: Record<string, unknown>) => ({ id: a.id, name: a.name, status: a.status, created_at: a.created_at, updated_at: a.updated_at ?? null });

const automationObject = (a: Record<string, unknown>) => ({
  object: 'automation',
  ...automationItem(a),
  steps: ((a.steps as Step[]) ?? []).map((s) => ({ key: s.key, type: s.type, config: s.config })),
  connections: ((a.connections as Connection[]) ?? []).map((c) => ({ from: c.from, to: c.to, type: c.type ?? 'default' })),
});

const runItem = (r: Record<string, unknown>) => ({ id: r.id, status: r.status, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null, created_at: r.created_at });

const eventItem = (e: Record<string, unknown>) => ({ id: e.id, name: e.name, schema: e.schema ?? null, created_at: e.created_at, updated_at: e.updated_at ?? null });

function status(v: unknown, dflt?: string): string | undefined {
  if (v === undefined) return dflt;
  if (v !== 'enabled' && v !== 'disabled') throw E.validation('Invalid `status` field. It must be `enabled` or `disabled`.');
  return v;
}

async function loadAutomation(ctx: AppContext, team: string, id: string) {
  const [a] = await ctx.sql`select * from automations where id = ${id} and team_id = ${team}`;
  if (!a) throw E.notFound('Automation not found');
  return a;
}

async function findEvent(ctx: AppContext, team: string, key: string) {
  const k = decodeURIComponent(key);
  const [e] = UUID_RE.test(k)
    ? await ctx.sql`select * from event_definitions where team_id = ${team} and (id = ${k.toLowerCase()} or name = ${k})`
    : await ctx.sql`select * from event_definitions where team_id = ${team} and name = ${k}`;
  if (!e) throw E.notFound('Event not found');
  return e;
}

export function registerAutomationRoutes(r: Router) {
  // ---------------- automations
  r.post('/automations', async (c, ctx) => {
    const b = body(c);
    if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
    if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
    const st = status(b.status, 'disabled')!;
    const g = await validateGraph(ctx, teamId(c), b.steps, b.connections);
    const [a] = await ctx.sql`
      insert into automations (team_id, name, status, steps, connections, updated_at)
      values (${teamId(c)}, ${b.name}, ${st}, ${ctx.sql.json(g.steps as never)}, ${ctx.sql.json(g.connections as never)}, now())
      returning id`;
    return c.json({ object: 'automation', id: a!.id }, 201);
  });

  r.get('/automations', async (c, ctx) => {
    const q = query(c);
    const page = parsePage(q, 20);
    const st = q.status === undefined ? undefined : status(q.status);
    const where = st ? ctx.sql`team_id = ${teamId(c)} and status = ${st}` : ctx.sql`team_id = ${teamId(c)}`;
    const { rows, hasMore } = await paginate(ctx.sql, 'automations', where, page, ctx.sql`id, name, status, created_at, updated_at`);
    return c.json(list(rows.map(automationItem), hasMore));
  });

  r.get('/automations/:automation_id', async (c, ctx) => c.json(automationObject(await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id')))));

  r.patch('/automations/:automation_id', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    const b = body(c);
    const hasGraph = b.steps !== undefined || b.connections !== undefined;
    if (b.name === undefined && b.status === undefined && !hasGraph) throw E.validation('Provide at least one of `name`, `status`, or both `steps` and `connections`.');
    if (hasGraph && (b.steps === undefined || b.connections === undefined)) throw E.validation('`steps` and `connections` must be provided together.');
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name)) throw E.validation('Invalid `name` field. It must be a non-empty string.');
    const st = status(b.status, a.status as string)!;
    let steps = a.steps;
    let connections = a.connections;
    if (hasGraph) {
      if (a.status === 'enabled' && st === 'enabled') throw E.validation('The graph of an enabled automation cannot be updated. Disable the automation first, or duplicate it and edit the copy.');
      const g = await validateGraph(ctx, teamId(c), b.steps, b.connections);
      steps = g.steps;
      connections = g.connections;
    }
    await ctx.sql`update automations set name = ${(b.name as string | undefined) ?? (a.name as string)}, status = ${st},
                  steps = ${ctx.sql.json(steps as never)}, connections = ${ctx.sql.json(connections as never)}, updated_at = now()
                  where id = ${a.id as string}`;
    return c.json({ object: 'automation', id: a.id });
  });

  r.delete('/automations/:automation_id', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    await ctx.sql`delete from jobs where kind = 'automation_step' and payload->>'runId' in (select id::text from automation_runs where automation_id = ${a.id as string})`;
    await ctx.sql`delete from automations where id = ${a.id as string}`;
    return c.json({ object: 'automation', id: a.id, deleted: true });
  });

  r.post('/automations/:automation_id/duplicate', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    const [d] = await ctx.sql`
      insert into automations (team_id, name, status, steps, connections, updated_at)
      values (${teamId(c)}, ${`${a.name} (Copy)`}, 'disabled', ${ctx.sql.json(a.steps as never)}, ${ctx.sql.json(a.connections as never)}, now())
      returning id`;
    return c.json({ object: 'automation', id: d!.id }, 201);
  });

  r.post('/automations/:automation_id/stop', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    await stopAutomation(ctx, a.id as string);
    return c.json({ object: 'automation', id: a.id, status: 'disabled' });
  });

  r.get('/automations/:automation_id/runs', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    const q = query(c);
    const page = parsePage(q, null);
    const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const s of statuses) if (!(RUN_STATUSES as readonly string[]).includes(s)) throw E.validation(`Invalid \`status\` filter \`${s}\`. Use: ${RUN_STATUSES.join(', ')}.`);
    const where = statuses.length
      ? ctx.sql`automation_id = ${a.id as string} and team_id = ${teamId(c)} and status = any(${statuses})`
      : ctx.sql`automation_id = ${a.id as string} and team_id = ${teamId(c)}`;
    const { rows, hasMore } = await paginate(ctx.sql, 'automation_runs', where, page, ctx.sql`id, status, started_at, completed_at, created_at`);
    return c.json(list(rows.map(runItem), hasMore));
  });

  r.get('/automations/:automation_id/runs/:run_id', async (c, ctx) => {
    const a = await loadAutomation(ctx, teamId(c), uuidParam(c, 'automation_id', 'automation_id'));
    const [run] = await ctx.sql`select * from automation_runs where id = ${uuidParam(c, 'run_id', 'run_id')} and automation_id = ${a.id as string}`;
    if (!run) throw E.notFound('Automation run not found');
    const order = ((a.steps as Step[]) ?? []).map((s) => s.key);
    const steps = [...((run.steps as Record<string, unknown>[]) ?? [])].map((s, i) => ({ s, i }))
      .sort((x, y) => String(x.s.created_at).localeCompare(String(y.s.created_at)) || order.indexOf(x.s.key as string) - order.indexOf(y.s.key as string) || x.i - y.i)
      .map(({ s }) => ({ key: s.key, type: s.type, status: s.status, started_at: s.started_at ?? null, completed_at: s.completed_at ?? null, output: s.output ?? null, error: s.error ?? null, created_at: s.created_at }));
    return c.json({ object: 'automation_run', ...runItem(run), steps });
  });

  // ---------------- events (custom events that trigger automations)
  r.post('/events', async (c, ctx) => {
    const b = body(c);
    if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
    if (typeof b.name !== 'string' || b.name.length > 256) throw E.validation('Invalid `name` field. It must be a string.');
    if (b.name.startsWith('resend:')) throw E.validation('Event names cannot start with the reserved `resend:` prefix.');
    const schema = validateSchema(b.schema);
    const [dup] = await ctx.sql`select id from event_definitions where team_id = ${teamId(c)} and name = ${b.name}`;
    if (dup) throw E.validation(`An event named \`${b.name}\` already exists.`, 409);
    const [e] = await ctx.sql`insert into event_definitions (team_id, name, schema, updated_at) values (${teamId(c)}, ${b.name}, ${schema ? ctx.sql.json(schema) : null}, now()) returning id`;
    return c.json({ object: 'event', id: e!.id }, 201);
  });

  r.post('/events/send', async (c, ctx) => {
    const b = body(c);
    await sendEvent(ctx, teamId(c), b);
    return c.json({ object: 'event', event: b.event }, 202);
  });

  r.get('/events', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'event_definitions', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map(eventItem), hasMore));
  });

  r.get('/events/:identifier', async (c, ctx) => c.json({ object: 'event', ...eventItem(await findEvent(ctx, teamId(c), param(c, 'identifier'))) }));

  r.patch('/events/:identifier', async (c, ctx) => {
    const e = await findEvent(ctx, teamId(c), param(c, 'identifier'));
    const b = body(c);
    if (!('schema' in b)) throw E.missingField('schema');
    const schema = validateSchema(b.schema);
    await ctx.sql`update event_definitions set schema = ${schema ? ctx.sql.json(schema) : null}, updated_at = now() where id = ${e.id as string}`;
    return c.json({ object: 'event', id: e.id });
  });

  r.delete('/events/:identifier', async (c, ctx) => {
    const e = await findEvent(ctx, teamId(c), param(c, 'identifier'));
    await ctx.sql`delete from event_definitions where id = ${e.id as string}`;
    return c.json({ object: 'event', id: e.id, deleted: true });
  });
}
