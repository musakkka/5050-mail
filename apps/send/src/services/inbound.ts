/**
 * Receiving: raw MIME in → received_emails + attachments → `email.received` webhook.
 * Fed by POST /inbound (relay push) or the JMAP poller (Stalwart catch-all mailbox).
 */
import PostalMime from 'postal-mime';
import type { AppContext } from '../context.js';
import { pgToIso } from '../db.js';
import { domainOf } from '../lib/address.js';
import { emit } from './webhooks.js';
import { deliverInboundToInboxes } from './inboxes.js';

export interface IngestResult {
  ids: string[];
  /** Recipients for which no receiving domain matched. */
  unmatched: string[];
}

const addrList = (v: { address?: string; group?: { address?: string }[] }[] | undefined): string[] =>
  (v ?? []).flatMap((a) => (a.group ? a.group.map((g) => g.address ?? '') : [a.address ?? ''])).filter(Boolean);

/** `for` clauses of Received headers. */
function receivedFor(headers: { key: string; value: string }[]): string[] {
  const out: string[] = [];
  for (const h of headers) {
    if (h.key !== 'received') continue;
    const m = /\bfor\s+<?([^\s<>;]+@[^\s<>;]+)>?/i.exec(h.value);
    if (m) out.push(m[1]!);
  }
  return [...new Set(out)];
}

export async function ingestRaw(ctx: AppContext, raw: Buffer, envelopeTo?: string[]): Promise<IngestResult> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const to = addrList(parsed.to as never);
  const cc = addrList(parsed.cc as never);
  const bcc = addrList(parsed.bcc as never);
  const rcpts = envelopeTo?.length ? envelopeTo : [...to, ...cc, ...bcc];
  // One received email per team whose receiving domain matches a recipient.
  const byTeam = new Map<string, { domainId: string; rcpts: string[] }>();
  const unmatched: string[] = [];
  for (const r of rcpts) {
    const dom = domainOf(r);
    const [d] = await ctx.sql`
      select id, team_id from domains
      where receiving = 'enabled' and (lower(name) = ${dom} or ${dom} like '%.' || lower(name))
        -- only once the receiving MX has been verified (an unverified registration must not capture mail)
        and (status = 'verified' or exists (select 1 from jsonb_array_elements(records) r where r->>'record' = 'Receiving' and r->>'status' = 'verified'))
      order by length(name) desc limit 1`;
    if (!d) {
      unmatched.push(r);
      continue;
    }
    const g = byTeam.get(d.team_id as string) ?? { domainId: d.id as string, rcpts: [] };
    g.rcpts.push(r);
    byTeam.set(d.team_id as string, g);
  }
  const headers: Record<string, string> = {};
  for (const h of parsed.headers) if (!(h.key in headers)) headers[h.key] = h.value;
  const from = parsed.from?.address ?? '';
  const replyTo = addrList(parsed.replyTo as never);
  const forList = receivedFor(parsed.headers);
  const ids: string[] = [];
  for (const [teamId, g] of byTeam) {
    const [row] = await ctx.sql`
      insert into received_emails (team_id, domain_id, from_addr, to_addrs, cc, bcc, reply_to, received_for, subject, html, text, headers, message_id, raw)
      values (${teamId}, ${g.domainId}, ${from}, ${to.length ? to : g.rcpts}, ${cc}, ${bcc}, ${replyTo}, ${forList.length ? forList : g.rcpts},
              ${parsed.subject ?? ''}, ${parsed.html ?? null}, ${parsed.text ?? null}, ${ctx.sql.json(headers)}, ${parsed.messageId ?? ''}, ${raw})
      returning id, created_at`;
    const id = row!.id as string;
    const atts = [];
    for (const a of parsed.attachments) {
      const content = Buffer.from(a.content as ArrayBuffer);
      const [ar] = await ctx.sql`
        insert into received_attachments (email_id, team_id, filename, content_type, content_id, disposition, size, content)
        values (${id}, ${teamId}, ${a.filename ?? null}, ${a.mimeType || 'application/octet-stream'}, ${a.contentId ? a.contentId.replace(/^<|>$/g, '') : null},
                ${a.disposition ?? null}, ${content.length}, ${content})
        returning id, filename, content_type, content_id, disposition`;
      atts.push({ id: ar!.id, filename: ar!.filename ?? null, content_type: ar!.content_type, content_disposition: ar!.disposition ?? null, content_id: ar!.content_id ?? null });
    }
    ids.push(id);
    await emit(ctx, teamId, 'email.received', {
      email_id: id,
      created_at: pgToIso(row!.created_at as string),
      from,
      to: to.length ? to : g.rcpts,
      bcc,
      cc,
      received_for: forList.length ? forList : g.rcpts,
      message_id: parsed.messageId ?? '',
      subject: parsed.subject ?? '',
      attachments: atts,
    });
    const p = parsed as unknown as { inReplyTo?: string; references?: string };
    await deliverInboundToInboxes(ctx, teamId, id, g.rcpts, {
      from: parsed.from?.name ? `${parsed.from.name} <${from}>` : from,
      to, cc, replyTo, subject: parsed.subject ?? '', messageId: parsed.messageId ?? '',
      inReplyTo: p.inReplyTo?.trim() || null,
      references: (p.references ?? '').split(/\s+/).filter(Boolean),
      html: parsed.html ?? null, text: parsed.text ?? null,
    });
    await ctx.sql`select pg_notify('send_inbound', ${teamId})`;
  }
  return { ids, unmatched };
}

/** Inline images as data: URIs (Resend's default `html_format=data_uri`). */
export function inlineCidImages(html: string, atts: { content_id: string | null; content_type: string; content: Buffer | null }[]): string {
  return html.replace(/(["'])cid:([^"']+)\1/gi, (m, q: string, cid: string) => {
    const a = atts.find((x) => x.content_id && x.content_id === cid);
    return a?.content ? `${q}data:${a.content_type};base64,${a.content.toString('base64')}${q}` : m;
  });
}
