/** Core HTTP: auth, error envelopes, validation limits, pagination, idempotency, rate-limit headers. */
import { startServer, ok, bad, info, check, j } from '../lib/harness.js';

const s = await startServer({ DEFAULT_RATE_LIMIT: '1000' });
try {
  const A = await s.team('A');
  const dom = await s.domain(A, 'a.verify.test');
  const { token: key, id: keyId } = await s.key(A);
  const send = (body: unknown, o: { headers?: Record<string, string>; key?: string } = {}) => s.req('POST', '/emails', { key: o.key ?? key, body, headers: o.headers });
  const base = { from: 'A <hi@a.verify.test>', to: 'x@example.com', subject: 's', html: '<p>h</p>' };

  // ---------- auth
  let r = await s.req('GET', '/domains');
  check('auth.missing', r.status === 401 && r.json?.name === 'missing_api_key', `missing key -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/domains', { headers: { authorization: 'Basic abc' } });
  check('auth.malformed-scheme', r.status === 400 && r.json?.name === 'validation_error', `Basic auth -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/domains', { key: 're_123' });
  check('auth.malformed-key', r.status === 400 && r.json?.message === 'API key is invalid', `re_123 -> ${r.status} ${r.text}`);
  r = await send(base, { key: 're_123' });
  info('auth.malformed-key-on-send', `POST /emails with re_123 -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/domains', { key: ('re_' + 'A'.repeat(8) + '_' + 'B'.repeat(24)) });
  check('auth.unknown-nonsend', r.status === 400, `unknown well-formed key on GET /domains -> ${r.status}`);
  r = await send(base, { key: ('re_' + 'A'.repeat(8) + '_' + 'B'.repeat(24)) });
  check('auth.unknown-send', r.status === 401 && r.json?.name === 'validation_error', `unknown key on POST /emails -> ${r.status} ${r.text}`);
  // Revoked
  const k2 = await s.key(A);
  await s.req('DELETE', `/api-keys/${k2.id}`, { key });
  r = await send(base, { key: k2.token });
  check('auth.revoked-send', r.status === 401, `revoked key send -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/emails', { key: k2.token });
  check('auth.revoked-get', r.status === 400, `revoked key GET -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/domains', { key: key + ' ' });
  info('auth.trailing-space', `key with trailing space -> ${r.status}`);
  r = await s.req('GET', '/domains', { key: key.toLowerCase() });
  check('auth.case-sensitive', r.status !== 200, `lower-cased key accepted? -> ${r.status}`);
  // no UA
  r = await s.req('GET', '/domains', { key, noUA: true });
  check('ua.required', r.status === 403 && r.text === 'error code: 1010', `no UA -> ${r.status} ${r.text}`);
  // Order: UA check vs 404?
  r = await s.req('GET', '/nope', { key });
  check('err.404', r.status === 404 && r.json?.name === 'not_found', `unknown path -> ${r.status} ${r.text}`);
  r = await s.req('PUT', '/emails', { key, body: {} });
  check('err.405', r.status === 405 && r.json?.name === 'method_not_allowed', `PUT /emails -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/emails/not-a-uuid', { key });
  check('err.uuid', r.status === 422 && r.json?.name === 'invalid_parameter', `bad uuid -> ${r.status} ${r.text}`);
  r = await s.req('GET', '/emails/00000000-0000-4000-8000-000000000000', { key });
  check('err.notfound-email', r.status === 404 && r.json?.name === 'not_found', `missing email -> ${r.status} ${r.text}`);
  r = await s.req('POST', '/emails', { key, raw: '{bad json' });
  info('err.badjson', `invalid JSON -> ${r.status} ${r.text}`);
  r = await s.req('POST', '/emails', { key, raw: '{"from":"a@b.co"}', headers: { 'content-type': 'text/plain' } });
  info('err.text-plain-json', `JSON body with content-type text/plain -> ${r.status} ${r.text}`);

  // ---------- send validation
  r = await send({ ...base, from: undefined });
  check('val.from-missing', r.status === 422 && r.json?.name === 'missing_required_field', `${r.status} ${r.text}`);
  r = await send({ ...base, to: undefined });
  check('val.to-missing', r.status === 422 && r.json?.name === 'missing_required_field', `${r.status} ${r.text}`);
  r = await send({ ...base, subject: undefined });
  check('val.subject-missing', r.status === 422 && r.json?.name === 'missing_required_field', `${r.status} ${r.text}`);
  r = await send({ ...base, subject: '' });
  info('val.subject-empty', `subject "" -> ${r.status} ${r.text}`);
  r = await send({ from: base.from, to: base.to, subject: 's' });
  info('val.no-body', `no html/text -> ${r.status} ${r.text}`);
  r = await send({ ...base, to: Array.from({ length: 50 }, (_, i) => `u${i}@example.com`) });
  check('val.to-50-ok', r.status === 200, `50 to -> ${r.status} ${r.text}`);
  r = await send({ ...base, to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) });
  check('val.to-51-rejected', r.status === 422, `51 to -> ${r.status} ${r.text}`);
  r = await send({ ...base, cc: Array.from({ length: 500 }, (_, i) => `c${i}@example.com`), bcc: Array.from({ length: 500 }, (_, i) => `b${i}@example.com`) });
  info('val.cc-bcc-unbounded', `50 to? no: 1 to + 500 cc + 500 bcc -> ${r.status} ${r.text}`);
  r = await send({ ...base, to: [] });
  check('val.to-empty-array', r.status === 422, `to [] -> ${r.status} ${r.text}`);
  r = await send({ ...base, to: 'not-an-email' });
  check('val.to-invalid', r.status === 422 && r.json?.name === 'validation_error', `${r.status} ${r.text}`);
  r = await send({ ...base, to: 123 });
  check('val.to-number', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, from: 'hi@unverified.example' });
  check('val.from-unverified', r.status === 403 && r.json?.name === 'validation_error', `${r.status} ${r.text}`);
  r = await send({ ...base, from: 'hi@sub.a.verify.test' });
  check('val.from-subdomain', r.status === 403, `subdomain of verified domain -> ${r.status} ${r.text}`);
  r = await send({ ...base, from: 'HI@A.VERIFY.TEST' });
  check('val.from-case', r.status === 200, `upper-case domain -> ${r.status} ${r.text}`);
  // tags
  r = await send({ ...base, tags: [{ name: 'a b', value: 'x' }] });
  check('val.tag-space', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, tags: [{ name: 'n', value: 'é' }] });
  check('val.tag-nonascii', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, tags: [{ name: 'x'.repeat(256), value: 'y'.repeat(256) }] });
  check('val.tag-256', r.status === 200, `${r.status} ${r.text}`);
  r = await send({ ...base, tags: [{ name: 'x'.repeat(257), value: 'y' }] });
  check('val.tag-257', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, tags: Array.from({ length: 76 }, (_, i) => ({ name: `t${i}`, value: 'v' })) });
  check('val.tags-76', r.status === 422, `76 tags -> ${r.status} ${r.text}`);
  r = await send({ ...base, tags: [{ name: 'n' }] });
  info('val.tag-no-value', `tag without value -> ${r.status} ${r.text}`);
  r = await send({ ...base, tags: { name: 'n', value: 'v' } });
  check('val.tags-object', r.status === 422, `tags object -> ${r.status} ${r.text}`);
  // headers
  r = await send({ ...base, headers: { 'X-Test': 'a\r\nBcc: evil@example.com' } });
  check('val.header-crlf', r.status === 422, `CRLF header value -> ${r.status} ${r.text}`);
  r = await send({ ...base, headers: { 'X Bad': 'a' } });
  check('val.header-name', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, subject: 'Hi\r\nBcc: evil@example.com' });
  info('val.subject-crlf', `CRLF in subject -> ${r.status} ${r.text}`);
  // attachments
  r = await send({ ...base, attachments: [{ filename: 'a.txt' }] });
  check('val.att-empty', r.status === 422 && r.json?.name === 'invalid_attachment', `${r.status} ${r.text}`);
  r = await send({ ...base, attachments: [{ filename: 'evil.exe', content: Buffer.from('MZ').toString('base64') }] });
  check('val.att-exe-blocked', r.status === 422, `.exe attachment -> ${r.status} ${r.text}`);
  r = await send({ ...base, attachments: [{ filename: 'a.txt', content: '!!!not base64!!!' }] });
  info('val.att-bad-b64', `invalid base64 content -> ${r.status} ${r.text}`);
  r = await send({ ...base, attachments: [{ path: 'https://example.com/%E0%A4%A' }] });
  check('val.att-path-bad-percent', r.status !== 500, `path with malformed %-escape -> ${r.status} ${r.text}`);
  r = await send({ ...base, attachments: [{ path: 'file:///etc/passwd' }] });
  check('val.att-path-file', r.status === 422, `file:// path -> ${r.status} ${r.text}`);
  r = await send({ ...base, attachments: [{ filename: 'a.png', content: 'aGk=', content_id: 'x'.repeat(200) }] });
  check('val.att-cid-128', r.status === 422, `content_id 200 chars (docs: < 128) -> ${r.status} ${r.text}`);
  // size: 40MB
  const big = 'A'.repeat(41 * 1024 * 1024);
  r = await send({ ...base, attachments: [{ filename: 'big.bin', content: big }] });
  check('val.att-40mb', r.status === 422 || r.status === 413, `41MB b64 attachment -> ${r.status} ${r.text.slice(0, 200)}`);
  // scheduled_at
  r = await send({ ...base, scheduled_at: 'in 1 min' });
  check('val.sched-nl', r.status === 200, `in 1 min -> ${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: new Date(Date.now() + 31 * 86400_000).toISOString() });
  check('val.sched-31d', r.status === 422, `31 days ahead -> ${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: 'gibberish date' });
  check('val.sched-garbage', r.status === 422, `${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: '2020-01-01T00:00:00Z' });
  info('val.sched-past', `past date -> ${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: 'tomorrow at 9am' });
  check('val.sched-tomorrow', r.status === 200, `tomorrow at 9am -> ${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: 'Friday at 3pm ET' });
  check('val.sched-friday-et', r.status === 200, `Friday at 3pm ET -> ${r.status} ${r.text}`);
  r = await send({ ...base, scheduled_at: 1767225600 });
  info('val.sched-number', `numeric scheduled_at -> ${r.status} ${r.text}`);
  // template + html
  r = await send({ ...base, template: { id: 'x' } });
  check('val.template-and-html', r.status === 422, `${r.status} ${r.text}`);
  // react field present
  r = await send({ ...base, react: '<div/>' });
  info('val.react-raw', `raw react field over HTTP -> ${r.status} ${r.text}`);

  // ---------- From-header spoofing via address-list parsing
  r = await send({ ...base, from: 'ceo@bank.example, Me <hi@a.verify.test>' });
  if (r.status === 200) {
    await s.drain();
    const m = s.transport.sent.at(-1)!;
    const fromLine = m.raw.toString('utf8').split(/\r?\n/).find((l) => /^From:/i.test(l));
    check('sec.from-list-spoof', !/bank\.example/.test(fromLine ?? ''), `from "ceo@bank.example, Me <hi@a.verify.test>" accepted; MIME ${fromLine}; envelope ${m.from}`);
  } else ok('sec.from-list-spoof', `rejected ${r.status}`);
  r = await send({ ...base, to: 'victim@other.example, Bob <bob@example.com>' });
  if (r.status === 200) {
    await s.drain();
    const m = s.transport.sent.at(-1)!;
    const toLine = m.raw.toString('utf8').split(/\r?\n/).find((l) => /^To:/i.test(l));
    info('sec.to-list', `to "victim@other.example, Bob <bob@example.com>" accepted; MIME ${toLine}; envelope rcpts ${j(m.recipients)}`);
  }
  // Subject header injection reaches MIME?
  s.transport.clear();
  r = await send({ ...base, subject: 'Hi\r\nBcc: evil@example.com\r\nX-Inj: 1' });
  if (r.status === 200) {
    await s.drain();
    const raw = s.transport.sent.at(-1)?.raw.toString('utf8') ?? '';
    const hdr = raw.split(/\r?\n\r?\n/)[0]!;
    check('sec.subject-injection', !/^X-Inj:/im.test(hdr) && !/^Bcc:/im.test(hdr), `subject CRLF -> headers: ${hdr.split(/\r?\n/).filter((l) => /^(Subject|Bcc|X-Inj)/i.test(l)).join(' | ')}`);
  }
  // Custom headers overriding protected ones
  s.transport.clear();
  r = await send({ ...base, headers: { 'Resent-From': 'ceo@bank.example', 'DKIM-Signature': 'v=1; fake', 'List-Unsubscribe': '<https://evil.example>', 'Authentication-Results': 'spf=pass' } });
  if (r.status === 200) {
    await s.drain();
    const hdr = s.transport.sent.at(-1)!.raw.toString('utf8').split(/\r?\n\r?\n/)[0]!;
    info('sec.custom-headers-passthrough', `passes: ${hdr.split(/\r?\n/).filter((l) => /^(Resent-From|DKIM-Signature|Authentication-Results|List-Unsubscribe)/i.test(l)).join(' | ')}`);
  }

  // ---------- text auto-generation
  s.transport.clear();
  r = await send({ ...base, html: '<h1>Title</h1><p>Body <a href="https://x.example">link</a></p>' });
  const g = await s.req('GET', `/emails/${r.json.id}`, { key });
  info('text.autogen', `GET text=${j(g.json?.text)}`);
  r = await send({ ...base, text: '' });
  const g2 = await s.req('GET', `/emails/${r.json.id}`, { key });
  info('text.optout', `text:"" -> GET text=${j(g2.json?.text)}`);

  // ---------- response envelopes
  r = await send({ ...base, cc: 'c@example.com', reply_to: 'r@example.com', tags: [{ name: 'k', value: 'v' }] });
  const id = r.json.id;
  check('env.send', Object.keys(r.json).join(',') === 'id', `send body keys ${Object.keys(r.json)}`);
  check('env.quota-header', r.headers.get('x-resend-monthly-quota') !== null, `x-resend-monthly-quota=${r.headers.get('x-resend-monthly-quota')}`);
  const ge = await s.req('GET', `/emails/${id}`, { key });
  info('env.get-email', j(ge.json));
  check('env.get-email.cc-array', Array.isArray(ge.json.cc) && Array.isArray(ge.json.reply_to), `cc=${j(ge.json.cc)} reply_to=${j(ge.json.reply_to)}`);
  const le = await s.req('GET', `/emails?limit=1`, { key });
  info('env.list-email', j(le.json).slice(0, 600));
  check('env.list-shape', le.json.object === 'list' && typeof le.json.has_more === 'boolean' && Array.isArray(le.json.data), j(le.json).slice(0, 200));

  // ---------- pagination
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'limit=1.5', 'after=x', `after=${id}&before=${id}`]) {
    r = await s.req('GET', `/emails?${q}`, { key });
    check(`page.${q.split('=')[0]}.${q}`, r.status === 422 && r.json?.name === 'validation_error', `GET /emails?${q} -> ${r.status} ${r.text.slice(0, 160)}`);
  }
  // full walk forward / backward
  const all: string[] = [];
  let after: string | undefined;
  for (let i = 0; i < 200; i++) {
    const p = await s.req('GET', `/emails?limit=7${after ? `&after=${after}` : ''}`, { key });
    all.push(...p.json.data.map((e: any) => e.id));
    if (!p.json.has_more) break;
    after = p.json.data.at(-1).id;
  }
  const [{ n }] = await s.ctx.sql`select count(*)::int as n from emails where team_id = ${A}`;
  check('page.walk-forward', all.length === n && new Set(all).size === n, `walked ${all.length} unique ${new Set(all).size} of ${n}`);
  const back = await s.req('GET', `/emails?limit=3&before=${all[10]}`, { key });
  check('page.before', j(back.json.data.map((e: any) => e.id)) === j(all.slice(7, 10)) && back.json.has_more === true, `before=${all[10]} -> ${j(back.json.data.map((e: any) => e.id))} want ${j(all.slice(7, 10))} has_more=${back.json.has_more}`);
  r = await s.req('GET', `/emails?after=00000000-0000-4000-8000-000000000000`, { key });
  info('page.unknown-cursor', `${r.status} ${r.text.slice(0, 120)}`);
  // list-all endpoints without limit
  r = await s.req('GET', '/api-keys', { key });
  check('page.api-keys-shape', r.json?.object === 'list' && 'has_more' in r.json, r.text.slice(0, 200));

  // ---------- idempotency
  const ik = { 'Idempotency-Key': 'verify-1' };
  const r1 = await send(base, { headers: ik });
  const r2 = await send(base, { headers: ik });
  check('idem.replay', r1.status === 200 && r2.status === 200 && r1.json.id === r2.json.id, `${r1.text} vs ${r2.text}`);
  const r3 = await send({ ...base, subject: 'other' }, { headers: ik });
  check('idem.conflict', r3.status === 409 && r3.json?.name === 'invalid_idempotent_request', `${r3.status} ${r3.text}`);
  const r4 = await s.req('POST', '/emails', { key, raw: JSON.stringify(base, null, 2), headers: ik });
  info('idem.whitespace-diff', `same JSON, different whitespace -> ${r4.status} ${r4.json?.name ?? ''}`);
  const r5 = await send(base, { headers: { 'Idempotency-Key': 'x'.repeat(257) } });
  check('idem.too-long', r5.status === 400 && r5.json?.name === 'invalid_idempotency_key', `${r5.status} ${r5.text}`);
  const r6 = await send(base, { headers: { 'Idempotency-Key': '' } });
  info('idem.empty', `empty key -> ${r6.status} ${r6.text}`);
  // concurrent
  const cc = await Promise.all(Array.from({ length: 8 }, () => send(base, { headers: { 'Idempotency-Key': 'conc-1' } })));
  const ids = new Set(cc.filter((x) => x.status === 200).map((x) => x.json.id));
  check('idem.concurrent', ids.size <= 1, `8 concurrent: statuses ${cc.map((x) => x.status).join(',')} distinct ids ${ids.size} names ${cc.map((x) => x.json?.name ?? '').join(',')}`);
  // key across teams
  const B = await s.team('B');
  await s.domain(B, 'b.verify.test');
  const kb = await s.key(B);
  const rb = await send({ ...base, from: 'hi@b.verify.test' }, { key: kb.token, headers: ik });
  check('idem.per-team', rb.status === 200 && rb.json.id !== r1.json.id, `team B with same key -> ${rb.status} ${rb.text}`);
  // failed request consumes key?
  const f1 = await send({ ...base, to: 'bad' }, { headers: { 'Idempotency-Key': 'fail-1' } });
  const f2 = await send(base, { headers: { 'Idempotency-Key': 'fail-1' } });
  info('idem.after-422', `422 first (${f1.status}) then valid with same key -> ${f2.status} ${f2.json?.name ?? f2.json?.id}`);
  // batch idempotency, header case
  const b1 = await s.req('POST', '/emails/batch', { key, body: [base, base], headers: { 'idempotency-key': 'b-1' } });
  const b2 = await s.req('POST', '/emails/batch', { key, body: [base, base], headers: { 'idempotency-key': 'b-1' } });
  check('idem.batch', j(b1.json) === j(b2.json), `${b1.text} vs ${b2.text}`);
  // Does idempotency replay re-emit quota headers / a fresh rate-limit hit? (informational)

  // ---------- batch
  r = await s.req('POST', '/emails/batch', { key, body: Array.from({ length: 101 }, () => base) });
  check('batch.101', r.status === 422, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key, body: Array.from({ length: 100 }, () => base) });
  check('batch.100', r.status === 200 && r.json.data.length === 100, `${r.status}`);
  r = await s.req('POST', '/emails/batch', { key, body: [{ ...base, attachments: [{ filename: 'a.txt', content: 'aGk=' }] }] });
  check('batch.attachments', r.status === 422, `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key, body: [base, { ...base, to: 'bad' }] });
  info('batch.strict-error', `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key, body: [base, { ...base, to: 'bad' }], headers: { 'x-batch-validation': 'permissive' } });
  info('batch.permissive', `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key, body: base });
  info('batch.object-body', `${r.status} ${r.text}`);
  r = await s.req('POST', '/emails/batch', { key, body: [{ ...base, scheduled_at: 'in 1 hour' }] });
  info('batch.scheduled', `${r.status} ${r.text}`);

  // ---------- update/cancel
  r = await send({ ...base, scheduled_at: 'in 1 hour' });
  const sid = r.json.id;
  r = await s.req('PATCH', `/emails/${sid}`, { key, body: { scheduled_at: 'in 2 hours' } });
  check('sched.update', r.status === 200 && r.json.object === 'email', `${r.status} ${r.text}`);
  r = await s.req('POST', `/emails/${sid}/cancel`, { key });
  check('sched.cancel', r.status === 200, `${r.status} ${r.text}`);
  const gc = await s.req('GET', `/emails/${sid}`, { key });
  check('sched.cancel-state', gc.json.last_event === 'canceled', `last_event=${gc.json.last_event}`);
  r = await s.req('PATCH', `/emails/${sid}`, { key, body: { scheduled_at: 'in 3 hours' } });
  check('sched.update-after-cancel', r.status >= 400, `${r.status} ${r.text}`);
  r = await s.req('POST', `/emails/${sid}/cancel`, { key });
  info('sched.cancel-twice', `${r.status} ${r.text}`);
  r = await s.req('POST', `/emails/${id}/cancel`, { key });
  info('sched.cancel-nonscheduled', `${r.status} ${r.text}`);

  // ---------- api keys
  r = await s.req('POST', '/api-keys', { key, body: { name: 'x'.repeat(51) } });
  check('keys.name-51', r.status === 422, `${r.status} ${r.text}`);
  r = await s.req('POST', '/api-keys', { key, body: { name: 'k', permission: 'sending_access', domain_id: dom } });
  check('keys.create', r.status === 201 || r.status === 200, `${r.status} ${r.text}`);
  info('keys.create-status', `POST /api-keys status ${r.status}`);
  r = await s.req('POST', '/api-keys', { key, body: { name: 'k', permission: 'full_access', domain_id: dom } });
  info('keys.full-with-domain', `${r.status} ${r.text}`);

  // body size limit
  info('misc.max-body', `MAX_BODY_BYTES=${s.config.maxBodyBytes}`);
} finally {
  await s.close();
}
