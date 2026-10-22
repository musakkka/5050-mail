/**
 * Synthetic seed data for the mock backend. Every name, address and message here
 * is invented (example.com / example.org / example.net style), deterministic
 * (seeded PRNG) and relative to "now" so screenshots stay stable.
 */
import type {
  ApiKey,
  ApiLog,
  Automation,
  Broadcast,
  Contact,
  ContactProperty,
  Domain,
  DomainRecord,
  Email,
  EmailEvent,
  EmailStatus,
  EventDefinition,
  Inbox,
  Member,
  OAuthGrant,
  ReceivedEmail,
  Segment,
  Suppression,
  Team,
  Template,
  Topic,
  Webhook,
  WebhookAttempt,
  WebhookDelivery,
} from '../types';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uuid(r: () => number): string {
  const h = () => Math.floor(r() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, h).join('');
  return `${s(8)}-${s(4)}-7${s(3)}-${'89ab'[Math.floor(r() * 4)]}${s(3)}-${s(12)}`;
}

export function token(r: () => number, n = 32): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => a[Math.floor(r() * a.length)]).join('');
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface MockDb {
  me: { email: string; name: string; isAdmin: boolean };
  teams: Team[];
  members: Record<string, Member[]>;
  emails: (Email & { api_key_id: string | null; events: EmailEvent[]; raw: string })[];
  received: ReceivedEmail[];
  suppressions: Suppression[];
  domains: Domain[];
  apiKeys: (ApiKey & { token: string })[];
  webhooks: Webhook[];
  deliveries: Record<string, (WebhookDelivery & { attempts_list: WebhookAttempt[] })[]>;
  logs: ApiLog[];
  contacts: Contact[];
  segments: Segment[];
  topics: Topic[];
  properties: ContactProperty[];
  broadcasts: Broadcast[];
  templates: Template[];
  automations: Automation[];
  events: EventDefinition[];
  inboxes: Inbox[];
  grants: OAuthGrant[];
  stats: { day: string; domain_id: string | null; sent: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number }[];
}

const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Edsger', 'Frances', 'Tim', 'Hedy', 'John', 'Annie', 'Niklaus', 'Sophie', 'Donald', 'Mary'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Dijkstra', 'Allen', 'Berners', 'Lamarr', 'McCarthy', 'Easley', 'Wirth', 'Wilson', 'Knuth', 'Jackson'];
const MAILDOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example.com', 'inbox.example.org'];

const SUBJECTS = [
  'Welcome to Northwind, {first}!',
  'Your order #{n} has shipped',
  'Reset your password',
  'Your invoice for October is ready',
  'Confirm your email address',
  'Your weekly summary: {n} new events',
  'Action required: verify your sign-in from a new device',
  'Receipt from Northwind Labs — #{n}',
  'Your trial ends in 3 days',
  'New comment on “Quarterly planning”',
  'Security alert: new API key created',
  'You have been invited to join the Northwind workspace',
];

export const STATUS_WEIGHTS: [EmailStatus, number][] = [
  ['delivered', 62],
  ['opened', 10],
  ['clicked', 6],
  ['sent', 5],
  ['bounced', 4],
  ['delivery_delayed', 2],
  ['complained', 1],
  ['failed', 2],
  ['scheduled', 3],
  ['queued', 1],
  ['canceled', 2],
  ['suppressed', 2],
];

function pick<T>(r: () => number, a: readonly T[]): T {
  return a[Math.floor(r() * a.length)]!;
}

function weighted<T>(r: () => number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    if ((x -= w) < 0) return v;
  }
  return items[0]![0];
}

function emailHtml(subject: string, first: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${subject}</title></head><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #eaeaea">
<tr><td style="padding:32px 40px 8px"><div style="font-weight:700;font-size:18px;letter-spacing:-.01em">Northwind</div></td></tr>
<tr><td style="padding:8px 40px 0"><h1 style="font-size:22px;line-height:30px;margin:16px 0">${subject}</h1>
<p style="font-size:15px;line-height:24px;margin:0 0 16px">Hi ${first},</p>
<p style="font-size:15px;line-height:24px;margin:0 0 16px">Thanks for being part of Northwind. This is a sample message generated for the 5050 Send dashboard preview, so nothing here is real.</p>
<p style="margin:24px 0"><a href="https://example.com/app" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">Open dashboard</a></p>
<p style="font-size:13px;line-height:20px;color:#666;margin:0 0 32px">If you didn't expect this email you can ignore it.</p></td></tr>
<tr><td style="padding:16px 40px 32px;border-top:1px solid #eee;font-size:12px;color:#888">Northwind Labs · 1 Example Street · Sample City<br><a href="https://example.com/unsubscribe" style="color:#888">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

function emailText(subject: string, first: string): string {
  return `${subject}\n\nHi ${first},\n\nThanks for being part of Northwind. This is a sample message generated for the 5050 Send dashboard preview, so nothing here is real.\n\nOpen dashboard: https://example.com/app\n\nIf you didn't expect this email you can ignore it.\n\nNorthwind Labs · 1 Example Street · Sample City\nUnsubscribe: https://example.com/unsubscribe`;
}

function rawMime(e: { id: string; from: string; to: string[]; subject: string; created_at: string; text: string; html: string }): string {
  const b = `b-${e.id.slice(0, 8)}`;
  return [
    `Received: from mta-1.example.com (mta-1.example.com [203.0.113.10])`,
    `\tby mx.example.com with ESMTPS id ${e.id.slice(0, 12)}`,
    `\tfor <${e.to[0]}>; ${new Date(e.created_at).toUTCString()}`,
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/simple; d=northwind.dev; s=send;`,
    `\th=from:to:subject:date:message-id:mime-version; bh=Zm9vYmFyYmF6cXV4cXV1eHF1dXg=;`,
    `\tb=c2FtcGxlLXNpZ25hdHVyZS1mb3ItdGhlLWRhc2hib2FyZC1wcmV2aWV3LW5vdC1yZWFs`,
    `From: ${e.from}`,
    `To: ${e.to.join(', ')}`,
    `Subject: ${e.subject}`,
    `Date: ${new Date(e.created_at).toUTCString()}`,
    `Message-ID: <${e.id}@send.example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    ``,
    `--${b}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    e.text,
    ``,
    `--${b}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    e.html,
    ``,
    `--${b}--`,
    ``,
  ].join('\r\n');
}

function eventsFor(status: EmailStatus, created: number, r: () => number, to: string): EmailEvent[] {
  const ev = (type: EmailEvent['type'], dt: number, data: Record<string, unknown> | null = null): EmailEvent => ({
    type,
    recipient: to,
    data,
    created_at: new Date(created + dt).toISOString(),
  });
  if (status === 'scheduled') return [ev('scheduled', 0)];
  if (status === 'queued') return [ev('queued', 0)];
  if (status === 'canceled') return [ev('scheduled', 0), ev('canceled', 60_000)];
  if (status === 'suppressed') return [ev('queued', 0), ev('suppressed', 400, { reason: 'Recipient is on the suppression list' })];
  if (status === 'failed') return [ev('queued', 0), ev('failed', 1200, { reason: 'Sending domain is not verified' })];
  const out = [ev('sent', 0)];
  if (status === 'sent') return out;
  if (status === 'bounced') return [...out, ev('bounced', 3000, { type: 'Permanent', subType: 'General', message: '550 5.1.1 The email account that you tried to reach does not exist.' })];
  if (status === 'delivery_delayed') return [...out, ev('delivery_delayed', 60_000, { message: '421 4.7.0 Try again later' })];
  out.push(ev('delivered', 1500 + Math.floor(r() * 3000)));
  if (status === 'complained') out.push(ev('complained', 3 * HOUR));
  if (status === 'opened' || status === 'clicked') out.push(ev('opened', 20 * 60_000, { userAgent: 'Mozilla/5.0', ipAddress: '198.51.100.24' }));
  if (status === 'clicked') out.push(ev('clicked', 22 * 60_000, { link: 'https://example.com/app' }));
  return out;
}

export function createSeed(now = Date.now()): MockDb {
  const r = rng(5050);
  const teamId = '0f1e2d3c-4b5a-7968-8776-a5b4c3d2e1f0';
  const team2 = '1a2b3c4d-5e6f-7a8b-9c0d-e1f2a3b4c5d6';
  const me = { email: 'ada@northwind.dev', name: 'Ada Lovelace', isAdmin: true };
  const iso = (ms: number) => new Date(ms).toISOString();

  const domains: Domain[] = [];
  const mkRecords = (name: string, st: DomainRecord['status'], receiving = false, tracking?: string): DomainRecord[] => {
    const recs: DomainRecord[] = [
      { record: 'DKIM', name: 'cf-bounce._domainkey', type: 'TXT', ttl: 'Auto', status: st, value: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7sampleKEYnotREAL0x5050SendDashboardPreviewOnlyAbCdEfGhIjKlMnOpQrStUvWxYz0123456789IDAQAB' },
      { record: 'SPF', name: 'cf-bounce', type: 'MX', ttl: 'Auto', status: st, value: 'route1.mx.cloudflare.net', priority: 10 },
      { record: 'SPF', name: 'cf-bounce', type: 'TXT', ttl: 'Auto', status: st, value: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      { record: 'DMARC', name: '_dmarc', type: 'TXT', ttl: 'Auto', status: st === 'verified' ? 'verified' : 'not_started', value: 'v=DMARC1; p=none;' },
    ];
    if (receiving) recs.push({ record: 'Receiving', name: '@', type: 'MX', ttl: 'Auto', status: st, value: 'inbound.example.com', priority: 10 });
    if (tracking) recs.push({ record: 'Tracking', name: tracking, type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'links.example.com' });
    void name;
    return recs;
  };
  const d1 = uuid(r);
  domains.push({
    object: 'domain', id: d1, name: 'northwind.dev', status: 'verified', created_at: iso(now - 300 * DAY), region: 'us-east-1',
    records: mkRecords('northwind.dev', 'verified', true), capabilities: { sending: 'enabled', receiving: 'enabled' },
    open_tracking: true, click_tracking: false, tls: 'opportunistic', custom_return_path: 'cf-bounce', tracking_subdomain: null,
  });
  const d2 = uuid(r);
  domains.push({
    object: 'domain', id: d2, name: 'updates.northwind.dev', status: 'verified', created_at: iso(now - 120 * DAY), region: 'eu-west-1',
    records: mkRecords('updates.northwind.dev', 'verified'), capabilities: { sending: 'enabled', receiving: 'disabled' },
    open_tracking: false, click_tracking: false, tls: 'enforced', custom_return_path: 'cf-bounce', tracking_subdomain: null,
  });
  const d3 = uuid(r);
  domains.push({
    object: 'domain', id: d3, name: 'mail.contoso-example-subdomain-for-overflow-testing.com', status: 'pending', created_at: iso(now - 2 * DAY), region: 'us-east-1',
    records: mkRecords('x', 'pending', false, 'links'), capabilities: { sending: 'enabled', receiving: 'disabled' },
    open_tracking: false, click_tracking: true, tls: 'opportunistic', custom_return_path: 'cf-bounce', tracking_subdomain: 'links',
  });
  const d4 = uuid(r);
  domains.push({
    object: 'domain', id: d4, name: 'fabrikam.example', status: 'failed', created_at: iso(now - 40 * DAY), region: 'sa-east-1',
    records: mkRecords('x', 'failed'), capabilities: { sending: 'enabled', receiving: 'disabled' },
    open_tracking: false, click_tracking: false, tls: 'opportunistic', custom_return_path: 'cf-bounce', tracking_subdomain: null,
  });

  const apiKeys: MockDb['apiKeys'] = [
    { id: uuid(r), name: 'Production', created_at: iso(now - 290 * DAY), last_used_at: iso(now - 3 * HOUR - 12 * 60_000), permission: 'sending_access', domain_id: d1, token: `re_${token(r, 8)}_${token(r, 24)}`, created_by: me.email },
    { id: uuid(r), name: 'Staging', created_at: iso(now - 95 * DAY), last_used_at: iso(now - 2 * DAY), permission: 'full_access', domain_id: null, token: `re_${token(r, 8)}_${token(r, 24)}`, created_by: me.email },
    { id: uuid(r), name: 'GitHub Actions — release notifications for the platform team', created_at: iso(now - 30 * DAY), last_used_at: null, permission: 'sending_access', domain_id: d2, token: `re_${token(r, 8)}_${token(r, 24)}`, created_by: 'grace@northwind.dev' },
  ];
  for (const k of apiKeys) k.token_preview = k.token.slice(0, 11);

  const emails: MockDb['emails'] = [];
  const logs: ApiLog[] = [];
  const fromAddrs = ['Northwind <hello@northwind.dev>', 'Northwind Billing <billing@northwind.dev>', 'Northwind Updates <news@updates.northwind.dev>', 'security@northwind.dev'];
  const N = 140;
  let t = now - 3 * HOUR;
  for (let i = 0; i < N; i++) {
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    let to = `${first.toLowerCase()}.${last.toLowerCase()}@${pick(r, MAILDOMAINS)}`;
    if (i === 5) to = 'a.very.long.recipient.address.used.to.test.truncation.in.tables@subdomain.example-company.example.org';
    let subject = pick(r, SUBJECTS).replace('{first}', first).replace('{n}', String(1000 + Math.floor(r() * 9000)));
    if (i === 3) subject = 'An unusually long subject line that keeps going to make sure the table truncates it correctly instead of pushing the layout wider than the viewport';
    let status: EmailStatus = i === 0 ? 'delivered' : i === 7 ? 'bounced' : weighted(r, STATUS_WEIGHTS);
    const created = t;
    if (status === 'scheduled' && i > 20) status = 'delivered';
    const scheduledAt = status === 'scheduled' ? iso(now + (2 + Math.floor(r() * 48)) * HOUR) : null;
    const key = apiKeys[i % 7 === 0 ? 1 : 0]!;
    const from = pick(r, fromAddrs);
    const id = uuid(r);
    const html = emailHtml(subject, first);
    const text = emailText(subject, first);
    const logId = uuid(r);
    const e = {
      object: 'email' as const, id, to: [to], from, created_at: iso(created), subject, html, text, bcc: null, cc: i % 9 === 0 ? [`ops@northwind.dev`] : null,
      reply_to: i % 4 === 0 ? ['support@northwind.dev'] : null, last_event: status, scheduled_at: scheduledAt,
      tags: i % 3 === 0 ? [{ name: 'category', value: 'transactional' }] : null, api_key_id: key.id, log_id: logId,
      events: eventsFor(status, created, r, to), raw: '',
    };
    e.raw = rawMime({ id, from, to: [to], subject, created_at: e.created_at, text, html });
    emails.push(e);
    logs.push({
      id: logId, created_at: iso(created), method: 'POST', endpoint: '/emails', response_status: 200, user_agent: i % 5 === 0 ? 'resend-python:2.4.0' : 'resend-node:6.34.1',
      api_key_id: key.id, source: 'api', duration_ms: 40 + Math.floor(r() * 180), ip: '203.0.113.' + (10 + (i % 80)),
      request_body: { from, to: [to], subject, html: html.slice(0, 120) + '…' },
      request_headers: { 'content-type': 'application/json', 'user-agent': 'resend-node:6.34.1', authorization: 'Bearer re_••••••••' },
      response_body: { id }, response_headers: { 'content-type': 'application/json', 'ratelimit-limit': '10', 'ratelimit-remaining': '9' },
    });
    t -= (0.4 + r() * (i < 30 ? 6 : 14)) * HOUR;
  }
  // a few non-email logs, including errors
  const extraLogs: [string, string, number, unknown][] = [
    ['GET', '/domains', 200, { object: 'list', data: [] }],
    ['POST', '/emails', 422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' }],
    ['POST', '/emails', 403, { statusCode: 403, name: 'validation_error', message: 'The northwind.io domain is not verified. Please, add and verify your domain on https://send.example.com/domains' }],
    ['POST', '/domains/' + d3 + '/verify', 200, { object: 'domain', id: d3 }],
    ['GET', '/emails/' + emails[1]!.id, 200, { object: 'email', id: emails[1]!.id }],
    ['POST', '/emails/batch', 429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 10 requests per second.' }],
    ['DELETE', '/api-keys/' + apiKeys[1]!.id, 404, { statusCode: 404, name: 'not_found', message: 'API key not found' }],
  ];
  extraLogs.forEach(([m, ep, st, rb], i) => {
    logs.push({
      id: uuid(r), created_at: iso(now - (1 + i * 5) * HOUR - 17 * 60_000), method: m, endpoint: ep, response_status: st, user_agent: 'curl/8.7.1',
      api_key_id: apiKeys[1]!.id, source: 'api', duration_ms: 30 + i * 11, ip: '198.51.100.7', request_body: m === 'GET' || m === 'DELETE' ? null : { to: 'not-an-email' },
      request_headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.7.1', authorization: 'Bearer re_••••••••' }, response_body: rb,
      response_headers: { 'content-type': 'application/json' },
    });
  });
  logs.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const received: ReceivedEmail[] = Array.from({ length: 9 }, (_, i) => {
    const first = FIRST[(i * 3) % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    const subj = ['Re: Your order has shipped', 'Question about my invoice', 'Partnership inquiry', 'Bug report: export button', 'Re: Welcome to Northwind!', 'Out of office', 'Feedback on the new dashboard', 'Can I change my plan?', 'Unsubscribe me please'][i]!;
    return {
      object: 'email', id: uuid(r), to: [i % 3 === 0 ? 'support@northwind.dev' : 'hello@northwind.dev'], from: `${first} ${last} <${first.toLowerCase()}@${MAILDOMAINS[i % MAILDOMAINS.length]}>`,
      created_at: iso(now - (i * 9 + 2) * HOUR), subject: subj, bcc: null, cc: null, reply_to: null, message_id: `<${token(r, 16)}@example.com>`,
      text: `Hi Northwind team,\n\n${subj}. This is a synthetic inbound message for the dashboard preview.\n\nThanks,\n${first}`,
      html: `<p>Hi Northwind team,</p><p>${subj}. This is a synthetic inbound message for the dashboard preview.</p><p>Thanks,<br>${first}</p>`,
      attachments: i === 3 ? [{ id: uuid(r), filename: 'screenshot.png', content_type: 'image/png', size: 182_331 }] : [],
    };
  });

  const suppressions: Suppression[] = emails
    .filter((e) => e.last_event === 'bounced' || e.last_event === 'complained')
    .slice(0, 8)
    .map((e) => ({ object: 'suppression', id: uuid(r), email: e.to[0]!, reason: e.last_event === 'bounced' ? 'bounce' : 'complaint', source: 'automatic', email_id: e.id, created_at: e.events.at(-1)!.created_at }));
  suppressions.push({ object: 'suppression', id: uuid(r), email: 'do-not-email@example.net', reason: 'manual', source: 'dashboard', email_id: null, created_at: iso(now - 12 * DAY) });

  const webhooks: Webhook[] = [
    { object: 'webhook', id: uuid(r), endpoint: 'https://api.northwind.dev/webhooks/send', events: ['email.sent', 'email.delivered', 'email.bounced', 'email.complained'], status: 'enabled', created_at: iso(now - 200 * DAY), signing_secret: `whsec_${token(r, 32)}` },
    { object: 'webhook', id: uuid(r), endpoint: 'https://hooks.example.com/services/T000/B000/a-very-long-path-segment-to-check-truncation-in-the-webhooks-table', events: ['email.opened', 'email.clicked'], status: 'disabled', created_at: iso(now - 20 * DAY), signing_secret: `whsec_${token(r, 32)}`, disabled_reason: 'Disabled manually' },
  ];
  const deliveries: MockDb['deliveries'] = {};
  for (const w of webhooks) {
    deliveries[w.id] = emails.slice(0, 24).map((e, i) => {
      const ok = w.status === 'enabled' ? i % 11 !== 4 : i % 3 !== 0;
      const at = e.created_at;
      const attempts: WebhookAttempt[] = [
        { id: uuid(r), http_status_code: ok ? 200 : 500, response: ok ? '{"ok":true}' : '{"error":"internal"}', error: null, duration_ms: 80 + i * 3, is_replay: false, sent_at: at },
      ];
      if (!ok) attempts.unshift({ id: uuid(r), http_status_code: null, response: null, error: 'connect ETIMEDOUT 192.0.2.10:443', duration_ms: 15000, is_replay: false, sent_at: iso(Date.parse(at) + 5 * 60_000) });
      return {
        id: uuid(r), type: (w.events[i % w.events.length] ?? 'email.sent') as WebhookDelivery['type'], status: ok ? 'success' : 'failed', created_at: at, attempts: attempts.length,
        last_attempt_at: attempts[0]!.sent_at, payload: { type: w.events[i % w.events.length], created_at: at, data: { email_id: e.id, from: e.from, to: e.to, subject: e.subject, created_at: e.created_at } },
        attempts_list: attempts,
      };
    });
  }

  const segments: Segment[] = [
    { object: 'segment', id: uuid(r), name: 'General', created_at: iso(now - 280 * DAY) },
    { object: 'segment', id: uuid(r), name: 'Beta testers', created_at: iso(now - 60 * DAY) },
    { object: 'segment', id: uuid(r), name: 'Customers — annual plan', created_at: iso(now - 15 * DAY) },
  ];
  const contacts: Contact[] = Array.from({ length: 64 }, (_, i) => {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 3) % LAST.length]!;
    return {
      object: 'contact', id: uuid(r), email: `${first.toLowerCase()}.${last.toLowerCase()}${i > 19 ? i : ''}@${MAILDOMAINS[i % MAILDOMAINS.length]}`,
      first_name: i % 6 === 5 ? null : first, last_name: i % 6 === 5 ? null : last, created_at: iso(now - (i * 2 + 1) * DAY - i * HOUR), unsubscribed: i % 9 === 4,
      properties: { company: i % 2 ? 'Northwind' : 'Contoso', plan: i % 3 ? 'pro' : 'free' },
      segments: [segments[i % 3 === 0 ? 1 : 0]!].map((s) => ({ id: s.id, name: s.name })),
    };
  });
  segments[0]!.contacts_count = contacts.filter((c) => c.segments?.some((s) => s.id === segments[0]!.id)).length;
  segments[1]!.contacts_count = contacts.filter((c) => c.segments?.some((s) => s.id === segments[1]!.id)).length;
  segments[2]!.contacts_count = 0;
  const topics: Topic[] = [
    { object: 'topic', id: uuid(r), name: 'Product updates', description: 'New features and improvements, about once a month.', default_subscription: 'opt_in', visibility: 'public', created_at: iso(now - 100 * DAY) },
    { object: 'topic', id: uuid(r), name: 'Security notices', description: 'Important account and security information.', default_subscription: 'opt_out', visibility: 'private', created_at: iso(now - 50 * DAY) },
  ];
  const properties: ContactProperty[] = [
    { object: 'contact_property', id: uuid(r), key: 'company', type: 'string', fallback_value: null, created_at: iso(now - 90 * DAY) },
    { object: 'contact_property', id: uuid(r), key: 'plan', type: 'string', fallback_value: 'free', created_at: iso(now - 90 * DAY) },
    { object: 'contact_property', id: uuid(r), key: 'seats', type: 'number', fallback_value: 1, created_at: iso(now - 10 * DAY) },
  ];

  const broadcasts: Broadcast[] = [
    { object: 'broadcast', id: uuid(r), name: 'October product update', segment_id: segments[0]!.id, topic_id: topics[0]!.id, from: 'Northwind <news@updates.northwind.dev>', subject: 'What’s new in October', reply_to: null, preview_text: 'Faster exports, a new API and more', html: emailHtml('What’s new in October', '{{{FIRST_NAME|there}}}'), text: null, status: 'sent', created_at: iso(now - 8 * DAY), scheduled_at: null, sent_at: iso(now - 7 * DAY) },
    { object: 'broadcast', id: uuid(r), name: 'Beta invite — new editor', segment_id: segments[1]!.id, topic_id: null, from: 'Northwind <news@updates.northwind.dev>', subject: 'You’re invited to try the new editor', reply_to: null, preview_text: null, html: emailHtml('You’re invited to try the new editor', '{{{FIRST_NAME|there}}}'), text: null, status: 'scheduled', created_at: iso(now - 1 * DAY), scheduled_at: iso(now + 2 * DAY), sent_at: null },
    { object: 'broadcast', id: uuid(r), name: null, segment_id: null, topic_id: null, from: null, subject: null, reply_to: null, preview_text: null, html: '', text: null, status: 'draft', created_at: iso(now - 3 * HOUR), scheduled_at: null, sent_at: null },
  ];
  const templates: Template[] = [
    { object: 'template', id: uuid(r), name: 'Welcome email', alias: 'welcome', status: 'published', from: 'Northwind <hello@northwind.dev>', subject: 'Welcome to Northwind, {{{FIRST_NAME}}}!', reply_to: null, html: emailHtml('Welcome to Northwind, {{{FIRST_NAME}}}!', '{{{FIRST_NAME}}}'), text: null, variables: [{ key: 'FIRST_NAME', type: 'string', fallback_value: 'there' }], created_at: iso(now - 70 * DAY), updated_at: iso(now - 9 * DAY), published_at: iso(now - 9 * DAY) },
    { object: 'template', id: uuid(r), name: 'Password reset', alias: 'password-reset', status: 'published', from: 'security@northwind.dev', subject: 'Reset your password', reply_to: null, html: emailHtml('Reset your password', '{{{FIRST_NAME}}}'), text: null, variables: [{ key: 'FIRST_NAME', type: 'string', fallback_value: 'there' }, { key: 'RESET_URL', type: 'string', fallback_value: null }], created_at: iso(now - 65 * DAY), updated_at: iso(now - 30 * DAY), published_at: iso(now - 30 * DAY), has_unpublished_versions: true },
    { object: 'template', id: uuid(r), name: 'Invoice receipt', alias: null, status: 'draft', from: null, subject: 'Your receipt #{{{INVOICE_NUMBER}}}', reply_to: null, html: emailHtml('Your receipt #{{{INVOICE_NUMBER}}}', 'there'), text: null, variables: [{ key: 'INVOICE_NUMBER', type: 'number', fallback_value: null }], created_at: iso(now - 2 * DAY), updated_at: iso(now - 2 * DAY), published_at: null },
  ];
  const events: EventDefinition[] = [
    { object: 'event', id: uuid(r), name: 'user.signed_up', schema: { plan: 'string', referral: 'string' }, created_at: iso(now - 40 * DAY) },
    { object: 'event', id: uuid(r), name: 'checkout.completed', schema: { amount: 'number', currency: 'string' }, created_at: iso(now - 20 * DAY) },
  ];
  const automations: Automation[] = [
    {
      object: 'automation', id: uuid(r), name: 'Onboarding sequence', status: 'enabled', created_at: iso(now - 35 * DAY), updated_at: iso(now - 4 * DAY),
      steps: [
        { key: 'trigger', type: 'trigger', config: { event_name: 'user.signed_up' } },
        { key: 'welcome', type: 'send_email', config: { template: { id: templates[0]!.id }, subject: 'Welcome to Northwind' } },
        { key: 'wait', type: 'delay', config: { duration: '2 days' } },
        { key: 'tips', type: 'send_email', config: { template: { id: templates[0]!.id }, subject: 'Getting started tips' } },
      ],
      connections: [
        { from: 'trigger', to: 'welcome', type: 'default' },
        { from: 'welcome', to: 'wait', type: 'default' },
        { from: 'wait', to: 'tips', type: 'default' },
      ],
    },
    {
      object: 'automation', id: uuid(r), name: 'Post-purchase follow-up for annual-plan customers in the beta segment', status: 'disabled', created_at: iso(now - 6 * DAY), updated_at: iso(now - 6 * DAY),
      steps: [
        { key: 'trigger', type: 'trigger', config: { event_name: 'checkout.completed' } },
        { key: 'delay', type: 'delay', config: { duration: '1 day' } },
      ],
      connections: [{ from: 'trigger', to: 'delay', type: 'default' }],
    },
  ];
  const inboxes: Inbox[] = [
    { object: 'inbox', id: uuid(r), name: 'Support', email_address: 'support@northwind.dev', from_name: 'Northwind Support', domain_id: d1, receiving_address: null, unread: 4, drafts: 1, last_received: iso(now - 2 * HOUR), created_at: iso(now - 80 * DAY), updated_at: iso(now - 2 * HOUR) },
    { object: 'inbox', id: uuid(r), name: null, email_address: 'hello@northwind.dev', from_name: null, domain_id: d1, receiving_address: null, unread: 0, drafts: 0, last_received: iso(now - 3 * DAY), created_at: iso(now - 40 * DAY), updated_at: iso(now - 3 * DAY) },
  ];
  const grants: OAuthGrant[] = [
    { id: uuid(r), client_name: 'Example MCP Client', client_uri: 'https://example.com', scopes: ['emails:send', 'domains:read'], created_at: iso(now - 14 * DAY), last_used_at: iso(now - 1 * DAY) },
  ];

  // Daily stats over the last 60 days.
  const stats: MockDb['stats'] = [];
  for (let i = 59; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    for (const d of [d1, d2]) {
      const base = d === d1 ? 40 : 12;
      const wave = Math.round(base * (0.6 + 0.4 * Math.sin(i / 3)) + r() * base * 0.5);
      const sent = i % 13 === 0 ? 0 : wave;
      const bounced = Math.round(sent * (r() * 0.03));
      const complained = r() < 0.15 ? 1 : 0;
      const delivered = Math.max(0, sent - bounced);
      stats.push({ day, domain_id: d, sent, delivered, bounced, complained: Math.min(complained, delivered), opened: Math.round(delivered * 0.4), clicked: Math.round(delivered * 0.08) });
    }
  }

  return {
    me,
    teams: [
      { id: teamId, name: 'northwind', monthly_quota: 50_000, daily_quota: 5_000, rate_limit: 10, created_at: iso(now - 320 * DAY), role: 'superadmin', members: 3, settings: { unsubscribe_page: { title: 'Manage your email preferences', description: 'Choose which emails you want to receive from Northwind.', accent_color: '#363A3F', background_color: '#05050A', show_topics: true }, labs: { inboxes: true, automations: true } } },
      { id: team2, name: 'northwind-staging', monthly_quota: 3_000, daily_quota: 100, rate_limit: 2, created_at: iso(now - 60 * DAY), role: 'admin', members: 1, settings: {} },
    ],
    members: {
      [teamId]: [
        { email: 'ada@northwind.dev', role: 'admin', added_by: null, created_at: iso(now - 320 * DAY) },
        { email: 'grace@northwind.dev', role: 'admin', added_by: 'ada@northwind.dev', created_at: iso(now - 200 * DAY) },
        { email: 'linus.with.a.rather.long.address@northwind.dev', role: 'member', added_by: 'ada@northwind.dev', created_at: iso(now - 12 * DAY) },
      ],
      [team2]: [{ email: 'ada@northwind.dev', role: 'admin', added_by: null, created_at: iso(now - 60 * DAY) }],
    },
    emails,
    received,
    suppressions,
    domains,
    apiKeys,
    webhooks,
    deliveries,
    logs,
    contacts,
    segments,
    topics,
    properties,
    broadcasts,
    templates,
    automations,
    events,
    inboxes,
    grants,
    stats,
  };
}

export const MOCK_TOKEN = token;
export const MOCK_UUID = uuid;
