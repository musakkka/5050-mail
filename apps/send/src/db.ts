import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Sql = postgres.Sql<Record<string, unknown>>;
// Transaction handles are callable like Sql for tagged templates; keep one type for both.
export type Tx = Sql;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fragment = postgres.PendingQuery<any>;

/**
 * Timestamps come back as Postgres text in UTC (`2025-11-30 20:39:59.540771+00`),
 * which is exactly how Resend renders `created_at` in API responses.
 */
export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? (Number(process.env.PG_POOL_MAX) || 10),
    onnotice: () => {},
    connection: { TimeZone: 'UTC', application_name: '5050-send' },
    types: {
      tstext: {
        to: 1184,
        from: [1184, 1114],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: (x: string) => x,
      },
      // bigint counts as numbers (they never exceed 2^53 here)
      int8num: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  }) as unknown as Sql;
}

/** "2025-11-30 20:39:59.54+00" → ISO 8601 with milliseconds. */
export function pgToIso(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = pgToDate(ts);
  return d ? d.toISOString() : null;
}

export function pgToDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const s = ts.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply pending SQL migrations in order (idempotent; serialised with an advisory lock). */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(505050)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name as string));
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(readFileSync(path.join(dir, f), 'utf8'));
      await tx`insert into schema_migrations (name) values (${f})`;
      applied.push(f);
      log(`applied ${f}`);
    }
  });
  return applied;
}
