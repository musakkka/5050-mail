import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Self-signed certificate via the openssl CLI (tests only). */
export function selfSigned(cn = 'smtp.test', days = 90, dir = mkdtempSync(path.join(tmpdir(), 'send-cert-'))) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', String(days), '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { dir, keyPath: key, certPath: cert, key: readFileSync(key), cert: readFileSync(cert) };
}

/** Sign a CSR with a throwaway CA (fake ACME CA in tests): the cert carries the CSR's key. */
export function signCsr(csrPem: string | Buffer, days = 90): string {
  const ca = selfSigned('Fake ACME CA', 365);
  const csr = path.join(ca.dir, 'req.csr');
  const out = path.join(ca.dir, 'leaf.pem');
  writeFileSync(csr, csrPem);
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', ca.certPath, '-CAkey', ca.keyPath, '-CAcreateserial', '-days', String(days), '-out', out], { stdio: 'ignore' });
  return readFileSync(out, 'utf8');
}
