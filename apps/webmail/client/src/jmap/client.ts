/**
 * Thin, typed JMAP client (RFC 8620/8621). Framework-agnostic so it can be
 * reused by the admin console. Talks to the same-origin BFF, which injects
 * credentials; we only need to send the CSRF header.
 */
import {
  CAP,
  type ChangesResponse,
  type Email,
  type EmailSubmission,
  type GetResponse,
  type Identity,
  type Id,
  type Mailbox,
  type QueryResponse,
  type SearchSnippet,
  type Session,
  type SetResponse,
  type StateChange,
  type Thread,
  type VacationResponse,
} from './types';

export interface MethodMap {
  'Core/echo': Record<string, unknown>;
  'Mailbox/get': GetResponse<Mailbox>;
  'Mailbox/changes': ChangesResponse;
  'Mailbox/query': QueryResponse;
  'Mailbox/set': SetResponse<Mailbox>;
  'Email/get': GetResponse<Email>;
  'Email/changes': ChangesResponse;
  'Email/query': QueryResponse;
  'Email/queryChanges': { oldQueryState: string; newQueryState: string; removed: Id[]; added: { id: Id; index: number }[]; total?: number };
  'Email/set': SetResponse<Email>;
  'Email/import': SetResponse<Email>;
  'Email/copy': SetResponse<Email>;
  'Email/parse': { parsed: Record<Id, Email> | null; notParsable: Id[] | null; notFound: Id[] | null };
  'Thread/get': GetResponse<Thread>;
  'Thread/changes': ChangesResponse;
  'Identity/get': GetResponse<Identity>;
  'Identity/set': SetResponse<Identity>;
  'Identity/changes': ChangesResponse;
  'EmailSubmission/get': GetResponse<EmailSubmission>;
  'EmailSubmission/set': SetResponse<EmailSubmission>;
  'EmailSubmission/query': QueryResponse;
  'EmailSubmission/changes': ChangesResponse;
  'SearchSnippet/get': { accountId: Id; list: SearchSnippet[]; notFound: Id[] | null };
  'VacationResponse/get': GetResponse<VacationResponse>;
  'VacationResponse/set': SetResponse<VacationResponse>;
}
export type MethodName = keyof MethodMap;

/** Capability needed for a method, derived from its object type. */
export function capabilityFor(method: string): string[] {
  const type = method.split('/')[0]!;
  if (type.startsWith('x:')) return [CAP.stalwart];
  switch (type) {
    case 'Core':
      return [];
    case 'Mailbox':
    case 'Email':
    case 'Thread':
    case 'SearchSnippet':
      return [CAP.mail];
    case 'Identity':
    case 'EmailSubmission':
      return [CAP.mail, CAP.submission];
    case 'VacationResponse':
      return [CAP.mail, CAP.vacation];
    case 'Blob':
      return [CAP.blob];
    case 'Quota':
      return [CAP.quota];
    case 'Principal':
      return [CAP.principals];
    default:
      return [];
  }
}

export class JmapError extends Error {}

/** HTTP 401 — the BFF session is gone. */
export class JmapAuthError extends JmapError {
  constructor() {
    super('Not authenticated');
    this.name = 'JmapAuthError';
  }
}

/** Request-level error (RFC 8620 §3.6.1 problem details) or transport failure. */
export class JmapRequestError extends JmapError {
  constructor(
    public status: number,
    public type: string,
    detail?: string,
  ) {
    super(detail ?? `${type} (${status})`);
    this.name = 'JmapRequestError';
  }
}

/** Method-level error (RFC 8620 §3.6.2). */
export class JmapMethodError extends JmapError {
  constructor(
    public method: string,
    public type: string,
    public description?: string,
    public details?: Record<string, unknown>,
  ) {
    super(`${method}: ${type}${description ? ` — ${description}` : ''}`);
    this.name = 'JmapMethodError';
  }
}

/** Handle to one method call inside a batch. Use `ref()` for back-references. */
export class CallHandle<R> {
  /** phantom for typing */
  declare readonly _r?: R;
  constructor(
    public readonly id: string,
    public readonly method: string,
  ) {}
  /** RFC 8620 §3.7 ResultReference, e.g. `q.ref('/ids')`. */
  ref(path: string) {
    return { resultOf: this.id, name: this.method, path };
  }
}

type Invocation = [string, Record<string, unknown>, string];

export class BatchResult {
  constructor(
    private responses: Invocation[],
    public sessionState: string,
  ) {}
  /** The response for a call; throws JmapMethodError if the server returned an error for it. */
  get<R>(h: CallHandle<R>): R {
    const all = this.responses.filter((r) => r[2] === h.id);
    const err = all.find((r) => r[0] === 'error');
    if (err) {
      const { type, description, ...details } = err[1] as { type: string; description?: string };
      throw new JmapMethodError(h.method, type, description, details);
    }
    const ok = all.find((r) => r[0] === h.method) ?? all[0];
    if (!ok) throw new JmapMethodError(h.method, 'missingResponse');
    return ok[1] as R;
  }
  /** Secondary responses with the same call id (e.g. the implicit Email/set after EmailSubmission/set). */
  getAll(h: CallHandle<unknown>, method: string): Record<string, unknown>[] {
    return this.responses.filter((r) => r[2] === h.id && r[0] === method).map((r) => r[1]);
  }
  raw(): Invocation[] {
    return this.responses;
  }
}

export class Batch {
  private calls: Invocation[] = [];
  private using = new Set<string>([CAP.core]);
  private n = 0;
  constructor(private client: JmapClient) {}

  call<M extends MethodName>(method: M, args: Record<string, unknown>): CallHandle<MethodMap[M]>;
  call<R = Record<string, unknown>>(method: string, args: Record<string, unknown>, using?: string[]): CallHandle<R>;
  call(method: string, args: Record<string, unknown>, using?: string[]): CallHandle<unknown> {
    const caps = using ?? capabilityFor(method);
    caps.forEach((c) => this.using.add(c));
    const id = `c${this.n++}`;
    const withAccount =
      'accountId' in args || method === 'Core/echo' ? args : { accountId: this.client.accountIdFor(caps[caps.length - 1] ?? CAP.mail), ...args };
    this.calls.push([method, withAccount, id]);
    return new CallHandle(id, method);
  }

  get size(): number {
    return this.calls.length;
  }

  send(): Promise<BatchResult> {
    return this.client.send([...this.using], this.calls);
  }
}

export interface JmapClientOptions {
  /** Where to fetch the session object. Default `/jmap/session`. */
  sessionUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers on every request (e.g. the BFF's CSRF header). */
  headers?: Record<string, string>;
  /** Called on HTTP 401 (BFF session expired). */
  onUnauthorized?: () => void;
  /** Base for resolving relative URLs (defaults to location.origin in browsers). */
  baseUrl?: string;
}

export class JmapClient {
  session: Session | null = null;
  private fetchFn: typeof fetch;
  private opts: JmapClientOptions;

  constructor(opts: JmapClientOptions = {}) {
    this.opts = opts;
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private url(u: string): string {
    const base = this.opts.baseUrl ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost');
    return new URL(u, base).toString();
  }

  private async http(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url(url), {
        credentials: 'same-origin',
        ...init,
        headers: { ...(this.opts.headers ?? {}), ...((init.headers as Record<string, string>) ?? {}) },
      });
    } catch (e) {
      throw new JmapRequestError(0, 'network', (e as Error).message);
    }
    if (res.status === 401) {
      this.opts.onUnauthorized?.();
      throw new JmapAuthError();
    }
    if (!res.ok) {
      let type = 'http';
      let detail = res.statusText;
      try {
        const j = (await res.json()) as { type?: string; detail?: string; message?: string };
        type = j.type ?? type;
        detail = j.detail ?? j.message ?? detail;
      } catch {
        /* not json */
      }
      throw new JmapRequestError(res.status, type, detail);
    }
    return res;
  }

  async connect(): Promise<Session> {
    const res = await this.http(this.opts.sessionUrl ?? '/jmap/session', { headers: { Accept: 'application/json' } });
    this.session = (await res.json()) as Session;
    return this.session;
  }

  private requireSession(): Session {
    if (!this.session) throw new JmapError('JmapClient.connect() has not been called');
    return this.session;
  }

  /** Primary account for a capability (defaults to mail). */
  accountIdFor(capability: string = CAP.mail): Id {
    const s = this.requireSession();
    return s.primaryAccounts[capability] ?? s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0]!;
  }

  get accountId(): Id {
    return this.accountIdFor(CAP.mail);
  }

  /** Does the account advertise a capability? */
  hasCapability(capability: string, accountId = this.accountId): boolean {
    const s = this.requireSession();
    return capability in (s.accounts[accountId]?.accountCapabilities ?? {}) || capability in s.capabilities;
  }

  accountCapability<T = Record<string, unknown>>(capability: string, accountId = this.accountId): T | undefined {
    return this.session?.accounts[accountId]?.accountCapabilities[capability] as T | undefined;
  }

  get limits() {
    return this.requireSession().capabilities[CAP.core];
  }

  batch(): Batch {
    return new Batch(this);
  }

  async send(using: string[], methodCalls: Invocation[]): Promise<BatchResult> {
    const s = this.requireSession();
    const max = s.capabilities[CAP.core]?.maxCallsInRequest;
    if (max && methodCalls.length > max) throw new JmapError(`Too many calls in one request (${methodCalls.length} > ${max})`);
    const res = await this.http(s.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ using, methodCalls }),
    });
    const json = (await res.json()) as { methodResponses: Invocation[]; sessionState: string };
    if (json.sessionState && json.sessionState !== s.state) {
      // Session changed (e.g. new account shared); refresh lazily.
      s.state = json.sessionState;
    }
    return new BatchResult(json.methodResponses, json.sessionState);
  }

  /** Single method call convenience. */
  async call<M extends MethodName>(method: M, args: Record<string, unknown>): Promise<MethodMap[M]> {
    const b = this.batch();
    const h = b.call(method, args);
    return (await b.send()).get(h);
  }

  // ------------------------------------------------------------- typed helpers
  mailboxGet(args: { ids?: Id[] | null; properties?: string[] } = {}) {
    return this.call('Mailbox/get', { ids: null, ...args });
  }
  mailboxChanges(sinceState: string, maxChanges?: number) {
    return this.call('Mailbox/changes', { sinceState, ...(maxChanges ? { maxChanges } : {}) });
  }
  mailboxSet(args: Record<string, unknown>) {
    return this.call('Mailbox/set', args);
  }
  emailQuery(args: Record<string, unknown>) {
    return this.call('Email/query', args);
  }
  emailGet(args: {
    ids: Id[];
    properties?: string[];
    fetchHTMLBodyValues?: boolean;
    fetchTextBodyValues?: boolean;
    fetchAllBodyValues?: boolean;
    maxBodyValueBytes?: number;
    bodyProperties?: string[];
  }) {
    return this.call('Email/get', args);
  }
  emailSet(args: Record<string, unknown>) {
    return this.call('Email/set', args);
  }
  emailChanges(sinceState: string, maxChanges?: number) {
    return this.call('Email/changes', { sinceState, ...(maxChanges ? { maxChanges } : {}) });
  }
  threadGet(ids: Id[]) {
    return this.call('Thread/get', { ids });
  }
  identityGet() {
    return this.call('Identity/get', { ids: null });
  }
  searchSnippetGet(emailIds: Id[], filter: unknown) {
    return this.call('SearchSnippet/get', { emailIds, filter });
  }
  vacationGet() {
    return this.call('VacationResponse/get', { ids: ['singleton'] });
  }
  vacationSet(patch: Partial<VacationResponse>) {
    return this.call('VacationResponse/set', { update: { singleton: patch } });
  }

  // ------------------------------------------------------------- blobs
  async upload(data: Blob, accountId = this.accountId, onProgress?: (fraction: number) => void): Promise<{ blobId: Id; type: string; size: number }> {
    const s = this.requireSession();
    const url = s.uploadUrl.replace('{accountId}', encodeURIComponent(accountId));
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', this.url(url));
        xhr.withCredentials = true;
        for (const [k, v] of Object.entries(this.opts.headers ?? {})) xhr.setRequestHeader(k, v);
        xhr.setRequestHeader('Content-Type', data.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
        xhr.onload = () => {
          if (xhr.status === 401) {
            this.opts.onUnauthorized?.();
            return reject(new JmapAuthError());
          }
          if (xhr.status < 200 || xhr.status >= 300) return reject(new JmapRequestError(xhr.status, 'upload', xhr.responseText));
          resolve(JSON.parse(xhr.responseText));
        };
        xhr.onerror = () => reject(new JmapRequestError(0, 'network', 'Upload failed'));
        xhr.send(data);
      });
    }
    const res = await this.http(url, { method: 'POST', headers: { 'Content-Type': data.type || 'application/octet-stream' }, body: data });
    return (await res.json()) as { blobId: Id; type: string; size: number };
  }

  downloadUrl(blobId: Id, name: string, type = 'application/octet-stream', opts: { accountId?: Id; inline?: boolean } = {}): string {
    const s = this.requireSession();
    const u = s.downloadUrl
      .replace('{accountId}', encodeURIComponent(opts.accountId ?? this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name || 'attachment'))
      .replace('{type}', encodeURIComponent(type));
    return opts.inline ? `${u}${u.includes('?') ? '&' : '?'}inline=1` : u;
  }

  async downloadBlob(blobId: Id, name = 'blob', type?: string): Promise<Blob> {
    const res = await this.http(this.downloadUrl(blobId, name, type), {});
    return res.blob();
  }

  // ------------------------------------------------------------- push
  /**
   * Subscribe to RFC 8620 §7.3 EventSource push. Returns an unsubscribe fn.
   * The browser's EventSource reconnects automatically.
   */
  subscribe(onChange: (change: StateChange) => void, opts: { types?: string[]; ping?: number; onOpen?: () => void; onError?: () => void } = {}): () => void {
    const s = this.requireSession();
    if (typeof EventSource === 'undefined') return () => {};
    const url = s.eventSourceUrl
      .replace('{types}', encodeURIComponent((opts.types ?? ['*']).join(',')))
      .replace('{closeafter}', 'no')
      .replace('{ping}', String(opts.ping ?? 60));
    const es = new EventSource(this.url(url), { withCredentials: true });
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as StateChange;
        if (data['@type'] === 'StateChange') onChange(data);
      } catch {
        /* ping or garbage */
      }
    };
    es.addEventListener('state', handler as EventListener);
    es.onmessage = handler;
    es.onopen = () => opts.onOpen?.();
    es.onerror = () => opts.onError?.();
    return () => es.close();
  }
}
