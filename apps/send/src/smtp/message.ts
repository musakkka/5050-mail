/**
 * Raw RFC 5322 message (as received over SMTP) → the same JSON payload POST /emails takes.
 * Resend's SMTP behaviour: `Resend-Idempotency-Key` makes retries safe, other custom
 * headers (e.g. X-Entity-Ref-ID, List-Unsubscribe) pass through to the sent email.
 */
import PostalMime from 'postal-mime';
import type { SendInput } from '../services/emails.js';

/** Headers that become structured fields or are transport noise; never passed through. */
const STRUCTURAL = new Set([
  'from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'mime-version', 'content-type',
  'content-transfer-encoding', 'content-disposition', 'content-id', 'sender', 'return-path', 'received',
  'dkim-signature', 'x-google-dkim-signature', 'arc-seal', 'arc-message-signature', 'arc-authentication-results',
  'authentication-results', 'delivered-to', 'x-received', 'resend-idempotency-key', 'x-resend-tags', 'bcc',
]);

export interface ParsedSmtpMessage {
  payload: SendInput;
  idempotencyKey?: string;
  /** Stable JSON of the payload (minus Date/Message-ID), used for idempotency body matching. */
  fingerprint: string;
}

/** Original-case header lines of the top-level header block (unfolded). */
export function rawHeaders(raw: Buffer): { name: string; value: string }[] {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  const out: { name: string; value: string }[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += ' ' + line.trim();
    else {
      const i = line.indexOf(':');
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  return out;
}

type Addr = { name?: string; address?: string; group?: Addr[] };
const flat = (v: Addr[] | Addr | undefined): Addr[] => (!v ? [] : (Array.isArray(v) ? v : [v]).flatMap((a) => (a.group ? flat(a.group) : [a])));
const fmt = (a: Addr) => (a.name ? `${a.name.replace(/[<>"]/g, '')} <${a.address}>` : (a.address ?? ''));

/** Our extension (not a Resend feature): `X-Resend-Tags: name=value, name2=value2`. */
export function parseTagsHeader(v: string | undefined): { name: string; value: string }[] | undefined {
  if (!v) return undefined;
  const tags = v.split(/[,;]/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i > 0 ? { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() } : { name: p, value: '' };
  });
  return tags.length ? tags : undefined;
}

export async function smtpToPayload(raw: Buffer, envelopeFrom: string, envelopeTo: string[]): Promise<ParsedSmtpMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'base64' });
  const headers = rawHeaders(raw);
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value;

  const from = flat(parsed.from as Addr)[0];
  const to = flat(parsed.to as Addr[]).filter((a) => a.address).map(fmt);
  const cc = flat(parsed.cc as Addr[]).filter((a) => a.address).map(fmt);
  const replyTo = flat(parsed.replyTo as Addr[]).filter((a) => a.address).map(fmt);
  const visible = new Set([...flat(parsed.to as Addr[]), ...flat(parsed.cc as Addr[])].map((a) => (a.address ?? '').toLowerCase()));
  // Bcc never appears in the headers we receive: it is every envelope recipient not in To/Cc.
  const bcc = envelopeTo.filter((r) => !visible.has(r.toLowerCase()));

  const custom: Record<string, string> = {};
  for (const h of headers) {
    const k = h.name.toLowerCase();
    if (STRUCTURAL.has(k) || k.startsWith('content-')) continue;
    if (!(h.name in custom)) custom[h.name] = h.value;
  }

  const attachments = parsed.attachments.map((a) => ({
    filename: a.filename ?? undefined,
    content: a.content as string,
    content_type: a.mimeType || undefined,
    ...(a.contentId && (a.disposition === 'inline' || a.related) ? { content_id: a.contentId.replace(/^<|>$/g, '') } : {}),
  }));

  const payload: SendInput = {
    from: from?.address ? fmt(from) : envelopeFrom,
    to: to.length ? to : bcc.splice(0, bcc.length),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(replyTo.length ? { reply_to: replyTo } : {}),
    subject: parsed.subject ?? '',
    ...(parsed.html ? { html: parsed.html } : {}),
    // An explicit empty text means "no text part" (no auto-generation from html).
    text: parsed.text ?? '',
    ...(Object.keys(custom).length ? { headers: custom } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  const tags = parseTagsHeader(get('x-resend-tags'));
  if (tags) payload.tags = tags;
  const key = get('resend-idempotency-key');
  return { payload, ...(key !== undefined ? { idempotencyKey: key } : {}), fingerprint: JSON.stringify(payload) };
}
