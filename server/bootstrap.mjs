#!/usr/bin/env node
/**
 * 5050 Mail: reconcile Stalwart's settings from the environment.
 *
 * Idempotent: every run converges the server to the configuration below and
 * never deletes mail, accounts or extra domains added later in the admin console.
 * Talks to Stalwart's management API (JMAP `x:<Object>/get|set`) with the
 * recovery admin (STALWART_ADMIN=user:password). No dependencies; Node >= 20.
 *
 *   docker compose run --rm bootstrap          (what install.sh does)
 *   node server/bootstrap.mjs --print-dns [--cloudflare] [--json] [--tsv]   (print the DNS records; create missing ones in Cloudflare)
 *
 * Environment (see .env.example):
 *   STALWART_URL            http://stalwart:8080
 *   STALWART_ADMIN          recovery admin "user:password"
 *   MAIL_DOMAIN             primary mail domain (example.com)
 *   MAIL_HOSTNAME           server hostname (default mail.$MAIL_DOMAIN): MX target, SMTP/IMAP name
 *   ADMIN_EMAIL             first admin mailbox (default admin@$MAIL_DOMAIN)
 *   ADMIN_PASSWORD          its password (only used when the mailbox is created)
 *   ADMIN_NAME              display name (default "Administrator")
 *   ACME_EMAIL              Let's Encrypt contact (default ADMIN_EMAIL)
 *   TLS_MODE                acme (default) | manual   (manual: no ACME, self-signed until you add a certificate)
 *   ACME_DIRECTORY          default Let's Encrypt production
 *   CLOUDFLARE_API_TOKEN    optional: DNS-01 certificates + automatic DNS records via Stalwart's Cloudflare DnsServer
 *   RELAY_HOST/RELAY_PORT/RELAY_USERNAME/RELAY_PASSWORD   optional outbound smarthost (default: direct delivery on 25)
 *   STALWART_EVENTS_SECRET  shared secret for the delivery webhook to 5050 Send (empty: webhook not configured)
 *   SEND_EVENTS_URL         where Stalwart POSTs delivery events (default http://send-web:3000/internal/stalwart-events)
 *   SEND_RELAY_PORT         internal SMTP port 5050 Send submits to (default 2525, never published)
 */

const env = process.env;
const STALWART = (env.STALWART_URL ?? 'http://stalwart:8080').replace(/\/+$/, '');
const ADMIN = env.STALWART_ADMIN ?? '';
const DOMAIN = (env.MAIL_DOMAIN ?? '').trim().toLowerCase();
const HOSTNAME = (env.MAIL_HOSTNAME || `mail.${DOMAIN}`).trim().toLowerCase();
const ADMIN_EMAIL = (env.ADMIN_EMAIL || `admin@${DOMAIN}`).trim().toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD ?? '';
const ADMIN_NAME = env.ADMIN_NAME || 'Administrator';
const ACME_EMAIL = (env.ACME_EMAIL || ADMIN_EMAIL).trim().toLowerCase();
const TLS_MODE = (env.TLS_MODE || 'acme').toLowerCase();
const ACME_DIRECTORY = env.ACME_DIRECTORY || 'https://acme-v02.api.letsencrypt.org/directory';
const CF = !!env.CLOUDFLARE_API_TOKEN;
const RELAY_HOST = env.RELAY_HOST ?? '';
const RELAY_PORT = Number(env.RELAY_PORT || 587);
const SEND_PORT = Number(env.SEND_RELAY_PORT || 2525);
const EVENTS_SECRET = env.STALWART_EVENTS_SECRET ?? '';
const EVENTS_URL = env.SEND_EVENTS_URL || 'http://send-web:3000/internal/stalwart-events';
const args = new Set(process.argv.slice(2));

const die = (m) => {
  console.error(`bootstrap: ${m}`);
  process.exit(1);
};
if (!ADMIN.includes(':')) die('STALWART_ADMIN must be "user:password"');
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(DOMAIN) && !/^[a-z0-9.-]+\.(test|local|internal)$/.test(DOMAIN)) die(`MAIL_DOMAIN "${DOMAIN}" is not a valid domain`);

const auth = `Basic ${Buffer.from(ADMIN).toString('base64')}`;
const log = (m) => console.log(`bootstrap: ${m}`);

async function jmap(calls) {
  const res = await fetch(`${STALWART}/jmap/`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  for (const r of json.methodResponses) if (r[0] === 'error') throw new Error(`JMAP error in ${r[2]}: ${JSON.stringify(r[1])}`);
  return json.methodResponses.map((r) => r[1]);
}
const getAll = async (object, properties) => (await jmap([[`x:${object}/get`, { ids: null, ...(properties ? { properties } : {}) }, '0']]))[0].list;
async function set(object, args) {
  const [r] = await jmap([[`x:${object}/set`, args, '0']]);
  for (const k of ['notCreated', 'notUpdated', 'notDestroyed']) {
    if (r[k] && Object.keys(r[k]).length) throw new Error(`x:${object}/set ${k}: ${JSON.stringify(r[k])}`);
  }
  return r;
}
async function upsert(object, match, value, label) {
  const list = await getAll(object);
  const hit = list.find(match);
  if (hit) {
    await set(object, { update: { [hit.id]: value } });
    return hit.id;
  }
  const r = await set(object, { create: { n: value } });
  log(`created ${label ?? object}`);
  return r.created.n.id;
}
const updateSingleton = (object, value) => set(object, { update: { singleton: value } });

async function waitForStalwart() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${STALWART}/healthz/live`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(`Stalwart did not become healthy at ${STALWART}`);
}


/**
 * Delivery feedback for 5050 Send: Stalwart POSTs the per-recipient outcome events (delivered,
 * bounced, deferred) to Send's internal endpoint, which turns them into email.delivered / .bounced /
 * .delivery_delayed. Works the same for direct delivery and for a relay. Authenticated with a Bearer
 * secret; the URL is on the internal compose network only.
 */
async function deliveryWebhook() {
  const existing = (await getAll('WebHook')).filter((w) => /\/internal\/stalwart-events$/.test(w.url ?? ''));
  if (!EVENTS_SECRET) {
    if (existing.length) await set('WebHook', { update: Object.fromEntries(existing.map((w) => [w.id, { enable: false }])) });
    log('STALWART_EVENTS_SECRET is empty: delivery webhook to 5050 Send not configured (emails stay at "sent")');
    return;
  }
  const hook = {
    url: EVENTS_URL,
    enable: true,
    httpAuth: { '@type': 'Bearer', bearerToken: { '@type': 'Value', secret: EVENTS_SECRET } },
    eventsPolicy: 'include',
    events: Object.fromEntries(
      ['delivery.dsn-success', 'delivery.dsn-perm-fail', 'delivery.dsn-temp-fail', 'queue.rescheduled', 'queue.blob-not-found'].map((e) => [e, true]),
    ),
    // Retry for an hour if Send is down (default 5 minutes), batch up to a second of events.
    discardAfter: 3600000,
    timeout: 30000,
    throttle: 1000,
  };
  if (existing.length) {
    await set('WebHook', { update: { [existing[0].id]: hook } });
    if (existing.length > 1) await set('WebHook', { destroy: existing.slice(1).map((w) => w.id) });
  } else {
    await set('WebHook', { create: { n: hook } });
    log('created delivery webhook to 5050 Send');
  }
}

// ---------------------------------------------------------------- reconcile
async function reconcile() {
  await upsert(
    'Tracer',
    (t) => t['@type'] === 'Stdout',
    { '@type': 'Stdout', eventsPolicy: 'exclude', lossy: false, buffered: true, enable: true, events: {}, ansi: false, multiline: false, level: 'info' },
    'stdout tracer',
  );

  // Logs go to stdout (docker logs); the default file tracer points at a directory the image lacks.
  const tracers = await getAll('Tracer');
  const fileTracers = tracers.filter((t) => t['@type'] === 'Log');
  if (fileTracers.length) await set('Tracer', { destroy: fileTracers.map((t) => t.id) });

  // Real client IPs: the webmail BFF and Caddy pass X-Forwarded-For, and Stalwart's HTTP
  // port is only reachable on the internal docker network, so auto-ban applies per client
  // instead of banning (or having to exempt) the proxy. Nothing is allow-listed.
  await updateSingleton('Http', { useXForwarded: true });
  const allowed = await getAll('AllowedIp');
  const legacy = allowed.filter((a) => /^5050 Mail internal network/.test(a.reason ?? ''));
  if (legacy.length) await set('AllowedIp', { destroy: legacy.map((a) => a.id) });

  let dnsServerId = null;
  if (CF) {
    dnsServerId = await upsert(
      'DnsServer',
      (d) => d['@type'] === 'Cloudflare' && d.description === 'Cloudflare',
      {
        '@type': 'Cloudflare',
        description: 'Cloudflare',
        secret: { '@type': 'EnvironmentVariable', variableName: 'CLOUDFLARE_API_TOKEN' },
        timeout: 30000,
        ttl: 300000,
        pollingInterval: 15000,
        propagationTimeout: 600000,
        propagationDelay: 10000,
      },
      'Cloudflare DNS server',
    );
  }

  let acmeId = null;
  if (TLS_MODE === 'acme') {
    // HTTP-01: Caddy forwards http://$MAIL_HOSTNAME/.well-known/acme-challenge/* to Stalwart.
    // DNS-01 through Cloudflare when a token is configured (works even with port 80 closed).
    const providers = await getAll('AcmeProvider');
    const hit = providers.find((p) => p.directory === ACME_DIRECTORY);
    const value = { challengeType: CF ? 'Dns01' : 'Http01', contact: { [ACME_EMAIL]: true }, renewBefore: 'R23', maxRetries: 10, reuseKey: false };
    if (hit) {
      await set('AcmeProvider', { update: { [hit.id]: value } });
      acmeId = hit.id;
    } else {
      const r = await set('AcmeProvider', { create: { n: { directory: ACME_DIRECTORY, ...value } } });
      acmeId = r.created.n.id;
      log(`created ACME provider (${value.challengeType})`);
    }
  }

  const sans = { [HOSTNAME]: true };
  const domainValue = {
    name: DOMAIN,
    isEnabled: true,
    description: 'Primary domain',
    subAddressing: { '@type': 'Enabled' },
    reportAddressUri: `mailto:postmaster@${DOMAIN}`,
    certificateManagement: acmeId ? { '@type': 'Automatic', acmeProviderId: acmeId, subjectAlternativeNames: sans } : { '@type': 'Manual' },
    // Stalwart keeps DKIM (including key rotation) and the DNS-01 challenges in Cloudflare. MX, SPF and DMARC are
    // left to install.sh: Stalwart's own MX can be published before the hostname is set (it used the container id).
    dnsManagement: dnsServerId
      ? { '@type': 'Automatic', dnsServerId, origin: env.CLOUDFLARE_ZONE || DOMAIN, publishRecords: { dkim: true, mx: false, spf: false, dmarc: false, tlsRpt: false } }
      : { '@type': 'Manual' },
    dkimManagement: {
      '@type': 'Automatic',
      selectorTemplate: 'v{version}-{algorithm}-{date-%Y%m%d}',
      retireAfter: 604800000,
      deleteAfter: 2592000000,
      rotateAfter: 7776000000,
      algorithms: { Dkim1Ed25519Sha256: true, Dkim1RsaSha256: true },
    },
    allowRelaying: false,
  };
  const domains = await getAll('Domain', ['name']);
  let domainId = domains.find((d) => d.name === DOMAIN)?.id;
  if (domainId) {
    // Never clobber what an admin changed in the console; only fill in TLS/DNS automation when it was off.
    const [cur] = (await jmap([['x:Domain/get', { ids: [domainId] }, '0']]))[0].list;
    const patch = {};
    if (cur.certificateManagement?.['@type'] !== domainValue.certificateManagement['@type']) patch.certificateManagement = domainValue.certificateManagement;
    if (dnsServerId && cur.dnsManagement?.['@type'] === 'Manual') patch.dnsManagement = domainValue.dnsManagement;
    if (Object.keys(patch).length) await set('Domain', { update: { [domainId]: patch } });
  } else {
    domainId = (await set('Domain', { create: { n: domainValue } })).created.n.id;
    log(`created domain ${DOMAIN}`);
  }

  await updateSingleton('SystemSettings', {
    defaultHostname: HOSTNAME,
    defaultDomainId: domainId,
    mailExchangers: { 0: { hostname: HOSTNAME, priority: 10 } },
    services: {
      imap: { hostname: HOSTNAME, cleartext: false },
      smtp: { hostname: HOSTNAME, cleartext: false },
      jmap: { hostname: HOSTNAME, cleartext: false },
      caldav: { hostname: null, cleartext: false },
      carddav: { hostname: null, cleartext: false },
      managesieve: { hostname: null, cleartext: false },
      pop3: { hostname: null, cleartext: false },
      webdav: { hostname: null, cleartext: false },
    },
  });

  // Listeners: 25 (inbound), 465 + 587 (submission), 993 (IMAPS), 8080 (HTTP behind Caddy),
  // plus an internal plain-SMTP port for 5050 Send that is reachable only on the docker network.
  const listeners = await getAll('NetworkListener');
  const ensureListener = async (name, value) => {
    const hit = listeners.find((l) => l.name === name);
    if (hit) await set('NetworkListener', { update: { [hit.id]: value } });
    else {
      await set('NetworkListener', { create: { n: { name, ...value } } });
      log(`created listener ${name}`);
    }
  };
  await ensureListener('submission', { bind: { '[::]:587': true }, protocol: 'smtp', useTls: true, tlsImplicit: false });
  await ensureListener('send-relay', { bind: { [`[::]:${SEND_PORT}`]: true }, protocol: 'smtp', useTls: false, tlsImplicit: false });
  for (const name of ['pop3s', 'sieve', 'https']) {
    const hit = listeners.find((l) => l.name === name);
    if (hit) {
      await set('NetworkListener', { destroy: [hit.id] });
      log(`removed unused listener ${name}`);
    }
  }

  // 5050 Send submits on SEND_PORT without SMTP AUTH (the port is never published):
  // relay is allowed there and mail from local domains is DKIM-signed like submissions.
  const fromSend = `local_port == ${SEND_PORT}`;
  await updateSingleton('MtaStageRcpt', { allowRelaying: { else: '!is_empty(authenticated_as)', match: { 0: { if: fromSend, then: 'true' } } } });
  // Mail from 5050 Send was already authenticated (API key) and is signed by Send itself:
  // no spam filtering for it, so a team's own mail never lands in Junk while DNS propagates.
  await updateSingleton('MtaStageData', { enableSpamFilter: { else: 'is_empty(authenticated_as)', match: { 0: { if: fromSend, then: 'false' } } } });
  await updateSingleton('MtaStageAuth', { require: { else: 'local_port != 25', match: { 0: { if: fromSend, then: 'false' } } } });
  // Inbound on 25: enforce the sender domain's published DMARC policy (our own domains publish
  // p=reject, so unauthenticated mail claiming to be from them is refused).
  await updateSingleton('SenderAuth', {
    dmarcVerify: { else: 'disable', match: { 0: { if: 'local_port == 25', then: 'strict' } } },
    spfFromVerify: { else: 'disable', match: { 0: { if: 'local_port == 25', then: 'relaxed' } } },
    dkimSignDomain: {
      else: 'false',
      match: {
        0: { if: `is_local_domain(sender_domain) && (!is_empty(authenticated_as) || ${fromSend})`, then: 'sender_domain' },
      },
    },
  });

  // Outbound: direct MX delivery on port 25 by default, or a smarthost.
  const routes = await getAll('MtaRoute');
  const relay = routes.find((r) => r.name === 'relay');
  if (RELAY_HOST) {
    const value = {
      '@type': 'Relay',
      description: 'Outbound smarthost (RELAY_HOST)',
      address: RELAY_HOST,
      port: RELAY_PORT,
      implicitTls: RELAY_PORT === 465,
      allowInvalidCerts: false,
      protocol: 'smtp',
      authUsername: env.RELAY_USERNAME || null,
      authSecret: env.RELAY_PASSWORD ? { '@type': 'EnvironmentVariable', variableName: 'RELAY_PASSWORD' } : { '@type': 'None' },
    };
    if (relay) await set('MtaRoute', { update: { [relay.id]: value } });
    else {
      await set('MtaRoute', { create: { n: { name: 'relay', ...value } } });
      log(`created relay route to ${RELAY_HOST}:${RELAY_PORT}`);
    }
    await updateSingleton('MtaOutboundStrategy', { route: { else: "'relay'", match: { 0: { if: 'is_local_domain(rcpt_domain)', then: "'local'" } } } });
  } else {
    await updateSingleton('MtaOutboundStrategy', { route: { else: "'mx'", match: { 0: { if: 'is_local_domain(rcpt_domain)', then: "'local'" } } } });
    if (relay) {
      await set('MtaRoute', { destroy: [relay.id] });
      log('removed relay route (direct delivery)');
    }
  }

  // First admin mailbox (+ postmaster/abuse/dmarc aliases on it).
  const [local, adminDomain] = ADMIN_EMAIL.split('@');
  if (adminDomain === DOMAIN) {
    const accounts = await getAll('Account', ['name', 'domainId', '@type']);
    const exists = accounts.some((a) => (a.name === local || a.name === ADMIN_EMAIL) && (!a.domainId || a.domainId === domainId));
    if (!exists) {
      if (ADMIN_PASSWORD.length < 8) die('ADMIN_PASSWORD (>= 8 chars) is required to create the first admin mailbox');
      await set('Account', {
        create: {
          n: {
            '@type': 'User',
            name: local,
            domainId,
            description: ADMIN_NAME,
            credentials: { 0: { '@type': 'Password', secret: ADMIN_PASSWORD } },
            roles: { '@type': 'Admin' },
            aliases: Object.fromEntries(
              ['postmaster', 'abuse', 'dmarc']
                .filter((a) => a !== local)
                .map((a, i) => [String(i), { name: a, domainId, enabled: true, description: null }]),
            ),
          },
        },
      }).catch(async (e) => {
        // Older schema without inline aliases: create the user alone.
        if (!/aliases/i.test(e.message)) throw e;
        await set('Account', {
          create: { n: { '@type': 'User', name: local, domainId, description: ADMIN_NAME, credentials: { 0: { '@type': 'Password', secret: ADMIN_PASSWORD } }, roles: { '@type': 'Admin' } } },
        });
      });
      log(`created admin mailbox ${ADMIN_EMAIL}`);
    }
  } else {
    log(`ADMIN_EMAIL ${ADMIN_EMAIL} is not on ${DOMAIN}; skipping admin mailbox creation`);
  }
  await deliveryWebhook();
  await set('Action', { create: { n: { '@type': 'ReloadSettings' } } }).catch((e) => log(`reload request failed (${e.message}); restart Stalwart to apply`));
  return domainId;
}

// ---------------------------------------------------------------- DNS records
export function zoneRecords(zoneFile) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const raw of (zoneFile ?? '').split(/\r?\n/)) {
    const line = raw.replace(/;[^"]*$/, '');
    if (!line.trim() && !depth) continue;
    const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '');
    depth += (bare.match(/\(/g)?.length ?? 0) - (bare.match(/\)/g)?.length ?? 0);
    buf += ` ${line.trim()}`;
    if (depth <= 0) {
      const m = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?([A-Z]+)\s+(.*)$/.exec(buf.trim());
      if (m) {
        let rdata = m[3].trim().replace(/^\(|\)$/g, '').trim();
        if (m[2] === 'TXT') rdata = [...rdata.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('') || rdata;
        out.push({ name: m[1].replace(/\.$/, ''), type: m[2], value: rdata });
      }
      buf = '';
      depth = 0;
    }
  }
  return out;
}

/**
 * A domain created while Stalwart was still in its first-start mode (before the restart) keeps a DKIM task
 * that never runs, so no key is ever made. Switching DKIM management to Manual and back queues a fresh task.
 */
async function nudgeDkim(domainId) {
  try {
    const [d] = (await jmap([['x:Domain/get', { ids: [domainId], properties: ['dkimManagement'] }, '0']]))[0].list;
    if (d?.dkimManagement?.['@type'] !== 'Automatic') return;
    log('no DKIM key yet; asking the mail server to create one');
    await set('Domain', { update: { [domainId]: { dkimManagement: { '@type': 'Manual' } } } });
    await set('Domain', { update: { [domainId]: { dkimManagement: d.dkimManagement } } });
  } catch (e) {
    log(`could not restart DKIM key creation: ${e.message}`);
  }
}

async function dnsRecords(domainId) {
  let zone = '';
  for (let i = 0; i < 15; i++) {
    const [d] = (await jmap([['x:Domain/get', { ids: [domainId], properties: ['dnsZoneFile'] }, '0']]))[0].list;
    zone = d?.dnsZoneFile ?? '';
    if (/_domainkey/.test(zone)) break;
    if (i === 3) await nudgeDkim(domainId);
    await new Promise((r) => setTimeout(r, 2000)); // DKIM keys are generated by a background task
  }
  const keep = (r) =>
    (r.type === 'MX' && r.name === DOMAIN) ||
    (r.type === 'TXT' && (r.name.includes('._domainkey.') || r.name.startsWith('_dmarc.') || r.name.startsWith('_smtp._tls.') || /^v=spf1/i.test(r.value)));
  const recs = zoneRecords(zone).filter(keep);
  const ip4 = env.PUBLIC_IPV4 || '';
  const ip6 = env.PUBLIC_IPV6 || '';
  const hosts = [...new Set([HOSTNAME, env.SEND_HOST, env.API_HOST].filter(Boolean))];
  const a = hosts.flatMap((h) => [
    { name: h, type: 'A', value: ip4 || '<server IPv4>' },
    ...(ip6 ? [{ name: h, type: 'AAAA', value: ip6 }] : []),
  ]);
  return [...a, ...recs];
}

async function printDns(domainId) {
  const recs = await dnsRecords(domainId);
  if (args.has('--tsv')) {
    // Machine-readable for install.sh: TYPE<TAB>NAME<TAB>VALUE per line, nothing else.
    for (const r of recs) console.log(`${r.type}\t${r.name}\t${r.value}`);
    return;
  }
  const w = Math.max(...recs.map((r) => r.name.length));
  console.log('');
  console.log(`DNS records for ${DOMAIN} (add them at your DNS provider; TTL 300-3600):`);
  console.log('');
  for (const r of recs) {
    const value = r.type === 'TXT' ? `"${r.value}"` : r.value;
    console.log(`  ${r.name.padEnd(w)}  ${r.type.padEnd(4)}  ${value}`);
  }
  console.log('');
  console.log('  Cloudflare users: set these A records to "DNS only" (grey cloud), not "Proxied".');
  console.log('  The proxy breaks SMTP/IMAP on the mail host and blocks the HTTPS certificate (error 525).');
  console.log('  If one of these hostnames is already used by another site, pick others with');
  console.log('  MAIL_HOSTNAME / SEND_HOST / API_HOST in /opt/5050-mail/.env, then run install.sh --upgrade.');
  console.log('  Keep a single MX for the domain: other MX records at the same priority split your inbound mail.');
  console.log('');
  console.log(`  Reverse DNS (PTR): ask your VPS provider to set the PTR of ${env.PUBLIC_IPV4 || 'the server IP'} to ${HOSTNAME}.`);
  console.log('  Without a matching PTR many receivers (Gmail, Outlook) spam-folder or reject direct mail.');
  console.log('');
  if (args.has('--json')) console.log(`DNS_JSON ${JSON.stringify({ hostname: HOSTNAME, domain: DOMAIN, records: recs })}`);
}

/** With CLOUDFLARE_API_TOKEN: create the records that are missing (never replaces an existing one). */
async function cloudflareDns(domainId) {
  const token = env.CLOUDFLARE_API_TOKEN;
  const api = async (method, path, body) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success) throw new Error(`Cloudflare ${method} ${path}: ${JSON.stringify(j.errors ?? r.status)}`);
    return j.result;
  };
  const labels = DOMAIN.split('.');
  let zone = null;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const name = labels.slice(i).join('.');
    if (env.CLOUDFLARE_ZONE && name !== env.CLOUDFLARE_ZONE) continue;
    zone = (await api('GET', `/zones?name=${encodeURIComponent(name)}`))[0] ?? null;
  }
  if (!zone) {
    log(`Cloudflare: no zone for ${DOMAIN} in this account; add the records by hand`);
    return false;
  }
  const recs = (await dnsRecords(domainId)).filter((r) => !r.value.startsWith('<'));
  let created = 0;
  for (const r of recs) {
    const have = await api('GET', `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`);
    const norm = (v) => String(v).replace(/^"|"$/g, '').replace(/"\s*"/g, '').trim().toLowerCase().replace(/\.$/, '');
    let content = r.value;
    let priority;
    if (r.type === 'MX') {
      const [p, h] = r.value.split(/\s+/);
      priority = Number(p);
      content = h.replace(/\.$/, '');
    }
    if (have.some((h) => norm(h.content) === norm(content))) continue;
    const tag = /^v=([a-z0-9]+)/i.exec(content)?.[1];
    if ((r.type === 'A' || r.type === 'AAAA') && have.length) {
      log(`Cloudflare: ${r.name} ${r.type} already points elsewhere (${have[0].content}); left unchanged`);
      continue;
    }
    if (tag && have.some((h) => norm(h.content).startsWith(`v=${tag.toLowerCase()}`))) {
      log(`Cloudflare: a different ${tag} record exists at ${r.name}; left unchanged`);
      continue;
    }
    await api('POST', `/zones/${zone.id}/dns_records`, {
      type: r.type,
      name: r.name,
      content,
      ttl: 1,
      ...(priority !== undefined ? { priority } : {}),
      ...(r.type === 'A' || r.type === 'AAAA' ? { proxied: false } : {}),
      comment: '5050 Mail',
    });
    created++;
  }
  log(`Cloudflare: zone ${zone.name}: created ${created} record(s); existing ones kept`);
  return true;
}

const domainIdOf = async () => {
  const domains = await getAll('Domain', ['name']);
  const id = domains.find((d) => d.name === DOMAIN)?.id;
  if (!id) die(`domain ${DOMAIN} not found; run bootstrap first`);
  return id;
};

await waitForStalwart();
if (args.has('--print-dns')) {
  const id = await domainIdOf();
  if (args.has('--cloudflare') && env.CLOUDFLARE_API_TOKEN) await cloudflareDns(id).catch((e) => log(`Cloudflare DNS failed: ${e.message}`));
  await printDns(id);
} else {
  await reconcile();
  log('Stalwart is configured');
}
