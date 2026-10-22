/** CIDR matching for trusted reverse proxies (IPv4, IPv6, IPv4-mapped IPv6). */
import { isIP } from 'node:net';

function v4ToBig(ip: string): bigint {
  return ip.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

function v6ToBig(ip: string): bigint {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToBig(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

/** Normalise to [family, value]; IPv4-mapped IPv6 becomes IPv4. */
function parse(ip: string): [4 | 6, bigint] | null {
  const bare = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return [4, v4ToBig(mapped[1]!)];
  const fam = isIP(bare.replace(/%.*$/, ''));
  if (fam === 4) return [4, v4ToBig(bare)];
  if (fam === 6) return [6, v6ToBig(bare)];
  return null;
}

export interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

export function parseCidr(s: string): Cidr {
  const [addr, len] = s.trim().split('/');
  const p = parse(addr ?? '');
  if (!p) throw new Error(`invalid address in CIDR "${s}"`);
  const max = p[0] === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`invalid prefix length in CIDR "${s}"`);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { family: p[0], base: p[1] & mask, bits };
}

export function inCidrs(ip: string | undefined, cidrs: Cidr[]): boolean {
  if (!ip) return false;
  const p = parse(ip);
  if (!p) return false;
  return cidrs.some((c) => {
    if (c.family !== p[0]) return false;
    const max = c.family === 4 ? 32 : 128;
    const mask = c.bits === 0 ? 0n : ((1n << BigInt(c.bits)) - 1n) << BigInt(max - c.bits);
    return (p[1] & mask) === c.base;
  });
}
