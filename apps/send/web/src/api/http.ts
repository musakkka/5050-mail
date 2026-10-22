/**
 * Transport for the dashboard: cookie session against /api/internal/* on the
 * dashboard host. In mock mode (VITE_MOCK=1, used by `npm run dev:mock`, the
 * parity screenshots and e2e) requests are answered by an in-memory backend that
 * follows the same documented shapes.
 */
export const BASE = '/api/internal';
export const CSRF_HEADERS = { 'X-Requested-With': '5050-send' } as const;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface MockHandler {
  (method: Method, path: string, body: unknown): Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
}

let mock: MockHandler | null = null;
let mockLoading: Promise<MockHandler> | null = null;

export const MOCK_ENABLED: boolean = import.meta.env.VITE_MOCK === '1';

async function getMock(): Promise<MockHandler> {
  if (mock) return mock;
  mockLoading ??= import('./mock').then((m) => (mock = m.handle));
  return mockLoading;
}

/** Set by the app so a 401 anywhere sends the user back to the login page. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

function errorFrom(status: number, body: unknown): ApiError {
  const b = (body ?? {}) as { message?: string; error?: string; name?: string };
  const msg = b.message ?? (status === 0 ? 'Network error' : `Request failed (${status})`);
  return new ApiError(msg, status, b.error ?? b.name);
}

export async function request<T>(method: Method, path: string, body?: unknown, opts: { signal?: AbortSignal; raw?: boolean } = {}): Promise<T> {
  if (MOCK_ENABLED) {
    const h = await getMock();
    const res = await h(method, path, body);
    if (res.status === 401 && onUnauthorized && !path.endsWith('/login')) onUnauthorized();
    if (res.status >= 400) throw errorFrom(res.status, res.body);
    return res.body as T;
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      signal: opts.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? CSRF_HEADERS : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('Could not reach 5050 Send. Check your connection and try again.', 0, 'network');
  }
  if (opts.raw) {
    if (!res.ok) throw errorFrom(res.status, await res.json().catch(() => ({})));
    return (await res.text()) as T;
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && onUnauthorized && !path.endsWith('/login')) onUnauthorized();
  if (!res.ok) throw errorFrom(res.status, json);
  return json as T;
}

export const get = <T>(p: string, signal?: AbortSignal) => request<T>('GET', p, undefined, { signal });
export const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {});
export const patch = <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {});
export const put = <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {});
export const del = <T>(p: string) => request<T>('DELETE', p);

/** `?a=1&b=2`, dropping empty values; arrays repeat the key. */
export function qs(params: Record<string, string | number | boolean | null | undefined | string[]>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
