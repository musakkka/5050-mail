/**
 * In-memory backend used when VITE_MOCK=1. Implements the documented internal API
 * and the Resend-compatible proxy with the same JSON shapes, plus the endpoints the
 * dashboard asked for in send/docs/dashboard-needs.md.
 *
 * Scenarios (for screenshots/e2e), via localStorage `send.mock` or `?mock=`:
 *   (unset)  seeded data      empty  → every list empty      error → data calls fail
 *   slow     → data calls never resolve (loading states)      signedout → 401
 *   newadmin → a mail admin with no team: first-team screen, then an empty team for onboarding
 */
import type { Method, MockHandler } from '../http';
import type { Contact, Domain, DomainRecord, EmailStatus, Template, WebhookEventType } from '../types';
import { createSeed, rng, uuid, token, type MockDb } from './seed';
import { MOCK_SNIPPETS } from './snippets';

type Res = { status: number; body: unknown; headers?: Record<string, string> };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const err = (status: number, message: string, name = 'validation_error'): Res => ({ status, body: { statusCode: status, name, message } });
const iso = () => new Date().toISOString();
const r = rng(Date.now() % 100000);

function scenario(): string {
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q) localStorage.setItem('send.mock', q === 'default' ? '' : q);
    return localStorage.getItem('send.mock') ?? '';
  } catch {
    return '';
  }
}

let db: MockDb | null = null;
let signedIn = true;
const emptyTeams = new Set<string>();
/** newadmin scenario: teams created in this session (the seeded ones stay hidden). */
const freshTeams = new Set<string>();

function getDb(): MockDb {
  if (!db) {
    db = createSeed();
    // The second team starts empty: shows the empty states.
    emptyTeams.add(db.teams[1]!.id);
  }
  return db;
}

const list = <T>(data: T[], has_more = false) => ({ object: 'list', has_more, data });

function paginate<T extends { id: string }>(rows: T[], q: URLSearchParams, def = 40) {
  const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? def)));
  let start = 0;
  const after = q.get('after');
  const before = q.get('before');
  if (after) start = rows.findIndex((x) => x.id === after) + 1;
  if (before) {
    const i = rows.findIndex((x) => x.id === before);
    const s = Math.max(0, i - limit);
    return list(rows.slice(s, i), s > 0);
  }
  return list(rows.slice(start, start + limit), start + limit < rows.length);
}

const days = (n: number) => n * 86400_000;

function domainStatus(recs: DomainRecord[]): Domain['status'] {
  if (recs.every((x) => x.status === 'verified')) return 'verified';
  if (recs.some((x) => x.status === 'failed')) return 'failed';
  if (recs.every((x) => x.status === 'not_started')) return 'not_started';
  return 'pending';
}

function stripEmail(e: MockDb['emails'][number]) {
  const { events: _e, raw: _r, ...rest } = e;
  void _e;
  void _r;
  return rest;
}

function listItem(e: MockDb['emails'][number]) {
  return { object: 'email', id: e.id, to: e.to, from: e.from, created_at: e.created_at, subject: e.subject, bcc: e.bcc, cc: e.cc, reply_to: e.reply_to, last_event: e.last_event, scheduled_at: e.scheduled_at, api_key_id: e.api_key_id };
}

async function route(method: Method, fullPath: string, body: any): Promise<Res> {
  const d = getDb();
  const [path, query = ''] = fullPath.split('?') as [string, string?];
  const q = new URLSearchParams(query);
  const sc = scenario();

  if (path === '/login' && method === 'POST') {
    const { email, password } = (body ?? {}) as { email?: string; password?: string };
    if (!email || !password) return { status: 400, body: { error: 'bad_request', message: 'Enter an email and password' } };
    if (password === 'wrong') return { status: 401, body: { error: 'invalid_credentials', message: 'Wrong email or password' } };
    signedIn = true;
    if (sc === 'signedout') localStorage.setItem('send.mock', '');
    return ok({ email: d.me.email, name: d.me.name, isAdmin: d.me.isAdmin });
  }
  if (path === '/logout') {
    signedIn = false;
    return ok({ ok: true });
  }
  if (!signedIn || sc === 'signedout') return { status: 401, body: { error: 'unauthenticated', message: 'Not signed in' } };
  if (path === '/me') return ok({ ...d.me, teams: sc === 'newadmin' ? d.teams.filter((t) => freshTeams.has(t.id)) : d.teams });
  if (path === '/system')
    return ok({ apiBase: 'https://api.example.com', dashboardBase: 'https://send.example.com', transport: 'cloudflare', cloudflareConfigured: true, warnings: [] });
  if (path === '/teams' && method === 'GET') return ok({ data: d.teams });
  if (path === '/teams' && method === 'POST') {
    const t = { id: uuid(r), name: String(body.name), monthly_quota: 3000, daily_quota: 100, rate_limit: 2, created_at: iso(), role: 'admin' as const, members: 1, settings: {} };
    d.teams.push(t);
    d.members[t.id] = [{ email: d.me.email, role: 'admin', added_by: null, created_at: iso() }];
    if (sc === 'newadmin') {
      // A brand-new team: nothing seeded, but what onboarding creates shows up.
      freshTeams.add(t.id);
      for (const k of ['emails', 'received', 'suppressions', 'domains', 'apiKeys', 'webhooks', 'logs', 'contacts', 'segments', 'topics', 'properties', 'broadcasts', 'templates', 'automations', 'events', 'inboxes', 'grants', 'stats'] as const) (d[k] as unknown[]) = [];
    } else emptyTeams.add(t.id);
    return ok(t, 201);
  }

  const m = path.match(/^\/teams\/([^/]+)(\/.*)?$/);
  if (!m) return { status: 404, body: { error: 'not_found' } };
  const teamId = m[1]!;
  const team = d.teams.find((t) => t.id === teamId);
  if (!team) return { status: 404, body: { error: 'not_found', message: 'Team not found' } };
  let sub = m[2] ?? '';

  if (sc === 'slow' && method === 'GET' && sub !== '') return new Promise(() => {});
  if (sc === 'error' && method === 'GET' && sub !== '') return { status: 500, body: { error: 'internal', message: 'Something went wrong (mock error scenario)' } };
  const empty = sc === 'empty' || emptyTeams.has(teamId);

  if (sub === '' && method === 'GET') return ok(team);
  if (sub === '' && method === 'PATCH') {
    if (body.name !== undefined) team.name = String(body.name);
    if (body.settings) team.settings = { ...(team.settings ?? {}), ...body.settings };
    return ok(team);
  }
  // ------------------------------------------------ members
  if (sub === '/members' && method === 'GET') return ok({ data: d.members[teamId] ?? [] });
  if (sub === '/members' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'bad_request', message: 'Enter a valid email address' } };
    const arr = (d.members[teamId] ??= []);
    const ex = arr.find((x) => x.email === email);
    if (ex) ex.role = body.role;
    else arr.push({ email, role: body.role === 'admin' ? 'admin' : 'member', added_by: d.me.email, created_at: iso() });
    return ok({ email, role: body.role }, 201);
  }
  let mm = sub.match(/^\/members\/([^/]+)$/);
  if (mm) {
    const email = decodeURIComponent(mm[1]!);
    const arr = d.members[teamId] ?? [];
    const i = arr.findIndex((x) => x.email === email);
    if (i < 0) return { status: 404, body: { error: 'not_found', message: 'Member not found' } };
    if (method === 'PATCH') {
      if (body.role === 'member' && arr.filter((x) => x.role === 'admin' && x.email !== email).length === 0)
        return { status: 409, body: { error: 'bad_request', message: 'A team needs at least one admin' } };
      arr[i]!.role = body.role;
      return ok(arr[i]);
    }
    if (method === 'DELETE') {
      arr.splice(i, 1);
      return ok({ email, deleted: true });
    }
  }
  if (sub === '/usage') {
    // Same shape as send/src/api/routes/misc.ts usageObject().
    const used = empty ? 0 : d.emails.filter((e) => Date.now() - Date.parse(e.created_at) < days(30)).length * 37;
    const today = empty ? 0 : 214;
    const next = (n: number) => new Date(Date.now() + days(n)).toISOString();
    return ok({
      object: 'usage',
      emails: {
        daily: { used: today, limit: team.daily_quota, sent: today, received: empty ? 0 : 3, resets_at: next(1) },
        monthly: { used, limit: team.monthly_quota, sent: used - (empty ? 0 : 9), received: empty ? 0 : 9, resets_at: next(9) },
      },
      contacts: { used: empty ? 0 : d.contacts.length, limit: 1000 },
      segments: { used: empty ? 0 : d.segments.length, limit: null },
      broadcasts: { used: empty ? 0 : d.broadcasts.filter((b) => b.status === 'sent').length, limit: null },
      ai_credits: { used: 0, limit: 0, next_increase_at: null },
      automation_runs: { used: empty ? 0 : 412, limit: 10000, resets_at: next(9) },
      domains: { used: empty ? 0 : d.domains.length, limit: null },
      rate_limit: { limit: team.rate_limit, duration: '1000ms' },
    });
  }
  if (sub === '/smtp' || sub === '/integrations') {
    const smtp = {
      host: 'smtp.example.com', username: 'resend', password: 'YOUR_API_KEY',
      ports: [{ port: 465, security: 'tls', description: 'Implicit TLS (SMTPS)' }, { port: 2465, security: 'tls', description: 'Implicit TLS (SMTPS)' }, { port: 587, security: 'starttls', description: 'STARTTLS' }, { port: 2587, security: 'starttls', description: 'STARTTLS' }],
      max_message_bytes: 40 * 1024 * 1024,
      notes: ['Use an API key as the password. Sending-access and full-access keys both work; domain-restricted keys can only send from their domain.', 'Emails sent over SMTP cannot be scheduled. The API rate limit also applies to SMTP.'],
    };
    return ok(sub === '/smtp' ? smtp : { smtp, snippets: MOCK_SNIPPETS });
  }
  if (sub.startsWith('/metrics')) return ok(metrics(d, q, empty));
  if (sub.startsWith('/stats/daily')) return ok({ data: empty ? [] : d.stats });
  // ------------------------------------------------ internal email list (dashboard-needs #1)
  if (sub === '/emails' && method === 'GET') {
    if (empty) return ok(list([]));
    let rows = d.emails;
    const st = q.get('status');
    if (st) rows = rows.filter((e) => e.last_event === st);
    const key = q.get('api_key_id');
    if (key) rows = rows.filter((e) => e.api_key_id === key);
    const qq = q.get('q')?.toLowerCase();
    if (qq) rows = rows.filter((e) => e.to.join(',').toLowerCase().includes(qq) || e.subject.toLowerCase().includes(qq) || e.from.toLowerCase().includes(qq) || e.id === qq);
    const start = q.get('start');
    if (start) rows = rows.filter((e) => e.created_at >= start);
    const end = q.get('end');
    if (end) rows = rows.filter((e) => e.created_at <= end);
    const p = paginate(rows, q, 40);
    return ok({ ...p, data: p.data.map(listItem) });
  }
  mm = sub.match(/^\/emails\/([^/]+)\/(events|raw)$/);
  if (mm) {
    const e = d.emails.find((x) => x.id === mm![1]);
    if (!e) return { status: 404, body: { error: 'not_found', message: 'Email not found' } };
    return ok(mm[2] === 'events' ? { data: e.events } : { raw: e.raw });
  }
  if (sub === '/api-keys' && method === 'GET') {
    if (empty) return ok(list([]));
    return ok(list(d.apiKeys.map(({ token: _t, ...k }) => k)));
  }
  if (sub.startsWith('/logs')) {
    const lm = sub.match(/^\/logs\/([^/]+)$/);
    if (lm) {
      const l = d.logs.find((x) => x.id === lm[1]);
      return l ? ok(l) : { status: 404, body: { error: 'not_found', message: 'Log not found' } };
    }
    if (empty) return ok({ has_more: false, data: [] });
    let rows = d.logs;
    const st = q.get('status');
    if (st) rows = rows.filter((l) => (st.endsWith('xx') ? Math.floor(l.response_status / 100) === Number(st[0]) : l.response_status === Number(st)));
    const me2 = q.get('method');
    if (me2) rows = rows.filter((l) => l.method === me2.toUpperCase());
    const ep = q.get('endpoint') ?? q.get('q');
    if (ep) rows = rows.filter((l) => l.endpoint.includes(ep));
    const key = q.get('api_key_id');
    if (key) rows = rows.filter((l) => l.api_key_id === key);
    const start = q.get('start');
    if (start) rows = rows.filter((l) => l.created_at >= start);
    const end = q.get('end');
    if (end) rows = rows.filter((l) => l.created_at <= end);
    const ua = q.get('user_agent');
    if (ua) rows = rows.filter((l) => (l.user_agent ?? '').toLowerCase().includes(ua.toLowerCase()));
    const src = q.get('source');
    if (src) rows = rows.filter((l) => (l.source ?? 'api') === src);
    const limit = Number(q.get('limit') ?? 40);
    const before = q.get('before');
    const i = before ? rows.findIndex((l) => l.id === before) + 1 : 0;
    const page = rows.slice(i, i + limit);
    return ok({ has_more: i + limit < rows.length, total: rows.length, data: page.map(({ request_body: _a, response_body: _b, request_headers: _c, response_headers: _d, ...x }) => x) });
  }
  mm = sub.match(/^\/webhooks\/([^/]+)\/(health|events\/([^/]+)\/attempts)$/);
  if (mm) {
    const w = d.webhooks.find((x) => x.id === mm![1]);
    if (!w) return { status: 404, body: { error: 'not_found', message: 'Webhook not found' } };
    const dl = d.deliveries[w.id] ?? [];
    if (mm[2] === 'health')
      return ok({ status: w.status, failing_since: null, disabled_reason: w.disabled_reason ?? null, last_7_days: { success: dl.filter((x) => x.status === 'success').length, failed: dl.filter((x) => x.status === 'failed').length, pending: 0 } });
    const ev = dl.find((x) => x.id === mm![3]);
    return ok({ data: ev?.attempts_list ?? [] });
  }
  mm = sub.match(/^\/domains\/([^/]+)\/cloudflare$/);
  if (mm) {
    const dom = d.domains.find((x) => x.id === mm![1]);
    if (!dom) return { status: 404, body: { error: 'not_found', message: 'Domain not found' } };
    const managed = dom.name.endsWith('northwind.dev') || (method === 'POST' && body.action === 'connect');
    if (method === 'POST') {
      dom.records = (dom.records ?? []).map((x) => ({ ...x, status: 'verified' }));
      dom.status = 'verified';
    }
    return ok({ zone_id: managed ? 'zone_' + dom.id.slice(0, 8) : null, zone: managed ? dom.name.split('.').slice(-2).join('.') : null, managed, sending_enabled: dom.status === 'verified', last_error: dom.status === 'failed' ? 'DKIM record not found at cf-bounce._domainkey' : null, last_checked_at: iso(), verified_at: dom.status === 'verified' ? dom.created_at : null });
  }
  if (sub.startsWith('/resend')) {
    sub = sub.slice('/resend'.length) || '/';
    return resend(d, method, sub, q, body ?? {}, empty, teamId);
  }
  return { status: 404, body: { error: 'not_found' } };
}

function metrics(d: MockDb, q: URLSearchParams, empty: boolean) {
  // Same shape as GET /api/internal/teams/:id/metrics (dimensions=period[,domain]).
  const n = Number(q.get('days') ?? 15);
  const doms = q.getAll('domain_id').flatMap((x) => x.split(',')).filter(Boolean);
  const byDomain = q.getAll('dimensions').join(',').includes('domain');
  const KEYS = ['sent', 'delivered', 'bounced', 'bounced_transient', 'bounced_permanent', 'bounced_undetermined', 'complained', 'opened', 'clicked', 'delivery_delayed', 'failed', 'suppressed', 'unsubscribed', 'received'] as const;
  const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<string, number>;
  const periods: string[] = [];
  for (let i = n - 1; i >= 0; i--) periods.push(new Date(Date.now() - days(i)).toISOString().slice(0, 10));
  const rows = new Map<string, Record<string, number | string | null>>();
  const totals = zero();
  for (const period of periods) if (!byDomain) rows.set(period, { period, ...zero() });
  if (!empty)
    for (const s of d.stats) {
      if (!periods.includes(s.day)) continue;
      if (doms.length && !doms.includes(s.domain_id ?? '')) continue;
      const key = byDomain ? `${s.day}|${s.domain_id}` : s.day;
      let row = rows.get(key);
      if (!row) {
        row = { period: s.day, ...zero(), ...(byDomain ? { domain_id: s.domain_id, domain_name: d.domains.find((x) => x.id === s.domain_id)?.name ?? null } : {}) };
        rows.set(key, row);
      }
      const v: Record<string, number> = { sent: s.sent, delivered: s.delivered, bounced: s.bounced, bounced_permanent: Math.ceil(s.bounced / 2), bounced_transient: Math.floor(s.bounced / 2), complained: s.complained, opened: s.opened, clicked: s.clicked, delivery_delayed: s.day.endsWith('7') ? 1 : 0 };
      for (const [k, x] of Object.entries(v)) {
        row[k] = (row[k] as number) + x;
        totals[k] = (totals[k] ?? 0) + x;
      }
    }
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    object: 'metrics', start_date: new Date(Date.now() - days(n)).toISOString(), end_date: new Date().toISOString(), granularity: 'daily',
    dimensions: byDomain ? ['period', 'domain'] : ['period'],
    totals: { ...totals, delivery_rate: pct(totals.delivered!, totals.sent!), bounce_rate: pct(totals.bounced!, totals.sent!), complaint_rate: pct(totals.complained!, totals.delivered!) },
    data: [...rows.values()].sort((x, y) => String(x.period).localeCompare(String(y.period))),
  };
}

function resend(d: MockDb, method: Method, p: string, q: URLSearchParams, b: any, empty: boolean, _teamId: string): Res {
  void _teamId;
  let m: RegExpMatchArray | null;
  // ---------------- emails
  if (p === '/emails' && method === 'GET') return ok(empty ? list([]) : { ...paginate(d.emails, q, 20), data: paginate(d.emails, q, 20).data.map(listItem) });
  if (p === '/emails' && method === 'POST') {
    const id = uuid(r);
    const to = Array.isArray(b.to) ? b.to : [b.to];
    const e = { object: 'email' as const, id, to, from: b.from, created_at: iso(), subject: b.subject, html: b.html ?? null, text: b.text ?? null, bcc: null, cc: null, reply_to: null, last_event: 'delivered' as EmailStatus, scheduled_at: null, api_key_id: null, log_id: null, events: [{ type: 'sent' as const, recipient: to[0], data: null, created_at: iso() }, { type: 'delivered' as const, recipient: to[0], data: null, created_at: iso() }], raw: '' };
    d.emails.unshift(e);
    return ok({ id });
  }
  if (p === '/emails/receiving' && method === 'GET') return ok(empty ? list([]) : paginate(d.received, q, 40));
  if ((m = p.match(/^\/emails\/receiving\/([^/]+)$/))) {
    const e = d.received.find((x) => x.id === m![1]);
    return e ? ok(e) : err(404, 'Email not found', 'not_found');
  }
  if ((m = p.match(/^\/emails\/([^/]+)$/))) {
    const e = d.emails.find((x) => x.id === m![1]);
    if (!e) return err(404, 'Email not found', 'not_found');
    if (method === 'PATCH') {
      e.scheduled_at = b.scheduled_at;
      return ok({ object: 'email', id: e.id });
    }
    return ok(stripEmail(e));
  }
  if ((m = p.match(/^\/emails\/([^/]+)\/(cancel|share)$/))) {
    const e = d.emails.find((x) => x.id === m![1]);
    if (!e) return err(404, 'Email not found', 'not_found');
    if (m[2] === 'cancel') {
      if (e.last_event !== 'scheduled') return err(422, 'Only scheduled emails can be canceled.');
      e.last_event = 'canceled';
      e.events.push({ type: 'canceled', recipient: e.to[0]!, data: null, created_at: iso() });
      return ok({ object: 'email', id: e.id });
    }
    return ok({ object: 'email', id: e.id, url: `https://send.example.com/shared?token=${token(r, 40)}` });
  }
  // ---------------- suppressions
  if (p === '/suppressions' && method === 'GET') {
    let rows = empty ? [] : d.suppressions;
    const qq = q.get('q')?.toLowerCase();
    if (qq) rows = rows.filter((s) => s.email.toLowerCase().includes(qq));
    const reason = q.get('reason');
    if (reason) rows = rows.filter((s) => s.reason === reason);
    return ok(paginate(rows, q, 40));
  }
  if (p === '/suppressions' && method === 'POST') {
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return err(422, 'Invalid `email` field.');
    if (d.suppressions.some((s) => s.email === email)) return err(409, 'This email is already suppressed.', 'conflict');
    const s = { object: 'suppression' as const, id: uuid(r), email, reason: 'manual', source: 'dashboard', email_id: null, created_at: iso() };
    d.suppressions.unshift(s);
    return ok(s, 201);
  }
  if ((m = p.match(/^\/suppressions\/([^/]+)$/))) {
    const key = decodeURIComponent(m[1]!);
    const i = d.suppressions.findIndex((s) => s.id === key || s.email === key);
    if (i < 0) return err(404, 'Suppression not found', 'not_found');
    if (method === 'DELETE') {
      d.suppressions.splice(i, 1);
      return ok({ object: 'suppression', id: key, deleted: true });
    }
    return ok(d.suppressions[i]);
  }
  // ---------------- domains
  if (p === '/domains' && method === 'GET') return ok(list(empty ? [] : d.domains.map(({ records: _r, ...x }) => x)));
  if (p === '/domains' && method === 'POST') {
    const name = String(b.name ?? '').trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(name)) return err(422, 'Invalid `name` field. Enter a domain like example.com.');
    if (d.domains.some((x) => x.name === name)) return err(403, `The ${name} domain has been registered already.`, 'validation_error');
    const recv = b.capabilities?.receiving === 'enabled';
    const records: DomainRecord[] = [
      { record: 'DKIM', name: 'cf-bounce._domainkey', type: 'TXT', ttl: 'Auto', status: 'not_started', value: `v=DKIM1; k=rsa; p=${token(r, 180)}` },
      { record: 'SPF', name: b.custom_return_path || 'cf-bounce', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'route1.mx.cloudflare.net', priority: 10 },
      { record: 'SPF', name: b.custom_return_path || 'cf-bounce', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      { record: 'DMARC', name: '_dmarc', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=DMARC1; p=none;' },
      ...(recv ? [{ record: 'Receiving', name: '@', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'inbound.example.com', priority: 10 }] : []),
    ];
    const dom: Domain = { object: 'domain', id: uuid(r), name, status: 'not_started', created_at: iso(), region: b.region ?? 'us-east-1', records, capabilities: { sending: 'enabled', receiving: recv ? 'enabled' : 'disabled' }, open_tracking: !!b.open_tracking, click_tracking: !!b.click_tracking, tls: b.tls ?? 'opportunistic', custom_return_path: b.custom_return_path || 'cf-bounce', tracking_subdomain: null };
    d.domains.unshift(dom);
    return ok(dom, 201);
  }
  if ((m = p.match(/^\/domains\/([^/]+)(\/verify)?$/))) {
    const dom = d.domains.find((x) => x.id === m![1]);
    if (!dom) return err(404, 'Domain not found', 'not_found');
    if (m[2]) {
      dom.records = (dom.records ?? []).map((x) => ({ ...x, status: x.status === 'not_started' ? 'pending' : x.status }));
      dom.status = domainStatus(dom.records);
      if (scenario() === 'newadmin')
        // The records "propagate" a moment later.
        setTimeout(() => {
          dom.records = (dom.records ?? []).map((x) => ({ ...x, status: 'verified' }));
          dom.status = 'verified';
        }, 1500);
      return ok({ object: 'domain', id: dom.id });
    }
    if (method === 'DELETE') {
      d.domains = d.domains.filter((x) => x !== dom);
      return ok({ object: 'domain', id: dom.id, deleted: true });
    }
    if (method === 'PATCH') {
      for (const k of ['open_tracking', 'click_tracking', 'tls'] as const) if (b[k] !== undefined) (dom as any)[k] = b[k];
      if (b.tracking_subdomain !== undefined) {
        dom.tracking_subdomain = b.tracking_subdomain;
        dom.records = (dom.records ?? []).filter((x) => x.record !== 'Tracking');
        if (b.tracking_subdomain) dom.records.push({ record: 'Tracking', name: b.tracking_subdomain, type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'links.example.com' });
      }
      return ok({ object: 'domain', id: dom.id });
    }
    return ok(dom);
  }
  // ---------------- api keys
  if (p === '/api-keys' && method === 'GET') return ok(list(empty ? [] : d.apiKeys.map(({ id, name, created_at, last_used_at }) => ({ id, name, created_at, last_used_at }))));
  if (p === '/api-keys' && method === 'POST') {
    if (!b.name || String(b.name).length > 50) return err(422, 'The `name` field must be between 1 and 50 characters.');
    if (b.domain_id && b.permission !== 'sending_access') return err(422, 'The `domain_id` field can only be used with `sending_access` permission.');
    const tok = `re_${token(r, 8)}_${token(r, 24)}`;
    const k = { id: uuid(r), name: String(b.name), created_at: iso(), last_used_at: null, permission: b.permission ?? 'full_access', domain_id: b.domain_id ?? null, token: tok, token_preview: tok.slice(0, 11), created_by: d.me.email };
    d.apiKeys.unshift(k);
    return ok({ id: k.id, object: 'api_key', token: tok }, 201);
  }
  if ((m = p.match(/^\/api-keys\/([^/]+)$/))) {
    const k = d.apiKeys.find((x) => x.id === m![1]);
    if (!k) return err(404, 'API key not found', 'not_found');
    if (method === 'DELETE') {
      d.apiKeys = d.apiKeys.filter((x) => x !== k);
      return ok({ object: 'api_key', id: k.id, deleted: true });
    }
    if (method === 'PATCH') {
      k.name = String(b.name);
      return ok({ object: 'api_key', id: k.id });
    }
  }
  // ---------------- webhooks
  if (p === '/webhooks' && method === 'GET') return ok(list(empty ? [] : d.webhooks.map(({ signing_secret: _s, ...w }) => w)));
  if (p === '/webhooks' && method === 'POST') {
    if (!/^https?:\/\/[^\s]+$/.test(String(b.endpoint ?? ''))) return err(422, 'Invalid `endpoint` field. It must be a valid URL.');
    if (!Array.isArray(b.events) || !b.events.length) return err(422, 'Select at least one event.');
    const w = { object: 'webhook' as const, id: uuid(r), endpoint: b.endpoint, events: b.events as WebhookEventType[], status: 'enabled' as const, created_at: iso(), signing_secret: `whsec_${token(r, 32)}` };
    d.webhooks.unshift(w);
    d.deliveries[w.id] = [];
    return ok(w, 201);
  }
  if ((m = p.match(/^\/webhooks\/([^/]+)(\/.*)?$/))) {
    const w = d.webhooks.find((x) => x.id === m![1]);
    if (!w) return err(404, 'Webhook not found', 'not_found');
    const rest = m[2] ?? '';
    if (rest === '' && method === 'GET') return ok(w);
    if (rest === '' && method === 'PATCH') {
      if (b.endpoint) w.endpoint = b.endpoint;
      if (b.events) w.events = b.events;
      if (b.status) w.status = b.status;
      return ok(w);
    }
    if (rest === '' && method === 'DELETE') {
      d.webhooks = d.webhooks.filter((x) => x !== w);
      return ok({ object: 'webhook', id: w.id, deleted: true });
    }
    if (rest === '/signing-secret/rotate') {
      w.signing_secret = `whsec_${token(r, 32)}`;
      return ok({ signing_secret: w.signing_secret });
    }
    const dl = d.deliveries[w.id] ?? [];
    if (rest === '/events') {
      const st = q.get('status');
      const rows = st ? dl.filter((x) => x.status === st) : dl;
      const pg = paginate(rows, q, 20);
      return ok({ ...pg, data: pg.data.map(({ attempts_list: _a, ...x }) => x) });
    }
    let em: RegExpMatchArray | null;
    if ((em = rest.match(/^\/events\/([^/]+)(\/replay)?$/))) {
      const ev = dl.find((x) => x.id === em![1]);
      if (!ev) return err(404, 'Event not found', 'not_found');
      if (em[2]) {
        ev.attempts_list.unshift({ id: uuid(r), http_status_code: 200, response: '{"ok":true}', error: null, duration_ms: 91, is_replay: true, sent_at: iso() });
        ev.status = 'success';
        ev.attempts = ev.attempts_list.length;
        return ok({ id: ev.id });
      }
      const { attempts_list: _a, ...x } = ev;
      return ok(x);
    }
  }
  if (p === '/oauth/grants') return ok(list(empty ? [] : d.grants));
  if ((m = p.match(/^\/oauth\/grants\/([^/]+)$/))) {
    d.grants = d.grants.filter((g) => g.id !== m![1]);
    return ok({ deleted: true });
  }
  // ---------------- contacts / segments / topics / properties
  if (p === '/contacts' && method === 'GET') {
    let rows = empty ? [] : d.contacts;
    const qq = q.get('q')?.toLowerCase();
    if (qq) rows = rows.filter((c) => c.email.includes(qq) || `${c.first_name ?? ''} ${c.last_name ?? ''}`.toLowerCase().includes(qq));
    return ok(paginate(rows, q, 40));
  }
  if (p === '/contacts' && method === 'POST') {
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(422, 'Invalid `email` field.');
    if (d.contacts.some((c) => c.email === email)) return err(409, 'Contact already exists.', 'conflict');
    const c: Contact = { object: 'contact', id: uuid(r), email, first_name: b.first_name || null, last_name: b.last_name || null, created_at: iso(), unsubscribed: !!b.unsubscribed, properties: b.properties ?? {}, segments: (b.segments ?? []).map((id: string) => ({ id, name: d.segments.find((s) => s.id === id)?.name ?? '' })) };
    d.contacts.unshift(c);
    return ok({ object: 'contact', id: c.id }, 201);
  }
  if (p === '/contacts/imports' && method === 'POST') {
    let imported = 0;
    let skipped = 0;
    for (const c of b.contacts ?? []) {
      const email = String(c.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || d.contacts.some((x) => x.email === email)) {
        skipped++;
        continue;
      }
      d.contacts.unshift({ object: 'contact', id: uuid(r), email, first_name: c.first_name || null, last_name: c.last_name || null, created_at: iso(), unsubscribed: !!c.unsubscribed, segments: b.segment_id ? [{ id: b.segment_id, name: d.segments.find((s) => s.id === b.segment_id)?.name ?? '' }] : [] });
      imported++;
    }
    return ok({ id: uuid(r), imported, skipped }, 201);
  }
  if ((m = p.match(/^\/contacts\/([^/]+)\/(segments\/([^/]+)|topics)$/))) {
    const key = decodeURIComponent(m[1]!);
    const c = d.contacts.find((x) => x.id === key || x.email === key);
    if (!c) return err(404, 'Contact not found', 'not_found');
    if (m[3]) {
      const s = d.segments.find((x) => x.id === m![3]);
      if (!s) return err(404, 'Segment not found', 'not_found');
      c.segments = (c.segments ?? []).filter((x) => x.id !== s.id);
      if (method === 'POST') c.segments.push({ id: s.id, name: s.name });
      return ok({ object: 'contact_segment', id: c.id, deleted: method === 'DELETE' || undefined });
    }
    const subs = ((c as any).topic_subs ??= {}) as Record<string, string>;
    if (method === 'PATCH') {
      for (const t of (Array.isArray(b) ? b : b.topics) ?? []) subs[t.id] = t.subscription;
      return ok({ object: 'contact_topics', id: c.id });
    }
    return ok(list(d.topics.map((t) => ({ id: t.id, name: t.name, description: t.description, subscription: subs[t.id] ?? t.default_subscription }))));
  }
  if ((m = p.match(/^\/contacts\/([^/]+)(\/segments)?$/))) {
    const key = decodeURIComponent(m[1]!);
    const c = d.contacts.find((x) => x.id === key || x.email === key);
    if (!c) return err(404, 'Contact not found', 'not_found');
    if (m[2]) return ok(list(c.segments ?? []));
    if (method === 'DELETE') {
      d.contacts = d.contacts.filter((x) => x !== c);
      return ok({ object: 'contact', id: c.id, deleted: true });
    }
    if (method === 'PATCH') {
      Object.assign(c, b);
      return ok({ object: 'contact', id: c.id });
    }
    return ok(c);
  }
  if (p === '/segments' && method === 'GET') return ok(list(empty ? [] : d.segments));
  if (p === '/segments' && method === 'POST') {
    if (!b.name) return err(422, 'Missing `name` field.');
    const s = { object: 'segment' as const, id: uuid(r), name: b.name, created_at: iso(), contacts_count: 0 };
    d.segments.push(s);
    return ok(s, 201);
  }
  if ((m = p.match(/^\/segments\/([^/]+)(\/contacts)?$/))) {
    const s = d.segments.find((x) => x.id === m![1]);
    if (!s) return err(404, 'Segment not found', 'not_found');
    if (m[2]) return ok(paginate(d.contacts.filter((c) => c.segments?.some((x) => x.id === s.id)), q, 40));
    if (method === 'DELETE') {
      d.segments = d.segments.filter((x) => x !== s);
      return ok({ deleted: true });
    }
    if (method === 'PATCH') {
      s.name = b.name ?? s.name;
      return ok(s);
    }
    return ok(s);
  }
  if (p === '/topics' && method === 'GET') return ok(list(empty ? [] : d.topics));
  if (p === '/topics' && method === 'POST') {
    if (!b.name) return err(422, 'Missing `name` field.');
    const t = { object: 'topic' as const, id: uuid(r), name: b.name, description: b.description ?? null, default_subscription: b.default_subscription ?? 'opt_in', visibility: b.visibility ?? 'public', created_at: iso() };
    d.topics.push(t);
    return ok(t, 201);
  }
  if ((m = p.match(/^\/topics\/([^/]+)$/))) {
    const t = d.topics.find((x) => x.id === m![1]);
    if (!t) return err(404, 'Topic not found', 'not_found');
    if (method === 'DELETE') {
      d.topics = d.topics.filter((x) => x !== t);
      return ok({ deleted: true });
    }
    if (method === 'PATCH') Object.assign(t, b);
    return ok(t);
  }
  if (p === '/contact-properties' && method === 'GET') return ok(list(empty ? [] : d.properties));
  if (p === '/contact-properties' && method === 'POST') {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(String(b.key ?? ''))) return err(422, 'Invalid `key` field. Use letters, numbers and underscores.');
    if (d.properties.some((x) => x.key === b.key)) return err(409, 'A property with this key already exists.', 'conflict');
    const pr = { object: 'contact_property' as const, id: uuid(r), key: b.key, type: b.type ?? 'string', fallback_value: b.fallback_value ?? null, created_at: iso() };
    d.properties.push(pr);
    return ok(pr, 201);
  }
  if ((m = p.match(/^\/contact-properties\/([^/]+)$/))) {
    const pr = d.properties.find((x) => x.id === m![1]);
    if (!pr) return err(404, 'Property not found', 'not_found');
    if (method === 'DELETE') {
      d.properties = d.properties.filter((x) => x !== pr);
      return ok({ deleted: true });
    }
    if (method === 'PATCH') Object.assign(pr, b);
    return ok(pr);
  }
  // ---------------- broadcasts
  if (p === '/broadcasts' && method === 'GET') return ok(list(empty ? [] : d.broadcasts));
  if (p === '/broadcasts' && method === 'POST') {
    for (const f of ['segment_id', 'from', 'subject']) if (!b[f]) return err(422, `Missing \`${f}\` field.`, 'missing_required_field');
    const bc = { object: 'broadcast' as const, id: uuid(r), name: b.name ?? null, segment_id: b.segment_id ?? null, topic_id: b.topic_id ?? null, from: b.from ?? null, subject: b.subject ?? null, reply_to: b.reply_to ?? null, preview_text: b.preview_text ?? null, html: b.html ?? '', text: b.text ?? null, status: 'draft' as const, created_at: iso(), scheduled_at: null, sent_at: null };
    d.broadcasts.unshift(bc);
    return ok({ id: bc.id }, 201);
  }
  if ((m = p.match(/^\/broadcasts\/([^/]+)\/(cancel|duplicate)$/)) && method === 'POST') {
    const bc = d.broadcasts.find((x) => x.id === m![1]);
    if (!bc) return err(404, 'Broadcast not found', 'not_found');
    if (m[2] === 'duplicate') {
      const c = { ...bc, id: uuid(r), name: `${bc.name ?? 'Untitled'} (copy)`.slice(0, 70), status: 'draft' as const, created_at: iso(), scheduled_at: null, sent_at: null };
      d.broadcasts.unshift(c);
      return ok({ object: 'broadcast', id: c.id }, 201);
    }
    if (bc.status !== 'scheduled' && bc.status !== 'queued') return err(422, 'Only scheduled or queued broadcasts can be canceled.');
    bc.status = bc.status === 'scheduled' ? 'draft' : 'canceled';
    bc.scheduled_at = null;
    return ok({ object: 'broadcast', id: bc.id });
  }
  if ((m = p.match(/^\/broadcasts\/([^/]+)(\/send)?$/))) {
    const bc = d.broadcasts.find((x) => x.id === m![1]);
    if (!bc) return err(404, 'Broadcast not found', 'not_found');
    if (m[2]) {
      if (bc.status !== 'draft') return err(422, 'Only draft broadcasts can be sent.');
      if (!bc.from || !bc.subject || !bc.segment_id) return err(422, 'Add a sender, subject and segment before sending.');
      if (b.scheduled_at) {
        const nl = /^in (\d+) (minute|hour|day)s?$/i.exec(String(b.scheduled_at).trim());
        const when = nl ? new Date(Date.now() + Number(nl[1]) * { minute: 60e3, hour: 3600e3, day: 86400e3 }[nl[2]!.toLowerCase() as 'minute']) : new Date(b.scheduled_at);
        if (Number.isNaN(when.getTime())) return err(422, 'Invalid `scheduled_at` field. Use ISO 8601 or natural language like "in 1 hour".');
        if (when.getTime() <= Date.now()) return err(422, 'The `scheduled_at` date must be in the future.');
        bc.status = 'scheduled';
        bc.scheduled_at = when.toISOString();
      } else {
        bc.status = 'sent';
        bc.sent_at = iso();
      }
      return ok({ id: bc.id });
    }
    if (method === 'DELETE') {
      if (bc.status !== 'draft' && bc.status !== 'scheduled') return err(422, 'Only draft or scheduled broadcasts can be deleted.');
      d.broadcasts = d.broadcasts.filter((x) => x !== bc);
      return ok({ deleted: true });
    }
    if (method === 'PATCH') {
      if (bc.status !== 'draft' && bc.status !== 'scheduled') return err(422, 'Only draft or scheduled broadcasts can be edited.');
      Object.assign(bc, b);
      return ok({ id: bc.id });
    }
    return ok(bc);
  }
  // ---------------- templates
  if (p === '/templates' && method === 'GET') return ok(list(empty ? [] : d.templates));
  if (p === '/templates' && method === 'POST') {
    if (!b.name) return err(422, 'Missing `name` field.', 'missing_required_field');
    if (b.html === undefined) return err(422, 'Missing `html` field.', 'missing_required_field');
    if (b.alias && d.templates.some((x) => x.alias === b.alias)) return err(409, 'A template with this alias already exists.', 'validation_error');
    const t: Template = { object: 'template', id: uuid(r), name: b.name ?? 'Untitled template', alias: b.alias ?? null, status: 'draft', from: b.from ?? null, subject: b.subject ?? null, reply_to: null, html: b.html ?? '', text: null, variables: b.variables ?? [], created_at: iso(), updated_at: iso(), published_at: null };
    d.templates.unshift(t);
    return ok({ id: t.id }, 201);
  }
  if ((m = p.match(/^\/templates\/([^/]+)(\/publish|\/duplicate)?$/))) {
    const t = d.templates.find((x) => x.id === m![1] || x.alias === m![1]);
    if (!t) return err(404, 'Template not found', 'not_found');
    if (m[2] === '/publish') {
      t.status = 'published';
      t.published_at = iso();
      t.has_unpublished_versions = false;
      return ok({ id: t.id });
    }
    if (m[2] === '/duplicate') {
      const c = { ...t, id: uuid(r), name: `${t.name} (Copy)`, alias: null, status: 'draft' as const, created_at: iso(), updated_at: iso(), published_at: null };
      d.templates.unshift(c);
      return ok({ id: c.id });
    }
    if (method === 'DELETE') {
      d.templates = d.templates.filter((x) => x !== t);
      return ok({ deleted: true });
    }
    if (method === 'PATCH') {
      if (b.alias && d.templates.some((x) => x !== t && x.alias === b.alias)) return err(409, 'A template with this alias already exists.', 'validation_error');
      Object.assign(t, b, { updated_at: iso() });
      if (t.status === 'published') t.has_unpublished_versions = true;
      return ok({ id: t.id });
    }
    return ok(t);
  }
  // ---------------- automations / events / inboxes
  if (p === '/automations' && method === 'GET') {
    const st = q.get('status');
    const rows = (empty ? [] : d.automations).filter((a) => !st || a.status === st);
    return ok(list(rows.map(({ steps: _s, connections: _c, ...a }) => a)));
  }
  if (p === '/automations' && method === 'POST') {
    if (!b.name) return err(422, 'Missing `name` field.', 'missing_required_field');
    if (!Array.isArray(b.steps) || !b.steps.some((s: { type: string }) => s.type === 'trigger')) return err(422, 'An automation needs a trigger step.');
    const a = { object: 'automation' as const, id: uuid(r), name: b.name, status: (b.status ?? 'disabled') as 'enabled' | 'disabled', steps: b.steps, connections: b.connections ?? [], created_at: iso(), updated_at: iso() };
    d.automations.unshift(a);
    return ok({ object: 'automation', id: a.id }, 201);
  }
  if ((m = p.match(/^\/automations\/([^/]+)(\/duplicate|\/stop)?$/))) {
    const a = d.automations.find((x) => x.id === m![1]);
    if (!a) return err(404, 'Automation not found', 'not_found');
    if (m[2] === '/duplicate') {
      const c = { ...a, id: uuid(r), name: `${a.name} (Copy)`, status: 'disabled' as const, created_at: iso(), updated_at: iso() };
      d.automations.unshift(c);
      return ok({ object: 'automation', id: c.id }, 201);
    }
    if (m[2] === '/stop') {
      a.status = 'disabled';
      return ok({ object: 'automation', id: a.id, status: 'disabled' });
    }
    if (method === 'DELETE') {
      d.automations = d.automations.filter((x) => x !== a);
      return ok({ object: 'automation', id: a.id, deleted: true });
    }
    if (method === 'PATCH') {
      if ((b.steps || b.connections) && a.status === 'enabled' && b.status !== 'disabled') return err(422, 'Disable the automation before changing its steps.');
      if (b.steps && !b.steps.some((s: { type: string }) => s.type === 'trigger')) return err(422, 'An automation needs a trigger step.');
      Object.assign(a, b, { updated_at: iso() });
      return ok({ object: 'automation', id: a.id });
    }
    return ok(a);
  }
  if (p === '/events' && method === 'GET') return ok(list(empty ? [] : d.events));
  if (p === '/events' && method === 'POST') {
    if (!/^[a-z0-9_.:-]{1,100}$/i.test(String(b.name ?? '')) || String(b.name).startsWith('resend:')) return err(422, 'Invalid `name` field. Use letters, numbers, dots, dashes and underscores.');
    if (d.events.some((e) => e.name === b.name)) return err(409, 'An event with this name already exists.', 'validation_error');
    const e = { object: 'event' as const, id: uuid(r), name: b.name, schema: b.schema ?? null, created_at: iso(), updated_at: iso() };
    d.events.unshift(e);
    return ok({ object: 'event', id: e.id }, 201);
  }
  if ((m = p.match(/^\/events\/([^/]+)$/))) {
    const e = d.events.find((x) => x.id === m![1] || x.name === decodeURIComponent(m![1]!));
    if (!e) return err(404, 'Event not found', 'not_found');
    if (method === 'DELETE') {
      d.events = d.events.filter((x) => x !== e);
      return ok({ object: 'event', id: e.id, deleted: true });
    }
    if (method === 'PATCH') {
      e.schema = b.schema ?? null;
      return ok({ object: 'event', id: e.id });
    }
    return ok(e);
  }
  if (p === '/inboxes' && method === 'GET') return ok(list(empty ? [] : d.inboxes));
  if (p === '/inboxes' && method === 'POST') {
    const address = String(b.email_address ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._%-]{1,64}@[^\s@]+\.[^\s@]+$/.test(address)) return err(422, 'Invalid `email_address` field.');
    const dom = d.domains.find((x) => address.endsWith('@' + x.name));
    if (!dom) return err(422, 'The domain of `email_address` is not one of your domains.');
    if (!b.forwarding && dom.capabilities?.receiving !== 'enabled') return err(422, `Enable receiving on ${dom.name} before creating an inbox on it.`);
    if (d.inboxes.some((x) => x.email_address === address)) return err(409, 'This address is already used by another inbox.', 'validation_error');
    const ib = { object: 'inbox' as const, id: uuid(r), name: b.name || null, email_address: address, from_name: b.from_name || null, domain_id: dom.id, receiving_address: null, unread: 0, drafts: 0, last_received: null, created_at: iso(), updated_at: iso() };
    d.inboxes.unshift(ib);
    return ok({ object: 'inbox', id: ib.id }, 201);
  }
  if ((m = p.match(/^\/inboxes\/([^/]+)$/))) {
    const key = decodeURIComponent(m[1]!).toLowerCase();
    const ib = d.inboxes.find((x) => x.id === key || x.email_address === key);
    if (!ib) return err(404, 'Inbox not found.', 'not_found');
    if (method === 'DELETE') {
      d.inboxes = d.inboxes.filter((x) => x !== ib);
      return ok({ object: 'inbox', id: ib.id, deleted: true });
    }
    if (method === 'PATCH') {
      if (b.name !== undefined) ib.name = b.name || null;
      if (b.from_name !== undefined) ib.from_name = b.from_name || null;
      ib.updated_at = iso();
      return ok({ object: 'inbox', id: ib.id });
    }
    return ok(ib);
  }
  return err(404, 'The requested endpoint does not exist.', 'not_found');
}

export const handle: MockHandler = async (method, path, body) => {
  const res = await route(method, path, body);
  // A short delay so loading states are exercised without slowing tests down.
  await new Promise((x) => setTimeout(x, 40));
  return res;
};
