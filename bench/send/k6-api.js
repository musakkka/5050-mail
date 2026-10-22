// k6 load for the 5050 Send public API.
//   SCENARIO=single  POST /emails (one recipient, small html+text)
//   SCENARIO=batch   POST /emails/batch with BATCH emails per request
//   SCENARIO=get     GET  /emails/{id} (read path)
// VUS concurrent connections for DURATION. Summary JSON goes to SUMMARY.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://bench-send:3000/v';
const KEY = __ENV.KEY;
const SCENARIO = __ENV.SCENARIO || 'single';
const BATCH = Number(__ENV.BATCH || 100);
const FROM = __ENV.FROM || 'Bench <bench@bench.example.com>';

export const options = {
  vus: Number(__ENV.VUS || 64),
  duration: __ENV.DURATION || '30s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: SCENARIO !== 'seed',
};

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': 'k6-bench/1.0' };
const email = (i) => ({
  from: FROM,
  to: [`rcpt-${__VU}-${i}@example.net`],
  subject: `Bench ${__VU}/${i}`,
  html: '<p>Hello from the 5050 Send benchmark. This is a short transactional message.</p>',
  text: 'Hello from the 5050 Send benchmark. This is a short transactional message.',
});

export function setup() {
  if (SCENARIO !== 'get') return {};
  const r = http.post(`${BASE}/emails`, JSON.stringify(email(0)), { headers, responseType: 'text' });
  return { id: r.json('id') };
}

export default function (data) {
  let r;
  if (SCENARIO === 'batch') {
    const body = [];
    for (let i = 0; i < BATCH; i++) body.push(email(`${__ITER}-${i}`));
    r = http.post(`${BASE}/emails/batch`, JSON.stringify(body), { headers });
  } else if (SCENARIO === 'get') {
    r = http.get(`${BASE}/emails/${data.id}`, { headers });
  } else {
    r = http.post(`${BASE}/emails`, JSON.stringify(email(__ITER)), { headers });
  }
  check(r, { ok: (x) => x.status === 200 || x.status === 201 });
}

export function handleSummary(d) {
  const m = d.metrics;
  const reqs = m.http_reqs.values;
  const dur = m.http_req_duration.values;
  const out = {
    scenario: SCENARIO, vus: options.vus, duration: options.duration, batch: SCENARIO === 'batch' ? BATCH : 1,
    requests: reqs.count, rps: reqs.rate,
    emails_per_sec: reqs.rate * (SCENARIO === 'batch' ? BATCH : SCENARIO === 'get' ? 0 : 1),
    failed_rate: m.http_req_failed.values.rate,
    p50_ms: dur.med, p95_ms: dur['p(95)'], p99_ms: dur['p(99)'], max_ms: dur.max, avg_ms: dur.avg,
  };
  return { stdout: JSON.stringify(out) + '\n', [__ENV.SUMMARY || '/out/summary.json']: JSON.stringify(out, null, 2) };
}
