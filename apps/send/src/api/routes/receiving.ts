import { pgToIso } from '../../db.js';
import { E } from '../../lib/errors.js';
import { signToken } from '../../lib/crypto.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { inlineCidImages } from '../../services/inbound.js';
import { query, teamId, uuidParam, type Router } from '../router.js';
import { attachmentObject } from './emails.js';

const attMeta = (a: Record<string, unknown>) => ({
  id: a.id,
  filename: a.filename ?? null,
  content_type: a.content_type,
  content_disposition: a.disposition ?? null,
  content_id: a.content_id ?? null,
  size: a.size,
});

const AUTH_RESULTS = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy'] as const;

/**
 * `{ spf, dkim, dmarc }` from the topmost Authentication-Results header (the one our receiving MTA
 * adds; deeper ones may have been forged by the sender). A method that was not evaluated is `none`.
 */
export function authenticationResults(headers: Record<string, string> | null | undefined) {
  const h = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'authentication-results')?.[1] ?? '';
  const pick = (method: string) => {
    const m = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, 'i').exec(h);
    const v = m?.[1]?.toLowerCase();
    return v && (AUTH_RESULTS as readonly string[]).includes(v) ? v : 'none';
  };
  return { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
}

export function registerReceivingRoutes(r: Router) {
  r.get('/emails/receiving', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'received_emails', ctx.sql`team_id = ${teamId(c)}`, page,
      ctx.sql`id, to_addrs, from_addr, subject, message_id, bcc, cc, reply_to, received_for, created_at`);
    const ids = rows.map((x) => x.id as string);
    const atts = ids.length ? await ctx.sql`select id, email_id, filename, content_type, content_id, disposition, size from received_attachments where email_id = any(${ids}) order by created_at, id` : [];
    return c.json(list(rows.map((e) => ({
      id: e.id, to: e.to_addrs, from: e.from_addr, created_at: pgToIso(e.created_at as string), subject: e.subject ?? null,
      bcc: e.bcc ?? null, cc: e.cc ?? null, reply_to: e.reply_to ?? null, received_for: e.received_for ?? [], message_id: e.message_id,
      attachments: atts.filter((a) => a.email_id === e.id).map(attMeta),
    })), hasMore));
  });

  r.get('/emails/receiving/:email_id', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'id');
    const [e] = await ctx.sql`select * from received_emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Email not found');
    const fmt = c.req.query('html_format') ?? 'data_uri';
    if (fmt !== 'data_uri' && fmt !== 'cid') throw E.validation('Invalid `html_format`. It must be `data_uri` or `cid`.');
    const atts = await ctx.sql`select id, filename, content_type, content_id, disposition, size, content from received_attachments where email_id = ${id} order by created_at, id`;
    let html = (e.html as string | null) ?? null;
    if (html && fmt === 'data_uri') html = inlineCidImages(html, atts as never);
    const exp = new Date(ctx.now().getTime() + 3600_000);
    const rawToken = signToken(ctx.config.sessionSecret, 'raw', { e: id, x: Math.floor(exp.getTime() / 1000) });
    return c.json({
      object: 'email', id: e.id, to: e.to_addrs, from: e.from_addr, created_at: pgToIso(e.created_at as string), subject: e.subject,
      html, html_format: fmt, text: e.text ?? null, headers: e.headers ?? null, bcc: e.bcc ?? [], cc: e.cc ?? [], reply_to: e.reply_to ?? [],
      received_for: e.received_for ?? [], authentication: authenticationResults(e.headers as Record<string, string> | null), message_id: e.message_id,
      raw: { download_url: `${ctx.config.publicApiBase}/receiving/raw/${rawToken}`, expires_at: exp.toISOString() },
      attachments: atts.map(attMeta),
    });
  });

  r.get('/emails/receiving/:email_id/attachments', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'email_id');
    const [e] = await ctx.sql`select id from received_emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Email not found');
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'received_attachments', ctx.sql`email_id = ${id} and team_id = ${teamId(c)}`, page,
      ctx.sql`id, filename, size, content_type, content_id, disposition, created_at`);
    return c.json(list(rows.map((a) => attachmentObject(ctx, 'received', a, false)), hasMore));
  });

  r.get('/emails/receiving/:email_id/attachments/:attachment_id', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'email_id');
    const aid = uuidParam(c, 'attachment_id', 'id');
    const [a] = await ctx.sql`select id, filename, size, content_type, content_id, disposition from received_attachments where id = ${aid} and email_id = ${id} and team_id = ${teamId(c)}`;
    if (!a) throw E.notFound('Attachment not found');
    return c.json(attachmentObject(ctx, 'received', a, true));
  });
}
