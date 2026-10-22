/**
 * SMTP relay (Resend's smtp.resend.com equivalent): user `resend`, password = API key.
 * Accepted messages go through the same pipeline as POST /emails (normalize → quota → persist).
 */
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { RateLimiter, TeamRateLimiter } from '../lib/rateLimit.js';
import { redact } from '../lib/redact.js';
import { verifyApiKey, type AuthContext } from '../services/apiKeys.js';
import { checkQuota, normalize, persist } from '../services/emails.js';
import { withIdempotency } from '../services/idempotency.js';
import { smtpToPayload } from './message.js';

export interface SmtpTls {
  key: string | Buffer;
  cert: string | Buffer;
}

export interface SmtpListen {
  port: number;
  /** true: implicit TLS (465/2465); false: STARTTLS (587/2587/25). */
  implicitTls: boolean;
  host?: string;
}

export interface SmtpHandle {
  servers: { server: SMTPServer; listen: SmtpListen; port: number }[];
  updateTls(tls: SmtpTls): void;
  close(): Promise<void>;
}

type Session = SMTPServerSession & { user?: unknown; rcptOverflow?: boolean };

/**
 * Envelope recipients per message: `to` (≤ 50, as in the API) plus Cc and Bcc. Over the limit the
 * RCPT gets 452 and the whole transaction is refused at DATA (also 452): many clients, nodemailer
 * included, would otherwise silently deliver to the accepted recipients only.
 */
export const MAX_RECIPIENTS = 150;

export class SmtpReply extends Error {
  constructor(public responseCode: number, message: string) {
    super(message);
  }
}

/** ApiError → SMTP reply (enhanced status codes per RFC 3463). */
export function smtpError(e: unknown): SmtpReply {
  if (e instanceof SmtpReply) return e;
  if (e instanceof ApiError) {
    const m = e.message;
    switch (e.errorName) {
      case 'rate_limit_exceeded':
        return new SmtpReply(451, `4.7.1 ${m}`);
      case 'daily_quota_exceeded':
      case 'monthly_quota_exceeded':
        return new SmtpReply(452, `4.5.3 ${m}`);
      case 'concurrent_idempotent_requests':
        return new SmtpReply(451, `4.3.0 ${m}`);
      case 'invalid_idempotent_request':
      case 'invalid_idempotency_key':
        return new SmtpReply(550, `5.7.0 ${m}`);
      case 'restricted_api_key':
      case 'missing_api_key':
        return new SmtpReply(535, `5.7.8 ${m}`);
    }
    if (e.statusCode === 413 || /exceeds the maximum size/i.test(m)) return new SmtpReply(552, `5.3.4 ${m}`);
    if (e.statusCode === 403) return new SmtpReply(550, `5.7.1 ${m}`);
    if (/address|`from`|`to`|`cc`|`bcc`|`reply_to`/.test(m) && e.statusCode === 422) return new SmtpReply(553, `5.1.3 ${m}`);
    if (e.statusCode >= 500) return new SmtpReply(451, `4.3.0 ${m}`);
    return new SmtpReply(550, `5.6.0 ${m}`);
  }
  return new SmtpReply(451, '4.3.0 Temporary server error, try again later');
}

export function startSmtp(ctx: AppContext, opts: { listen: SmtpListen[]; tls?: SmtpTls; rateLimiter?: TeamRateLimiter }): Promise<SmtpHandle> {
  const cfg = ctx.config;
  const limiter = opts.rateLimiter ?? new TeamRateLimiter();
  // Brute-force protection on AUTH (per client IP), like the dashboard login.
  const authFails = new RateLimiter(cfg.loginRateLimit, cfg.loginRateWindowMs);

  const onAuth = (auth: SMTPServerAuthentication, session: Session, cb: (err: Error | null | undefined, res?: { user: unknown }) => void) => {
    const ip = session.remoteAddress ?? 'unknown';
    if (authFails.peek(ip)) return cb(new SmtpReply(454, '4.7.0 Too many failed login attempts, try again later'));
    const fail = () => {
      authFails.hit(ip);
      cb(new SmtpReply(535, '5.7.8 Authentication credentials invalid'));
    };
    if (auth.method !== 'PLAIN' && auth.method !== 'LOGIN') return fail();
    if ((auth.username ?? '').toLowerCase() !== 'resend' || !auth.password) return fail();
    verifyApiKey(ctx.sql, auth.password.trim())
      .then((r) => {
        if (r.status !== 'ok') return fail();
        authFails.reset(ip);
        cb(null, { user: { ...r.auth, source: 'smtp' } satisfies AuthContext });
      })
      .catch((e) => {
        ctx.log('smtp', 'auth lookup failed', { error: (e as Error).message });
        cb(new SmtpReply(454, '4.7.0 Temporary authentication failure'));
      });
  };

  const onData = (stream: NodeJS.ReadableStream & { sizeExceeded?: boolean }, session: Session, cb: (err?: Error | null, message?: string) => void) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', (e) => cb(e));
    stream.on('end', () => {
      if (session.rcptOverflow) return cb(new SmtpReply(452, `4.5.3 Too many recipients. A message can have at most ${MAX_RECIPIENTS} recipients (to, cc and bcc); send the rest in another message`));
      if (stream.sizeExceeded) return cb(new SmtpReply(552, `5.3.4 Message exceeds the maximum size of ${Math.floor(cfg.smtpMaxMessageBytes / 1024 / 1024)}MB`));
      const raw = Buffer.concat(chunks);
      handleMessage(ctx, session, raw, limiter)
        .then((id) => cb(null, `2.0.0 OK ${id}`))
        .catch((e) => cb(smtpError(e)));
    });
  };

  const make = (l: SmtpListen) =>
    new SMTPServer({
      name: cfg.smtpHostname,
      banner: '5050 Send SMTP relay',
      secure: l.implicitTls,
      ...(opts.tls ? { key: opts.tls.key, cert: opts.tls.cert } : {}),
      authMethods: ['PLAIN', 'LOGIN'],
      allowInsecureAuth: false,
      authOptional: false,
      size: cfg.smtpMaxMessageBytes,
      disabledCommands: [],
      logger: false,
      onAuth: onAuth as never,
      onMailFrom(_addr, session, cb) {
        (session as Session).rcptOverflow = false;
        cb();
      },
      onRcptTo(addr, session, cb) {
        if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
          (session as Session).rcptOverflow = true;
          return cb(new SmtpReply(452, `4.5.3 Too many recipients (at most ${MAX_RECIPIENTS} per message)`));
        }
        cb();
      },
      onData: onData as never,
    });

  return new Promise((resolve, reject) => {
    const servers: SmtpHandle['servers'] = [];
    let pending = opts.listen.length;
    if (!pending) resolve(handle());
    for (const l of opts.listen) {
      const server = make(l);
      server.on('error', (e) => ctx.log('smtp', 'server error', { port: l.port, error: (e as Error).message }));
      server.listen(l.port, l.host ?? '0.0.0.0', () => {
        const addr = server.server.address();
        servers.push({ server, listen: l, port: typeof addr === 'object' && addr ? addr.port : l.port });
        if (--pending === 0) resolve(handle());
      });
      server.server.once('error', reject);
    }
    function handle(): SmtpHandle {
      return {
        servers,
        updateTls(tls) {
          for (const s of servers) s.server.updateSecureContext({ key: tls.key, cert: tls.cert });
        },
        close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.server.close(() => r())))).then(() => undefined),
      };
    }
  });
}

async function handleMessage(ctx: AppContext, session: Session, raw: Buffer, limiter: TeamRateLimiter): Promise<string> {
  const auth = session.user as AuthContext;
  const started = Date.now();
  const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
  const envelopeTo = session.envelope.rcptTo.map((r) => r.address);
  let payload: unknown = null;
  let status = 200;
  let response: unknown = null;
  try {
    const rl = limiter.hit(auth.team.id, auth.team.rate_limit);
    if (!rl.allowed) throw new ApiError(429, 'rate_limit_exceeded', 'Too many requests. Please limit the number of requests per second.');
    const msg = await smtpToPayload(raw, envelopeFrom, envelopeTo);
    payload = msg.payload;
    const res = await withIdempotency(ctx, auth.team.id, 'SMTP', msg.idempotencyKey, msg.fingerprint, async () => {
      const n = await normalize(ctx, auth, msg.payload, { source: 'smtp' });
      await checkQuota(ctx, auth, 1);
      const [id] = await persist(ctx, auth, [n], { source: 'smtp' });
      return { status: 200, body: { id } };
    });
    response = res.body;
    return (res.body as { id: string }).id;
  } catch (e) {
    if (e instanceof ApiError) {
      status = e.statusCode;
      response = e.toJSON();
    } else {
      status = 500;
      response = { statusCode: 500, message: 'An unexpected error occurred.', name: 'application_error' };
      ctx.log('smtp', 'message processing failed', { error: (e as Error).message });
    }
    throw e;
  } finally {
    // SMTP sends show up in the dashboard's logs (source 'smtp'); GET /logs keeps listing API calls only.
    ctx.sql`
      insert into api_logs (team_id, api_key_id, source, method, endpoint, response_status, user_agent, ip, request_body, response_body, duration_ms)
      values (${auth.team.id}, ${auth.apiKeyId}, 'smtp', 'SMTP', '/smtp', ${status}, ${session.clientHostname ?? null}, ${session.remoteAddress ?? null},
              ${payload === null ? null : ctx.sql.json(redact(payload) as never)}, ${response === null ? null : ctx.sql.json(redact(response) as never)}, ${Date.now() - started})`.catch(
      (e: Error) => ctx.log('smtp', 'log write failed', { error: e.message }),
    );
  }
}
