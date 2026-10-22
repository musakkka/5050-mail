/** Cross-team IDOR with API keys, sending_access restrictions on every route, domain-scoped keys. */
import { startServer, ok, bad, info, check, j } from '../lib/harness.js';

const s = await startServer({ DEFAULT_RATE_LIMIT: '1000' });
try {
  const A = await s.team('A');
  const B = await s.team('B');
  const domA = await s.domain(A, 'a.iso.test');
  const domA2 = await s.domain(A, 'a2.iso.test');
  const domB = await s.domain(B, 'b.iso.test');
  const kA = (await s.key(A)).token;
  const kB = (await s.key(B)).token;
  const kBid = (await s.ctx.sql`select id from api_keys where team_id = ${B} limit 1`)[0]!.id as string;
  const kSend = (await s.key(A, 'sending_access')).token;
  const kSendDom = (await s.key(A, 'sending_access', domA)).token;

  // --- build team B resources
  const B_ = async (m: string, p: string, body?: unknown) => (await s.req(m, p, { key: kB, body })).json;
  const em = await B_('POST', '/emails', { from: 'b@b.iso.test', to: 'x@example.com', subject: 's', text: 't', attachments: [{ filename: 'a.txt', content: 'aGk=' }] });
  const sch = await B_('POST', '/emails', { from: 'b@b.iso.test', to: 'x@example.com', subject: 's', text: 't', scheduled_at: 'in 1 hour' });
  await s.drain();
  const att = (await B_('GET', `/emails/${em.id}/attachments`)).data[0];
  const wh = await B_('POST', '/webhooks', { endpoint: 'https://example.com/h', events: ['email.sent'] });
  const seg = await B_('POST', '/segments', { name: 'S' });
  const top = await B_('POST', '/topics', { name: 'T', default_subscription: 'opt_in' });
  const con = await B_('POST', '/contacts', { email: 'secret-contact@example.com' });
  const prop = await B_('POST', '/contact-properties', { key: 'plan', type: 'string' });
  const tpl = await B_('POST', '/templates', { name: 't', html: '<p>x</p>' });
  const bc = await B_('POST', '/broadcasts', { segment_id: seg.id, from: 'b@b.iso.test', subject: 's', html: 'x' });
  const sup = await B_('POST', '/suppressions', { email: 'sup@example.com' });
  const ev = await B_('POST', '/events', { name: 'b.event' });
  const logs = await B_('GET', '/logs');
  const logId = logs?.data?.[0]?.id;
  info('fixtures', j({ em: em?.id, wh: wh?.id, seg: seg?.id, con: con?.id, tpl: tpl?.id, bc: bc?.id, sup: sup?.id, logId }));

  // --- team A tries to read/modify every B resource
  const probes: [string, string, unknown?][] = [
    ['GET', `/emails/${em.id}`], ['PATCH', `/emails/${sch.id}`, { scheduled_at: 'in 2 hours' }], ['POST', `/emails/${sch.id}/cancel`],
    ['POST', `/emails/${em.id}/share`], ['GET', `/emails/${em.id}/attachments`], ['GET', `/emails/${em.id}/attachments/${att?.id}`],
    ['GET', `/domains/${domB}`], ['PATCH', `/domains/${domB}`, { open_tracking: true }], ['POST', `/domains/${domB}/verify`], ['DELETE', `/domains/${domB}`],
    ['PATCH', `/api-keys/${kBid}`, { name: 'pwned' }], ['DELETE', `/api-keys/${kBid}`],
    ['GET', `/webhooks/${wh.id}`], ['PATCH', `/webhooks/${wh.id}`, { endpoint: 'https://evil.example/h' }], ['POST', `/webhooks/${wh.id}/signing-secret/rotate`],
    ['GET', `/webhooks/${wh.id}/events`], ['DELETE', `/webhooks/${wh.id}`],
    ['GET', `/segments/${seg.id}`], ['PATCH', `/segments/${seg.id}`, { name: 'x' }], ['GET', `/segments/${seg.id}/contacts`], ['GET', `/audiences/${seg.id}`],
    ['GET', `/topics/${top.id}`], ['PATCH', `/topics/${top.id}`, { name: 'x' }], ['DELETE', `/topics/${top.id}`],
    ['GET', `/contacts/${con.id}`], ['GET', `/contacts/secret-contact@example.com`], ['PATCH', `/contacts/${con.id}`, { first_name: 'x' }],
    ['GET', `/contacts/${con.id}/segments`], ['GET', `/contacts/${con.id}/topics`], ['GET', `/audiences/${seg.id}/contacts`],
    ['GET', `/contact-properties/${prop.id}`], ['PATCH', `/contact-properties/${prop.id}`, { fallback_value: 'x' }], ['DELETE', `/contact-properties/${prop.id}`],
    ['GET', `/templates/${tpl.id}`], ['PATCH', `/templates/${tpl.id}`, { name: 'x' }], ['POST', `/templates/${tpl.id}/publish`], ['POST', `/templates/${tpl.id}/duplicate`],
    ['GET', `/broadcasts/${bc.id}`], ['PATCH', `/broadcasts/${bc.id}`, { subject: 'x' }], ['POST', `/broadcasts/${bc.id}/send`], ['POST', `/broadcasts/${bc.id}/duplicate`],
    ['GET', `/broadcasts/${bc.id}/recipients?type=sent`], ['GET', `/suppressions/${sup.id}`], ['GET', `/suppressions/sup@example.com`],
    ['GET', `/events/b.event`], ['GET', `/logs/${logId}`],
  ];
  for (const [m, p, b] of probes) {
    const r = await s.req(m, p, { key: kA, body: b });
    check(`idor.${m} ${p.replace(/[0-9a-f-]{36}/g, ':id')}`, r.status === 404 || r.status === 422 || (m === 'DELETE' && r.json?.deleted === true && false), `${r.status} ${r.text.slice(0, 160)}`);
  }
  // destructive cross-team calls that answer "deleted: true" regardless: verify the B object still exists
  for (const [p, check2] of [[`/segments/${seg.id}`, `/segments/${seg.id}`], [`/contacts/${con.id}`, `/contacts/${con.id}`], [`/suppressions/${sup.id}`, `/suppressions/${sup.id}`], [`/broadcasts/${bc.id}`, `/broadcasts/${bc.id}`], [`/templates/${tpl.id}`, `/templates/${tpl.id}`], [`/events/b.event`, `/events/b.event`]] as const) {
    const d = await s.req('DELETE', p, { key: kA });
    const still = await s.req('GET', check2, { key: kB });
    check(`idor.DELETE-effect ${p.replace(/[0-9a-f-]{36}/g, ':id')}`, still.status === 200, `A DELETE -> ${d.status} ${d.text.slice(0, 80)}; B GET after -> ${still.status}`);
  }
  // A sending from B's domain, A using B's template / topic / segment
  let r = await s.req('POST', '/emails', { key: kA, body: { from: 'x@b.iso.test', to: 'y@example.com', subject: 's', text: 't' } });
  check('idor.send-from-other-team-domain', r.status === 403, `${r.status} ${r.text}`);
  await s.req('POST', `/templates/${tpl.id}/publish`, { key: kB });
  r = await s.req('POST', '/emails', { key: kA, body: { from: 'x@a.iso.test', to: 'y@example.com', subject: 's', template: { id: tpl.id } } });
  check('idor.send-other-team-template', r.status === 404, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails', { key: kA, body: { from: 'x@a.iso.test', to: 'y@example.com', subject: 's', text: 't', topic_id: top.id } });
  check('idor.send-other-team-topic', r.status === 404, `${r.status} ${r.text}`);
  r = await s.req('POST', '/broadcasts', { key: kA, body: { segment_id: seg.id, from: 'x@a.iso.test', subject: 's', html: 'x' } });
  check('idor.broadcast-other-team-segment', r.status === 404 || r.status === 422, `${r.status} ${r.text}`);
  r = await s.req('POST', '/contacts', { key: kA, body: { email: 'z@example.com', segments: [{ id: seg.id }], topics: [{ id: top.id, subscription: 'opt_in' }] } });
  check('idor.contact-into-other-team-segment', r.status >= 400, `${r.status} ${r.text}`);
  r = await s.req('POST', '/api-keys', { key: kA, body: { name: 'x', permission: 'sending_access', domain_id: domB } });
  check('idor.key-scoped-to-other-team-domain', r.status === 404, `${r.status} ${r.text}`);
  // lists don't leak
  for (const p of ['/emails', '/domains', '/api-keys', '/webhooks', '/contacts', '/segments', '/topics', '/templates', '/broadcasts', '/suppressions', '/logs', '/events', '/contact-properties', '/emails/receiving']) {
    const l = await s.req('GET', p, { key: kA });
    const txt = l.text;
    check(`idor.list ${p}`, !txt.includes(B) && !txt.includes('b.iso.test') && !txt.includes('secret-contact') && !txt.includes('sup@example.com'), `${l.status} leaks B data: ${txt.slice(0, 200)}`);
  }

  // --- sending_access: every non-send route must be 401 restricted_api_key
  const routes = s.ctx as any;
  void routes;
  const { createServerApp } = await import('../../src/server.js');
  const { api } = createServerApp(s.ctx);
  let leaked = 0;
  for (const rt of api.router.routes) {
    const path = rt.path.replace(/:[A-Za-z_]+/g, '00000000-0000-4000-8000-000000000000');
    const rr = await s.req(rt.method, path, { key: kSend, body: rt.method === 'GET' ? undefined : {} });
    if (rt.sending) { info(`sending-route ${rt.method} ${rt.path}`, `${rr.status}`); continue; }
    if (!(rr.status === 401 && rr.json?.name === 'restricted_api_key')) { leaked++; bad(`restricted ${rt.method} ${rt.path}`, `${rr.status} ${rr.text.slice(0, 120)}`); }
  }
  check('restricted.all-non-send-routes', leaked === 0, `${leaked} non-send routes reachable with sending_access`);
  // domain-scoped sending key
  r = await s.req('POST', '/emails', { key: kSendDom, body: { from: 'x@a2.iso.test', to: 'y@example.com', subject: 's', text: 't' } });
  check('scoped.other-own-domain', r.status === 403, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails', { key: kSendDom, body: { from: 'x@a.iso.test', to: 'y@example.com', subject: 's', text: 't' } });
  check('scoped.own-domain', r.status === 200, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key: kSendDom, body: [{ from: 'x@a.iso.test', to: 'y@example.com', subject: 's', text: 't' }, { from: 'x@a2.iso.test', to: 'y@example.com', subject: 's', text: 't' }] });
  check('scoped.batch-mixed', r.status === 403, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails', { key: kSendDom, body: { from: 'onboarding@resend.dev', to: 'delivered@resend.dev', subject: 's', text: 't' } });
  check('scoped.sandbox', r.status === 403, `${r.status} ${r.text}`);
  void domA2;

  // --- inbound routing: unverified subdomain registered by another team captures mail
  await s.ctx.sql`update domains set receiving = 'enabled' where id = ${domA}`;
  const sub = await s.req('POST', '/domains', { key: kB, body: { name: 'mail.a.iso.test', capabilities: { sending: 'disabled', receiving: 'enabled' } } });
  info('inbound.subdomain-create', `${sub.status} ${sub.json?.status ?? sub.text.slice(0, 100)}`);
  const mime = 'From: x@ext.example\r\nTo: ceo@mail.a.iso.test\r\nSubject: confidential\r\n\r\nbody\r\n';
  const inb = await fetch(`${s.api}/inbound`, { method: 'POST', headers: { authorization: 'Bearer verify-inbound-secret', 'user-agent': 'x' }, body: mime });
  const [row] = await s.ctx.sql`select team_id from received_emails where subject = 'confidential'`;
  const [dStatus] = await s.ctx.sql`select status from domains where name = 'mail.a.iso.test'`;
  info('inbound.unverified-routing', `inbound ${inb.status}; mail for ceo@mail.a.iso.test stored for team ${row?.team_id === B ? 'B (unverified domain, status ' + dStatus?.status + ')' : row?.team_id === A ? 'A' : 'none'}`);
  if (row?.team_id === B) bad('inbound.unverified-domain-receives', `team B's unverified domain mail.a.iso.test (status ${dStatus?.status}) receives inbound mail`);
} finally {
  await s.close();
}
