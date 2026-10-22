/** Contacts, custom properties, segment membership and topic subscriptions. */
import type { AppContext } from '../context.js';
import { pgToIso } from '../db.js';
import { isEmail } from '../lib/address.js';
import { E } from '../lib/errors.js';
import { isUuid, UUID_RE } from '../lib/ids.js';
import { emit } from './webhooks.js';

export async function contactEventData(ctx: AppContext, c: Record<string, unknown>) {
  const segs = await ctx.sql`select segment_id from contact_segments where contact_id = ${c.id as string} order by created_at`;
  const ids = segs.map((s) => s.segment_id as string);
  return {
    id: c.id,
    audience_id: ids[0] ?? null,
    segment_ids: ids,
    created_at: pgToIso(c.created_at as string),
    updated_at: pgToIso(c.updated_at as string),
    email: c.email,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    unsubscribed: c.unsubscribed,
  };
}

/** Contact by id or email (path parameter), team-scoped. */
export async function findContact(ctx: AppContext, teamId: string, idOrEmail: string): Promise<Record<string, unknown> | undefined> {
  const k = decodeURIComponent(idOrEmail);
  if (UUID_RE.test(k)) return (await ctx.sql`select * from contacts where team_id = ${teamId} and id = ${k}`)[0];
  if (k.includes('@')) return (await ctx.sql`select * from contacts where team_id = ${teamId} and lower(email) = ${k.toLowerCase()}`)[0];
  throw E.invalidParam('The `id` must be a valid UUID or email address.');
}

/** Validate a `properties` map against the team's defined contact properties. */
export async function validateProperties(ctx: AppContext, teamId: string, props: unknown): Promise<Record<string, string | number | null>> {
  if (props === undefined || props === null) return {};
  if (typeof props !== 'object' || Array.isArray(props)) throw E.validation('Invalid `properties` field. It must be an object.');
  const defs = await ctx.sql`select key, type from contact_properties where team_id = ${teamId}`;
  const byKey = new Map(defs.map((d) => [d.key as string, d.type as string]));
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    const type = byKey.get(k);
    if (!type) throw E.validation(`The \`${k}\` property does not exist. Create it with POST /contact-properties first.`);
    if (v === null) out[k] = null;
    else if (type === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (type === 'string' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[k] = String(v);
    else throw E.validation(`Invalid value for the \`${k}\` property. It must be a ${type}.`);
  }
  return out;
}

export async function propertiesView(ctx: AppContext, teamId: string, props: Record<string, unknown>) {
  const defs = await ctx.sql`select key, type from contact_properties where team_id = ${teamId}`;
  const types = new Map(defs.map((d) => [d.key as string, d.type as string]));
  const out: Record<string, { type: string; value: unknown }> = {};
  for (const [k, v] of Object.entries(props ?? {})) if (v !== null && v !== undefined) out[k] = { value: v, type: types.get(k) ?? (typeof v === 'number' ? 'number' : 'string') };
  return out;
}

export interface ContactInput {
  email?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  unsubscribed?: unknown;
  properties?: unknown;
  segments?: unknown;
  topics?: unknown;
}

export async function createContact(ctx: AppContext, teamId: string, b: ContactInput, legacySegmentId?: string): Promise<Record<string, unknown>> {
  if (b.email === undefined || b.email === null || b.email === '') throw E.missingField('email');
  if (typeof b.email !== 'string' || !isEmail(b.email.trim())) throw E.validation('Invalid `email` field.');
  for (const k of ['first_name', 'last_name'] as const) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw E.validation(`Invalid \`${k}\` field. It must be a string.`);
  if (b.unsubscribed !== undefined && typeof b.unsubscribed !== 'boolean') throw E.validation('Invalid `unsubscribed` field. It must be a boolean.');
  const props = await validateProperties(ctx, teamId, b.properties);
  const segIds: string[] = legacySegmentId ? [legacySegmentId] : [];
  if (b.segments !== undefined && b.segments !== null) {
    if (!Array.isArray(b.segments)) throw E.validation('Invalid `segments` field. It must be an array of `{ id }`.');
    for (const s of b.segments as { id?: unknown }[]) {
      const id = typeof s === 'string' ? s : s?.id;
      if (!isUuid(id)) throw E.invalidUuid('segments.id');
      segIds.push(id);
    }
  }
  const topics: { id: string; subscription: string }[] = [];
  if (b.topics !== undefined && b.topics !== null) {
    if (!Array.isArray(b.topics)) throw E.validation('Invalid `topics` field. It must be an array.');
    for (const t of b.topics as { id?: unknown; subscription?: unknown }[]) {
      if (!isUuid(t?.id)) throw E.invalidUuid('topics.id');
      if (t.subscription !== 'opt_in' && t.subscription !== 'opt_out') throw E.validation('Invalid `topics.subscription`. It must be `opt_in` or `opt_out`.');
      topics.push({ id: t.id, subscription: t.subscription });
    }
  }
  for (const id of segIds) {
    const [s] = await ctx.sql`select id from segments where id = ${id} and team_id = ${teamId}`;
    if (!s) throw E.notFound(legacySegmentId === id ? 'Audience not found' : 'Segment not found');
  }
  for (const t of topics) {
    const [x] = await ctx.sql`select id from topics where id = ${t.id} and team_id = ${teamId}`;
    if (!x) throw E.notFound('Topic not found');
  }
  const email = b.email.trim();
  const [existing] = await ctx.sql`select * from contacts where team_id = ${teamId} and lower(email) = ${email.toLowerCase()}`;
  let row: Record<string, unknown>;
  let created = false;
  if (existing) {
    // Resend upserts: adding an existing email to another segment returns the same contact.
    [row] = (await ctx.sql`
      update contacts set first_name = coalesce(${(b.first_name as string | undefined) ?? null}, first_name),
        last_name = coalesce(${(b.last_name as string | undefined) ?? null}, last_name),
        unsubscribed = coalesce(${(b.unsubscribed as boolean | undefined) ?? null}, unsubscribed),
        properties = properties || ${ctx.sql.json(props)}, updated_at = now()
      where id = ${existing.id as string} returning *`) as Record<string, unknown>[];
  } else {
    [row] = (await ctx.sql`
      insert into contacts (team_id, email, first_name, last_name, unsubscribed, properties)
      values (${teamId}, ${email}, ${(b.first_name as string | undefined) ?? null}, ${(b.last_name as string | undefined) ?? null}, ${(b.unsubscribed as boolean | undefined) ?? false}, ${ctx.sql.json(props)})
      returning *`) as Record<string, unknown>[];
    created = true;
  }
  for (const id of segIds) await ctx.sql`insert into contact_segments (contact_id, segment_id) values (${row!.id as string}, ${id}) on conflict do nothing`;
  for (const t of topics) {
    await ctx.sql`insert into contact_topics (contact_id, topic_id, subscription) values (${row!.id as string}, ${t.id}, ${t.subscription})
                  on conflict (contact_id, topic_id) do update set subscription = excluded.subscription, updated_at = now()`;
  }
  await emit(ctx, teamId, created ? 'contact.created' : 'contact.updated', await contactEventData(ctx, row!));
  if (topics.length) await emit(ctx, teamId, 'contact.topics.updated', { email: row!.email, topics });
  return row!;
}

export async function updateContact(ctx: AppContext, teamId: string, c: Record<string, unknown>, b: ContactInput): Promise<void> {
  for (const k of ['first_name', 'last_name'] as const) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw E.validation(`Invalid \`${k}\` field. It must be a string.`);
  if (b.unsubscribed !== undefined && typeof b.unsubscribed !== 'boolean') throw E.validation('Invalid `unsubscribed` field. It must be a boolean.');
  if (b.email !== undefined && (typeof b.email !== 'string' || !isEmail(b.email))) throw E.validation('Invalid `email` field.');
  const props = await validateProperties(ctx, teamId, b.properties);
  const merged = { ...((c.properties as Record<string, unknown>) ?? {}), ...props };
  for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
  const [row] = await ctx.sql`
    update contacts set
      email = ${(b.email as string | undefined) ?? (c.email as string)},
      first_name = ${b.first_name === undefined ? (c.first_name as string | null) : (b.first_name as string | null)},
      last_name = ${b.last_name === undefined ? (c.last_name as string | null) : (b.last_name as string | null)},
      unsubscribed = ${b.unsubscribed === undefined ? (c.unsubscribed as boolean) : (b.unsubscribed as boolean)},
      properties = ${ctx.sql.json(merged as never)}, updated_at = now()
    where id = ${c.id as string} returning *`;
  await emit(ctx, teamId, 'contact.updated', await contactEventData(ctx, row!));
}

export async function deleteContact(ctx: AppContext, teamId: string, c: Record<string, unknown>): Promise<void> {
  const data = await contactEventData(ctx, c);
  await ctx.sql`delete from contacts where id = ${c.id as string}`;
  await emit(ctx, teamId, 'contact.deleted', data);
}
