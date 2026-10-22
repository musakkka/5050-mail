/** MIME assembly (nodemailer MailComposer) plus open-pixel and click-rewrite tracking. */
import MailComposer from 'nodemailer/lib/mail-composer';
import { signToken } from '../lib/crypto.js';
import { mailbox } from '../lib/address.js';

export interface MimeAttachment {
  filename?: string | null;
  content: Buffer;
  contentType: string;
  contentId?: string | null;
  disposition: 'inline' | 'attachment';
}

export interface MimeInput {
  messageId: string;
  from: string;
  to: string[];
  cc?: string[] | null;
  replyTo?: string[] | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string> | null;
  attachments?: MimeAttachment[];
  date?: Date;
  listUnsubscribe?: string | null;
}

/** Headers that callers may not override through `headers` (they're set from the structured fields). */
const RESERVED = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding', 'reply-to', 'sender', 'return-path']);

export function filterCustomHeaders(h: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (RESERVED.has(k.toLowerCase())) continue;
    out[k] = String(v).replace(/[\r\n]+/g, ' ');
  }
  return out;
}

export async function buildMime(m: MimeInput): Promise<Buffer> {
  const headers: Record<string, string> = filterCustomHeaders(m.headers);
  if (m.listUnsubscribe) {
    headers['List-Unsubscribe'] = `<${m.listUnsubscribe}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const mc = new MailComposer({
    messageId: m.messageId,
    date: m.date ?? new Date(),
    from: mailbox(m.from),
    to: m.to.map(mailbox),
    ...(m.cc?.length ? { cc: m.cc.map(mailbox) } : {}),
    ...(m.replyTo?.length ? { replyTo: m.replyTo.map(mailbox) } : {}),
    subject: m.subject,
    ...(m.html ? { html: m.html } : {}),
    ...(m.text ? { text: m.text } : {}),
    headers,
    attachments: (m.attachments ?? []).map((a) => ({
      filename: a.filename ?? undefined,
      content: a.content,
      contentType: a.contentType,
      ...(a.contentId ? { cid: a.contentId } : {}),
      contentDisposition: a.disposition,
    })),
  });
  return mc.compile().build();
}

export interface TrackingOpts {
  secret: string;
  base: string;
  emailId: string;
  opens: boolean;
  clicks: boolean;
}

export const openToken = (secret: string, emailId: string) => signToken(secret, 'open', { e: emailId });
export const clickToken = (secret: string, emailId: string, url: string) => signToken(secret, 'click', { e: emailId, u: url });

/** Rewrite http(s) links through the click redirect and add the open pixel. */
export function applyTracking(html: string, t: TrackingOpts): string {
  let out = html;
  if (t.clicks) {
    out = out.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])(.*?)\2/gi, (m, pre: string, q: string, href: string) => {
      const raw = href.trim().replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(raw)) return m;
      if (raw.startsWith(t.base)) return m; // already ours (e.g. unsubscribe links)
      return `${pre}${q}${t.base}/t/c/${clickToken(t.secret, t.emailId, raw)}${q}`;
    });
  }
  if (t.opens) {
    const pixel = `<img src="${t.base}/t/o/${openToken(t.secret, t.emailId)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  }
  return out;
}
