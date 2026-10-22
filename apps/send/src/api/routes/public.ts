/**
 * Unauthenticated endpoints on the API host: open pixel, click redirect,
 * one-click unsubscribe, signed attachment / raw downloads, and inbound ingest.
 */
import { Hono, type Context } from 'hono';
import type { AppContext } from '../../context.js';
import { safeEqual, verifyToken } from '../../lib/crypto.js';
import { escapeHtml } from '../../services/render.js';
import { loadEmailForEvents, recordEvent } from '../../services/emailEvents.js';
import { ingestRaw } from '../../services/inbound.js';
import { emit } from '../../services/webhooks.js';
import { contactEventData } from '../../services/contacts.js';
import { clientIp } from '../app.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const DOWNLOAD_CSP = "sandbox; default-src 'none'";
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,-apple-system,sans-serif;background:#f6f6f4;color:#1a1a1a;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:32px;max-width:440px;width:100%}h1{font-size:20px;margin:0 0 8px}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1a1a1a;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}main{background:#1b1b1b;border-color:#333}button{background:#eee;color:#111}}</style></head><body><main>${bodyHtml}</main></body></html>`;
}

interface UnsubToken {
  t: string;
  c: string;
  b: string | null;
  p: string | null;
}

async function unsubscribe(ctx: AppContext, tok: UnsubToken) {
  const [contact] = await ctx.sql`select * from contacts where id = ${tok.c} and team_id = ${tok.t}`;
  if (!contact) return false;
  if (tok.p) {
    await ctx.sql`insert into contact_topics (contact_id, topic_id, subscription) values (${tok.c}, ${tok.p}, 'opt_out')
                  on conflict (contact_id, topic_id) do update set subscription = 'opt_out', updated_at = now()`;
    await emit(ctx, tok.t, 'contact.topics.updated', { email: contact.email, topics: [{ id: tok.p, subscription: 'opt_out' }] });
  } else if (!contact.unsubscribed) {
    const [u] = await ctx.sql`update contacts set unsubscribed = true, updated_at = now() where id = ${tok.c} returning *`;
    await emit(ctx, tok.t, 'contact.updated', await contactEventData(ctx, u!));
  }
  if (tok.b) {
    const [e] = await ctx.sql`select id from emails where broadcast_id = ${tok.b} and contact_id = ${tok.c} limit 1`;
    if (e) {
      const row = await loadEmailForEvents(ctx, e.id as string);
      if (row) await recordEvent(ctx, row, 'unsubscribed', { recipients: [contact.email as string], dedupeKey: `unsub:${e.id}` });
    }
  }
  return true;
}

export function registerPublicPages(ctx: AppContext): Hono {
  const app = new Hono();
  const secret = ctx.config.sessionSecret;

  app.get('/t/o/:token', async (c) => {
    const tok = verifyToken<{ e: string }>(secret, 'open', c.req.param('token').replace(/\.gif$/, ''));
    if (tok) {
      const e = await loadEmailForEvents(ctx, tok.e);
      if (e) await recordEvent(ctx, e, 'opened', { recipients: e.to_addrs });
    }
    return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0', 'content-length': String(GIF.length) } });
  });

  app.get('/t/c/:token', async (c) => {
    const tok = verifyToken<{ e: string; u: string }>(secret, 'click', c.req.param('token'));
    if (!tok || !/^https?:\/\//i.test(tok.u)) return c.text('Invalid link', 404);
    const e = await loadEmailForEvents(ctx, tok.e);
    if (e) {
      await recordEvent(ctx, e, 'clicked', {
        recipients: e.to_addrs,
        extra: { click: { ipAddress: clientIp(ctx, c as unknown as Context) ?? '', link: tok.u, timestamp: ctx.now().toISOString(), userAgent: c.req.header('user-agent') ?? '' } },
      });
    }
    return c.redirect(tok.u, 302);
  });

  app.get('/unsubscribe/:token', (c) => {
    const tok = verifyToken<UnsubToken>(secret, 'unsub', c.req.param('token'));
    c.header('Content-Security-Policy', PAGE_CSP);
    if (!tok) return c.html(page('Link expired', '<h1>This link is not valid</h1><p>The unsubscribe link is invalid or has been altered.</p>'), 404);
    return c.html(page('Unsubscribe', `<h1>Unsubscribe</h1><p>${tok.p ? 'Stop receiving emails about this topic?' : 'Stop receiving these emails?'}</p><form method="post"><button type="submit">Unsubscribe</button></form>`));
  });

  // RFC 8058 one-click (List-Unsubscribe-Post) and the confirmation form.
  app.post('/unsubscribe/:token', async (c) => {
    const tok = verifyToken<UnsubToken>(secret, 'unsub', c.req.param('token'));
    c.header('Content-Security-Policy', PAGE_CSP);
    if (!tok) return c.html(page('Link expired', '<h1>This link is not valid</h1>'), 404);
    await unsubscribe(ctx, tok);
    return c.html(page('Unsubscribed', "<h1>You're unsubscribed</h1><p>You won't receive these emails anymore.</p>"));
  });

  app.get('/attachments/:token', async (c) => {
    const tok = verifyToken<{ k: 'sent' | 'received'; a: string; x: number }>(secret, 'attachment', c.req.param('token'));
    if (!tok || tok.x * 1000 < ctx.now().getTime()) return c.text('Link expired', 403);
    const [a] = tok.k === 'sent'
      ? await ctx.sql`select filename, content_type, content from email_attachments where id = ${tok.a}`
      : await ctx.sql`select filename, content_type, content from received_attachments where id = ${tok.a}`;
    if (!a || !a.content) return c.text('Not found', 404);
    const name = String(a.filename ?? 'attachment').replace(/["\r\n\\]/g, '_');
    return new Response(a.content as Buffer, {
      headers: {
        'content-type': String(a.content_type || 'application/octet-stream'),
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(String(a.filename ?? 'attachment'))}`,
        'content-security-policy': DOWNLOAD_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=0',
      },
    });
  });

  app.get('/receiving/raw/:token', async (c) => {
    const tok = verifyToken<{ e: string; x: number }>(secret, 'raw', c.req.param('token'));
    if (!tok || tok.x * 1000 < ctx.now().getTime()) return c.text('Link expired', 403);
    const [e] = await ctx.sql`select raw from received_emails where id = ${tok.e}`;
    if (!e?.raw) return c.text('Not found', 404);
    return new Response(e.raw as Buffer, { headers: { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="${tok.e}.eml"`, 'content-security-policy': DOWNLOAD_CSP, 'x-content-type-options': 'nosniff' } });
  });

  /** Raw MIME push from the receiving relay (Stalwart / Cloudflare Email Worker). */
  app.post('/inbound', async (c) => {
    const want = ctx.config.inboundSecret;
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!want || !got || !safeEqual(got, want)) return c.json({ error: 'unauthorized' }, 401);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!raw.length) return c.json({ error: 'empty' }, 400);
    if (raw.length > 40 * 1024 * 1024) return c.json({ error: 'too_large' }, 413);
    const env = (c.req.header('x-envelope-to') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await ingestRaw(ctx, raw, env.length ? env : undefined);
    return c.json({ ids: r.ids, unmatched: r.unmatched }, r.ids.length ? 200 : 404);
  });

  return app;
}
