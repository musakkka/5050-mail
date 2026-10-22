/**
 * Contact imports (CSV). Runs as the `contact_import` worker job. Like Resend,
 * imported contacts do not trigger contact.* webhooks.
 */
import type { AppContext } from '../context.js';
import { isEmail } from '../lib/address.js';
import { ApiError, E } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';
import { enqueue } from './jobs.js';

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

export interface ColumnMap {
  email?: string;
  first_name?: string;
  last_name?: string;
  unsubscribed?: string;
  properties?: Record<string, { column: string; type?: 'string' | 'number' | 'boolean' }>;
}

export interface ImportOptions {
  column_map: ColumnMap | null;
  on_conflict: 'upsert' | 'skip';
  segments: { id: string }[];
  topics: { id: string; subscription: 'opt_in' | 'opt_out' }[];
}

export const importObject = (r: Record<string, unknown>) => ({
  object: 'contact_import',
  id: r.id,
  status: r.status,
  created_at: r.created_at,
  completed_at: r.completed_at ?? null,
  counts: r.counts,
});

/** RFC 4180 CSV: quoted fields, escaped quotes, CRLF/LF, newlines inside quotes. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function jsonField<T>(name: string, v: string | File | null): T | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw E.validation(`Invalid \`${name}\` field. It must be a JSON-encoded string.`);
  try {
    return JSON.parse(v) as T;
  } catch {
    throw E.validation(`Invalid \`${name}\` field. It must be valid JSON.`);
  }
}

export async function createImport(ctx: AppContext, teamId: string, form: FormData): Promise<string> {
  const file = form.get('file');
  if (!file) throw E.missingField('file');
  if (typeof file === 'string') throw E.validation('Invalid `file` field. It must be a CSV file.');
  if (file.size > MAX_IMPORT_BYTES) throw E.validation('The file exceeds the maximum size of 200MB.');
  const columnMap = jsonField<ColumnMap>('column_map', form.get('column_map'));
  if (columnMap !== null && (typeof columnMap !== 'object' || Array.isArray(columnMap))) throw E.validation('Invalid `column_map` field. It must be an object.');
  for (const k of ['email', 'first_name', 'last_name', 'unsubscribed'] as const) {
    if (columnMap?.[k] !== undefined && typeof columnMap[k] !== 'string') throw E.validation(`Invalid \`column_map.${k}\` field. It must be a column name.`);
  }
  for (const [k, m] of Object.entries(columnMap?.properties ?? {})) {
    if (!/^[A-Za-z0-9_]{1,50}$/.test(k)) throw E.validation(`Invalid property key \`${k}\`.`);
    if (!m || typeof m.column !== 'string') throw E.missingField(`column_map.properties.${k}.column`);
    if (m.type !== undefined && !['string', 'number', 'boolean'].includes(m.type)) throw E.validation(`Invalid type for property \`${k}\`. It must be string, number or boolean.`);
  }
  const onConflict = (form.get('on_conflict') ?? 'upsert') as string;
  if (onConflict !== 'upsert' && onConflict !== 'skip') throw E.validation('Invalid `on_conflict` field. It must be `upsert` or `skip`.');
  const segments = jsonField<{ id: string }[]>('segments', form.get('segments')) ?? [];
  if (!Array.isArray(segments)) throw E.validation('Invalid `segments` field. It must be an array.');
  for (const s of segments) {
    if (!isUuid(s?.id)) throw E.invalidUuid('segments.id');
    const [x] = await ctx.sql`select id from segments where id = ${s.id} and team_id = ${teamId}`;
    if (!x) throw E.notFound('Segment not found');
  }
  const topics = jsonField<{ id: string; subscription: 'opt_in' | 'opt_out' }[]>('topics', form.get('topics')) ?? [];
  if (!Array.isArray(topics)) throw E.validation('Invalid `topics` field. It must be an array.');
  for (const t of topics) {
    if (!isUuid(t?.id)) throw E.invalidUuid('topics.id');
    if (t.subscription !== 'opt_in' && t.subscription !== 'opt_out') throw E.validation('Invalid `topics.subscription`. It must be `opt_in` or `opt_out`.');
    const [x] = await ctx.sql`select id from topics where id = ${t.id} and team_id = ${teamId}`;
    if (!x) throw E.notFound('Topic not found');
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length) throw new ApiError(422, 'validation_error', 'The file is empty.');
  const opts: ImportOptions = { column_map: columnMap, on_conflict: onConflict, segments, topics };
  const [row] = await ctx.sql`insert into contact_imports (team_id, options, file) values (${teamId}, ${ctx.sql.json(opts as never)}, ${bytes}) returning id`;
  await enqueue(ctx.sql, 'contact_import', { importId: row!.id as string }, { uniqueKey: `import:${row!.id}` });
  return row!.id as string;
}

const truthy = (v: string) => ['true', '1', 'yes', 'y', 't'].includes(v.trim().toLowerCase());

export async function runImport(ctx: AppContext, importId: string): Promise<void> {
  const [imp] = await ctx.sql`select * from contact_imports where id = ${importId}`;
  if (!imp || imp.status === 'completed' || imp.status === 'failed') return;
  const teamId = imp.team_id as string;
  const opts = imp.options as ImportOptions;
  await ctx.sql`update contact_imports set status = 'in_progress' where id = ${importId}`;
  const counts = { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    const rows = parseCsv((imp.file as Buffer).toString('utf8'));
    if (!rows.length) throw new Error('The CSV file has no header row');
    const header = rows[0]!.map((h) => h.trim());
    const col = (name: string | undefined, fallback: string[]): number => {
      const want = name ?? null;
      if (want) return header.findIndex((h) => h === want || h.toLowerCase() === want.toLowerCase());
      return header.findIndex((h) => fallback.includes(h.toLowerCase().replace(/[\s-]+/g, '_')));
    };
    const cm = opts.column_map ?? {};
    const ci = {
      email: col(cm.email, ['email', 'email_address', 'e_mail']),
      first: col(cm.first_name, ['first_name', 'firstname', 'first']),
      last: col(cm.last_name, ['last_name', 'lastname', 'last']),
      unsub: col(cm.unsubscribed, ['unsubscribed']),
    };
    if (ci.email < 0) throw new Error('The CSV file has no email column');
    const propCols = Object.entries(cm.properties ?? {}).map(([key, m]) => ({ key, idx: col(m.column, []), type: m.type ?? 'string' }));
    for (const p of propCols) {
      const t = p.type === 'number' ? 'number' : 'string';
      await ctx.sql`insert into contact_properties (team_id, key, type) values (${teamId}, ${p.key}, ${t}) on conflict (team_id, key) do nothing`;
    }
    for (const r of rows.slice(1)) {
      counts.total++;
      const email = (r[ci.email] ?? '').trim();
      if (!email || !isEmail(email)) {
        counts.failed++;
        continue;
      }
      const props: Record<string, string | number> = {};
      let bad = false;
      for (const p of propCols) {
        const raw = p.idx >= 0 ? (r[p.idx] ?? '').trim() : '';
        if (raw === '') continue;
        if (p.type === 'number') {
          const n = Number(raw);
          if (!Number.isFinite(n)) bad = true;
          else props[p.key] = n;
        } else if (p.type === 'boolean') props[p.key] = String(truthy(raw));
        else props[p.key] = raw;
      }
      if (bad) {
        counts.failed++;
        continue;
      }
      const first = ci.first >= 0 ? (r[ci.first] ?? '').trim() || null : null;
      const last = ci.last >= 0 ? (r[ci.last] ?? '').trim() || null : null;
      const unsub = ci.unsub >= 0 && (r[ci.unsub] ?? '').trim() !== '' ? truthy(r[ci.unsub]!) : null;
      const [existing] = await ctx.sql`select id from contacts where team_id = ${teamId} and lower(email) = ${email.toLowerCase()}`;
      let contactId: string;
      if (existing) {
        if (opts.on_conflict === 'skip') {
          counts.skipped++;
          continue;
        }
        await ctx.sql`update contacts set first_name = coalesce(${first}, first_name), last_name = coalesce(${last}, last_name),
                      unsubscribed = coalesce(${unsub}, unsubscribed), properties = properties || ${ctx.sql.json(props)}, updated_at = now()
                      where id = ${existing.id as string}`;
        contactId = existing.id as string;
        counts.updated++;
      } else {
        const [c] = await ctx.sql`insert into contacts (team_id, email, first_name, last_name, unsubscribed, properties)
                                  values (${teamId}, ${email}, ${first}, ${last}, ${unsub ?? false}, ${ctx.sql.json(props)}) returning id`;
        contactId = c!.id as string;
        counts.created++;
      }
      for (const s of opts.segments) await ctx.sql`insert into contact_segments (contact_id, segment_id) values (${contactId}, ${s.id}) on conflict do nothing`;
      for (const t of opts.topics) {
        await ctx.sql`insert into contact_topics (contact_id, topic_id, subscription) values (${contactId}, ${t.id}, ${t.subscription})
                      on conflict (contact_id, topic_id) do update set subscription = excluded.subscription, updated_at = now()`;
      }
    }
    await ctx.sql`update contact_imports set status = 'completed', counts = ${ctx.sql.json(counts)}, completed_at = now(), file = null where id = ${importId}`;
  } catch (e) {
    await ctx.sql`update contact_imports set status = 'failed', counts = ${ctx.sql.json(counts)}, error = ${(e as Error).message}, completed_at = now() where id = ${importId}`;
  }
}
