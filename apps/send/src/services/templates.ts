/**
 * Templates: a mutable draft plus a published snapshot (`templates.published`)
 * that POST /emails `template` and automation send_email steps read.
 */
import type { AppContext } from '../context.js';
import { parseAddress, toList } from '../lib/address.js';
import { E } from '../lib/errors.js';
import { UUID_RE, uuid } from '../lib/ids.js';

export const RESERVED_VARIABLES = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'UNSUBSCRIBE_URL', 'RESEND_UNSUBSCRIBE_URL', 'contact', 'this'];
export const VARIABLE_TYPES = ['string', 'number', 'boolean', 'object', 'list'];
export const MAX_VARIABLES = 50;

export interface StoredVariable {
  id: string;
  key: string;
  type: string;
  fallback_value: unknown;
  created_at: string;
  updated_at: string;
}

export interface TemplateRow {
  id: string;
  team_id: string;
  name: string;
  alias: string | null;
  status: 'draft' | 'published';
  subject: string | null;
  html: string;
  text: string | null;
  from_addr: string | null;
  reply_to: string[] | null;
  variables: StoredVariable[];
  published: Record<string, unknown> | null;
  current_version_id: string;
  has_unpublished_versions: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

const pgNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '+00');

function fallbackMatches(type: string, v: unknown): boolean {
  if (v === null || v === undefined) return true;
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return typeof v === 'object' && !Array.isArray(v);
    case 'list': return Array.isArray(v);
    default: return false;
  }
}

export function validateVariables(input: unknown, previous: StoredVariable[] = []): StoredVariable[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw E.validation('Invalid `variables` field. It must be an array.');
  if (input.length > MAX_VARIABLES) throw E.validation(`A template can have at most ${MAX_VARIABLES} variables.`);
  const seen = new Set<string>();
  const prev = new Map(previous.map((v) => [v.key, v]));
  const now = pgNow();
  return input.map((v: { key?: unknown; type?: unknown; fallback_value?: unknown }) => {
    if (!v || typeof v !== 'object') throw E.validation('Invalid variable. Each variable needs a `key` and a `type`.');
    if (v.key === undefined || v.key === null || v.key === '') throw E.missingField('variables.key');
    if (typeof v.key !== 'string' || !/^[A-Za-z0-9_]{1,50}$/.test(v.key)) {
      throw E.validation('Invalid variable `key`. It may only contain ASCII letters, numbers and underscores, and be at most 50 characters.');
    }
    if (RESERVED_VARIABLES.includes(v.key)) throw E.validation(`The variable name \`${v.key}\` is reserved and cannot be used.`);
    if (seen.has(v.key)) throw E.validation(`Duplicate variable \`${v.key}\`.`);
    seen.add(v.key);
    if (v.type === undefined) throw E.missingField('variables.type');
    if (typeof v.type !== 'string' || !VARIABLE_TYPES.includes(v.type)) throw E.validation(`Invalid variable \`type\`. It must be one of: ${VARIABLE_TYPES.join(', ')}.`);
    if (!fallbackMatches(v.type, v.fallback_value)) throw E.validation(`The fallback value of \`${v.key}\` must match its type (${v.type}).`);
    const old = prev.get(v.key);
    return {
      id: old?.id ?? uuid(),
      key: v.key,
      type: v.type,
      fallback_value: v.fallback_value ?? null,
      created_at: old?.created_at ?? now,
      updated_at: old && old.type === v.type && JSON.stringify(old.fallback_value) === JSON.stringify(v.fallback_value ?? null) ? old.updated_at : now,
    };
  });
}

function strOrNull(field: string, v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw E.validation(`Invalid \`${field}\` field. It must be a string.`);
  return v;
}

export interface TemplateFields {
  name?: string;
  alias?: string | null;
  subject?: string | null;
  html?: string;
  text?: string | null;
  from?: string | null;
  reply_to?: string[] | null;
  variables?: StoredVariable[];
}

export function validateTemplateInput(b: Record<string, unknown>, creating: boolean, prevVars: StoredVariable[] = []): TemplateFields {
  const out: TemplateFields = {};
  if (creating || b.name !== undefined) {
    if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
    if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
    out.name = b.name;
  }
  if (creating || b.html !== undefined) {
    if (b.html === undefined || b.html === null) throw E.missingField('html');
    if (typeof b.html !== 'string') throw E.validation('Invalid `html` field. It must be a string.');
    out.html = b.html;
  }
  const alias = strOrNull('alias', b.alias);
  if (alias !== undefined) {
    if (alias !== null && (!/^[A-Za-z0-9_.-]{1,100}$/.test(alias) || UUID_RE.test(alias))) {
      throw E.validation('Invalid `alias` field. Use letters, numbers, dashes, dots or underscores (max 100), and not a UUID.');
    }
    out.alias = alias || null;
  }
  const subject = strOrNull('subject', b.subject);
  if (subject !== undefined) out.subject = subject;
  const text = strOrNull('text', b.text);
  if (text !== undefined) out.text = text;
  const from = strOrNull('from', b.from);
  if (from !== undefined) {
    if (from && !parseAddress(from)) throw E.validation('Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.');
    out.from = from || null;
  }
  if (b.reply_to !== undefined) {
    if (b.reply_to === null) out.reply_to = null;
    else {
      const l = toList(b.reply_to);
      if (!l || l.some((a) => !parseAddress(a))) throw E.validation('Invalid `reply_to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.');
      out.reply_to = l.length ? l : null;
    }
  }
  if (b.variables !== undefined) out.variables = validateVariables(b.variables, prevVars);
  return out;
}

export async function findTemplate(ctx: AppContext, teamId: string, idOrAlias: string): Promise<TemplateRow | null> {
  const k = decodeURIComponent(idOrAlias);
  const [row] = UUID_RE.test(k)
    ? await ctx.sql`select * from templates where team_id = ${teamId} and id = ${k.toLowerCase()}`
    : await ctx.sql`select * from templates where team_id = ${teamId} and alias = ${k}`;
  return (row as unknown as TemplateRow) ?? null;
}

async function assertAliasFree(ctx: AppContext, teamId: string, alias: string | null | undefined, exceptId?: string) {
  if (!alias) return;
  const [dup] = await ctx.sql`select id from templates where team_id = ${teamId} and alias = ${alias} ${exceptId ? ctx.sql`and id <> ${exceptId}` : ctx.sql``}`;
  if (dup) throw E.validation(`A template with the alias \`${alias}\` already exists.`, 409);
}

export async function createTemplate(ctx: AppContext, teamId: string, b: Record<string, unknown>): Promise<string> {
  const f = validateTemplateInput(b, true);
  await assertAliasFree(ctx, teamId, f.alias);
  const [row] = await ctx.sql`
    insert into templates (team_id, name, alias, subject, html, text, from_addr, reply_to, variables)
    values (${teamId}, ${f.name!}, ${f.alias ?? null}, ${f.subject ?? null}, ${f.html!}, ${f.text ?? null}, ${f.from ?? null},
            ${f.reply_to ?? null}, ${ctx.sql.json((f.variables ?? []) as never)})
    returning id`;
  return row!.id as string;
}

export async function updateTemplate(ctx: AppContext, t: TemplateRow, b: Record<string, unknown>): Promise<void> {
  const f = validateTemplateInput(b, false, t.variables);
  if (f.alias !== undefined) await assertAliasFree(ctx, t.team_id, f.alias, t.id);
  const pick = <K extends keyof TemplateFields>(k: K, cur: unknown) => (f[k] === undefined ? cur : f[k]);
  // Any change creates a new draft version on top of the published one.
  await ctx.sql`
    update templates set
      name = ${pick('name', t.name) as string},
      alias = ${pick('alias', t.alias) as string | null},
      subject = ${pick('subject', t.subject) as string | null},
      html = ${pick('html', t.html) as string},
      text = ${pick('text', t.text) as string | null},
      from_addr = ${pick('from', t.from_addr) as string | null},
      reply_to = ${pick('reply_to', t.reply_to) as string[] | null},
      variables = ${ctx.sql.json(pick('variables', t.variables) as never)},
      current_version_id = gen_random_uuid(),
      has_unpublished_versions = ${t.status === 'published'},
      updated_at = now()
    where id = ${t.id}`;
}

export async function publishTemplate(ctx: AppContext, t: TemplateRow): Promise<void> {
  const snapshot = {
    subject: t.subject,
    html: t.html,
    text: t.text,
    from: t.from_addr,
    reply_to: t.reply_to,
    variables: (t.variables ?? []).map((v) => ({ key: v.key, type: v.type, fallback_value: v.fallback_value })),
    version_id: t.current_version_id,
  };
  await ctx.sql`
    update templates set status = 'published', published = ${ctx.sql.json(snapshot as never)}, has_unpublished_versions = false,
                         published_at = now(), updated_at = now()
    where id = ${t.id}`;
}

export async function duplicateTemplate(ctx: AppContext, t: TemplateRow): Promise<string> {
  const vars = (t.variables ?? []).map((v) => ({ ...v, id: uuid() }));
  const [row] = await ctx.sql`
    insert into templates (team_id, name, alias, subject, html, text, from_addr, reply_to, variables)
    values (${t.team_id}, ${`${t.name} (Copy)`}, ${null}, ${t.subject}, ${t.html}, ${t.text}, ${t.from_addr}, ${t.reply_to}, ${ctx.sql.json(vars as never)})
    returning id`;
  return row!.id as string;
}

export function templateObject(t: TemplateRow) {
  return {
    object: 'template',
    id: t.id,
    current_version_id: t.current_version_id,
    alias: t.alias,
    name: t.name,
    created_at: t.created_at,
    updated_at: t.updated_at,
    status: t.status,
    published_at: t.published_at ?? null,
    from: t.from_addr ?? null,
    subject: t.subject ?? null,
    reply_to: t.reply_to ?? null,
    html: t.html,
    text: t.text ?? null,
    variables: t.variables ?? [],
    has_unpublished_versions: t.has_unpublished_versions,
  };
}

export const templateListItem = (t: Record<string, unknown>) => ({
  id: t.id,
  name: t.name,
  status: t.status,
  published_at: t.published_at ?? null,
  created_at: t.created_at,
  updated_at: t.updated_at,
  alias: t.alias ?? null,
});
