/**
 * Optional built-in ACME (Let's Encrypt) issuer for smtp.example.com using DNS-01
 * through the Cloudflare DNS API (ACME_ENABLED=1). State in ACME_STATE_DIR:
 * account.key, key.pem, cert.pem. Renews when < 30 days remain; files are replaced
 * atomically so the cert watcher (tls.ts) hot-reloads the relay.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as acme from 'acme-client';
import type { CloudflareClient } from '../cloudflare/client.js';
import { certExpiry } from './tls.js';

export type AcmeClientLike = Pick<acme.Client, 'auto'>;
export type AcmeClientFactory = (opts: { directoryUrl: string; accountKey: Buffer }) => AcmeClientLike;

export interface AcmeOptions {
  host: string;
  email?: string;
  directoryUrl: string;
  stateDir: string;
  renewBeforeDays?: number;
  cf: CloudflareClient;
  clientFactory?: AcmeClientFactory;
  now?: () => Date;
  log?: (m: string) => void;
}

export const acmePaths = (dir: string) => ({ account: path.join(dir, 'account.key'), key: path.join(dir, 'key.pem'), cert: path.join(dir, 'cert.pem') });

const writeAtomic = (file: string, data: string | Buffer, mode = 0o600) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
};

export function needsRenewal(certFile: string, now: Date, renewBeforeDays = 30): boolean {
  if (!existsSync(certFile)) return true;
  try {
    return certExpiry(readFileSync(certFile)).getTime() - now.getTime() < renewBeforeDays * 86400_000;
  } catch {
    return true;
  }
}

/** Issue or renew if needed. Returns true when a new certificate was written. */
export async function ensureCertificate(o: AcmeOptions): Promise<boolean> {
  const log = o.log ?? (() => {});
  const now = (o.now ?? (() => new Date()))();
  const p = acmePaths(o.stateDir);
  if (!needsRenewal(p.cert, now, o.renewBeforeDays)) return false;
  mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  let accountKey: Buffer;
  if (existsSync(p.account)) accountKey = readFileSync(p.account);
  else {
    accountKey = await acme.crypto.createPrivateKey();
    writeAtomic(p.account, accountKey);
  }
  const client = (o.clientFactory ?? ((x) => new acme.Client(x)))({ directoryUrl: o.directoryUrl, accountKey });
  const [key, csr] = await acme.crypto.createCsr({ commonName: o.host });
  const created = new Map<string, { zoneId: string; id: string }>();
  const cert = await client.auto({
    csr,
    email: o.email,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      if (challenge.type !== 'dns-01') throw new Error(`unsupported challenge ${challenge.type}`);
      const name = `_acme-challenge.${authz.identifier.value}`;
      const zone = await o.cf.findZone(authz.identifier.value);
      if (!zone) throw new Error(`No Cloudflare zone for ${authz.identifier.value}`);
      const rec = await o.cf.createDnsRecord(zone.id, { type: 'TXT', name, content: `"${keyAuthorization}"` }, '5050 Send SMTP ACME challenge');
      created.set(`${name}|${keyAuthorization}`, { zoneId: zone.id, id: rec.id ?? '' });
      log(`acme: published ${name}`);
    },
    challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
      const name = `_acme-challenge.${authz.identifier.value}`;
      const r = created.get(`${name}|${keyAuthorization}`);
      if (r?.id) await o.cf.deleteDnsRecord(r.zoneId, r.id).catch((e) => log(`acme: cleanup of ${name} failed: ${(e as Error).message}`));
    },
  });
  writeAtomic(p.key, key);
  writeAtomic(p.cert, cert, 0o644);
  log(`acme: certificate for ${o.host} written (expires ${certExpiry(cert).toISOString()})`);
  return true;
}

/** Check now and then twice a day. */
export function startAcme(o: AcmeOptions, onError: (e: Error) => void): { stop(): void; ready: Promise<boolean> } {
  const run = () => ensureCertificate(o).catch((e) => {
    onError(e as Error);
    return false;
  });
  const ready = run();
  const t = setInterval(run, 12 * 3600_000);
  t.unref();
  return { ready, stop: () => clearInterval(t) };
}
