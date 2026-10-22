import type { Fragment, Sql } from '../db.js';
import { E } from './errors.js';
import { isUuid } from './ids.js';

export interface PageQuery {
  limit: number | null;
  after?: string;
  before?: string;
}

const LIMIT_MSG = 'The pagination limit must be a number between 1 and 100. See https://resend.com/docs/pagination for more information.';

/**
 * Parse `limit` / `after` / `before` as Resend does. `defaultLimit` null means
 * "no limit given → return everything" (the older list endpoints); otherwise 20.
 */
export function parsePage(q: Record<string, string | undefined>, defaultLimit: number | null = 20, opts: { before?: boolean; uuidCursor?: boolean } = {}): PageQuery {
  const { limit: rawLimit, after, before } = q;
  let limit: number | null = defaultLimit;
  if (rawLimit !== undefined && rawLimit !== '') {
    if (!/^\d+$/.test(rawLimit)) throw E.validation(LIMIT_MSG);
    limit = Number(rawLimit);
    if (limit < 1 || limit > 100) throw E.validation(LIMIT_MSG);
  }
  if (after && before) {
    throw E.validation('You can only use either `after` or `before` parameter, not both. See https://resend.com/docs/pagination for more information.');
  }
  if (before && opts.before === false) throw E.validation('The `before` parameter is not supported for this endpoint.');
  const uuidCursor = opts.uuidCursor ?? true;
  for (const [name, v] of [['after', after], ['before', before]] as const) {
    if (v !== undefined && (v === '' || (uuidCursor && !isUuid(v)))) {
      throw E.validation(`The \`${name}\` parameter must be a valid ID. See https://resend.com/docs/pagination for more information.`);
    }
  }
  return { limit, ...(after ? { after } : {}), ...(before ? { before } : {}) };
}

export interface Page<T> {
  object: 'list';
  has_more: boolean;
  data: T[];
}

/**
 * Keyset pagination over (created_at desc, id desc).
 * `where` is a fragment that already scopes the rows (always includes team_id).
 */
export async function paginate<R extends Record<string, unknown>>(
  sql: Sql,
  table: string,
  where: Fragment,
  page: PageQuery,
  columns: Fragment = sql`*`,
  orderCol = 'created_at',
): Promise<{ rows: R[]; hasMore: boolean }> {
  const t = sql(table);
  const oc = sql(orderCol);
  const cursorId = page.after ?? page.before;
  let cursor: { c: string; id: string } | undefined;
  if (cursorId) {
    const r = await sql`select ${oc}::text as c, id::text as id from ${t} where ${where} and id = ${cursorId}`;
    if (!r.length) {
      // Unknown cursor: nothing after/before it.
      return { rows: [], hasMore: false };
    }
    cursor = r[0] as { c: string; id: string };
  }
  const lim = page.limit;
  const limitSql = lim === null ? sql`` : sql`limit ${lim + 1}`;
  let rows: R[];
  if (cursor && page.before) {
    rows = (await sql`
      select ${columns} from ${t}
      where ${where} and (${oc}, id::text) > (${cursor.c}::timestamptz, ${cursor.id})
      order by ${oc} asc, id asc ${limitSql}`) as unknown as R[];
    const hasMore = lim !== null && rows.length > lim;
    if (hasMore) rows = rows.slice(0, lim!);
    return { rows: rows.reverse(), hasMore };
  }
  rows = (await sql`
    select ${columns} from ${t}
    where ${where} ${cursor ? sql`and (${oc}, id::text) < (${cursor.c}::timestamptz, ${cursor.id})` : sql``}
    order by ${oc} desc, id desc ${limitSql}`) as unknown as R[];
  const hasMore = lim !== null && rows.length > lim;
  return { rows: hasMore ? rows.slice(0, lim!) : rows, hasMore };
}

export const list = <T>(data: T[], hasMore: boolean): Page<T> => ({ object: 'list', has_more: hasMore, data });
