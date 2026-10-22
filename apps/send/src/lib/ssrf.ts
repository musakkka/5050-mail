/**
 * SSRF-safe outbound HTTP for webhook delivery and attachment `path` fetches.
 * The DNS answer is checked and the connection is pinned to the checked address
 * (no TOCTOU between validation and connect), redirects are not followed.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export class SsrfError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]!);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(s)) return true; // hex-mapped v4: be conservative
    const first = parseInt(s.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8') || s.startsWith('100:')) return true;
    return false;
  }
  return true;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  truncated: boolean;
}

export interface SafeRequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export function safeRequest(url: string, opts: SafeRequestOpts = {}): Promise<SafeResponse> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new SsrfError('Invalid URL'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.reject(new SsrfError('Only http and https URLs are allowed'));
  if (u.username || u.password) return Promise.reject(new SsrfError('URLs with credentials are not allowed'));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && net.isIP(host) && isPrivateIp(host)) return Promise.reject(new SsrfError('Destination address is not allowed'));

  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return (cb as (e: Error | null, a: string, f: number) => void)(err, '', 0);
      const list = addrs as dns.LookupAddress[];
      const ok = list.filter((a) => opts.allowPrivate || !isPrivateIp(a.address));
      if (!ok.length || ok.length !== list.length) {
        return (cb as (e: Error | null, a: string, f: number) => void)(new SsrfError('Destination address is not allowed'), '', 0);
      }
      const pick = ok[0]!;
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [pick]);
      else (cb as (e: null, a: string, f: number) => void)(null, pick.address, pick.family);
    });
  };

  const mod = u.protocol === 'https:' ? https : http;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        lookup,
        timeout: opts.timeoutMs ?? 15_000,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
        res.on('error', (e) => (truncated ? undefined : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
