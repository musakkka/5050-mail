import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { startTestServer, type TestServer } from '../helpers.js';
import { startSmtp, type SmtpHandle } from '../../src/smtp/server.js';
import { readCertPair, watchCertFiles } from '../../src/smtp/tls.js';
import { acmePaths, ensureCertificate, needsRenewal, type AcmeClientFactory } from '../../src/smtp/acme.js';
import { selfSigned, signCsr } from './certs.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(() => t.close());

/** Certificate subject CN presented on an implicit-TLS port. */
const peerCn = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'smtp.test' }, () => {
      const cn = s.getPeerCertificate().subject?.CN as string;
      s.end();
      resolve(cn);
    });
    s.on('error', reject);
  });

const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
};

describe('SMTP TLS certificates', () => {
  it('hot-reloads cert files when they change', async () => {
    const a = selfSigned('first.test');
    const b = selfSigned('second.test');
    const pair = readCertPair(a.certPath, a.keyPath);
    const smtp: SmtpHandle = await startSmtp(t.ctx, { listen: [{ port: 0, implicitTls: true, host: '127.0.0.1' }], tls: pair });
    const port = smtp.servers[0]!.port;
    const w = watchCertFiles(a.certPath, a.keyPath, (p) => smtp.updateTls(p));
    try {
      expect(await peerCn(port)).toBe('first.test');
      copyFileSync(b.keyPath, a.keyPath);
      copyFileSync(b.certPath, a.certPath);
      await waitFor(async () => (await peerCn(port)) === 'second.test');
    } finally {
      w.close();
      await smtp.close();
    }
  });

  it('issues via ACME DNS-01 on Cloudflare and renews 30 days before expiry', async () => {
    const zone = t.ctx.cfFake!.zones.find((z) => z.name === 'cfzone.test')!;
    const seen: string[] = [];
    let issued = 0;
    // Fake ACME CA: runs the challenge hooks like acme-client's auto() and returns a cert.
    const factory: AcmeClientFactory = () => ({
      auto: async (opts) => {
        const authz = { identifier: { type: 'dns', value: 'smtp.cfzone.test' } } as never;
        const challenge = { type: 'dns-01', token: 'tok', url: 'x', status: 'pending' } as never;
        await opts.challengeCreateFn!(authz, challenge, 'key-auth-123');
        seen.push(...zone.records.filter((r) => r.name === '_acme-challenge.smtp.cfzone.test').map((r) => r.content));
        await opts.challengeRemoveFn!(authz, challenge, 'key-auth-123');
        issued++;
        return signCsr(opts.csr, issued === 1 ? 20 : 90);
      },
    });
    const dir = selfSigned('unused').dir + '/acme';
    const o = { host: 'smtp.cfzone.test', directoryUrl: 'https://acme.invalid/dir', stateDir: dir, cf: t.ctx.cf!.cf, clientFactory: factory };
    expect(await ensureCertificate(o)).toBe(true);
    expect(seen).toEqual(['"key-auth-123"']);
    expect(zone.records.some((r) => r.name.startsWith('_acme-challenge'))).toBe(false); // cleaned up
    const p = acmePaths(dir);
    expect(existsSync(p.account) && existsSync(p.key) && existsSync(p.cert)).toBe(true);
    // 20-day cert → due for renewal; renewal writes a fresh 90-day cert.
    expect(needsRenewal(p.cert, new Date())).toBe(true);
    expect(await ensureCertificate(o)).toBe(true);
    expect(issued).toBe(2);
    const days = (new Date(new X509Certificate(readFileSync(p.cert)).validTo).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(80);
    expect(await ensureCertificate(o)).toBe(false);
    readCertPair(p.cert, p.key); // key and cert match
  });
});
