/** Certificate files for the SMTP relay, re-read when they change (certbot/ACME renewals). */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

export interface CertPair {
  key: Buffer;
  cert: Buffer;
}

export function readCertPair(certPath: string, keyPath: string): CertPair {
  const pair = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  tls.createSecureContext(pair); // throws on a mismatched/invalid pair
  return pair;
}

export function certExpiry(cert: string | Buffer): Date {
  const first = String(cert).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] ?? String(cert);
  return new Date(new X509Certificate(first).validTo);
}

/**
 * Watch the directories of the cert/key files (renewals usually replace files
 * atomically, which a file watch would miss) and call `onChange` with a validated pair.
 */
export function watchCertFiles(certPath: string, keyPath: string, onChange: (p: CertPair) => void, log: (m: string) => void = () => {}): { close(): void } {
  const dirs = [...new Set([path.dirname(certPath), path.dirname(keyPath)])];
  const names = new Set([path.basename(certPath), path.basename(keyPath)]);
  let timer: NodeJS.Timeout | null = null;
  let last = '';
  const reload = () => {
    try {
      const p = readCertPair(certPath, keyPath);
      const sig = p.cert.toString('base64').slice(-64) + p.key.length;
      if (sig === last) return;
      last = sig;
      onChange(p);
      log(`reloaded TLS certificate (expires ${certExpiry(p.cert).toISOString()})`);
    } catch (e) {
      log(`TLS reload skipped: ${(e as Error).message}`);
    }
  };
  try {
    const p = readCertPair(certPath, keyPath);
    last = p.cert.toString('base64').slice(-64) + p.key.length;
  } catch {
    /* initial load is the caller's job */
  }
  const watchers: FSWatcher[] = dirs.map((d) =>
    watch(d, (_ev, file) => {
      if (file && !names.has(String(file)) && !String(file).startsWith('..')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 200);
    }),
  );
  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
