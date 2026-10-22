/**
 * Test DB: a local postgres:16 container (docker run … -p 55432:5432 postgres:16-alpine,
 * see README). A template database with all migrations is built once; every test
 * file then clones it (CREATE DATABASE … TEMPLATE), so files run isolated and in parallel.
 */
import postgres from 'postgres';
import { createSql, migrate } from '../src/db.js';

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://send:sendpw@localhost:55432/postgres';
/** Per-run prefix so concurrent runs (other worktrees) never drop each other's databases. */
export const RUN_PREFIX = process.env.SEND_TEST_RUN ?? `send_test_${Math.floor(Date.now() / 1000)}_${process.pid}`;
export const TEMPLATE_DB = `${RUN_PREFIX}_tpl`;

export default async function setup() {
  process.env.SEND_TEST_RUN = RUN_PREFIX;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin`select 1`;
  } catch (e) {
    throw new Error(`Test Postgres not reachable at ${ADMIN_URL}. Start it with: docker run -d --name send-pg -e POSTGRES_PASSWORD=sendpw -e POSTGRES_USER=send -e POSTGRES_DB=send -p 55432:5432 postgres:16-alpine (${(e as Error).message})`);
  }
  // Drop leftovers of runs that started more than 2 hours ago (names carry the start time).
  const cutoff = Math.floor(Date.now() / 1000) - 7200;
  const old = await admin`select datname from pg_database where datname like 'send_test_%'`;
  for (const d of old) {
    const ts = Number(/^send_test_(\d+)_/.exec(d.datname as string)?.[1] ?? 0);
    if (ts && ts < cutoff) await admin.unsafe(`drop database if exists "${d.datname}" with (force)`);
  }
  await admin.unsafe(`create database "${TEMPLATE_DB}"`);
  const sql = createSql(ADMIN_URL.replace(/\/[^/]*$/, `/${TEMPLATE_DB}`), { max: 1 });
  await migrate(sql);
  await sql.end();
  await admin.end();
  return async () => {
    const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    const mine = await a`select datname from pg_database where datname like ${RUN_PREFIX + '%'}`;
    for (const d of mine) await a.unsafe(`drop database if exists "${d.datname}" with (force)`).catch(() => {});
    await a.end();
  };
}
