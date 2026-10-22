/**
 * Role: SMTP relay. `node dist/smtp.js`
 *   SMTP_PORTS_TLS (implicit TLS, default 465,2465), SMTP_PORTS_STARTTLS (default 587,2587)
 *   TLS: SMTP_TLS_CERT/SMTP_TLS_KEY files (hot-reloaded), or ACME_ENABLED=1 (DNS-01 via Cloudflare).
 */
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate } from './db.js';
import { startSmtp, type SmtpListen } from './smtp/server.js';
import { readCertPair, watchCertFiles } from './smtp/tls.js';
import { acmePaths, startAcme } from './smtp/acme.js';

const config = loadConfig();
const ctx = createContext(config);
if (process.env.MIGRATE_ON_START !== '0') await migrate(ctx.sql, undefined, (m) => ctx.log('migrate', m));
const log = (m: string) => ctx.log('smtp', m);

let certPath = config.smtpTlsCert;
let keyPath = config.smtpTlsKey;
let acme: ReturnType<typeof startAcme> | null = null;
if (config.acmeEnabled) {
  if (!ctx.cf) throw new Error('ACME_ENABLED needs CLOUDFLARE_API_TOKEN (DNS:Edit on the smtp host zone)');
  const p = acmePaths(config.acmeStateDir);
  certPath = p.cert;
  keyPath = p.key;
  acme = startAcme(
    { host: config.smtpHostname, email: config.acmeEmail, directoryUrl: config.acmeDirectory, stateDir: config.acmeStateDir, cf: ctx.cf.cf, log },
    (e) => log(`acme failed: ${e.message}`),
  );
  await acme.ready;
}

let tls: { key: Buffer; cert: Buffer } | undefined;
if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) tls = readCertPair(certPath, keyPath);
else if (config.env === 'production') throw new Error('SMTP needs a certificate: set SMTP_TLS_CERT/SMTP_TLS_KEY or ACME_ENABLED=1');
else log('no certificate configured: using smtp-server\'s built-in self-signed certificate (development only)');

const listen: SmtpListen[] = [
  ...config.smtpPortsTls.map((port) => ({ port, implicitTls: true })),
  ...config.smtpPortsStartTls.map((port) => ({ port, implicitTls: false })),
];
const handle = await startSmtp(ctx, { listen, tls });
log(`listening on ${handle.servers.map((s) => `${s.port}${s.listen.implicitTls ? '/tls' : '/starttls'}`).join(', ')} as ${config.smtpHostname}`);
const watcher = certPath && keyPath && tls ? watchCertFiles(certPath, keyPath, (p) => handle.updateTls(p), log) : null;

const shutdown = async () => {
  log('shutting down');
  watcher?.close();
  acme?.stop();
  await handle.close();
  await ctx.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
