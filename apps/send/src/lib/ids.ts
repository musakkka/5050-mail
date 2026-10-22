import { randomBytes, randomUUID } from 'node:crypto';

export const uuid = (): string => randomUUID();

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * KSUID-style id (27 base62 chars: 4-byte timestamp + 16 random bytes), the format
 * Svix/Resend use for `msg_…` and `atmpt_…`. Lexicographically sortable by time.
 */
export function ksuid(now = Date.now()): string {
  const buf = Buffer.alloc(20);
  buf.writeUInt32BE(Math.floor(now / 1000) - 1400000000, 0);
  randomBytes(16).copy(buf, 4);
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(27, '0');
}

export const msgId = () => `msg_${ksuid()}`;
export const attemptId = () => `atmpt_${ksuid()}`;

/** Random base62 string. */
export function randomToken(len: number): string {
  const bytes = randomBytes(len * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    const b = bytes[i]!;
    if (b < 248) out += B62[b % 62];
  }
  return out.length === len ? out : out + randomToken(len - out.length);
}
