import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // keep timing roughly constant
    return false;
  }
  return timingSafeEqual(x, y);
}

const key = (secret: string, purpose: string) => createHmac('sha256', secret).update(`5050-send:${purpose}`).digest();

/** Compact signed token: base64url(JSON payload) + "." + base64url(HMAC-SHA256)[0..22]. */
export function signToken(secret: string, purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', key(secret, purpose)).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}

export function verifyToken<T>(secret: string, purpose: string, token: string): T | null {
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const want = createHmac('sha256', key(secret, purpose)).update(body).digest('base64url').slice(0, 22);
  if (!safeEqual(sig, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** AES-256-GCM for small secrets at rest (e.g. the dashboard session's Stalwart credential). */
export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret, 'enc'), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decrypt(secret: string, blob: string): string | null {
  try {
    const b = Buffer.from(blob, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(secret, 'enc'), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
