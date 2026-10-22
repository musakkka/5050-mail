// k6 load for the 5050 Mail webmail BFF (Hono) in front of Stalwart JMAP.
//   SCENARIO=login | mailboxes | threads | search
// Each VU uses its own mailbox (u01..uNN) because Stalwart allows 4 concurrent JMAP requests per account.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const lat = new Trend('op_duration', true);
const ops = new Counter('ops');
const errs = new Counter('op_errors');

const BASE = __ENV.BASE || 'http://bench-bff:3000';
const USERS = Number(__ENV.USERS || 32);
const PASS = __ENV.PASS || 'Bench-Mailbox-Pass-2026';
const DOMAIN = __ENV.DOMAIN || 'bench.test';
const SCENARIO = __ENV.SCENARIO || 'threads';
const WORDS = (__ENV.WORDS || 'lorem,ipsum,bench,consectetur,dolor').split(',');
const LITE = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'hasAttachment', 'attachments'];
const ATT = ['partId', 'blobId', 'size', 'name', 'type', 'disposition', 'cid'];

export const options = {
  vus: Number(__ENV.VUS || 32),
  duration: __ENV.DURATION || '30s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '300s',
};

const user = (i) => `u${String(i + 1).padStart(2, '0')}@${DOMAIN}`;
const H = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };

function login(i) {
  const r = http.post(`${BASE}/api/login`, JSON.stringify({ email: user(i), password: PASS }), { headers: H, tags: { name: 'login' }, jar: new http.CookieJar() });
  if (r.status !== 200) return null;
  const c = r.cookies.kesh_sid || r.cookies[Object.keys(r.cookies)[0]];
  return c ? `${c[0].name}=${c[0].value}` : null;
}

export function setup() {
  const sessions = [];
  for (let i = 0; i < USERS; i++) {
    const cookie = login(i);
    if (!cookie) fail(`login failed for ${user(i)}`);
    const s = http.get(`${BASE}/.well-known/jmap`, { headers: { cookie } }).json();
    const accountId = s.primaryAccounts['urn:ietf:params:jmap:mail'];
    const mb = jmap(cookie, [['Mailbox/get', { accountId, properties: ['id', 'role', 'totalEmails'] }, 'm']]).json();
    const list = mb.methodResponses[0][1].list;
    const inbox = list.find((m) => m.role === 'inbox');
    sessions.push({ cookie, accountId, inbox: inbox.id, total: inbox.totalEmails });
  }
  return { sessions };
}

function jmap(cookie, calls, name) {
  return http.post(`${BASE}/jmap/`, JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }),
    { headers: { ...H, cookie }, tags: { name: name || 'jmap' } });
}

export default function (data) {
  const idx = (__VU - 1) % USERS;
  const s = data.sessions[idx];
  let r;
  if (SCENARIO === 'login') {
    r = http.post(`${BASE}/api/login`, JSON.stringify({ email: user(idx), password: PASS }), { headers: H });
  } else if (SCENARIO === 'mailboxes') {
    r = jmap(s.cookie, [['Mailbox/get', { accountId: s.accountId }, 'm']]);
  } else if (SCENARIO === 'threads') {
    // Same batch the SPA sends for an inbox page (src/mail/threads.ts fetchThreadPage).
    r = jmap(s.cookie, [
      ['Email/query', { accountId: s.accountId, filter: { inMailbox: s.inbox }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position: 0, limit: 50, calculateTotal: true }, 'q'],
      ['Email/get', { accountId: s.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: LITE, bodyProperties: ATT }, 'r'],
      ['Thread/get', { accountId: s.accountId, '#ids': { resultOf: 'r', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId: s.accountId, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: LITE, bodyProperties: ATT }, 'a'],
    ]);
  } else if (SCENARIO === 'search') {
    const filter = { text: WORDS[__ITER % WORDS.length] };
    r = jmap(s.cookie, [
      ['Email/query', { accountId: s.accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position: 0, limit: 50, calculateTotal: true }, 'q'],
      ['Email/get', { accountId: s.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: LITE, bodyProperties: ATT }, 'r'],
      ['SearchSnippet/get', { accountId: s.accountId, '#emailIds': { resultOf: 'q', name: 'Email/query', path: '/ids' }, filter }, 's'],
    ]);
  }
  const good = r.status === 200 && (SCENARIO === 'login' || !String(r.body).includes('"error"'));
  check(r, { ok: () => good });
  lat.add(r.timings.duration);
  ops.add(1);
  if (!good) { errs.add(1); if (__ENV.DEBUG && __ITER < 2) console.log(r.status + ' ' + String(r.body).slice(0, 400)); }
}

const secs = (x) => { const m = /^(\d+)(s|m)$/.exec(x); return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : NaN; };

export function handleSummary(d) {
  const m = d.metrics;
  const reqs = m.ops.values;
  const dur = m.op_duration.values;
  const out = {
    scenario: SCENARIO, vus: options.vus, duration: options.duration,
    requests: reqs.count, rps: reqs.count / secs(options.duration), errors: m.op_errors ? m.op_errors.values.count : 0,
    p50_ms: dur.med, p95_ms: dur['p(95)'], p99_ms: dur['p(99)'], max_ms: dur.max, avg_ms: dur.avg,
  };
  return { stdout: JSON.stringify(out) + '\n', [__ENV.SUMMARY || '/out/summary.json']: JSON.stringify(out, null, 2) };
}
