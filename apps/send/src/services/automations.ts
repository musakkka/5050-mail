/**
 * Automations: validation of the step graph, custom events, and a compact run engine
 * (worker job `automation_step`). One active path per run: a step follows the first
 * connection whose type matches its outcome.
 */
import type { AppContext } from '../context.js';
import { isEmail } from '../lib/address.js';
import { E } from '../lib/errors.js';
import { UUID_RE } from '../lib/ids.js';
import { parseDuration } from '../lib/time.js';
import { loadTeam, type AuthContext } from './apiKeys.js';
import { createContact, deleteContact, updateContact } from './contacts.js';
import { normalize, persist } from './emails.js';
import { cancelJob, enqueue } from './jobs.js';
import type { Vars } from './render.js';

export const STEP_TYPES = ['trigger', 'send_email', 'delay', 'wait_for_event', 'condition', 'contact_update', 'contact_delete', 'add_to_segment'] as const;
export const CONNECTION_TYPES = ['default', 'condition_met', 'condition_not_met', 'timeout', 'event_received'] as const;
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'exists', 'is_empty'];
const MAX_STEPS = 150;
const MAX_DURATION_S = 30 * 86400;
const SCHEMA_TYPES = ['string', 'number', 'boolean', 'date'];

export interface Step {
  key: string;
  type: (typeof STEP_TYPES)[number];
  config: Record<string, unknown>;
}
export interface Connection {
  from: string;
  to: string;
  type: (typeof CONNECTION_TYPES)[number];
}
export interface RunStepRecord {
  key: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}
export interface RunContext {
  event_name: string;
  event: Record<string, unknown>;
  email?: string | null;
  wait_events: Record<string, Record<string, unknown>>;
}

const pgTs = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '+00');

// ------------------------------------------------------------------ validation

function duration(field: string, v: unknown, required: boolean): number | null {
  if (v === undefined || v === null) {
    if (required) throw E.missingField(field);
    return null;
  }
  const s = typeof v === 'string' ? parseDuration(v) : null;
  if (!s || s <= 0) throw E.validation(`Invalid \`${field}\`. Use a duration like "30 minutes", "1 hour" or "3 days".`);
  if (s > MAX_DURATION_S) throw E.validation(`The \`${field}\` cannot exceed 30 days.`);
  return s;
}

function validateRule(r: unknown, path: string, allowWaitEvents: boolean): void {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw E.validation(`Invalid \`${path}\`. It must be a rule object.`);
  const o = r as Record<string, unknown>;
  if (o.type === 'and' || o.type === 'or') {
    if (!Array.isArray(o.rules) || !o.rules.length) throw E.validation(`\`${path}.rules\` must contain at least one rule.`);
    o.rules.forEach((x, i) => validateRule(x, `${path}.rules[${i}]`, allowWaitEvents));
    return;
  }
  if (o.type !== 'rule') throw E.validation(`Invalid \`${path}.type\`. It must be \`rule\`, \`and\` or \`or\`.`);
  if (typeof o.field !== 'string' || !/^(event|contact|wait_events)\./.test(o.field)) {
    throw E.validation(`Invalid \`${path}.field\`. It must start with \`event.\`, \`contact.\` or \`wait_events.\`.`);
  }
  if (!allowWaitEvents && o.field.startsWith('wait_events.')) throw E.validation(`\`${path}.field\` cannot use \`wait_events.\` in a wait for event filter.`);
  if (typeof o.operator !== 'string' || !OPERATORS.includes(o.operator)) throw E.validation(`Invalid \`${path}.operator\`. It must be one of: ${OPERATORS.join(', ')}.`);
  if (!['exists', 'is_empty'].includes(o.operator) && !('value' in o)) throw E.missingField(`${path}.value`);
  if (['gt', 'gte', 'lt', 'lte'].includes(o.operator) && typeof o.value !== 'number' && !isVarRef(o.value)) throw E.validation(`\`${path}.value\` must be a number for \`${o.operator}\`.`);
}

const isVarRef = (v: unknown): v is { var: string } => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { var?: unknown }).var === 'string';

export async function validateGraph(ctx: AppContext, teamId: string, stepsIn: unknown, connsIn: unknown): Promise<{ steps: Step[]; connections: Connection[] }> {
  if (!Array.isArray(stepsIn)) throw E.missingField('steps');
  if (!Array.isArray(connsIn)) throw E.missingField('connections');
  if (!stepsIn.length) throw E.validation('An automation needs at least one step.');
  if (stepsIn.length > MAX_STEPS) throw E.validation(`An automation can have at most ${MAX_STEPS} steps.`);
  const keys = new Set<string>();
  const steps: Step[] = [];
  for (const [i, s] of stepsIn.entries()) {
    if (!s || typeof s !== 'object') throw E.validation(`Invalid \`steps[${i}]\`.`);
    const { key, type, config } = s as Record<string, unknown>;
    if (typeof key !== 'string' || !key) throw E.missingField(`steps[${i}].key`);
    if (keys.has(key)) throw E.validation(`Duplicate step key \`${key}\`.`);
    keys.add(key);
    if (typeof type !== 'string' || !(STEP_TYPES as readonly string[]).includes(type)) throw E.validation(`Invalid \`steps[${i}].type\`. It must be one of: ${STEP_TYPES.join(', ')}.`);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw E.missingField(`steps[${i}].config`);
    const cfg = config as Record<string, unknown>;
    const p = `steps[${i}].config`;
    switch (type) {
      case 'trigger':
      case 'wait_for_event':
        if (typeof cfg.event_name !== 'string' || !cfg.event_name) throw E.missingField(`${p}.event_name`);
        if (type === 'wait_for_event') {
          duration(`${p}.timeout`, cfg.timeout, false);
          if (cfg.filter_rule !== undefined && cfg.filter_rule !== null) validateRule(cfg.filter_rule, `${p}.filter_rule`, false);
        }
        break;
      case 'delay':
        duration(`${p}.duration`, cfg.duration, true);
        break;
      case 'condition':
        validateRule(cfg, p, true);
        break;
      case 'send_email': {
        const t = cfg.template as { id?: unknown; variables?: unknown } | undefined;
        if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) throw E.missingField(`${p}.template.id`);
        if (t.variables !== undefined && (typeof t.variables !== 'object' || t.variables === null || Array.isArray(t.variables))) throw E.validation(`Invalid \`${p}.template.variables\`. It must be an object.`);
        const [tpl] = UUID_RE.test(t.id)
          ? await ctx.sql`select id from templates where team_id = ${teamId} and (id = ${t.id} or alias = ${t.id})`
          : await ctx.sql`select id from templates where team_id = ${teamId} and alias = ${t.id}`;
        if (!tpl) throw E.notFound('Template not found');
        for (const f of ['subject', 'from', 'reply_to']) if (cfg[f] !== undefined && cfg[f] !== null && typeof cfg[f] !== 'string') throw E.validation(`Invalid \`${p}.${f}\`. It must be a string.`);
        break;
      }
      case 'add_to_segment': {
        if (typeof cfg.segment_id !== 'string' || !UUID_RE.test(cfg.segment_id)) throw E.invalidUuid(`${p}.segment_id`);
        const [sg] = await ctx.sql`select id from segments where team_id = ${teamId} and id = ${cfg.segment_id}`;
        if (!sg) throw E.notFound('Segment not found');
        break;
      }
      case 'contact_update':
        if (cfg.properties !== undefined && (typeof cfg.properties !== 'object' || cfg.properties === null || Array.isArray(cfg.properties))) throw E.validation(`Invalid \`${p}.properties\`. It must be an object.`);
        break;
      default:
        break;
    }
    steps.push({ key, type: type as Step['type'], config: cfg });
  }
  if (!steps.some((s) => s.type === 'trigger')) throw E.validation('An automation needs at least one `trigger` step.');
  const connections: Connection[] = [];
  for (const [i, c] of connsIn.entries()) {
    const { from, to, type } = (c ?? {}) as Record<string, unknown>;
    if (typeof from !== 'string' || !keys.has(from)) throw E.validation(`Invalid \`connections[${i}].from\`. It must be the key of a step.`);
    if (typeof to !== 'string' || !keys.has(to)) throw E.validation(`Invalid \`connections[${i}].to\`. It must be the key of a step.`);
    const t = type ?? 'default';
    if (typeof t !== 'string' || !(CONNECTION_TYPES as readonly string[]).includes(t)) throw E.validation(`Invalid \`connections[${i}].type\`. It must be one of: ${CONNECTION_TYPES.join(', ')}.`);
    connections.push({ from, to, type: t as Connection['type'] });
  }
  return { steps, connections };
}

// ------------------------------------------------------------------ events

export function validateSchema(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw E.validation('Invalid `schema` field. It must be a flat object of key/type pairs.');
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (typeof t !== 'string' || !SCHEMA_TYPES.includes(t)) throw E.validation(`Invalid type for \`schema.${k}\`. Supported types: ${SCHEMA_TYPES.join(', ')}.`);
  }
  return v as Record<string, string>;
}

function coerce(schema: Record<string, string> | null, payload: Record<string, unknown>): Record<string, unknown> {
  if (!schema) return payload;
  const out = { ...payload };
  for (const [k, t] of Object.entries(schema)) {
    if (!(k in out) || out[k] === null || out[k] === undefined) continue;
    const v = out[k];
    if (t === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw E.validation(`The \`payload.${k}\` value must be a number.`);
      out[k] = n;
    } else if (t === 'boolean') {
      if (typeof v === 'boolean') continue;
      if (v === 'true' || v === 'false') out[k] = v === 'true';
      else throw E.validation(`The \`payload.${k}\` value must be a boolean.`);
    } else if (t === 'date') {
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) throw E.validation(`The \`payload.${k}\` value must be a date.`);
      out[k] = d.toISOString();
    } else out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export interface SendEventInput {
  event?: unknown;
  contact_id?: unknown;
  email?: unknown;
  payload?: unknown;
}

/** POST /events/send: resume waiting runs and start runs of enabled automations triggered by this event. */
export async function sendEvent(ctx: AppContext, teamId: string, b: SendEventInput): Promise<{ started: string[]; resumed: string[] }> {
  if (b.event === undefined || b.event === null || b.event === '') throw E.missingField('event');
  if (typeof b.event !== 'string') throw E.validation('Invalid `event` field. It must be a string.');
  const hasId = b.contact_id !== undefined && b.contact_id !== null;
  const hasEmail = b.email !== undefined && b.email !== null;
  if (hasId === hasEmail) throw E.validation('Exactly one of `contact_id` or `email` must be provided.');
  if (b.payload !== undefined && b.payload !== null && (typeof b.payload !== 'object' || Array.isArray(b.payload))) throw E.validation('Invalid `payload` field. It must be an object.');
  let contact: Record<string, unknown> | undefined;
  let email: string | null = null;
  if (hasId) {
    if (typeof b.contact_id !== 'string' || !UUID_RE.test(b.contact_id)) throw E.invalidUuid('contact_id');
    [contact] = await ctx.sql`select * from contacts where team_id = ${teamId} and id = ${b.contact_id}`;
    if (!contact) throw E.notFound('Contact not found');
    email = contact.email as string;
  } else {
    if (typeof b.email !== 'string' || !isEmail(b.email.trim())) throw E.validation('Invalid `email` field.');
    email = b.email.trim();
    [contact] = await ctx.sql`select * from contacts where team_id = ${teamId} and lower(email) = ${email.toLowerCase()}`;
  }
  const [def] = await ctx.sql`select schema from event_definitions where team_id = ${teamId} and name = ${b.event}`;
  const payload = coerce((def?.schema as Record<string, string> | null) ?? null, (b.payload as Record<string, unknown>) ?? {});

  // Waiting runs for this contact.
  const resumed: string[] = [];
  const waiting = await ctx.sql`
    select id, automation_id, contact_id, context, current_step from automation_runs
    where team_id = ${teamId} and status = 'running' and waiting_for = ${b.event}
      and (${contact ? ctx.sql`contact_id = ${contact.id as string}` : ctx.sql`false`} or lower(context->>'email') = ${email.toLowerCase()})`;
  for (const run of waiting) {
    const [auto] = await ctx.sql`select steps from automations where id = ${run.automation_id as string}`;
    const step = ((auto?.steps as Step[]) ?? []).find((s) => s.key === run.current_step);
    const filter = step?.config.filter_rule;
    const c = run.contact_id ? (await ctx.sql`select * from contacts where id = ${run.contact_id as string}`)[0] : contact;
    const rctx = run.context as RunContext;
    if (filter && !evalRule(filter as Record<string, unknown>, { event: payload, contact: contactView(c), wait_events: {} }, { event: rctx.event, contact: contactView(c), wait_events: rctx.wait_events })) continue;
    const ctxNext: RunContext = { ...rctx, wait_events: { ...rctx.wait_events, [b.event]: payload } };
    const upd = await ctx.sql`update automation_runs set context = ${ctx.sql.json(ctxNext as never)}, waiting_for = null, wait_until = null
                              where id = ${run.id as string} and waiting_for = ${b.event} returning id`;
    if (!upd.length) continue;
    await cancelJob(ctx.sql, `autorun:${run.id}:${run.current_step}:timeout`);
    await enqueue(ctx.sql, 'automation_step', { runId: run.id, resume: { kind: 'event', key: run.current_step } }, { runAt: ctx.now() });
    resumed.push(run.id as string);
  }

  // New runs.
  const autos = await ctx.sql`
    select id, steps from automations
    where team_id = ${teamId} and status = 'enabled'
      and exists (select 1 from jsonb_array_elements(steps) s where s->>'type' = 'trigger' and s->'config'->>'event_name' = ${b.event})`;
  const started: string[] = [];
  if (autos.length && !contact) contact = await createContact(ctx, teamId, { email: email! });
  for (const a of autos) {
    const trigger = (a.steps as Step[]).find((s) => s.type === 'trigger' && s.config.event_name === b.event)!;
    const rc: RunContext = { event_name: b.event, event: payload, email, wait_events: {} };
    const [run] = await ctx.sql`
      insert into automation_runs (automation_id, team_id, contact_id, status, context, steps, current_step, started_at, created_at)
      values (${a.id as string}, ${teamId}, ${(contact?.id as string) ?? null}, 'running', ${ctx.sql.json(rc as never)}, '[]', ${trigger.key},
              ${ctx.now().toISOString()}, ${ctx.now().toISOString()})
      returning id`;
    await enqueue(ctx.sql, 'automation_step', { runId: run!.id }, { runAt: ctx.now() });
    started.push(run!.id as string);
  }
  return { started, resumed };
}

// ------------------------------------------------------------------ rules & variables

function contactView(c: Record<string, unknown> | undefined) {
  if (!c) return {};
  return { id: c.id, email: c.email, first_name: c.first_name ?? null, last_name: c.last_name ?? null, unsubscribed: c.unsubscribed, properties: c.properties ?? {} };
}

interface Scope {
  event: Record<string, unknown>;
  contact: Record<string, unknown>;
  wait_events: Record<string, Record<string, unknown>>;
}

const dig = (o: unknown, parts: string[]): unknown => parts.reduce<unknown>((x, p) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[p] : undefined), o);

export function resolvePath(scope: Scope, path: string): unknown {
  const [ns, ...rest] = path.split('.');
  if (ns === 'event') return dig(scope.event, rest);
  if (ns === 'contact') return dig(scope.contact, rest);
  if (ns === 'wait_events') {
    // Event names may contain dots: match the longest received event name.
    const names = Object.keys(scope.wait_events).sort((a, b) => b.length - a.length);
    const joined = rest.join('.');
    for (const n of names) if (joined === n || joined.startsWith(`${n}.`)) return dig(scope.wait_events[n], joined === n ? [] : joined.slice(n.length + 1).split('.'));
    return undefined;
  }
  return undefined;
}

const resolveValue = (v: unknown, scope: Scope) => (isVarRef(v) ? resolvePath(scope, v.var) : v);

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v !== null && !Array.isArray(v) && !Object.keys(v).length);

/** `fieldScope` resolves `field`, `valueScope` resolves `{ var }` values (differs for wait_for_event filters). */
export function evalRule(rule: Record<string, unknown>, fieldScope: Scope, valueScope: Scope = fieldScope): boolean {
  if (rule.type === 'and') return (rule.rules as Record<string, unknown>[]).every((r) => evalRule(r, fieldScope, valueScope));
  if (rule.type === 'or') return (rule.rules as Record<string, unknown>[]).some((r) => evalRule(r, fieldScope, valueScope));
  const a = resolvePath(fieldScope, rule.field as string);
  const b = resolveValue(rule.value, valueScope);
  switch (rule.operator) {
    case 'eq': return a === b || (a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b));
    case 'neq': return !(a === b || (a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b)));
    case 'gt': return Number(a) > Number(b);
    case 'gte': return Number(a) >= Number(b);
    case 'lt': return Number(a) < Number(b);
    case 'lte': return Number(a) <= Number(b);
    case 'contains': return a !== undefined && a !== null && (Array.isArray(a) ? a.map(String).includes(String(b)) : String(a).includes(String(b)));
    case 'starts_with': return a !== undefined && a !== null && String(a).startsWith(String(b));
    case 'ends_with': return a !== undefined && a !== null && String(a).endsWith(String(b));
    case 'exists': return a !== undefined && a !== null;
    case 'is_empty': return isEmpty(a);
    default: return false;
  }
}

// ------------------------------------------------------------------ engine

interface RunRow {
  id: string;
  automation_id: string;
  team_id: string;
  contact_id: string | null;
  status: string;
  context: RunContext;
  steps: RunStepRecord[];
  current_step: string | null;
}

export interface StepJob {
  runId: string;
  resume?: { kind: 'delay' | 'event' | 'timeout'; key: string };
}

/** Advance a run until it waits, ends or fails. */
export async function runAutomationStep(ctx: AppContext, job: StepJob): Promise<void> {
  const [r] = await ctx.sql`select * from automation_runs where id = ${job.runId}`;
  if (!r) return;
  const run = r as unknown as RunRow;
  if (run.status !== 'running') return;
  const [auto] = await ctx.sql`select steps, connections from automations where id = ${run.automation_id}`;
  if (!auto) return;
  const steps = auto.steps as Step[];
  const conns = auto.connections as Connection[];
  const records = [...(run.steps ?? [])];
  const now = () => pgTs(ctx.now());
  const rec = (key: string, type: string): RunStepRecord => {
    let x = records.find((s) => s.key === key && (s.status === 'waiting' || s.status === 'running'));
    if (!x) {
      x = { key, type, status: 'running', output: null, error: null, started_at: now(), completed_at: null, created_at: now() };
      records.push(x);
    }
    return x;
  };
  const save = async (fields: { status?: string; waiting_for?: string | null; wait_until?: string | null; current_step?: string | null; completed?: boolean }) => {
    await ctx.sql`
      update automation_runs set steps = ${ctx.sql.json(records as never)},
        status = ${fields.status ?? 'running'},
        waiting_for = ${fields.waiting_for ?? null}, wait_until = ${fields.wait_until ?? null},
        current_step = ${fields.current_step ?? null},
        completed_at = ${fields.completed ? ctx.now().toISOString() : null}
      where id = ${run.id}`;
  };
  const next = (key: string, type: Connection['type']): string | null => {
    const c = conns.find((x) => x.from === key && x.type === type);
    if (c) return c.to;
    if (type === 'event_received') return conns.find((x) => x.from === key && x.type === 'default')?.to ?? null;
    return null;
  };

  let key: string | null = job.resume?.key ?? run.current_step;
  let resume = job.resume;
  let guard = 0;
  while (key) {
    if (++guard > MAX_STEPS * 4) {
      await save({ status: 'failed', completed: true });
      return;
    }
    const step = steps.find((s) => s.key === key);
    if (!step) break;
    const x = rec(step.key, step.type);
    const scope = async (): Promise<Scope> => {
      const c = run.contact_id ? (await ctx.sql`select * from contacts where id = ${run.contact_id}`)[0] : undefined;
      return { event: run.context.event ?? {}, contact: contactView(c), wait_events: run.context.wait_events ?? {} };
    };
    let outcome: Connection['type'] = 'default';
    try {
      switch (step.type) {
        case 'trigger':
          break;
        case 'delay': {
          if (resume?.kind === 'delay' && resume.key === step.key) break;
          const secs = parseDuration(String(step.config.duration))!;
          x.status = 'waiting';
          await save({ current_step: step.key });
          await enqueue(ctx.sql, 'automation_step', { runId: run.id, resume: { kind: 'delay', key: step.key } }, { runAt: new Date(ctx.now().getTime() + secs * 1000), uniqueKey: `autorun:${run.id}:${step.key}:delay` });
          return;
        }
        case 'wait_for_event': {
          if (resume && resume.key === step.key && (resume.kind === 'event' || resume.kind === 'timeout')) {
            if (resume.kind === 'timeout') {
              const [still] = await ctx.sql`select waiting_for from automation_runs where id = ${run.id}`;
              if (!still?.waiting_for) return; // the event arrived first
              x.output = { timed_out: true };
              outcome = 'timeout';
            } else {
              const name = String(step.config.event_name);
              const [fresh] = await ctx.sql`select context from automation_runs where id = ${run.id}`;
              run.context = fresh!.context as RunContext;
              x.output = { event: name, payload: run.context.wait_events?.[name] ?? null };
              outcome = 'event_received';
            }
            break;
          }
          const timeout = step.config.timeout ? parseDuration(String(step.config.timeout)) : null;
          x.status = 'waiting';
          const until = timeout ? new Date(ctx.now().getTime() + timeout * 1000) : null;
          await save({ current_step: step.key, waiting_for: String(step.config.event_name), wait_until: until?.toISOString() ?? null });
          if (until) await enqueue(ctx.sql, 'automation_step', { runId: run.id, resume: { kind: 'timeout', key: step.key } }, { runAt: until, uniqueKey: `autorun:${run.id}:${step.key}:timeout` });
          return;
        }
        case 'condition': {
          const met = evalRule(step.config, await scope());
          x.output = { result: met };
          outcome = met ? 'condition_met' : 'condition_not_met';
          break;
        }
        case 'send_email': {
          const s = await scope();
          if (!s.contact.email) throw new Error('The run has no contact to send to');
          const tpl = step.config.template as { id: string; variables?: Record<string, unknown> };
          const variables: Vars = {};
          for (const [k, v] of Object.entries(tpl.variables ?? {})) {
            const val = resolveValue(v, s);
            if (val !== undefined && val !== null) variables[k] = typeof val === 'number' || typeof val === 'string' ? val : typeof val === 'boolean' ? String(val) : JSON.stringify(val);
          }
          const contextVars: Vars = {
            'contact.email': s.contact.email as string,
            'contact.first_name': (s.contact.first_name as string | null) ?? undefined,
            'contact.last_name': (s.contact.last_name as string | null) ?? undefined,
            FIRST_NAME: (s.contact.first_name as string | null) ?? undefined,
            LAST_NAME: (s.contact.last_name as string | null) ?? undefined,
            EMAIL: s.contact.email as string,
          };
          for (const [k, v] of Object.entries((s.contact.properties as Record<string, unknown>) ?? {})) if (typeof v === 'string' || typeof v === 'number') contextVars[`contact.properties.${k}`] = v;
          const team = await loadTeam(ctx.sql, run.team_id);
          if (!team) throw new Error('Team not found');
          const auth: AuthContext = { team, apiKeyId: null, permission: 'full_access', domainId: null, source: 'api' };
          const opts = { source: 'automation' as const, automationRunId: run.id, contactId: run.contact_id, skipQuota: true, contextVars };
          const n = await normalize(ctx, auth, {
            to: s.contact.email,
            template: { id: tpl.id, variables },
            ...(step.config.from ? { from: step.config.from } : {}),
            ...(step.config.subject ? { subject: step.config.subject } : {}),
            ...(step.config.reply_to ? { reply_to: step.config.reply_to } : {}),
          }, opts);
          const [emailId] = await persist(ctx, auth, [n], opts);
          x.output = { email_id: emailId };
          break;
        }
        case 'contact_update': {
          const s = await scope();
          if (!run.contact_id) throw new Error('The run has no contact');
          const [c] = await ctx.sql`select * from contacts where id = ${run.contact_id}`;
          if (!c) throw new Error('Contact not found');
          const upd: Record<string, unknown> = {};
          for (const f of ['first_name', 'last_name', 'unsubscribed'] as const) if (f in step.config) upd[f] = resolveValue(step.config[f], s);
          if (step.config.properties) {
            upd.properties = Object.fromEntries(Object.entries(step.config.properties as Record<string, unknown>).map(([k, v]) => [k, resolveValue(v, s) ?? null]));
          }
          await updateContact(ctx, run.team_id, c, upd);
          break;
        }
        case 'contact_delete': {
          if (run.contact_id) {
            const [c] = await ctx.sql`select * from contacts where id = ${run.contact_id}`;
            if (c) await deleteContact(ctx, run.team_id, c);
          }
          break;
        }
        case 'add_to_segment': {
          if (!run.contact_id) throw new Error('The run has no contact');
          const [sg] = await ctx.sql`select id from segments where id = ${String(step.config.segment_id)} and team_id = ${run.team_id}`;
          if (!sg) throw new Error('Segment not found');
          await ctx.sql`insert into contact_segments (contact_id, segment_id) values (${run.contact_id}, ${sg.id as string}) on conflict do nothing`;
          break;
        }
      }
    } catch (e) {
      x.status = 'failed';
      x.completed_at = now();
      x.error = { message: (e as { message?: string }).message ?? String(e), ...((e as { errorName?: string }).errorName ? { name: (e as { errorName: string }).errorName } : {}) };
      await save({ status: 'failed', completed: true });
      return;
    }
    x.status = 'completed';
    x.completed_at = now();
    resume = undefined;
    key = next(step.key, outcome);
    run.current_step = key;
  }
  await save({ status: 'completed', completed: true });
}

/** POST /automations/:id/stop — disable and cancel running runs. */
export async function stopAutomation(ctx: AppContext, automationId: string): Promise<void> {
  await ctx.sql`update automations set status = 'disabled', updated_at = now() where id = ${automationId}`;
  const runs = await ctx.sql`update automation_runs set status = 'cancelled', completed_at = now(), waiting_for = null
                             where automation_id = ${automationId} and status = 'running' returning id`;
  for (const r of runs) await ctx.sql`delete from jobs where kind = 'automation_step' and payload->>'runId' = ${r.id as string} and locked_at is null`;
}
