#!/usr/bin/env node
/**
 * 5050 Mail: publish the mail domain's DNS records in Cloudflare without breaking what is there.
 * Run by install.sh inside the bootstrap container.
 *
 *   cfdns.mjs plan    print what would change (nothing is written)
 *   cfdns.mjs apply   make the changes
 *
 * stdin: one record per line, tab separated: TYPE NAME VALUE (what `bootstrap.mjs --print-dns --tsv` prints).
 * stdout: one action per line, tab separated: ACTION TYPE NAME CONTENT NOTE
 *   ACTION is create, merge, replace, keep, skip, conflict or error.
 * Environment: CLOUDFLARE_API_TOKEN, MAIL_DOMAIN, MAIL_HOSTNAME, PUBLIC_IPV4, CLOUDFLARE_ZONE (optional zone name),
 * CF_REPLACE_MX=1 (replace MX records that would compete with ours). CLOUDFLARE_API_BASE is for tests.
 * Rules: records are DNS only; a second SPF or DMARC record is never created; DKIM and A records
 * that already hold another value are left alone. Exit 2 means the token lacks a permission.
 */
import { readFileSync } from 'node:fs';

const env = process.env;
const APPLY = process.argv[2] === 'apply';
const DOMAIN = (env.MAIL_DOMAIN ?? '').trim().toLowerCase();
const HOST = (env.MAIL_HOSTNAME ?? '').trim().toLowerCase();
const BASE = env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const out = (act, type = '', name = '', content = '', note = '') => console.log([act, type, name, content, note].join('\t').replace(/\r|\n/g, ' '));

class CfError extends Error {}
async function cf(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const e = new CfError(`${method} ${path}: ${(j.errors ?? []).map((x) => x.message).join('; ') || r.status}`);
    e.status = r.status;
    throw e;
  }
  return j.result;
}
const norm = (v) => String(v ?? '').replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim().toLowerCase().replace(/\.$/, '');

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

const records = readFileSync(0, 'utf8')
  .split('\n')
  .map((l) => l.split('\t'))
  .filter((p) => p.length >= 3 && p[0])
  .map(([type, name, ...rest]) => ({ type, name: name.toLowerCase(), value: rest.join('\t') }))
  .filter((r) => !r.value.startsWith('<'));
// MX first: the SPF decision depends on whether the MX will be ours.
records.sort((a, b) => (b.type === 'MX') - (a.type === 'MX'));

async function main() {
  const zone = await findZone();
  if (!zone) {
    out('error', '', '', '', `no Cloudflare zone for ${DOMAIN} is visible to this token`);
    process.exit(1);
  }
  const list = (type, name) => cf('GET', `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=100`);
  const create = (body) => cf('POST', `/zones/${zone.id}/dns_records`, { ttl: 1, comment: '5050 Mail', ...body });
  let mxIsOurs = true;

  for (const r of records) {
    const { type, name } = r;
    let content = r.value;
    const have = await list(type, name);
    if (type === 'MX') {
      const [p, h] = r.value.split(/\s+/);
      const priority = Number(p);
      content = norm(h);
      if (have.some((x) => norm(x.content) === content)) { out('keep', type, name, `${priority} ${content}`, 'already points here'); continue; }
      const rivals = have.filter((x) => x.priority <= priority);
      const backups = have.filter((x) => x.priority > priority);
      if (rivals.length) {
        const list2 = rivals.map((x) => `${x.priority} ${norm(x.content)}`).join(', ');
        if (!APPLY) { out('conflict', type, name, `${priority} ${content}`, `existing MX would compete: ${list2}`); mxIsOurs = env.CF_REPLACE_MX === '1'; continue; }
        if (env.CF_REPLACE_MX !== '1') { mxIsOurs = false; out('skip', type, name, `${priority} ${content}`, `kept existing MX (${list2}); mail still goes there`); continue; }
        for (const x of rivals) await cf('DELETE', `/zones/${zone.id}/dns_records/${x.id}`);
        await create({ type, name, content, priority });
        out('replace', type, name, `${priority} ${content}`, `replaced ${list2}`);
        continue;
      }
      if (APPLY) await create({ type, name, content, priority });
      out('create', type, name, `${priority} ${content}`, backups.length ? 'existing MX kept as backup' : '');
      continue;
    }
    if (type === 'A' || type === 'AAAA') {
      if (have.some((x) => norm(x.content) === norm(content))) { out('keep', type, name, content, 'already set'); continue; }
      if (have.length) { out('skip', type, name, content, `already points to ${have[0].content}; left unchanged`); continue; }
      if (APPLY) await create({ type, name, content, proxied: false });
      out('create', type, name, content, 'DNS only');
      continue;
    }
    // TXT
    if (have.some((x) => norm(x.content) === norm(content))) { out('keep', type, name, content.slice(0, 60), 'already set'); continue; }
    if (/^v=spf1/i.test(content)) {
      const spf = have.filter((x) => /^v=spf1/i.test(norm(x.content)));
      if (!spf.length) { if (APPLY) await create({ type, name, content }); out('create', type, name, content, 'SPF'); continue; }
      if (spf.length > 1) { out('skip', type, name, content, 'more than one SPF record already exists; fix that first, then re-run'); continue; }
      const cur = String(spf[0].content).replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim();
      const toks = cur.toLowerCase().split(/\s+/);
      const ok = toks.includes(`a:${HOST}`) || (env.PUBLIC_IPV4 && toks.includes(`ip4:${env.PUBLIC_IPV4}`)) || (mxIsOurs && toks.includes('mx'));
      if (ok) { out('keep', type, name, cur, 'existing SPF already allows this server'); continue; }
      const parts = cur.split(/\s+/);
      const i = parts.findIndex((x) => /^[-~?+]?all$/i.test(x));
      parts.splice(i === -1 ? parts.length : i, 0, `a:${HOST}`);
      if (APPLY) await cf('PATCH', `/zones/${zone.id}/dns_records/${spf[0].id}`, { content: parts.join(' ') });
      out('merge', type, name, parts.join(' '), `SPF: added a:${HOST} to your existing record (was: ${cur})`);
      continue;
    }
    if (/^v=dmarc1/i.test(content) || name.startsWith('_dmarc.')) {
      const d = have.find((x) => /v=dmarc1/i.test(norm(x.content)));
      if (d) { out('keep', type, name, String(d.content).replace(/^"|"$/g, ''), 'existing DMARC policy kept'); continue; }
    }
    if (name.includes('._domainkey.') && have.some((x) => /v=dkim1/i.test(norm(x.content)))) { out('skip', type, name, content.slice(0, 40) + '...', 'a different DKIM key is already published here; left unchanged'); continue; }
    if (name.startsWith('_smtp._tls.') && have.some((x) => /v=tlsrptv1/i.test(norm(x.content)))) { out('keep', type, name, '', 'existing TLS reporting kept'); continue; }
    if (APPLY) await create({ type, name, content });
    out('create', type, name, content.length > 60 ? `${content.slice(0, 57)}...` : content, '');
  }
}

try {
  await main();
} catch (e) {
  if (e.status === 403 || e.status === 401) { out('error', '', '', '', `Zone > DNS > Edit: ${e.message}`); process.exit(2); }
  out('error', '', '', '', e.message);
  process.exit(1);
}
