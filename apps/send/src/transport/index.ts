import nodemailer from 'nodemailer';
import { CloudflareClient, CloudflareError } from '../cloudflare/client.js';

export interface OutboundMessage {
  emailId: string;
  teamId: string;
  /** Envelope sender (bare address). */
  from: string;
  /** Envelope recipients (to + cc + bcc), already filtered for suppressions. */
  recipients: string[];
  raw: Buffer;
}

export interface SendResult {
  providerMessageId?: string;
  /** The mail server's queue id for this submission (decimal string), when it reports one. */
  queueId?: string;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  suppressed: string[];
}

export class TransportError extends Error {
  constructor(
    message: string,
    /** false → retrying won't help (e.g. message too big, domain not onboarded). */
    public readonly retryable: boolean,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface Transport {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Cloudflare Email Sending, raw MIME variant (we build the MIME ourselves). */
export class CloudflareTransport implements Transport {
  readonly name = 'cloudflare';
  constructor(private cf: CloudflareClient) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.raw.length > 5 * 1024 * 1024) {
      throw new TransportError('Message exceeds the 5 MiB limit of Cloudflare Email Sending', false, 'too_big');
    }
    try {
      const r = await this.cf.sendRaw({ from: msg.from, recipients: msg.recipients, mime_message: msg.raw.toString('utf8') });
      return {
        providerMessageId: r.message_id,
        delivered: r.delivered ?? [],
        queued: r.queued ?? [],
        permanentBounces: r.permanent_bounces ?? [],
        suppressed: r.suppressed_recipients ?? [],
      };
    } catch (e) {
      if (e instanceof CloudflareError) {
        const retryable = e.status >= 500 || e.status === 429;
        throw new TransportError(e.message, retryable, String(e.code ?? e.status));
      }
      throw new TransportError((e as Error).message, true);
    }
  }
}

/** In-memory transport for tests and local dev. Never leaves the process. */
export class FakeTransport implements Transport {
  readonly name = 'fake';
  sent: (OutboundMessage & { at: Date; queueId: string })[] = [];
  private seq = 0;
  /** Recipients to report as permanent bounces. */
  bounce = new Set<string>();
  /** Behave like the SMTP transport: accept everything as queued and leave the outcome to the mail server's events. */
  queueOnly = false;
  /** Throw this on the next send. */
  failNext: TransportError | null = null;

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const queueId = String(336447000000000000n + BigInt(++this.seq));
    this.sent.push({ ...msg, at: new Date(), queueId });
    const bounced = msg.recipients.filter((r) => this.bounce.has(r.toLowerCase()));
    return {
      providerMessageId: `<fake-${msg.emailId}@fake.transport>`,
      queueId,
      delivered: this.queueOnly ? [] : msg.recipients.filter((r) => !bounced.includes(r)),
      queued: this.queueOnly ? msg.recipients : [],
      permanentBounces: this.queueOnly ? [] : bounced,
      suppressed: [],
    };
  }

  clear() {
    this.sent = [];
  }
}

/** Logs and drops (local dev without a fake, never in production). */
export class LogTransport implements Transport {
  readonly name = 'log';
  async send(msg: OutboundMessage): Promise<SendResult> {
    console.log(`[transport:log] ${msg.emailId} from=${msg.from} to=${msg.recipients.join(',')} bytes=${msg.raw.length}`);
    return { delivered: [], queued: msg.recipients, permanentBounces: [], suppressed: [] };
  }
}

/**
 * SMTP submission to the local mail server (self-hosted default): 5050 Send hands
 * the finished MIME to Stalwart on its internal relay port; Stalwart DKIM-signs,
 * queues and delivers (direct MX or the configured smarthost). Accepted recipients
 * are reported as queued (status "sent"); 5xx rejections are permanent bounces.
 */
export class SmtpTransport implements Transport {
  readonly name = 'smtp';
  private transporter: import('nodemailer').Transporter;

  constructor(
    url: string,
    transporter?: import('nodemailer').Transporter,
    /** DKIM key for the sender's domain (self-hosted domains are signed here, not by the mail server). */
    private dkimFor?: (from: string) => Promise<{ domainName: string; keySelector: string; privateKey: string } | null>,
  ) {
    this.transporter = transporter ?? nodemailer.createTransport(url, { pool: true, maxConnections: 5 } as never);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      type Addr = string | { address: string };
      const dkim = (await this.dkimFor?.(msg.from)) ?? undefined;
      const info = (await this.transporter.sendMail({ envelope: { from: msg.from, to: msg.recipients }, raw: msg.raw, ...(dkim ? { dkim } : {}) })) as {
        messageId?: string;
        response?: string;
        accepted?: Addr[];
        rejected?: Addr[];
        rejectedErrors?: { responseCode?: number; recipient?: string }[];
      };
      const addr = (r: Addr) => (typeof r === 'string' ? r : r.address);
      const rejected = (info.rejected ?? []).map(addr);
      const accepted = (info.accepted ?? []).map(addr);
      const perm = (info.rejectedErrors ?? []).filter((e) => Number(e.responseCode) >= 500).map((e) => e.recipient ?? '');
      if (!accepted.length && rejected.length && perm.length < rejected.length) throw new TransportError('Mail server temporarily rejected all recipients', true, 'smtp_tempfail');
      return { providerMessageId: info.messageId, queueId: parseQueueId(info.response), delivered: [], queued: accepted, permanentBounces: rejected.filter((r) => perm.includes(r) || !perm.length), suppressed: [] };
    } catch (e) {
      if (e instanceof TransportError) throw e;
      const code = Number((e as { responseCode?: number }).responseCode);
      const permanent = code >= 500 && code < 600;
      throw new TransportError(`SMTP: ${(e as Error).message}`, !permanent, code ? String(code) : 'smtp_error');
    }
  }
}

/**
 * Stalwart answers a submission with "250 2.0.0 Message queued with id 4ab4d05aa400e00" (the queue id
 * in hex); its logs and webhooks carry the same number in decimal. Returns the decimal string.
 */
export function parseQueueId(response: string | undefined): string | undefined {
  const m = /queued (?:for delivery )?with id ([0-9a-f]{1,16})\b/i.exec(response ?? '');
  return m ? BigInt('0x' + m[1]).toString() : undefined;
}
