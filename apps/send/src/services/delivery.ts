/** Worker side of sending: suppression/topic filtering, MIME, tracking, transport, outcome events. */
import type { AppContext } from '../context.js';
import { parseAddress } from '../lib/address.js';
import { safeRequest } from '../lib/ssrf.js';
import { signToken } from '../lib/crypto.js';
import { TransportError } from '../transport/index.js';
import { applyTracking, buildMime, type MimeAttachment } from './mime.js';
import { recordEvent, type EmailRow } from './emailEvents.js';
import { CLOUDFLARE_MAX_BYTES, TEST_ADDRESS_RE } from './emails.js';
import { renderVars } from './render.js';

export class RetryableError extends Error {}

const bare = (a: string) => parseAddress(a)?.address ?? a;

export function unsubscribeUrl(ctx: AppContext, teamId: string, contactId: string, broadcastId: string | null, topicId: string | null): string {
  const token = signToken(ctx.config.sessionSecret, 'unsub', { t: teamId, c: contactId, b: broadcastId, p: topicId });
  return `${ctx.config.publicTrackingBase}/unsubscribe/${token}`;
}

/** Process one queued/scheduled email. Throws RetryableError to have the job retried. */
export async function processSendEmail(ctx: AppContext, emailId: string, attempt = 1, maxAttempts = 6): Promise<void> {
  const [email] = await ctx.sql`select * from emails where id = ${emailId}`;
  if (!email) return;
  if (email.last_event !== 'queued' && email.last_event !== 'scheduled') return; // canceled or already processed
  const ev = email as unknown as EmailRow & Record<string, unknown>;

  const fail = async (reason: string) => {
    await ctx.sql`update emails set failed_reason = ${reason} where id = ${emailId}`;
    await recordEvent(ctx, ev, 'failed', { extra: { failed: { reason } } });
  };

  // Domain must still be verified at send time (scheduled emails can outlive it).
  let domain: Record<string, unknown> | undefined;
  if (email.domain_id) {
    [domain] = await ctx.sql`select * from domains where id = ${email.domain_id as string}`;
    if (!domain || domain.status !== 'verified' || domain.sending !== 'enabled') return fail('domain_not_verified');
  }
  if (email.api_key_id && email.source === 'api') {
    const [k] = await ctx.sql`select id from api_keys where id = ${email.api_key_id as string}`;
    if (!k && email.scheduled_at) return fail('api_key_not_active');
  }

  const to = (email.to_addrs as string[]) ?? [];
  const cc = (email.cc as string[] | null) ?? [];
  const bcc = (email.bcc as string[] | null) ?? [];
  let recipients = [...new Set([...to, ...cc, ...bcc].map(bare))];

  // Account-level suppression list.
  const sup = await ctx.sql`select lower(email) as e from suppressions where team_id = ${email.team_id as string} and lower(email) = any(${recipients.map((r) => r.toLowerCase())})`;
  const suppressed = new Set(sup.map((r) => r.e as string));
  const testSuppressed = recipients.filter((r) => /^suppressed(\+[^@]*)?@resend\.dev$/i.test(r));
  const suppressedList = recipients.filter((r) => suppressed.has(r.toLowerCase()) || testSuppressed.includes(r));
  if (suppressedList.length) {
    await recordEvent(ctx, ev, 'suppressed', {
      recipients: suppressedList,
      extra: { suppressed: { message: 'Resend has suppressed sending to this address because it is on the account-level suppression list. This does not count toward your bounce rate metric', type: 'OnAccountSuppressionList' } },
    });
    recipients = recipients.filter((r) => !suppressedList.includes(r));
  }

  // Topic subscriptions: opted-out contacts are skipped; non-contacts follow the topic default.
  if (email.topic_id && recipients.length) {
    const [topic] = await ctx.sql`select default_subscription from topics where id = ${email.topic_id as string}`;
    const subs = await ctx.sql`
      select lower(c.email) as e, ct.subscription from contacts c
      left join contact_topics ct on ct.contact_id = c.id and ct.topic_id = ${email.topic_id as string}
      where c.team_id = ${email.team_id as string} and lower(c.email) = any(${recipients.map((r) => r.toLowerCase())})`;
    const byEmail = new Map(subs.map((s) => [s.e as string, (s.subscription as string | null) ?? (topic?.default_subscription as string)]));
    const optedOut = recipients.filter((r) => {
      const s = byEmail.get(r.toLowerCase());
      return s === undefined ? topic?.default_subscription !== 'opt_in' : s === 'opt_out';
    });
    if (optedOut.length) recipients = recipients.filter((r) => !optedOut.includes(r));
    if (!recipients.length) return fail('recipient_opted_out_of_topic');
  }
  if (!recipients.length) return;

  // Resend's test addresses never leave the building: simulate their outcomes.
  const testRecipients = recipients.filter((r) => TEST_ADDRESS_RE.test(r));
  const realRecipients = recipients.filter((r) => !TEST_ADDRESS_RE.test(r));
  let providerMessageId: string | undefined;
  let delivered: string[] = [];
  let bounced: string[] = [];
  let queued: string[] = [];
  let cfSuppressed: string[] = [];

  if (realRecipients.length) {
    let fromHeader = email.from_addr as string;
    let envelopeFrom = bare(fromHeader);
    let replyTo = (email.reply_to as string[] | null) ?? [];
    if (!email.domain_id) {
      // Sandbox (resend.dev) to a team member: we cannot send as resend.dev, use SANDBOX_SENDER.
      const sender = process.env.SANDBOX_SENDER;
      if (!sender) return fail('sandbox_sender_not_configured');
      const name = parseAddress(fromHeader)?.name;
      fromHeader = name ? `${name} <${sender}>` : sender;
      envelopeFrom = sender;
      if (!replyTo.length) replyTo = [email.from_addr as string];
    }
    const atts = await ctx.sql`select * from email_attachments where email_id = ${emailId} order by created_at, id`;
    const mimeAtts: MimeAttachment[] = [];
    for (const a of atts) {
      let content = a.content as Buffer | null;
      if (!content && a.path) {
        try {
          const r = await safeRequest(a.path as string, { timeoutMs: 30_000, maxBytes: 40 * 1024 * 1024, allowPrivate: ctx.config.allowPrivateWebhooks });
          if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
          if (r.truncated) throw new Error('attachment exceeds 40MB');
          content = r.body;
          const ct = typeof r.headers['content-type'] === 'string' ? r.headers['content-type'].split(';')[0]!.trim() : null;
          if (ct && a.content_type === 'application/octet-stream') a.content_type = ct;
          await ctx.sql`update email_attachments set content = ${content}, size = ${content.length}, content_type = ${a.content_type as string} where id = ${a.id as string}`;
        } catch (e) {
          if (attempt < maxAttempts) throw new RetryableError(`attachment fetch failed: ${(e as Error).message}`);
          return fail('attachment_fetch_failed');
        }
      }
      mimeAtts.push({ filename: a.filename as string | null, content: content ?? Buffer.alloc(0), contentType: a.content_type as string, contentId: a.content_id as string | null, disposition: a.disposition as 'inline' | 'attachment' });
    }

    let html = email.html as string | null;
    let text = email.text as string | null;
    let listUnsubscribe: string | null = null;
    if (email.contact_id && email.broadcast_id) {
      listUnsubscribe = unsubscribeUrl(ctx, email.team_id as string, email.contact_id as string, email.broadcast_id as string, email.topic_id as string | null);
      const v = { RESEND_UNSUBSCRIBE_URL: listUnsubscribe };
      if (html) html = renderVars(html, v);
      if (text) text = renderVars(text, v);
    }
    if (html && domain && (domain.open_tracking || domain.click_tracking)) {
      html = applyTracking(html, {
        secret: ctx.config.sessionSecret,
        base: ctx.config.publicTrackingBase,
        emailId,
        opens: !!domain.open_tracking,
        clicks: !!domain.click_tracking,
      });
    }
    const raw = await buildMime({
      messageId: email.message_id as string,
      from: fromHeader,
      to: (email.to_addrs as string[]).filter((r) => realRecipients.includes(bare(r))),
      cc: cc.filter((r) => realRecipients.includes(bare(r))),
      replyTo,
      subject: email.subject as string,
      html,
      text,
      headers: email.headers as Record<string, string> | null,
      attachments: mimeAtts,
      listUnsubscribe,
      date: ctx.now(),
    });
    if (ctx.config.transport === 'cloudflare' && raw.length > CLOUDFLARE_MAX_BYTES) return fail('message_too_large');
    // At-most-once: claim the email for this attempt. A job re-claimed after a stale lock (worker
    // died or hung mid-send) finds the claim and never hands the message to the transport again.
    const [claimed] = await ctx.sql`update emails set send_claimed_at = now() where id = ${emailId} and send_claimed_at is null and sent_at is null returning id`;
    if (!claimed) {
      const [c] = await ctx.sql`select send_claimed_at < now() - interval '10 minutes' as stale, sent_at is not null as sent from emails where id = ${emailId}`;
      ctx.log('delivery', 'email already handed to the transport by an earlier attempt; not sending again', { emailId });
      // A fresh claim belongs to an attempt still in flight, which records the outcome itself. A
      // stale one means that attempt died mid-send: the outcome is unknown, so report it instead of resending.
      if (c?.stale && !c.sent) return fail('send_interrupted');
      return;
    }
    try {
      const r = await ctx.transport.send({ emailId, teamId: email.team_id as string, from: envelopeFrom, recipients: realRecipients, raw });
      providerMessageId = r.providerMessageId;
      delivered = r.delivered;
      bounced = r.permanentBounces;
      queued = r.queued;
      cfSuppressed = r.suppressed;
    } catch (e) {
      if (e instanceof TransportError && e.retryable && attempt < maxAttempts) {
        // The transport said it did not take the message: release the claim for the retry.
        await ctx.sql`update emails set send_claimed_at = null where id = ${emailId}`;
        throw new RetryableError(e.message);
      }
      ctx.log('delivery', 'transport failed', { emailId, error: (e as Error).message });
      return fail(e instanceof TransportError && e.code === 'too_big' ? 'message_too_large' : 'transport_error');
    }
    await ctx.sql`update emails set provider_message_id = ${providerMessageId ?? null}, sent_at = now() where id = ${emailId}`;
  } else {
    await ctx.sql`update emails set sent_at = now() where id = ${emailId}`;
  }

  const sentTo = [...realRecipients.filter((r) => !cfSuppressed.includes(r)), ...testRecipients.filter((r) => !/^suppressed/i.test(r))];
  if (sentTo.length) await recordEvent(ctx, ev, 'sent', { recipients: sentTo });
  if (cfSuppressed.length) {
    await recordEvent(ctx, ev, 'suppressed', { recipients: cfSuppressed, extra: { suppressed: { message: 'The recipient is on the Cloudflare Email Sending suppression list.', type: 'OnAccountSuppressionList' } } });
  }
  for (const t of testRecipients) {
    const kind = /^([a-z]+)/i.exec(t)![1]!.toLowerCase();
    if (kind === 'delivered') delivered.push(t);
    else if (kind === 'bounced') bounced.push(t);
    else if (kind === 'complained') delivered.push(t);
  }
  if (delivered.length) await recordEvent(ctx, ev, 'delivered', { recipients: delivered });
  if (bounced.length) {
    await recordEvent(ctx, ev, 'bounced', {
      recipients: bounced,
      extra: { bounce: { message: "The recipient's mail server permanently rejected the email.", subType: 'General', type: 'Permanent' } },
    });
  }
  const complained = testRecipients.filter((r) => /^complained/i.test(r));
  if (complained.length) await recordEvent(ctx, ev, 'complained', { recipients: complained });
  void queued; // final outcome for queued recipients comes from the analytics poller
}
