/** Composing: reply/forward prefill, quoting, building JMAP Email objects. */
import type { Email, EmailAddress, EmailCreate, Id, Identity } from '../jmap/types';
import { escapeHtml, formatAddress, stripSubjectPrefix } from '../lib/format';
import { KW } from './mapping';
import { htmlToText, sanitizeForCompose } from './sanitize';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface Recipient {
  name: string;
  email: string;
}

export interface ComposeAttachment {
  /** Local key. */
  key: string;
  name: string;
  type: string;
  size: number;
  blobId?: Id;
  /** 0..1 while uploading. */
  progress?: number;
  error?: string;
  /** Inline image content id (for pasted/inserted images). */
  cid?: string;
  /** Object URL shown in the editor for inline images (replaced by cid: on save). */
  previewUrl?: string;
}

export interface ComposeDraft {
  mode: ComposeMode;
  identityId?: Id;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  /** Editor HTML (the user's part, without the quoted original). */
  html: string;
  /** Quoted original / forwarded block (HTML), kept separate so it can be hidden behind "•••". */
  quotedHtml: string;
  attachments: ComposeAttachment[];
  inReplyTo: string[] | null;
  references: string[] | null;
  threadId?: Id;
  /** Email being replied to / forwarded. */
  sourceEmailId?: Id;
  /** Id of the saved draft on the server, if any. */
  draftEmailId?: Id;
}

export const EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
/** Same, but also accepts single-label hosts such as `localhost` (dev / intranet). */
export const LOOSE_EMAIL_RE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+$/;

export function isValidEmail(s: string): boolean {
  return LOOSE_EMAIL_RE.test(s.trim());
}

/** Parse pasted text "Alice <a@x>, b@y; "Carol, C" <c@z>" into recipients. */
export function parseRecipients(text: string): Recipient[] {
  const out: Recipient[] = [];
  const re = /\s*(?:"([^"]*)"\s*<([^>]+)>|([^<,;]*?)\s*<([^>]+)>|([^,;\s]+))\s*[,;]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) {
    const name = (m[1] ?? m[3] ?? '').trim();
    const email = (m[2] ?? m[4] ?? m[5] ?? '').trim();
    if (email) out.push({ name, email });
  }
  return out;
}

const lc = (s: string) => s.toLowerCase();

function uniq(list: Recipient[], exclude: Set<string>): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of list) {
    const k = lc(r.email);
    if (seen.has(k) || exclude.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

const toRecipients = (a: EmailAddress[] | null | undefined): Recipient[] => (a ?? []).map((x) => ({ name: x.name ?? '', email: x.email }));

export function quoteHeader(e: Email): string {
  const d = new Date(e.sentAt ?? e.receivedAt);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const from = e.from?.[0];
  const who = from ? `${escapeHtml(from.name || from.email)} &lt;<a href="mailto:${escapeHtml(from.email)}">${escapeHtml(from.email)}</a>&gt;` : 'someone';
  return `On ${date} at ${time} ${who} wrote:`;
}

/** The original message body as HTML (sanitized, for quoting). */
export function bodyHtmlOf(e: Email): string {
  const html = e.htmlBody?.find((p) => p.type === 'text/html' && p.partId && e.bodyValues?.[p.partId]);
  if (html?.partId) return sanitizeForCompose(e.bodyValues![html.partId]!.value);
  const parts = (e.textBody ?? []).filter((p) => p.partId && e.bodyValues?.[p.partId]);
  const text = parts.map((p) => e.bodyValues![p.partId!]!.value).join('\n');
  return `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

export function buildQuote(e: Email): string {
  return `<div class="ff_quote"><div dir="ltr" class="ff_attr">${quoteHeader(e)}<br></div><blockquote class="ff_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${bodyHtmlOf(e)}</blockquote></div>`;
}

export function buildForwardBlock(e: Email): string {
  const from = e.from?.[0];
  const line = (label: string, v: string) => (v ? `${label}: ${v}<br>` : '');
  const addrs = (a: EmailAddress[] | null) =>
    (a ?? [])
      .map((x) => (x.name ? `${escapeHtml(x.name)} &lt;<a href="mailto:${escapeHtml(x.email)}">${escapeHtml(x.email)}</a>&gt;` : escapeHtml(x.email)))
      .join(', ');
  const d = new Date(e.sentAt ?? e.receivedAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    `<div class="ff_quote"><div dir="ltr" class="ff_attr">---------- Forwarded message ---------<br>` +
    `From: <strong>${escapeHtml(from?.name || '')}</strong> &lt;${escapeHtml(from?.email ?? '')}&gt;<br>` +
    line('Date', escapeHtml(d)) +
    line('Subject', escapeHtml(e.subject ?? '')) +
    line('To', addrs(e.to)) +
    line('Cc', addrs(e.cc)) +
    `</div><br><br>${bodyHtmlOf(e)}</div>`
  );
}

/** Prefill a reply / reply-all / forward from the source email. */
export function prefill(mode: Exclude<ComposeMode, 'new'>, src: Email, myEmails: Set<string>, identities: Identity[]): Partial<ComposeDraft> {
  const subjectBase = stripSubjectPrefix(src.subject ?? '');
  const refs = [...(src.references ?? src.inReplyTo ?? []), ...(src.messageId ?? [])];
  const references = refs.length ? [...new Set(refs)] : null;
  const fromMe = src.from?.some((f) => myEmails.has(lc(f.email)));
  // Reply from the identity the message was addressed to.
  const addressed = [...(src.to ?? []), ...(src.cc ?? []), ...(src.from ?? [])].map((a) => lc(a.email));
  const identity = identities.find((i) => addressed.includes(lc(i.email))) ?? identities[0];

  if (mode === 'forward') {
    return {
      mode,
      identityId: identity?.id,
      subject: `Fwd: ${subjectBase}`,
      quotedHtml: buildForwardBlock(src),
      references,
      inReplyTo: null,
      threadId: src.threadId,
      sourceEmailId: src.id,
      attachments: (src.attachments ?? [])
        .filter((a) => a.blobId && !(a.disposition === 'inline' && a.cid))
        .map((a, i) => ({ key: `fwd${i}`, name: a.name ?? 'attachment', type: a.type, size: a.size, blobId: a.blobId! })),
    };
  }

  let to: Recipient[];
  let cc: Recipient[] = [];
  if (fromMe) {
    to = toRecipients(src.to);
    if (mode === 'replyAll') cc = toRecipients(src.cc);
  } else {
    to = toRecipients(src.replyTo?.length ? src.replyTo : src.from);
    if (mode === 'replyAll') {
      to = [...to, ...toRecipients(src.to)];
      cc = toRecipients(src.cc);
    }
  }
  const exclude = new Set(fromMe ? [] : myEmails);
  to = uniq(to, mode === 'replyAll' ? exclude : new Set());
  const toSet = new Set(to.map((r) => lc(r.email)));
  cc = uniq(cc, new Set([...exclude, ...toSet]));
  return {
    mode,
    identityId: identity?.id,
    to,
    cc,
    subject: /^re:/i.test(src.subject ?? '') ? (src.subject ?? '') : `Re: ${subjectBase}`,
    quotedHtml: buildQuote(src),
    inReplyTo: src.messageId ?? null,
    references,
    threadId: src.threadId,
    sourceEmailId: src.id,
  };
}

/** Does the reply-all set differ from reply? (show "Reply all" only when > 1 recipient). */
export function hasMultipleRecipients(src: Email, myEmails: Set<string>): boolean {
  const all = [...(src.from ?? []), ...(src.to ?? []), ...(src.cc ?? [])].map((a) => lc(a.email)).filter((e) => !myEmails.has(e));
  return new Set(all).size > 1;
}

export function fullHtml(d: Pick<ComposeDraft, 'html' | 'quotedHtml'>): string {
  const body = `<div dir="ltr">${d.html}</div>`;
  return d.quotedHtml ? `${body}<br>${d.quotedHtml}` : body;
}

export function isDraftEmpty(d: ComposeDraft): boolean {
  return !d.to.length && !d.cc.length && !d.bcc.length && !d.subject.trim() && !htmlToText(d.html).trim() && !d.attachments.length;
}

/** Build the Email/set create object for a draft or message to send. */
export function buildEmail(d: ComposeDraft, identity: Identity | undefined, mailboxIds: Record<Id, boolean>, opts: { draft: boolean }): EmailCreate {
  const html = fullHtml(d);
  const text = htmlToText(html);
  const addr = (r: Recipient[]): EmailAddress[] => r.map((x) => ({ name: x.name || null, email: x.email.trim() }));
  const files = d.attachments.filter((a) => a.blobId);
  const email: EmailCreate = {
    mailboxIds,
    keywords: opts.draft ? { [KW.draft]: true, [KW.seen]: true } : { [KW.seen]: true },
    from: identity ? [{ name: identity.name || null, email: identity.email }] : undefined,
    to: addr(d.to),
    cc: d.cc.length ? addr(d.cc) : undefined,
    bcc: d.bcc.length ? addr(d.bcc) : undefined,
    subject: d.subject,
    inReplyTo: d.inReplyTo,
    references: d.references,
    bodyValues: { text: { value: text }, html: { value: html } },
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    attachments: files.map((a) => ({
      blobId: a.blobId!,
      type: a.type || 'application/octet-stream',
      name: a.name,
      disposition: a.cid ? 'inline' : 'attachment',
      ...(a.cid ? { cid: a.cid } : {}),
    })),
  };
  if (identity?.replyTo?.length) email.replyTo = identity.replyTo;
  if (!email.cc) delete email.cc;
  if (!email.bcc) delete email.bcc;
  if (!email.from) delete email.from;
  return email;
}

/** Envelope for EmailSubmission (all To/Cc/Bcc, deduped). */
export function envelopeFor(d: ComposeDraft, identity: Identity, holdParam?: { HOLDFOR?: string; HOLDUNTIL?: string }) {
  const rcpts = [...new Set([...d.to, ...d.cc, ...d.bcc].map((r) => r.email.trim().toLowerCase()))];
  return {
    mailFrom: { email: identity.email, parameters: holdParam && Object.keys(holdParam).length ? holdParam : null },
    rcptTo: rcpts.map((email) => ({ email, parameters: null })),
  };
}

/** Restore a compose state from a saved draft email (Drafts view / undo send). */
export function draftFromEmail(e: Email, identities: Identity[]): ComposeDraft {
  const html = bodyHtmlOf(e);
  // Split off our own quote block so it goes back behind "•••".
  const idx = html.indexOf('<div class="ff_quote">');
  const own = idx >= 0 ? html.slice(0, idx) : html;
  const quoted = idx >= 0 ? html.slice(idx) : '';
  const fromEmail = e.from?.[0]?.email?.toLowerCase();
  return {
    mode: e.inReplyTo?.length ? 'reply' : 'new',
    identityId: identities.find((i) => i.email.toLowerCase() === fromEmail)?.id ?? identities[0]?.id,
    to: toRecipients(e.to),
    cc: toRecipients(e.cc),
    bcc: toRecipients(e.bcc),
    subject: e.subject ?? '',
    html: own.replace(/^<div dir="ltr">([\s\S]*)<\/div>(<br>)?$/, '$1'),
    quotedHtml: quoted,
    attachments: (e.attachments ?? [])
      .filter((a) => a.blobId)
      .map((a, i) => ({ key: `d${i}`, name: a.name ?? 'attachment', type: a.type, size: a.size, blobId: a.blobId!, cid: a.cid ?? undefined })),
    inReplyTo: e.inReplyTo,
    references: e.references,
    threadId: e.threadId,
    draftEmailId: e.id,
  };
}

export function recipientLabel(r: Recipient): string {
  return r.name || r.email;
}

export { formatAddress };
