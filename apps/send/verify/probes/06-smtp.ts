/** SMTP relay: AUTH PLAIN/LOGIN, wrong creds, restricted keys, recipients, size, STARTTLS, plaintext-AUTH refusal. */
import net from 'node:net';
import tls from 'node:tls';
import nodemailer from 'nodemailer';
import { startServer, ok, bad, info, check, j } from '../lib/harness.js';
import { startSmtp, type SmtpHandle } from '../../src/smtp/server.js';
import { selfSigned } from '../../test/smtp/certs.js';

const s = await startServer({ DEFAULT_RATE_LIMIT: '1000' });
const cert = selfSigned('smtp.test');
let tlsPort = 0, startPort = 0;
let handle: SmtpHandle | null = null;
try {
  const A = await s.team('A');
  await s.domain(A, 'smtp.verify.test');
  const key = (await s.key(A)).token;
  const keySend = (await s.key(A, 'sending_access')).token;
  const B = await s.team('B');
  await s.domain(B, 'b.smtp.test');

  handle = await startSmtp(s.ctx, { listen: [{ port: 0, implicitTls: true, host: '127.0.0.1' }, { port: 0, implicitTls: false, host: '127.0.0.1' }], tls: { key: cert.key, cert: cert.cert } });
  tlsPort = handle.servers.find((x) => x.listen.implicitTls)!.port;
  startPort = handle.servers.find((x) => !x.listen.implicitTls)!.port;
  info('smtp.ports', `tls=${tlsPort} starttls=${startPort}`);

  const send = async (o: { user?: string; pass: string; implicit?: boolean; authMethod?: string; from?: string; to?: string[]; subject?: string; bytes?: number; requireTls?: boolean }) => {
    const t = nodemailer.createTransport({
      host: '127.0.0.1', port: o.implicit ? tlsPort : startPort, secure: !!o.implicit,
      auth: { user: o.user ?? 'resend', pass: o.pass }, authMethod: o.authMethod,
      tls: { rejectUnauthorized: false }, requireTLS: o.requireTls !== false, connectionTimeout: 8000, greetingTimeout: 8000,
    });
    try {
      const info = await t.sendMail({ envelope: { from: (o.from ?? 'hi@smtp.verify.test').replace(/.*<|>.*/g, ''), to: o.to ?? ['x@example.com'] }, from: o.from ?? 'hi@smtp.verify.test', to: o.to ?? ['x@example.com'], subject: o.subject ?? 'smtp', text: o.bytes ? 'x'.repeat(o.bytes) : 'hello', headers: { 'X-Resend-Tags': 'env=test' } });
      return { ok: true, response: info.response };
    } catch (e) { return { ok: false, code: (e as any).responseCode, response: (e as any).response ?? (e as Error).message }; } finally { t.close(); }
  };

  // valid auth over implicit TLS and STARTTLS
  let r = await send({ pass: key, implicit: true });
  check('smtp.auth-plain-implicit', r.ok, j(r));
  r = await send({ pass: key, implicit: false });
  check('smtp.auth-starttls', r.ok, j(r));
  r = await send({ pass: key, authMethod: 'LOGIN', implicit: true });
  check('smtp.auth-login', r.ok, j(r));
  await s.drain();
  check('smtp.delivered-to-transport', s.transport.sent.length >= 3, `transport got ${s.transport.sent.length}`);
  const last = s.transport.sent.at(-1)!;
  check('smtp.tags-passthrough', !/^X-Resend-Tags/im.test(last.raw.toString()), `X-Resend-Tags should be consumed, not sent: ${/^X-Resend-Tags.*$/im.exec(last.raw.toString())?.[0] ?? 'absent'}`);

  // wrong user / wrong key / revoked / restricted
  r = await send({ user: 'notresend', pass: key, implicit: true });
  check('smtp.wrong-user', !r.ok && r.code === 535, j(r));
  r = await send({ pass: 're_bad_bad', implicit: true });
  check('smtp.wrong-key', !r.ok && r.code === 535, j(r));
  r = await send({ pass: keySend, implicit: true });
  check('smtp.restricted-key-can-send', r.ok, `sending_access key over SMTP -> ${j(r)}`);
  // wrong-team domain
  r = await send({ pass: key, from: 'x@b.smtp.test', implicit: true });
  check('smtp.wrong-team-domain', !r.ok && (r.code === 550 || r.code === 553), j(r));
  // unverified domain
  r = await send({ pass: key, from: 'x@unverified.example', implicit: true });
  check('smtp.unverified-domain', !r.ok, j(r));

  // many recipients: RCPT limit is 150
  r = await send({ pass: key, to: Array.from({ length: 151 }, (_, i) => `u${i}@example.com`), implicit: true });
  check('smtp.rcpt-over-150', !r.ok && r.code === 452, j(r));
  // but the send pipeline normalize() caps `to` at 50 — what happens at 60?
  r = await send({ pass: key, to: Array.from({ length: 60 }, (_, i) => `u${i}@example.com`), implicit: true });
  info('smtp.rcpt-60', `60 recipients (SMTP allows <=150, API caps to<=50): ${j(r)}`);

  // size limit
  r = await send({ pass: key, bytes: 41 * 1024 * 1024, implicit: true });
  check('smtp.size-limit', !r.ok && (r.code === 552 || r.code === 523), j(r));

  // plaintext AUTH without TLS must be refused (STARTTLS port, AUTH before STARTTLS)
  const plainAuth = await new Promise<string>((resolve) => {
    const sock = net.connect(startPort, '127.0.0.1');
    let buf = '';
    let stage = 0;
    sock.setTimeout(8000, () => { sock.destroy(); resolve('TIMEOUT:' + buf.slice(-200)); });
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\r\n');
      if (stage === 0 && /^220 /m.test(buf)) { stage = 1; sock.write('EHLO verify\r\n'); }
      else if (stage === 1 && /^250[ -]/m.test(lines.at(-2) ?? '')) { stage = 2; sock.write('AUTH PLAIN ' + Buffer.from('\0resend\0' + key).toString('base64') + '\r\n'); }
      else if (stage === 2 && /^\d{3} /m.test(lines.at(-2) ?? '')) { const code = (lines.filter((l) => /^\d{3} /.test(l)).at(-1) ?? ''); resolve('AUTHRESP:' + code); sock.destroy(); }
    });
    sock.on('error', (e) => resolve('ERR:' + e.message));
  });
  check('smtp.plaintext-auth-refused', /AUTHRESP:5\d\d|538|530/.test(plainAuth) && !/AUTHRESP:235/.test(plainAuth), `AUTH PLAIN before STARTTLS -> ${plainAuth}`);
  // Does EHLO advertise AUTH before STARTTLS on the cleartext port?
  const ehlo = await new Promise<string>((resolve) => {
    const sock = net.connect(startPort, '127.0.0.1');
    let buf = '';
    sock.setTimeout(6000, () => { sock.destroy(); resolve(buf); });
    sock.on('data', (d) => { buf += d.toString(); if (/^220 /m.test(buf) && !buf.includes('EHLO')) sock.write('EHLO verify\r\n'); if (/^250 /m.test(buf)) { resolve(buf); sock.destroy(); } });
    sock.on('error', () => resolve(buf));
  });
  check('smtp.no-auth-before-starttls', !/250[ -]AUTH/i.test(ehlo) || /STARTTLS/i.test(ehlo), `cleartext EHLO: ${ehlo.replace(/\r\n/g, ' | ')}`);
  info('smtp.ehlo-cleartext', ehlo.replace(/\r\n/g, ' | '));

  // implicit TLS really is TLS
  const tlsCheck = await new Promise<string>((resolve) => {
    const sock = tls.connect({ port: tlsPort, host: '127.0.0.1', rejectUnauthorized: false }, () => { sock.once('data', (d) => { resolve(d.toString().slice(0, 60)); sock.destroy(); }); });
    sock.setTimeout(6000, () => { sock.destroy(); resolve('TIMEOUT'); });
    sock.on('error', (e) => resolve('ERR:' + e.message));
  });
  check('smtp.implicit-tls-banner', /^220 /.test(tlsCheck), tlsCheck);

  // idempotency via Resend-Idempotency-Key header
  const mkOne = (hdr: string) => nodemailer.createTransport({ host: '127.0.0.1', port: tlsPort, secure: true, auth: { user: 'resend', pass: key }, tls: { rejectUnauthorized: false } }).sendMail({ from: 'hi@smtp.verify.test', to: 'x@example.com', subject: 'idem', text: 'body', headers: { 'Resend-Idempotency-Key': hdr } });
  const a1 = await mkOne('smtp-idem-1'); const a2 = await mkOne('smtp-idem-1');
  const id1 = /OK (\S+)/.exec((a1 as any).response)?.[1]; const id2 = /OK (\S+)/.exec((a2 as any).response)?.[1];
  check('smtp.idempotency', !!id1 && id1 === id2, `${(a1 as any).response} vs ${(a2 as any).response}`);

  // AUTH brute-force lockout (per IP)
  let codes: number[] = [];
  for (let i = 0; i < 12; i++) { const x = await send({ pass: `re_bad_${i}`, implicit: true }); codes.push(x.code ?? 0); }
  check('smtp.auth-bruteforce-lockout', codes.includes(454) || codes.filter((c) => c === 535).length < 12, `12 bad auths: ${codes.join(',')}`);
} finally {
  await handle?.close();
  await s.close();
}
