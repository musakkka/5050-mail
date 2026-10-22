import { describe, expect, it } from 'vitest';
import { inCidrs, parseCidr } from '../src/net';

describe('CIDR matching', () => {
  const list = ['127.0.0.0/8', '::1/128', '10.20.1.4/32', 'fd00::/8'].map(parseCidr);
  it('matches IPv4, IPv6 and IPv4-mapped IPv6 peers', () => {
    expect(inCidrs('127.0.0.1', list)).toBe(true);
    expect(inCidrs('::ffff:127.0.0.1', list)).toBe(true);
    expect(inCidrs('::1', list)).toBe(true);
    expect(inCidrs('10.20.1.4', list)).toBe(true);
    expect(inCidrs('fd12:3456::1', list)).toBe(true);
    for (const ip of ['10.20.1.5', '128.0.0.1', '::2', 'fe80::1', 'unknown', undefined, '']) expect(inCidrs(ip, list)).toBe(false);
  });
  it('rejects malformed CIDRs', () => {
    for (const bad of ['10.0.0.0/33', 'nope', '::/129', '1.2.3/8']) expect(() => parseCidr(bad)).toThrow();
  });
});
