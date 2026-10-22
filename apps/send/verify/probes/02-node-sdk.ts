/** Official Node SDK (resend@6.34.1) against the server: every resource, edge cases, doc-shape diffs. */
import { Resend } from 'resend';
import { Webhook } from 'svix';
import { startServer, receiver, ok, bad, info, check, j } from '../lib/harness.js';
import { shape } from '../lib/shape.js';

const s = await startServer({ DEFAULT_RATE_LIMIT: '1000', ALLOW_PRIVATE_WEBHOOKS: '1' });
const hook = await receiver();
try {
  const A = await s.team('A', { members: [{ email: 'owner-a@dev.test', role: 'admin' }] });
  const domId = await s.domain(A, 'sdk.verify.test');
  const { token } = await s.key(A);
  const r = new Resend(token, { baseUrl: s.api });
  const from = 'SDK <hi@sdk.verify.test>';
  const must = <T>(id: string, res: { data: T | null; error: any }): T => {
    if (res.error) bad(id, `SDK error ${j(res.error)}`);
    return res.data as T;
  };

  // ---------------- webhooks first so we capture events
  const wh = must('sdk.webhooks.create', await r.webhooks.create({ endpoint: `${hook.url}/hook`, events: ['email.sent', 'email.delivered', 'email.bounced', 'email.scheduled', 'email.failed', 'contact.created', 'domain.created', 'email.suppressed'] }));
  shape('webhooks__create-webhook', wh);
  shape('webhooks__get-webhook', must('sdk.webhooks.get', await r.webhooks.get(wh.id)));
  shape('webhooks__list-webhooks', must('sdk.webhooks.list', await r.webhooks.list()));
  shape('webhooks__update-webhook', must('sdk.webhooks.update', await r.webhooks.update(wh.id, { events: ['email.sent', 'email.delivered', 'email.bounced', 'email.scheduled', 'email.failed', 'contact.created', 'domain.created', 'email.suppressed'] })));

  // ---------------- emails.send edge cases
  const sent = must('sdk.emails.send', await r.emails.send({
    from, to: ['delivered@resend.dev'], subject: 'Ünïcødé 🚀 ' + 'long '.repeat(200), html: '<p>héllo <img src="cid:logo"></p>', text: 'héllo',
    cc: 'cc@example.com', bcc: ['b1@example.com', 'b2@example.com'], replyTo: ['r1@example.com', 'Reply Two <r2@example.com>'],
    headers: { 'X-Entity-Ref-ID': '123' }, tags: [{ name: 'category', value: 'confirm_email' }],
    attachments: [
      { filename: 'logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentId: 'logo' },
      { filename: 'a.txt', content: Buffer.from('hello').toString('base64') },
    ],
  }));
  shape('emails__send-email', sent);
  await s.drain();
  const msg = s.transport.sent.find((m) => m.emailId === sent.id);
  if (!msg) bad('sdk.emails.send.transport', 'not handed to transport');
  else {
    const raw = msg.raw.toString('utf8');
    check('sdk.emails.send.envelope', j([...msg.recipients].sort()) === j(['b1@example.com', 'b2@example.com', 'cc@example.com']), `envelope ${j(msg.recipients)} (delivered@resend.dev is simulated, not sent)`);
    check('mime.no-bcc-header', !/^Bcc:/im.test(raw), 'Bcc header leaked into MIME');
    check('mime.cid', /Content-ID: <logo>/i.test(raw), 'inline Content-ID missing');
    check('mime.subject-encoded', /^Subject: =\?UTF-8\?/im.test(raw), 'subject not RFC2047-encoded');
    check('mime.custom-header', /^X-Entity-Ref-ID: 123/im.test(raw), 'custom header missing');
    check('mime.reply-to', /^Reply-To: r1@example.com, Reply Two <r2@example.com>/im.test(raw), `reply-to: ${raw.match(/^Reply-To:.*$/im)?.[0]}`);
  }
  const got = must('sdk.emails.get', await r.emails.get(sent.id));
  shape('emails__retrieve-email', got, { ignore: /\.tags\[0\]/ });
  check('sdk.emails.get.subject-unicode', got.subject.startsWith('Ünïcødé 🚀'), got.subject.slice(0, 20));
  check('sdk.emails.get.last_event', got.last_event === 'delivered', `last_event=${got.last_event}`);
  shape('emails__list-emails', must('sdk.emails.list', await r.emails.list({ limit: 5 })));
  const atts = must('sdk.emails.attachments.list', await r.emails.attachments.list({ emailId: sent.id }));
  shape('emails__list-email-attachments', atts);
  const att = must('sdk.emails.attachments.get', await r.emails.attachments.get({ emailId: sent.id, id: (atts as any).data[0].id }));
  shape('emails__retrieve-email-attachment', att);
  const dl = await fetch((att as any).download_url);
  check('sdk.attachment.download', dl.status === 200, `download ${dl.status}`);
  // share
  const sh = must('sdk.emails.share', await r.emails.share(sent.id, { expiresIn: '10m' }));
  shape('emails__share-email', sh);
  // metrics
  const mt = must('sdk.emails.metrics', await r.emails.metrics({ metrics: ['sent', 'delivered', 'open_rate'], dimensions: ['period', 'domain'] }));
  shape('emails__get-metrics', mt);
  // schedule / update / cancel via SDK camelCase
  const sch = must('sdk.emails.schedule', await r.emails.send({ from, to: 'x@example.com', subject: 's', text: 't', scheduledAt: 'in 1 hour' }));
  const upd = must('sdk.emails.update', await r.emails.update({ id: sch.id, scheduledAt: new Date(Date.now() + 7200_000).toISOString() }));
  shape('emails__update-email', upd);
  shape('emails__cancel-email', must('sdk.emails.cancel', await r.emails.cancel(sch.id)));
  // idempotency through SDK
  const i1 = await r.emails.send({ from, to: 'x@example.com', subject: 'i', text: 't' }, { idempotencyKey: 'sdk-1' });
  const i2 = await r.emails.send({ from, to: 'x@example.com', subject: 'i', text: 't' }, { idempotencyKey: 'sdk-1' });
  check('sdk.idempotency', i1.data?.id === i2.data?.id, `${j(i1)} ${j(i2)}`);
  // error envelope through SDK
  const e1 = await r.emails.send({ from: 'x@nope.example', to: 'x@example.com', subject: 's', text: 't' });
  check('sdk.error-envelope', e1.error?.name === 'validation_error' && (e1.error as any).statusCode === 403, j(e1.error));
  // remote path attachment (local receiver, private allowed in this instance)
  const fileSrv = await receiver((_req, _b, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4 fake'); });
  const pe = must('sdk.emails.path-attachment', await r.emails.send({ from, to: 'x@example.com', subject: 'p', text: 't', attachments: [{ path: `${fileSrv.url}/files/invoice.pdf` }] }));
  await s.drain();
  const pm = s.transport.sent.find((m) => m.emailId === pe.id);
  check('sdk.path-attachment.fetched', !!pm && /filename="?invoice\.pdf/.test(pm.raw.toString()) && /application\/pdf/.test(pm.raw.toString()), `path attachment in MIME? ${!!pm}`);
  await fileSrv.close();

  // ---------------- batch
  const bt = must('sdk.batch.send', await r.batch.send([{ from, to: 'a@example.com', subject: '1', html: '<b>1</b>' }, { from, to: ['b@example.com'], subject: '2', text: '2', tags: [{ name: 't', value: 'v' }] }]));
  shape('emails__send-batch-emails', bt);
  const bp = await r.batch.send([{ from, to: 'a@example.com', subject: '1', html: '1' }, { from, to: 'bad', subject: '2', html: '2' }], { batchValidation: 'permissive' });
  info('sdk.batch.permissive', j(bp.data ?? bp.error));

  // ---------------- domains
  const dc = must('sdk.domains.create', await r.domains.create({ name: 'newdomain.example', region: 'eu-west-1', customReturnPath: 'outbound', openTracking: true }));
  shape('domains__create-domain', dc, { ignore: /records\[0\]\.(priority|ttl)/ });
  const dg = must('sdk.domains.get', await r.domains.get(dc.id));
  shape('domains__get-domain', dg, { ignore: /records\[0\]\.(priority|ttl)/ });
  shape('domains__list-domains', must('sdk.domains.list', await r.domains.list()));
  shape('domains__update-domain', must('sdk.domains.update', await r.domains.update({ id: dc.id, clickTracking: true, tls: 'enforced' })));
  shape('domains__verify-domain', must('sdk.domains.verify', await r.domains.verify(dc.id)));
  shape('domains__delete-domain', must('sdk.domains.remove', await r.domains.remove(dc.id)));
  // tenant creating a domain inside the operator's Cloudflare zone (fake zones: cfzone.test, acmedemo.test)
  const B = await s.team('B');
  const rb = new Resend((await s.key(B)).token, { baseUrl: s.api });
  for (const name of ['cfzone.test', 'anything.acmedemo.test']) {
    const d = await rb.domains.create({ name });
    if (d.error) { ok(`sec.operator-zone.${name}`, `rejected ${j(d.error)}`); continue; }
    await s.drain();
    const g = await rb.domains.get(d.data!.id);
    const sendRes = await rb.emails.send({ from: `ceo@${name}`, to: 'victim@example.com', subject: 'spoof', text: 'x' });
    check(`sec.operator-zone.${name}`, g.data?.status !== 'verified' && !!sendRes.error,
      `team B created ${name} with no DNS proof -> status=${g.data?.status}; send as ceo@${name}: ${sendRes.error ? j(sendRes.error) : 'ACCEPTED ' + sendRes.data?.id}; fake CF records in zone: ${s.ctx.cfFake?.zones.map((z) => `${z.name}:${z.records.length}`).join(',')}`);
  }
  // claims
  const cl = await r.domains.claims.create({ name: 'sdk.verify.test' });
  info('sdk.domains.claims.create-own', j(cl.error ?? cl.data));

  // ---------------- api keys
  const kc = must('sdk.apiKeys.create', await r.apiKeys.create({ name: 'restricted', permission: 'sending_access', domainId: domId }));
  shape('api-keys__create-api-key', kc);
  shape('api-keys__list-api-keys', must('sdk.apiKeys.list', await r.apiKeys.list()));
  shape('api-keys__update-api-key', must('sdk.apiKeys.update', await r.apiKeys.update(kc.id, { name: 'renamed' } as any)));
  shape('api-keys__delete-api-key', must('sdk.apiKeys.remove', await r.apiKeys.remove(kc.id)));

  // ---------------- contacts / segments / topics / properties
  const seg = must('sdk.segments.create', await r.segments.create({ name: 'Seg' }));
  shape('segments__create-segment', seg);
  shape('segments__get-segment', must('sdk.segments.get', await r.segments.get(seg.id)));
  shape('segments__list-segments', must('sdk.segments.list', await r.segments.list()));
  const top = must('sdk.topics.create', await r.topics.create({ name: 'News', defaultSubscription: 'opt_in', description: 'd' }));
  shape('topics__create-topic', top);
  shape('topics__get-topic', must('sdk.topics.get', await r.topics.get(top.id)));
  shape('topics__list-topics', must('sdk.topics.list', await r.topics.list()));
  shape('topics__update-topic', must('sdk.topics.update', await r.topics.update({ id: top.id, name: 'News2' })));
  const prop = must('sdk.contactProperties.create', await r.contactProperties.create({ key: 'plan', type: 'string', fallbackValue: 'free' }));
  shape('contact-properties__create-contact-property', prop);
  must('sdk.contactProperties.get', await r.contactProperties.get(prop.id));
  shape('contact-properties__get-contact-property', (await s.req('GET', `/contact-properties/${prop.id}`, { key: token })).json);
  must('sdk.contactProperties.list', await r.contactProperties.list());
  shape('contact-properties__list-contact-properties', (await s.req('GET', '/contact-properties', { key: token })).json);
  const con = must('sdk.contacts.create', await r.contacts.create({ email: 'Steve.Wozniak@Example.com', firstName: 'Steve', lastName: 'W', unsubscribed: false, properties: { plan: 'pro' }, segments: [{ id: seg.id }], topics: [{ id: top.id, subscription: 'opt_out' }] } as any));
  shape('contacts__create-contact', con);
  const cg = must('sdk.contacts.get', await r.contacts.get({ id: con.id }));
  shape('contacts__get-contact', cg, { ignore: /properties\./ });
  const cge = await r.contacts.get({ email: 'steve.wozniak@example.com' });
  check('sdk.contacts.get-by-email-case', !cge.error, `lookup by lower-case email: ${j(cge.error ?? cge.data?.id)}`);
  shape('contacts__list-contacts', must('sdk.contacts.list', await r.contacts.list()));
  shape('contacts__update-contact', must('sdk.contacts.update', await r.contacts.update({ id: con.id, firstName: 'S' })));
  shape('contacts__list-contact-segments', must('sdk.contacts.segments.list', await r.contacts.segments.list({ contactId: con.id })));
  const seg2 = must('sdk.segments.create2', await r.segments.create({ name: 'Seg2' }));
  shape('contacts__add-contact-to-segment', must('sdk.contacts.segments.add', await r.contacts.segments.add({ contactId: con.id, segmentId: seg2.id })));
  shape('contacts__delete-contact-segment', must('sdk.contacts.segments.remove', await r.contacts.segments.remove({ contactId: con.id, segmentId: seg2.id })));
  shape('contacts__get-contact-topics', must('sdk.contacts.topics.list', await r.contacts.topics.list({ id: con.id })));
  shape('contacts__update-contact-topics', must('sdk.contacts.topics.update', await r.contacts.topics.update({ id: con.id, topics: [{ id: top.id, subscription: 'opt_in' }] })));
  const csv = new Blob(['Email,First Name,Plan\nimp1@example.com,Imp,pro\nimp2@example.com,Imp2,free\n'], { type: 'text/csv' });
  const imp = await r.contacts.imports.create({ file: csv, columnMap: { email: 'Email', firstName: 'First Name', properties: { plan: { column: 'Plan', type: 'string' } } }, onConflict: 'upsert', segments: [{ id: seg.id }] } as any);
  if (imp.error) bad('sdk.contacts.imports.create', j(imp.error));
  else {
    shape('contacts__create-contact-import', imp.data);
    await s.drain();
    shape('contacts__get-contact-import', must('sdk.contacts.imports.get', await r.contacts.imports.get((imp.data as any).id)));
    shape('contacts__list-contact-imports', must('sdk.contacts.imports.list', await r.contacts.imports.list()));
  }
  shape('segments__list-segment-contacts', must('sdk.segments.contacts', await r.get(`/segments/${seg.id}/contacts`)));
  shape('segments__get-segment-metrics', must('sdk.segments.metrics', await r.get(`/segments/metrics?dimensions=segment`)));

  // ---------------- templates
  const tc = must('sdk.templates.create', await r.templates.create({ name: 'order', alias: 'order-conf', subject: 'Order {{{PRODUCT}}}', from, html: '<p>{{{PRODUCT}}} {{{PRICE}}}</p>', variables: [{ key: 'PRODUCT', type: 'string', fallbackValue: 'item' }, { key: 'PRICE', type: 'number', fallbackValue: 25 }] }));
  shape('templates__create-template', tc);
  shape('templates__publish-template', must('sdk.templates.publish', await r.templates.publish(tc.id)));
  shape('templates__get-template', must('sdk.templates.get', await r.templates.get(tc.id)));
  shape('templates__list-templates', must('sdk.templates.list', await r.templates.list()));
  shape('templates__update-template', must('sdk.templates.update', await r.templates.update(tc.id, { html: '<p>{{{PRODUCT}}} costs {{{PRICE}}}</p>' })));
  const dup = must('sdk.templates.duplicate', await (r.templates as any).duplicate(tc.id));
  shape('templates__duplicate-template', dup);
  const ts = await r.emails.send({ to: 'x@example.com', template: { id: 'order-conf', variables: { PRODUCT: 'Book' } } } as any);
  check('sdk.send-template-alias', !ts.error, `send by alias with template from/subject: ${j(ts.error ?? ts.data)}`);
  const tsBad = await r.emails.send({ from, to: 'x@example.com', subject: 's', template: { id: 'order-conf', variables: { FIRST_NAME: 'x' } } } as any);
  info('sdk.send-template-reserved-var', `reserved var FIRST_NAME: ${j(tsBad.error ?? tsBad.data)}`);
  const chain = await r.templates.create({ name: 'chain', html: '<p>hi</p>' }).publish();
  check('sdk.templates.create.publish-chain', !chain.error, j(chain.error ?? chain.data));
  shape('templates__delete-template', must('sdk.templates.remove', await r.templates.remove(dup.id)));

  // ---------------- broadcasts
  const bc = must('sdk.broadcasts.create', await r.broadcasts.create({ segmentId: seg.id, from, subject: 'Hello', html: 'Hi {{{contact.first_name|there}}} {{{RESEND_UNSUBSCRIBE_URL}}}', name: 'B1', topicId: top.id } as any));
  shape('broadcasts__create-broadcast', bc);
  shape('broadcasts__get-broadcast', must('sdk.broadcasts.get', await r.broadcasts.get(bc.id)));
  shape('broadcasts__list-broadcasts', must('sdk.broadcasts.list', await r.broadcasts.list()));
  shape('broadcasts__update-broadcast', must('sdk.broadcasts.update', await r.broadcasts.update(bc.id, { subject: 'Hello 2' })));
  const bdup = must('sdk.broadcasts.duplicate', await (r.broadcasts as any).duplicate(bc.id));
  shape('broadcasts__duplicate-broadcast', bdup);
  shape('broadcasts__send-broadcast', must('sdk.broadcasts.send', await r.broadcasts.send(bc.id)));
  await s.drain();
  shape('broadcasts__list-broadcast-recipients', must('sdk.broadcasts.recipients', await (r.broadcasts as any).recipients(bc.id, { type: 'sent', limit: 20 })));
  shape('broadcasts__list-broadcast-clicked-links', must('sdk.broadcasts.clickedLinks', await (r.broadcasts as any).clickedLinks(bc.id, { limit: 20 })));
  const bsch = must('sdk.broadcasts.create-scheduled', await r.broadcasts.create({ segmentId: seg.id, from, subject: 'S', html: 'x', send: true, scheduledAt: 'in 1 hour' } as any));
  shape('broadcasts__cancel-broadcast', must('sdk.broadcasts.cancel', await (r.broadcasts as any).cancel(bsch.id)));
  shape('broadcasts__delete-broadcast', must('sdk.broadcasts.remove', await r.broadcasts.remove(bdup.id)));

  // ---------------- events + automations
  const ev = must('sdk.events.create', await r.events.create({ name: 'user.created', schema: { plan: 'string' } } as any));
  shape('events__create-event', ev);
  shape('events__get-event', must('sdk.events.get', await r.events.get('user.created')));
  shape('events__list-events', must('sdk.events.list', await r.events.list()));
  shape('events__update-event', must('sdk.events.update', await r.events.update('user.created', { schema: { plan: 'string', trial: 'boolean' } } as any)));
  const au = must('sdk.automations.create', await r.automations.create({ name: 'Welcome', status: 'enabled', steps: [{ key: 'start', type: 'trigger', config: { eventName: 'user.created' } }, { key: 'welcome', type: 'send_email', config: { template: { id: tc.id } } }], connections: [{ from: 'start', to: 'welcome' }] } as any));
  shape('automations__create-automation', au);
  shape('automations__get-automation', must('sdk.automations.get', await r.automations.get(au.id)));
  shape('automations__list-automations', must('sdk.automations.list', await r.automations.list()));
  shape('events__send-event', must('sdk.events.send', await r.events.send({ event: 'user.created', contactId: con.id, payload: { plan: 'pro' } } as any)));
  await s.drain();
  const runs = must('sdk.automations.runs.list', await r.automations.runs.list({ automationId: au.id }));
  shape('automations__list-automation-runs', runs);
  if ((runs as any)?.data?.[0]) shape('automations__get-automation-run', must('sdk.automations.runs.get', await r.automations.runs.get({ automationId: au.id, runId: (runs as any).data[0].id })));
  else bad('sdk.automations.run-created', 'events.send did not start an automation run');
  shape('automations__update-automation', must('sdk.automations.update', await r.automations.update(au.id, { status: 'disabled' } as any)));
  const adup = must('sdk.automations.duplicate', await r.automations.duplicate(au.id));
  shape('automations__duplicate-automation', adup);
  shape('automations__stop-automation', must('sdk.automations.stop', await r.automations.stop(au.id)));
  shape('automations__delete-automation', must('sdk.automations.remove', await r.automations.remove(adup.id)));
  shape('events__delete-event', must('sdk.events.remove', await r.events.remove('user.created')));

  // ---------------- suppressions
  const sup = must('sdk.suppressions.add', await r.suppressions.add({ email: 'Blocked@Example.com' }));
  shape('suppressions__add-suppression', sup);
  shape('suppressions__get-suppression', must('sdk.suppressions.get', await r.suppressions.get('blocked@example.com')));
  shape('suppressions__list-suppressions', must('sdk.suppressions.list', await r.suppressions.list()));
  shape('suppressions__add-batch-suppressions', must('sdk.suppressions.batch.add', await r.suppressions.batch.add({ emails: ['s1@example.com', 's2@example.com'] })));
  shape('suppressions__remove-batch-suppressions', must('sdk.suppressions.batch.remove', await r.suppressions.batch.remove({ emails: ['s1@example.com'] } as any)));
  // suppressed recipient is not delivered
  s.transport.clear();
  const se = must('sdk.send-to-suppressed', await r.emails.send({ from, to: 'BLOCKED@example.com', subject: 's', text: 't' }));
  await s.drain();
  check('suppression.respected', !s.transport.sent.some((m) => m.recipients.map((x) => x.toLowerCase()).includes('blocked@example.com')), `suppressed address handed to transport: ${j(s.transport.sent.map((m) => m.recipients))}`);
  info('suppression.last_event', `last_event=${(await r.emails.get(se.id)).data?.last_event}`);
  shape('suppressions__remove-suppression', must('sdk.suppressions.remove', await r.suppressions.remove('blocked@example.com')));

  // ---------------- logs / usage / oauth
  const logs = must('sdk.logs.list', await r.logs.list());
  shape('logs__list-logs', logs);
  if ((logs as any).data?.[0]) shape('logs__retrieve-log', must('sdk.logs.get', await r.logs.get((logs as any).data[0].id)));
  const lg = JSON.stringify(await s.ctx.sql`select request_body, response_body from api_logs where team_id = ${A}`);
  check('logs.redaction', !/re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/.test(lg) && !/whsec_[A-Za-z0-9+/=]{20,}/.test(lg), 'API key token or webhook secret stored in api_logs');
  info('sdk.usage', j((await r.usage.get()).data ?? (await r.usage.get()).error));
  info('sdk.oauthGrants.list', j((await r.oauthGrants.list()).data));

  // ---------------- receiving (inbound)
  await s.ctx.sql`update domains set receiving = 'enabled' where id = ${domId}`;
  const mime = ['From: Ext <ext@other.example>', 'To: inbox@sdk.verify.test', 'Subject: inbound', 'Message-ID: <in-1@other.example>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'hi', '--b', 'Content-Type: text/plain; name=x.txt', 'Content-Disposition: attachment; filename=x.txt', '', 'att', '--b--', ''].join('\r\n');
  const inb = await fetch(`${s.api}/inbound`, { method: 'POST', headers: { authorization: 'Bearer verify-inbound-secret', 'user-agent': 'x' }, body: mime });
  info('inbound.push', `${inb.status} ${await inb.text()}`);
  const rl = must('sdk.emails.receiving.list', await r.emails.receiving.list());
  shape('emails__list-received-emails', rl);
  const rid = (rl as any).data?.[0]?.id;
  if (rid) {
    shape('emails__retrieve-received-email', must('sdk.emails.receiving.get', await r.emails.receiving.get(rid)), { ignore: /\$\.headers\./ });
    const ra = must('sdk.emails.receiving.attachments.list', await r.emails.receiving.attachments.list({ emailId: rid }));
    shape('emails__list-received-email-attachments', ra);
    if ((ra as any).data?.[0]) shape('emails__retrieve-received-email-attachment', must('sdk.emails.receiving.attachments.get', await r.emails.receiving.attachments.get({ emailId: rid, id: (ra as any).data[0].id })));
  }

  // ---------------- webhook delivery + signature (svix + SDK verify)
  await s.drain();
  const deliveries = hook.got.filter((g) => g.url === '/hook');
  check('webhook.delivered', deliveries.length > 0, `deliveries=${deliveries.length}`);
  const secret = (await r.webhooks.get(wh.id)).data!.signing_secret as string;
  let sigOk = 0, sigBad = 0;
  for (const d of deliveries) {
    try {
      new Webhook(secret).verify(d.body, { 'svix-id': d.headers['svix-id'] as string, 'svix-timestamp': d.headers['svix-timestamp'] as string, 'svix-signature': d.headers['svix-signature'] as string });
      r.webhooks.verify({ payload: d.body, headers: { id: d.headers['svix-id'] as string, timestamp: d.headers['svix-timestamp'] as string, signature: d.headers['svix-signature'] as string }, webhookSecret: secret });
      sigOk++;
    } catch (e) { sigBad++; info('webhook.sig-fail', (e as Error).message); }
  }
  check('webhook.signatures', sigBad === 0 && sigOk > 0, `ok=${sigOk} bad=${sigBad}`);
  const types = deliveries.map((d) => JSON.parse(d.body).type);
  info('webhook.types', j(types));
  const sentEv = deliveries.map((d) => JSON.parse(d.body)).find((p) => p.type === 'email.sent');
  if (sentEv) {
    const docSent = { type: 'email.sent', created_at: '', data: { broadcast_id: '', created_at: '', email_id: '', from: '', to: [], subject: '', template_id: '', tags: {} } };
    info('webhook.email.sent.payload', j(sentEv));
    void docSent;
  }
  shape('webhooks__list-events', must('sdk.webhooks.events.list', await r.webhooks.events.list({ webhookId: wh.id } as any)));
  const evId = deliveries[0] ? (deliveries[0].headers['svix-id'] as string) : '';
  if (evId) {
    shape('webhooks__get-event', must('sdk.webhooks.events.get', await r.webhooks.events.get({ webhookId: wh.id, eventId: evId } as any)));
    shape('webhooks__list-event-attempts', must('sdk.webhooks.events.attempts', await r.webhooks.events.attempts.list({ webhookId: wh.id, eventId: evId } as any)));
    shape('webhooks__replay-event', must('sdk.webhooks.events.replay', await r.webhooks.events.replay({ webhookId: wh.id, eventId: evId } as any)));
  }
  // rotation: old + new both verify for 24h
  const rot = must('sdk.webhooks.rotate', await r.webhooks.rotateSigningSecret(wh.id));
  shape('webhooks__rotate-signing-secret', rot);
  const before = hook.got.length;
  await r.emails.send({ from, to: 'delivered@resend.dev', subject: 'after-rotate', text: 't' });
  await s.drain();
  const post = hook.got.slice(before).filter((g) => g.url === '/hook');
  let newOk = 0, oldOk = 0;
  for (const d of post) {
    const h = { 'svix-id': d.headers['svix-id'] as string, 'svix-timestamp': d.headers['svix-timestamp'] as string, 'svix-signature': d.headers['svix-signature'] as string };
    try { new Webhook(rot.signing_secret!).verify(d.body, h); newOk++; } catch { /* */ }
    try { new Webhook(secret).verify(d.body, h); oldOk++; } catch { /* */ }
  }
  check('webhook.rotation-overlap', post.length > 0 && newOk === post.length && oldOk === post.length, `post-rotation deliveries=${post.length} newOk=${newOk} oldOk=${oldOk}`);
  shape('webhooks__delete-webhook', must('sdk.webhooks.remove', await r.webhooks.remove(wh.id)));

  // ---------------- inboxes (spot check)
  const ib = await r.inboxes.create({ emailAddress: 'support@sdk.verify.test', name: 'Support' } as any);
  if (ib.error) bad('sdk.inboxes.create', j(ib.error));
  else {
    shape('inboxes__create-inbox', ib.data);
    shape('inboxes__get-inbox', must('sdk.inboxes.get', await r.inboxes.get({ inboxId: (ib.data as any).id } as any)));
    shape('inboxes__list-inboxes', must('sdk.inboxes.list', await r.inboxes.list()));
    const dr = await r.inboxes.drafts.create({ inboxId: (ib.data as any).id, to: ['ada@example.org'], subject: 'Refund', html: '<p>x</p>', text: 'x' } as any);
    if (dr.error) bad('sdk.inboxes.drafts.create', j(dr.error));
    else {
      shape('inboxes__create-draft', dr.data);
      shape('inboxes__send-draft', must('sdk.inboxes.drafts.send', await r.inboxes.drafts.send({ inboxId: (ib.data as any).id, draftId: (dr.data as any).id } as any)));
    }
    shape('inboxes__list-threads', must('sdk.inboxes.threads.list', await r.inboxes.threads.list({ inboxId: (ib.data as any).id } as any)));
  }

  // ---------------- contacts delete + segments delete + misc removes
  shape('contacts__delete-contact', must('sdk.contacts.remove', await r.contacts.remove({ id: con.id })));
  shape('segments__delete-segment', must('sdk.segments.remove', await r.segments.remove(seg2.id)));
  shape('topics__delete-topic', must('sdk.topics.remove', await r.topics.remove(top.id)));
  shape('contact-properties__delete-contact-property', must('sdk.contactProperties.remove', await r.contactProperties.remove(prop.id)));
} finally {
  await hook.close();
  await s.close();
}
