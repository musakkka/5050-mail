/**
 * SMTP load generator (STARTTLS + AUTH PLAIN, pooled connections, nodemailer).
 *   HOST PORT USER PASS FROM CONC (parallel connections) TOTAL (messages) OUT (json path)
 * Used for both the 5050 Send relay (USER=resend, PASS=API key) and Stalwart MX ingest
 * (no AUTH, port 25, NOAUTH=1).
 */
import nodemailer from 'nodemailer';
import { writeFileSync } from 'node:fs';

const e = (k, d) => process.env[k] ?? d;
const CONC = Number(e('CONC', 16));
const TOTAL = Number(e('TOTAL', 5000));
const NOAUTH = e('NOAUTH', '0') === '1';
const RCPT = e('RCPT', 'rcpt-{n}@example.net');
const SIZE = Number(e('BODY_BYTES', 2000));
const MOD = Number(e('RCPT_MOD', 1000));
const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil(SIZE / 57)).slice(0, SIZE);

const transports = Array.from({ length: CONC }, () =>
  nodemailer.createTransport({
    host: e('HOST', 'bench-send'), port: Number(e('PORT', 2587)), secure: false,
    ignoreTLS: e('NOTLS', '0') === '1', requireTLS: !NOAUTH && e('NOTLS', '0') !== '1',
    tls: { rejectUnauthorized: false },
    auth: NOAUTH ? undefined : { user: e('USER', 'resend'), pass: e('PASS') },
    pool: true, maxConnections: 1, maxMessages: Number(e('MAX_MSGS', Infinity)),
  }),
);

let next = 0, ok = 0, failed = 0;
const lat = [];
const firstErr = [];
const t0 = performance.now();
await Promise.all(transports.map(async (tr) => {
  while (next < TOTAL) {
    const n = next++;
    const s = performance.now();
    try {
      await tr.sendMail({ from: e('FROM', 'bench@bench.example.com'), to: RCPT.replace('{n}', String((n % MOD) + 1).padStart(2, '0')), subject: `bench ${n}`, text: body });
      ok++;
      lat.push(performance.now() - s);
    } catch (err) {
      failed++;
      if (firstErr.length < 3) firstErr.push(String(err.message ?? err));
    }
  }
  tr.close();
}));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
const out = { conc: CONC, total: TOTAL, ok, failed, seconds: +secs.toFixed(2), msgs_per_sec: +(ok / secs).toFixed(1), p50_ms: p(0.5), p95_ms: p(0.95), p99_ms: p(0.99), errors: firstErr };
console.log(JSON.stringify(out));
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
