#!/usr/bin/env node
/**
 * 5050 Mail: outbound-relay helpers (run by install.sh inside the bootstrap container).
 *
 *   relay.mjs cf-onboard   onboard MAIL_DOMAIN for Cloudflare Email Service sending and create its DNS records
 *   relay.mjs spf          merge RELAY_SPF_INCLUDE into the root SPF record of MAIL_DOMAIN in Cloudflare DNS
 *   relay.mjs retry        ask Stalwart to retry every queued message now (exit 3 if the API refuses)
 *
 * Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE (optional), MAIL_DOMAIN, RELAY_SPF_INCLUDE,
 * STALWART_URL, STALWART_ADMIN. No dependencies; Node >= 20.
 */
const env = process.env;
const DOMAIN = (env.MAIL_DOMAIN ?? '').trim().toLowerCase();
const log = (m) => console.log(`relay: ${m}`);
const cmd = process.argv[2];

async function cf(method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const e = new Error(`Cloudflare ${method} ${path}: ${JSON.stringify(j.errors ?? r.status)}`);
    e.status = r.status;
    throw e;
  }
  return j.result;
}
async function findZone() {
  const labels = DOMAIN.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    if (env.CLOUDFLARE_ZONE && name !== env.CLOUDFLARE_ZONE) continue;
    const z = (await cf('GET', `/zones?name=${encodeURIComponent(name)}`))[0];
    if (z) return z;
  }
  return null;
}
const norm = (v) => String(v ?? '').replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim().toLowerCase().replace(/\.$/, '');

async function cfOnboard() {
  const zone = await findZone();
  if (!zone) throw new Error(`no Cloudflare zone for ${DOMAIN} in this account`);
  let sub;
  try {
    sub = await cf('POST', `/zones/${zone.id}/email/sending/subdomains`, { name: DOMAIN });
  } catch (e) {
    // Already onboarded: look it up instead.
    const list = await cf('GET', `/zones/${zone.id}/email/sending/subdomains`).catch(() => null);
    const arr = Array.isArray(list) ? list : (list?.subdomains ?? list?.items ?? []);
    sub = arr.find((s) => norm(s.name) === DOMAIN);
    if (!sub) throw e;
    log(`${DOMAIN} is already onboarded for sending`);
  }
  const tag = sub.tag ?? sub.id;
  if (!tag) throw new Error(`unexpected onboarding response: ${JSON.stringify(sub).slice(0, 200)}`);
  const dns = await cf('GET', `/zones/${zone.id}/email/sending/subdomains/${tag}/dns`);
  const recs = Array.isArray(dns) ? dns : (dns?.records ?? []);
  let created = 0;
  for (const r of recs) {
    const content = r.content ?? r.value;
    const type = r.type;
    const have = await cf('GET', `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(r.name)}`);
    if (have.some((h) => norm(h.content) === norm(content))) continue;
    // Never create a second SPF or DMARC record at the same name.
    const tag2 = /^v=(spf1|dmarc1)/i.exec(norm(content))?.[1];
    if (tag2 && have.some((h) => norm(h.content).startsWith(`v=${tag2}`))) {
      log(`a ${tag2.toUpperCase()} record already exists at ${r.name}; left unchanged`);
      continue;
    }
    if (/^_dmarc\./i.test(r.name) && have.length) {
      log(`a DMARC record already exists at ${r.name}; left unchanged`);
      continue;
    }
    await cf('POST', `/zones/${zone.id}/dns_records`, {
      type, name: r.name, content, ttl: r.ttl ?? 1, ...(r.priority !== undefined ? { priority: r.priority } : {}), comment: '5050 Mail (Cloudflare Email Service)',
    });
    created++;
  }
  log(`Cloudflare Email Service: ${DOMAIN} onboarded, created ${created} DNS record(s)`);
}

async function spf() {
  const inc = env.RELAY_SPF_INCLUDE;
  if (!inc) return;
  const zone = await findZone();
  if (!zone) throw new Error('no Cloudflare zone');
  const have = (await cf('GET', `/zones/${zone.id}/dns_records?type=TXT&name=${encodeURIComponent(DOMAIN)}`)).filter((h) => /^v=spf1/i.test(norm(h.content)));
  if (!have.length) {
    log(`no SPF record at ${DOMAIN} yet; add: "v=spf1 mx include:${inc} ~all"`);
    process.exit(4);
  }
  const rec = have[0];
  const cur = String(rec.content).replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim();
  if (cur.split(/\s+/).includes(`include:${inc}`)) return log(`SPF already includes ${inc}`);
  const parts = cur.split(/\s+/);
  const i = parts.findIndex((p) => /^[-~?+]?all$/i.test(p));
  parts.splice(i === -1 ? parts.length : i, 0, `include:${inc}`);
  await cf('PATCH', `/zones/${zone.id}/dns_records/${rec.id}`, { content: parts.join(' ') });
  log(`SPF updated: ${parts.join(' ')}`);
}

async function retry() {
  const base = (env.STALWART_URL ?? 'http://stalwart:8080').replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(env.STALWART_ADMIN ?? '').toString('base64')}`;
  const jmap = async (calls) => {
    const res = await fetch(`${base}/jmap/`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    for (const r of j.methodResponses) if (r[0] === 'error') throw new Error(JSON.stringify(r[1]));
    return j.methodResponses.map((r) => r[1]);
  };
  const [g] = await jmap([['x:QueuedMessage/get', { ids: null, properties: ['id'] }, '0']]);
  const ids = (g.list ?? []).map((m) => m.id);
  if (!ids.length) return log('queue is empty');
  const now = new Date().toISOString();
  const [s] = await jmap([['x:QueuedMessage/set', { update: Object.fromEntries(ids.map((id) => [id, { nextRetry: now }])) }, '0']]);
  const bad = Object.keys(s.notUpdated ?? {}).length;
  if (bad === ids.length) throw new Error(`queue API refused the update: ${JSON.stringify(s.notUpdated).slice(0, 200)}`);
  log(`rescheduled ${ids.length - bad} queued message(s) for immediate delivery`);
}

try {
  if (cmd === 'cf-onboard') await cfOnboard();
  else if (cmd === 'spf') await spf();
  else if (cmd === 'retry') await retry();
  else throw new Error('usage: relay.mjs cf-onboard|spf|retry');
} catch (e) {
  console.error(`relay: ${e.message}`);
  process.exit(cmd === 'retry' ? 3 : 1);
}
