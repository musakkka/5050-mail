/**
 * Self-hosted domains (TRANSPORT=smtp): no Cloudflare Email Sending. Each domain
 * gets its own DKIM key (generated here, private half encrypted at rest), and
 * 5050 Send signs outgoing mail itself before handing it to the local mail
 * server, which then delivers it. The domain is never added to the mail server
 * as a local domain, so registering an unverified name can't hijack its mail.
 *
 * Records: DKIM TXT `<selector>._domainkey`, SPF TXT on the apex authorising the
 * mail server's hostname, DMARC TXT. Verification checks public DNS.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { AppContext } from '../context.js';
import { decrypt, encrypt } from '../lib/crypto.js';

export const LOCAL_SELECTOR = 'send5050';

export const localDomainMode = (ctx: AppContext) => ctx.config.domainRecords === 'local';

/** Hostname that sends mail (SPF `a:` mechanism), from MAIL_HOSTNAME. */
export const mailHostname = () => (process.env.MAIL_HOSTNAME || `mail.${process.env.MAIL_DOMAIN || 'example.com'}`).toLowerCase();

export interface LocalKey {
  selector: string;
  publicKey: string;
}

/** Create the domain's DKIM key once; returns the selector and the base64 public key (DNS `p=`). */
export async function ensureDkimKey(ctx: AppContext, domainId: string): Promise<LocalKey> {
  const [row] = await ctx.sql`select dkim_selector, dkim_public_key from domains where id = ${domainId}`;
  if (row?.dkim_selector && row.dkim_public_key) return { selector: row.dkim_selector as string, publicKey: row.dkim_public_key as string };
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const [upd] = await ctx.sql`
    update domains set dkim_selector = coalesce(dkim_selector, ${LOCAL_SELECTOR}),
                       dkim_public_key = coalesce(dkim_public_key, ${pub}),
                       dkim_private_key = coalesce(dkim_private_key, ${encrypt(ctx.config.sessionSecret, priv)})
    where id = ${domainId} returning dkim_selector, dkim_public_key`;
  return { selector: upd!.dkim_selector as string, publicKey: upd!.dkim_public_key as string };
}

export const spfValue = () => `v=spf1 a:${mailHostname()} ~all`;

/** SPF passes when any SPF record on the apex authorises the mail host (a:host, include:host, or mx when MX points at it). */
export function spfAuthorises(values: string[]): boolean {
  const host = mailHostname();
  return values.some((v) => /^v=spf1\b/i.test(v) && (v.toLowerCase().includes(host) || /\s[+]?mx(\s|$)/i.test(v)));
}

/** Signing key for the sender's domain, when the domain belongs to a team and has a key. */
export async function signingKeyFor(ctx: AppContext, fromAddress: string): Promise<{ domainName: string; keySelector: string; privateKey: string } | null> {
  const domain = fromAddress.split('@').pop()?.toLowerCase();
  if (!domain) return null;
  const [row] = await ctx.sql`select name, dkim_selector, dkim_private_key from domains where lower(name) = ${domain} and dkim_private_key is not null limit 1`;
  if (!row) return null;
  const privateKey = decrypt(ctx.config.sessionSecret, row.dkim_private_key as string);
  return privateKey ? { domainName: row.name as string, keySelector: row.dkim_selector as string, privateKey } : null;
}
