import type { Context } from 'hono';
import type { Session } from './sessions.js';
import type { FetchFn } from './stalwart.js';
import { DOWNLOAD_CSP } from './security.js';

/** Request headers we pass through to Stalwart. Everything else (cookies!) is dropped. */
const FORWARD_REQ = ['content-type', 'accept', 'last-event-id', 'range', 'if-none-match', 'if-modified-since', 'accept-language'];
/** Response headers we pass back. Notably NOT www-authenticate (would trigger a browser auth prompt) or set-cookie. */
const FORWARD_RES = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'content-range',
  'accept-ranges',
  'retry-after',
];

/** Types safe to show inline (`?inline=1`) from our origin. Never HTML/SVG/XML. */
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;

export interface ProxyDeps {
  fetch: FetchFn;
  stalwartUrl: string;
  clientIp: string;
}

/** Rewrite the absolute URLs Stalwart advertises into same-origin paths served by this BFF. */
export function rewriteSession(session: Record<string, unknown>): Record<string, unknown> {
  const out = { ...session };
  const strip = (v: unknown) => (typeof v === 'string' ? v.replace(/^[a-z]+:\/\/[^/]+/i, '') : v);
  out.apiUrl = '/jmap/';
  for (const k of ['downloadUrl', 'uploadUrl', 'eventSourceUrl'] as const) {
    if (typeof out[k] === 'string') out[k] = strip(out[k]);
  }
  out.downloadUrl ??= '/jmap/download/{accountId}/{blobId}/{name}?accept={type}';
  out.uploadUrl ??= '/jmap/upload/{accountId}/';
  out.eventSourceUrl ??= '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}';
  // We don't proxy WebSockets; hide the capability so clients use EventSource.
  if (out.capabilities && typeof out.capabilities === 'object') {
    const caps = { ...(out.capabilities as Record<string, unknown>) };
    delete caps['urn:ietf:params:jmap:websocket'];
    out.capabilities = caps;
  }
  if (out.accounts && typeof out.accounts === 'object') {
    const accounts: Record<string, unknown> = {};
    for (const [id, acc] of Object.entries(out.accounts as Record<string, Record<string, unknown>>)) {
      const caps = { ...((acc.accountCapabilities as Record<string, unknown>) ?? {}) };
      delete caps['urn:ietf:params:jmap:websocket'];
      accounts[id] = { ...acc, accountCapabilities: caps };
    }
    out.accounts = accounts;
  }
  return out;
}

function upstreamHeaders(c: Context, session: Session, clientIp: string): Headers {
  const h = new Headers();
  for (const name of FORWARD_REQ) {
    const v = c.req.header(name);
    if (v) h.set(name, v);
  }
  h.set('Authorization', session.authorization);
  h.set('Accept-Encoding', 'identity');
  h.set('X-Forwarded-For', clientIp);
  return h;
}

function copyResponseHeaders(from: Headers): Headers {
  const h = new Headers();
  for (const name of FORWARD_RES) {
    const v = from.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

export type ProxyOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'unauthorized' }
  | { kind: 'notFound' }
  | { kind: 'forbidden'; detail: string };

/** Largest JMAP API request body we buffer to check account ids (Stalwart's maxSizeRequest is 10 MB). */
const MAX_API_BODY = 12 * 1024 * 1024;

function methodNames(body: unknown): string[] {
  const calls = (body as { methodCalls?: unknown } | undefined)?.methodCalls;
  return Array.isArray(calls) ? calls.map((c) => (Array.isArray(c) && typeof c[0] === 'string' ? c[0] : '')) : [];
}

/** Account ids referenced by a JMAP request: every call's accountId / fromAccountId. */
export function referencedAccounts(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { methodCalls?: unknown }).methodCalls)) return null;
  const out: string[] = [];
  for (const call of (body as { methodCalls: unknown[] }).methodCalls) {
    if (!Array.isArray(call) || !call[1] || typeof call[1] !== 'object') return null;
    for (const k of ['accountId', 'fromAccountId']) {
      const v = (call[1] as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) {
        if (typeof v !== 'string') return null;
        out.push(v);
      }
    }
  }
  return out;
}

const SEG = '[A-Za-z0-9_.~@+=-]+';
/**
 * Only these upstream endpoints are reachable through the proxy. Anything else
 * (Stalwart's admin UI, /api, traversal attempts like /jmap/..%2fapi) is refused
 * *before* it reaches Stalwart — such probes can get the BFF's IP scan-banned.
 */
const ALLOWED_PATHS = [
  /^\/jmap\/?$/,
  /^\/jmap\/session$/,
  /^\/\.well-known\/jmap$/,
  new RegExp(`^/jmap/upload/${SEG}/?$`),
  new RegExp(`^/jmap/download/${SEG}/${SEG}/[^/]+$`),
  /^\/jmap\/eventsource\/?$/,
];

const DOWNLOAD_RE = /^(\/jmap\/download\/[^/]+\/[^/]+\/)([^/]+)$/;

export function isAllowedProxyPath(rawPath: string): boolean {
  // The download file-name segment may legitimately contain dots or encoded characters;
  // it is re-encoded by safeUpstreamPath(). Everything else must be plain.
  const m = DOWNLOAD_RE.exec(rawPath);
  const checked = m ? m[1]! : rawPath;
  if (/(\.\.|%2e|%2f|%5c|\\)/i.test(checked)) return false;
  return ALLOWED_PATHS.some((re) => re.test(rawPath));
}

/** Re-encode the download file name so it can never act as a path (no `/`, `\`, leading dots). */
export function safeUpstreamPath(rawPath: string): string {
  const m = DOWNLOAD_RE.exec(rawPath);
  if (!m) return rawPath;
  let name: string;
  try {
    name = decodeURIComponent(m[2]!);
  } catch {
    name = 'attachment';
  }
  name = name.replace(/[/\\\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || 'attachment';
  return m[1]! + encodeURIComponent(name);
}

/** Forward the current request to Stalwart, streaming both bodies. */
export async function proxyToStalwart(c: Context, session: Session, deps: ProxyDeps): Promise<ProxyOutcome> {
  const url = new URL(c.req.url);
  // Use the raw (still percent-encoded) path so encoded traversal can't be normalised into something else.
  const rawPath = c.req.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0]!;
  if (!isAllowedProxyPath(rawPath)) return { kind: 'notFound' };
  let path = safeUpstreamPath(rawPath);
  const isSession = path === '/jmap/session' || path === '/.well-known/jmap';
  if (isSession) path = '/jmap/session';
  const isEventSource = path.startsWith('/jmap/eventsource');
  const isDownload = path.startsWith('/jmap/download/');

  const search = new URLSearchParams(url.search);
  const inline = isDownload && search.get('inline') === '1';
  search.delete('inline');
  const qs = search.toString();
  const target = `${deps.stalwartUrl}${path}${qs ? `?${qs}` : ''}`;

  const method = c.req.method;
  const hasBody = !['GET', 'HEAD'].includes(method);
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: upstreamHeaders(c, session, deps.clientIp),
    redirect: 'manual',
    // Abort upstream when the browser goes away (important for EventSource).
    signal: c.req.raw.signal,
  };
  if (hasBody) {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }

  // Only this login's own accounts may be addressed (Stalwart itself lets a user upload blobs into
  // another account). Sessions from before account ids were recorded skip the account check.
  const allowed = session.accountIds;
  const seg = /^\/jmap\/(?:upload|download)\/([^/]+)/.exec(path)?.[1];
  if (allowed && seg !== undefined && !allowed.includes(decodeURIComponent(seg))) return { kind: 'forbidden', detail: 'Not your account' };
  if (method === 'POST' && /^\/jmap\/?$/.test(path)) {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_API_BODY) return { kind: 'forbidden', detail: 'Request too large' };
    const text = await c.req.text();
    if (text.length > MAX_API_BODY) return { kind: 'forbidden', detail: 'Request too large' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // Malformed requests go to Stalwart unchanged (it answers with a proper JMAP error).
    const ids = referencedAccounts(parsed);
    if (allowed && ids && ids.some((id) => !allowed.includes(id))) return { kind: 'forbidden', detail: 'Not your account' };
    // The directory (Principal/*) lists every account on every hosted domain; the app doesn't use it,
    // so only administrators may query it through the BFF.
    if (!session.isAdmin && methodNames(parsed).some((m) => /^Principal\//i.test(m))) return { kind: 'forbidden', detail: 'Directory access is limited to administrators' };
    init.body = text;
    delete init.duplex;
  }

  const upstream = await deps.fetch(target, init);
  if (upstream.status === 401 || (isSession && upstream.status === 403)) {
    await upstream.body?.cancel().catch(() => {});
    return { kind: 'unauthorized' };
  }

  const headers = copyResponseHeaders(upstream.headers);

  if (isSession && upstream.ok) {
    const json = (await upstream.json()) as Record<string, unknown>;
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return { kind: 'response', response: new Response(JSON.stringify(rewriteSession(json)), { status: 200, headers }) };
  }

  if (isEventSource) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
    headers.delete('content-length');
  }

  if (isDownload) {
    headers.set('Content-Security-Policy', DOWNLOAD_CSP);
    headers.set('Cache-Control', 'private, max-age=3600');
    const ct = (headers.get('content-type') ?? '').split(';')[0]!.trim();
    const disp = headers.get('content-disposition') ?? '';
    const filename = /filename\*?=([^;]+)/i.exec(disp)?.[0];
    const isPdf = /^application\/pdf$/i.test(ct);
    // PDFs need Chrome's viewer, which a CSP sandbox disables — so an unsandboxed inline PDF is only
    // served into our own preview frame, never as a top-level page on our origin (a link in a mail,
    // a new tab, or another site framing it).
    const dest = c.req.header('Sec-Fetch-Dest');
    const site = c.req.header('Sec-Fetch-Site');
    const pdfFramed = (dest === 'iframe' || dest === 'embed' || dest === 'object') && (site === undefined || site === 'same-origin');
    if (inline && INLINE_SAFE.test(ct) && (!isPdf || pdfFramed)) {
      headers.set('content-disposition', filename ? `inline; ${filename}` : 'inline');
      if (isPdf) {
        headers.set('Content-Security-Policy', "default-src 'none'; object-src 'self'; frame-ancestors 'self'");
        headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      }
    } else if (!/^attachment/i.test(disp)) {
      headers.set('content-disposition', filename ? `attachment; ${filename}` : 'attachment');
    }
  }

  return { kind: 'response', response: new Response(upstream.body, { status: upstream.status, headers }) };
}
