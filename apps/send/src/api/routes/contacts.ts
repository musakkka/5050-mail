import type { Context } from 'hono';
import type { AppContext } from '../../context.js';
import { pgToIso } from '../../db.js';
import { E } from '../../lib/errors.js';
import { isUuid } from '../../lib/ids.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { createContact, deleteContact, findContact, propertiesView, updateContact, contactEventData } from '../../services/contacts.js';
import { emit } from '../../services/webhooks.js';
import { body, param, query, teamId, uuidParam, type ApiEnv, type Router } from '../router.js';
import { registerImportRoutes } from './imports.js';

const contactItem = (c: Record<string, unknown>) => ({
  id: c.id, email: c.email, first_name: c.first_name ?? null, last_name: c.last_name ?? null, created_at: c.created_at, unsubscribed: c.unsubscribed,
});

async function contactObject(ctx: AppContext, team: string, c: Record<string, unknown>) {
  return { object: 'contact', ...contactItem(c), properties: await propertiesView(ctx, team, (c.properties as Record<string, unknown>) ?? {}) };
}

async function segmentOr404(ctx: AppContext, team: string, id: string, label = 'Segment') {
  const [s] = await ctx.sql`select * from segments where id = ${id} and team_id = ${team}`;
  if (!s) throw E.notFound(`${label} not found`);
  return s;
}

const topicItem = (t: Record<string, unknown>) => ({
  id: t.id, name: t.name, description: t.description ?? null, default_subscription: t.default_subscription, visibility: t.visibility, created_at: t.created_at,
});

async function topicEvent(ctx: AppContext, t: Record<string, unknown>, deleted = false) {
  return { id: t.id, name: t.name, description: t.description ?? null, default_subscription: t.default_subscription, deleted, created_at: pgToIso(t.created_at as string), updated_at: pgToIso(t.updated_at as string) };
}

const propItem = (p: Record<string, unknown>) => ({ id: p.id, key: p.key, type: p.type, fallback_value: p.fallback_value ?? null, created_at: p.created_at });

function contactRoutes(r: Router, prefix: '' | '/audiences/:audience_id') {
  const seg = async (c: Context<ApiEnv>, ctx: AppContext) => (prefix ? (await segmentOr404(ctx, teamId(c), uuidParam(c, 'audience_id', 'audience_id'), 'Audience')).id as string : undefined);

  r.post(`${prefix}/contacts`, async (c, ctx) => {
    const segId = await seg(c, ctx);
    const row = await createContact(ctx, teamId(c), body(c), segId);
    return c.json({ object: 'contact', id: row.id }, 201);
  });
  r.get(`${prefix}/contacts`, async (c, ctx) => {
    const segId = await seg(c, ctx);
    const page = parsePage(query(c), null);
    const where = segId
      ? ctx.sql`team_id = ${teamId(c)} and id in (select contact_id from contact_segments where segment_id = ${segId})`
      : ctx.sql`team_id = ${teamId(c)}`;
    const { rows, hasMore } = await paginate(ctx.sql, 'contacts', where, page);
    return c.json(list(rows.map(contactItem), hasMore));
  });
  r.get(`${prefix}/contacts/:contact`, async (c, ctx) => {
    const segId = await seg(c, ctx);
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    if (segId) {
      const [m] = await ctx.sql`select 1 from contact_segments where contact_id = ${row.id as string} and segment_id = ${segId}`;
      if (!m) throw E.notFound('Contact not found');
    }
    return c.json(await contactObject(ctx, teamId(c), row));
  });
  r.patch(`${prefix}/contacts/:contact`, async (c, ctx) => {
    await seg(c, ctx);
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    await updateContact(ctx, teamId(c), row, body(c));
    return c.json({ object: 'contact', id: row.id });
  });
  r.delete(`${prefix}/contacts/:contact`, async (c, ctx) => {
    const segId = await seg(c, ctx);
    const key = decodeURIComponent(param(c, 'contact'));
    const row = await findContact(ctx, teamId(c), key);
    if (row) {
      if (segId) {
        // Legacy audience delete removes the contact (audiences were contact containers).
        await deleteContact(ctx, teamId(c), row);
      } else await deleteContact(ctx, teamId(c), row);
    }
    // Resend answers deleted:true even for unknown contacts.
    return c.json({ object: 'contact', contact: key, deleted: true });
  });
}

export function registerContactRoutes(r: Router) {
  // Imports must be registered before /contacts/:contact.
  registerImportRoutes(r);
  contactRoutes(r, '');
  contactRoutes(r, '/audiences/:audience_id');

  // ---- contact ↔ segments
  r.get('/contacts/:contact/segments', async (c, ctx) => {
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'segments', ctx.sql`team_id = ${teamId(c)} and id in (select segment_id from contact_segments where contact_id = ${row.id as string})`, page);
    return c.json(list(rows.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at })), hasMore));
  });
  r.post('/contacts/:contact/segments/:segment_id', async (c, ctx) => {
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    const s = await segmentOr404(ctx, teamId(c), uuidParam(c, 'segment_id', 'segment_id'));
    await ctx.sql`insert into contact_segments (contact_id, segment_id) values (${row.id as string}, ${s.id as string}) on conflict do nothing`;
    await emit(ctx, teamId(c), 'contact.updated', await contactEventData(ctx, row));
    return c.json({ id: s.id });
  });
  r.delete('/contacts/:contact/segments/:segment_id', async (c, ctx) => {
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    const sid = uuidParam(c, 'segment_id', 'segment_id');
    const del = await ctx.sql`delete from contact_segments where contact_id = ${row.id as string} and segment_id = ${sid} returning segment_id`;
    if (del.length) await emit(ctx, teamId(c), 'contact.updated', await contactEventData(ctx, row));
    return c.json({ object: 'contact_segment', id: row.id, audienceId: sid, deleted: true });
  });

  // ---- contact ↔ topics
  r.get('/contacts/:contact/topics', async (c, ctx) => {
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'topics', ctx.sql`team_id = ${teamId(c)}`, page);
    const subs = await ctx.sql`select topic_id, subscription from contact_topics where contact_id = ${row.id as string}`;
    const m = new Map(subs.map((s) => [s.topic_id as string, s.subscription as string]));
    return c.json(list(rows.map((t) => ({ id: t.id, name: t.name, description: t.description ?? null, subscription: m.get(t.id as string) ?? t.default_subscription })), hasMore));
  });
  r.patch('/contacts/:contact/topics', async (c, ctx) => {
    const row = await findContact(ctx, teamId(c), param(c, 'contact'));
    if (!row) throw E.notFound('Contact not found');
    const raw = c.get('requestBody');
    // The Node SDK sends the bare array; the API reference documents `{ topics: [...] }`.
    const topics = Array.isArray(raw) ? raw : (raw as { topics?: unknown } | undefined)?.topics;
    if (!Array.isArray(topics)) throw E.missingField('topics');
    const out: { id: string; subscription: string }[] = [];
    for (const t of topics as { id?: unknown; subscription?: unknown }[]) {
      if (!isUuid(t?.id)) throw E.invalidUuid('topics.id');
      if (t.subscription !== 'opt_in' && t.subscription !== 'opt_out') throw E.validation('Invalid `subscription`. It must be `opt_in` or `opt_out`.');
      const [x] = await ctx.sql`select id from topics where id = ${t.id} and team_id = ${teamId(c)}`;
      if (!x) throw E.notFound('Topic not found');
      out.push({ id: t.id, subscription: t.subscription });
    }
    for (const t of out) {
      await ctx.sql`insert into contact_topics (contact_id, topic_id, subscription) values (${row.id as string}, ${t.id}, ${t.subscription})
                    on conflict (contact_id, topic_id) do update set subscription = excluded.subscription, updated_at = now()`;
    }
    await emit(ctx, teamId(c), 'contact.topics.updated', { email: row.email, topics: out });
    return c.json({ object: 'contact_topics', id: row.id });
  });

  // ---- segments (+ legacy audiences)
  for (const base of ['/segments', '/audiences'] as const) {
    const obj = base === '/segments' ? 'segment' : 'audience';
    const label = base === '/segments' ? 'Segment' : 'Audience';
    r.post(base, async (c, ctx) => {
      const b = body(c);
      if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
      if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
      const [s] = await ctx.sql`insert into segments (team_id, name) values (${teamId(c)}, ${b.name}) returning id, name`;
      return c.json({ object: obj, id: s!.id, name: s!.name }, 201);
    });
    r.get(base, async (c, ctx) => {
      const page = parsePage(query(c), null);
      const { rows, hasMore } = await paginate(ctx.sql, 'segments', ctx.sql`team_id = ${teamId(c)}`, page);
      return c.json(list(rows.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at })), hasMore));
    });
    if (base === '/segments') {
      r.get('/segments/metrics', async (c, ctx) => {
        const q = c.req.queries();
        const multi = (k: string) => (q[k] ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
        const ALL = ['all_contacts', 'subscribers', 'unsubscribers'];
        const metrics = multi('metrics').length ? [...new Set(multi('metrics'))] : ALL;
        for (const m of metrics) if (!ALL.includes(m)) throw E.validation(`Invalid metric \`${m}\`.`);
        const dims = [...new Set(multi('dimensions'))];
        for (const d of dims) if (d !== 'segment') throw E.validation(`Invalid dimension \`${d}\`.`);
        const segIds = multi('segment_id');
        for (const s of segIds) if (!isUuid(s)) throw E.invalidUuid('segment_id');
        const pick = (r: Record<string, unknown>) => Object.fromEntries(metrics.map((m) => [m, r[m] as number]));
        const scope = segIds.length
          ? ctx.sql`and id in (select contact_id from contact_segments where segment_id = any(${segIds}))`
          : ctx.sql``;
        const [tot] = await ctx.sql`select count(*)::int as all_contacts, count(*) filter (where not unsubscribed)::int as subscribers,
                                    count(*) filter (where unsubscribed)::int as unsubscribers from contacts where team_id = ${teamId(c)} ${scope}`;
        const out: Record<string, unknown> = { object: 'metrics', metrics, dimensions: dims, totals: pick(tot!) };
        if (dims.includes('segment')) {
          const rows = await ctx.sql`
            select s.id, s.name, count(ct.id)::int as all_contacts, count(ct.id) filter (where not ct.unsubscribed)::int as subscribers,
                   count(ct.id) filter (where ct.unsubscribed)::int as unsubscribers
            from segments s left join contact_segments cs on cs.segment_id = s.id left join contacts ct on ct.id = cs.contact_id
            where s.team_id = ${teamId(c)} ${segIds.length ? ctx.sql`and s.id = any(${segIds})` : ctx.sql``}
            group by s.id, s.name, s.created_at order by s.created_at desc`;
          out.data = rows.map((x) => ({ id: x.id, name: x.name, ...pick(x) }));
        }
        return c.json(out);
      });
      r.get('/segments/:id/contacts', async (c, ctx) => {
        const s = await segmentOr404(ctx, teamId(c), uuidParam(c, 'id'), 'Audience');
        const page = parsePage(query(c), null);
        const { rows, hasMore } = await paginate(ctx.sql, 'contacts', ctx.sql`team_id = ${teamId(c)} and id in (select contact_id from contact_segments where segment_id = ${s.id as string})`, page);
        return c.json(list(rows.map(contactItem), hasMore));
      });
    }
    r.get(`${base}/:id`, async (c, ctx) => {
      const s = await segmentOr404(ctx, teamId(c), uuidParam(c, 'id'), 'Audience');
      return c.json({ object: obj, id: s.id, name: s.name, created_at: s.created_at });
    });
    if (base === '/segments') {
      r.patch('/segments/:id', async (c, ctx) => {
        const s = await segmentOr404(ctx, teamId(c), uuidParam(c, 'id'), label);
        const b = body(c);
        if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
        if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
        await ctx.sql`update segments set name = ${b.name} where id = ${s.id as string}`;
        return c.json({ object: 'segment', id: s.id });
      });
    }
    r.delete(`${base}/:id`, async (c, ctx) => {
      const id = uuidParam(c, 'id');
      await ctx.sql`delete from segments where id = ${id} and team_id = ${teamId(c)}`;
      // Resend answers deleted:true even when the segment didn't exist.
      return c.json({ object: obj, id, deleted: true });
    });
  }

  // ---- topics
  r.post('/topics', async (c, ctx) => {
    const b = body(c);
    if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
    if (typeof b.name !== 'string' || b.name.length > 50) throw E.validation('Invalid `name` field. Max 50 characters.');
    if (b.default_subscription === undefined) throw E.missingField('default_subscription');
    if (b.default_subscription !== 'opt_in' && b.default_subscription !== 'opt_out') throw E.validation('Invalid `default_subscription`. It must be `opt_in` or `opt_out`.');
    if (b.description !== undefined && b.description !== null && (typeof b.description !== 'string' || b.description.length > 200)) throw E.validation('Invalid `description` field. Max 200 characters.');
    if (b.visibility !== undefined && b.visibility !== 'public' && b.visibility !== 'private') throw E.validation('Invalid `visibility`. It must be `public` or `private`.');
    const [t] = await ctx.sql`insert into topics (team_id, name, description, default_subscription, visibility)
                              values (${teamId(c)}, ${b.name}, ${(b.description as string | undefined) ?? null}, ${b.default_subscription}, ${(b.visibility as string | undefined) ?? 'private'}) returning *`;
    await emit(ctx, teamId(c), 'topic.created', await topicEvent(ctx, t!));
    return c.json({ object: 'topic', id: t!.id }, 201);
  });
  r.get('/topics', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'topics', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map(topicItem), hasMore));
  });
  r.get('/topics/:id', async (c, ctx) => {
    const [t] = await ctx.sql`select * from topics where id = ${uuidParam(c, 'id')} and team_id = ${teamId(c)}`;
    if (!t) throw E.notFound('Topic not found');
    return c.json({ object: 'topic', ...topicItem(t) });
  });
  r.patch('/topics/:id', async (c, ctx) => {
    const id = uuidParam(c, 'id');
    const b = body(c);
    const [t] = await ctx.sql`select * from topics where id = ${id} and team_id = ${teamId(c)}`;
    if (!t) throw E.notFound('Topic not found');
    if (b.default_subscription !== undefined && b.default_subscription !== t.default_subscription) throw E.validation('The `default_subscription` of a topic cannot be changed after creation.');
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name || b.name.length > 50)) throw E.validation('Invalid `name` field. Max 50 characters.');
    if (b.description !== undefined && b.description !== null && (typeof b.description !== 'string' || b.description.length > 200)) throw E.validation('Invalid `description` field. Max 200 characters.');
    if (b.visibility !== undefined && b.visibility !== 'public' && b.visibility !== 'private') throw E.validation('Invalid `visibility`. It must be `public` or `private`.');
    const [u] = await ctx.sql`update topics set name = ${(b.name as string | undefined) ?? (t.name as string)},
                              description = ${b.description === undefined ? (t.description as string | null) : (b.description as string | null)},
                              visibility = ${(b.visibility as string | undefined) ?? (t.visibility as string)}, updated_at = now()
                              where id = ${id} returning *`;
    await emit(ctx, teamId(c), 'topic.updated', await topicEvent(ctx, u!));
    return c.json({ object: 'topic', id });
  });
  r.delete('/topics/:id', async (c, ctx) => {
    const id = uuidParam(c, 'id');
    const [t] = await ctx.sql`delete from topics where id = ${id} and team_id = ${teamId(c)} returning *`;
    if (!t) throw E.notFound('Topic not found');
    await emit(ctx, teamId(c), 'topic.deleted', await topicEvent(ctx, t, true));
    return c.json({ object: 'topic', id, deleted: true });
  });

  // ---- contact properties
  r.post('/contact-properties', async (c, ctx) => {
    const b = body(c);
    if (b.key === undefined || b.key === null || b.key === '') throw E.missingField('key');
    if (typeof b.key !== 'string' || !/^[A-Za-z0-9_]{1,50}$/.test(b.key)) throw E.validation('Invalid `key` field. Only alphanumeric characters and underscores are allowed, max 50 characters.');
    if (b.type === undefined) throw E.missingField('type');
    if (b.type !== 'string' && b.type !== 'number') throw E.validation('Invalid `type` field. It must be `string` or `number`.');
    if (b.fallback_value !== undefined && b.fallback_value !== null && typeof b.fallback_value !== b.type) throw E.validation('The `fallback_value` must match the property `type`.');
    const [dup] = await ctx.sql`select id from contact_properties where team_id = ${teamId(c)} and key = ${b.key}`;
    if (dup) throw E.validation(`A contact property with the key \`${b.key}\` already exists.`, 409);
    const [p] = await ctx.sql`insert into contact_properties (team_id, key, type, fallback_value)
                              values (${teamId(c)}, ${b.key}, ${b.type}, ${b.fallback_value === undefined || b.fallback_value === null ? null : ctx.sql.json(b.fallback_value as never)}) returning id`;
    return c.json({ object: 'contact_property', id: p!.id }, 201);
  });
  r.get('/contact-properties', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'contact_properties', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map(propItem), hasMore));
  });
  r.get('/contact-properties/:id', async (c, ctx) => {
    const [p] = await ctx.sql`select * from contact_properties where id = ${uuidParam(c, 'id')} and team_id = ${teamId(c)}`;
    if (!p) throw E.notFound('Contact property not found');
    return c.json({ object: 'contact_property', ...propItem(p) });
  });
  r.patch('/contact-properties/:id', async (c, ctx) => {
    const id = uuidParam(c, 'id');
    const b = body(c);
    const [p] = await ctx.sql`select * from contact_properties where id = ${id} and team_id = ${teamId(c)}`;
    if (!p) throw E.notFound('Contact property not found');
    if (b.key !== undefined || b.type !== undefined) throw E.validation('Only `fallback_value` can be updated.');
    if (b.fallback_value !== undefined && b.fallback_value !== null && typeof b.fallback_value !== p.type) throw E.validation('The `fallback_value` must match the property `type`.');
    await ctx.sql`update contact_properties set fallback_value = ${b.fallback_value === undefined || b.fallback_value === null ? null : ctx.sql.json(b.fallback_value as never)} where id = ${id}`;
    return c.json({ object: 'contact_property', id });
  });
  r.delete('/contact-properties/:id', async (c, ctx) => {
    const id = uuidParam(c, 'id');
    const [p] = await ctx.sql`delete from contact_properties where id = ${id} and team_id = ${teamId(c)} returning key`;
    if (!p) throw E.notFound('Contact property not found');
    await ctx.sql`update contacts set properties = properties - ${p.key as string} where team_id = ${teamId(c)} and properties ? ${p.key as string}`;
    return c.json({ object: 'contact_property', id, deleted: true });
  });
}
