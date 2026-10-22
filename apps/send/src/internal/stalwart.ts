/** Copied from web/server/src/stalwart.ts (webmail BFF) — login verification against Stalwart. */
/** Minimal server-side helpers for talking to Stalwart during login. */

export type FetchFn = typeof fetch;

export function basicAuth(email: string, password: string): string {
  return 'Basic ' + Buffer.from(`${email}:${password}`, 'utf8').toString('base64');
}

export interface UpstreamSession {
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean; accountCapabilities: Record<string, unknown> }>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
  [k: string]: unknown;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Returns the JMAP session if the credentials are valid, null if they are rejected. */
export async function fetchSession(
  fetchFn: FetchFn,
  stalwartUrl: string,
  authorization: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<UpstreamSession | null> {
  const res = await fetchFn(`${stalwartUrl}/jmap/session`, {
    headers: { Authorization: authorization, Accept: 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new UpstreamError(`Stalwart session returned ${res.status}`, res.status);
  return (await res.json()) as UpstreamSession;
}

export interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][];
}

export async function jmapCall(
  fetchFn: FetchFn,
  stalwartUrl: string,
  authorization: string,
  using: string[],
  methodCalls: [string, Record<string, unknown>, string][],
): Promise<JmapResponse | null> {
  const res = await fetchFn(`${stalwartUrl}/jmap/`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ using, methodCalls }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return (await res.json()) as JmapResponse;
}

/**
 * An account is an admin if it may call Stalwart's management API.
 * A `forbidden` / `unknownMethod` / `unknownCapability` error (or any failure) means non-admin.
 */
export async function detectAdmin(fetchFn: FetchFn, stalwartUrl: string, authorization: string, session: UpstreamSession): Promise<boolean> {
  try {
    const accountId = session.primaryAccounts['urn:stalwart:jmap'] ?? session.primaryAccounts['urn:ietf:params:jmap:mail'];
    const r = await jmapCall(
      fetchFn,
      stalwartUrl,
      authorization,
      ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      [['x:Account/query', { ...(accountId ? { accountId } : {}), limit: 1 }, '0']],
    );
    const first = r?.methodResponses?.[0];
    return !!first && first[0] === 'x:Account/query';
  } catch {
    return false;
  }
}

/** Best-effort display name: the primary Identity's name, else the local part of the address. */
export async function fetchDisplayName(fetchFn: FetchFn, stalwartUrl: string, authorization: string, session: UpstreamSession, email: string): Promise<string> {
  const fallback = email.split('@')[0] ?? email;
  try {
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:submission'];
    if (!accountId) return fallback;
    const r = await jmapCall(
      fetchFn,
      stalwartUrl,
      authorization,
      ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      [['Identity/get', { accountId }, '0']],
    );
    const list = (r?.methodResponses?.[0]?.[1]?.list ?? []) as { name?: string; email?: string }[];
    const own = list.find((i) => i.email?.toLowerCase() === email.toLowerCase()) ?? list[0];
    return own?.name?.trim() || fallback;
  } catch {
    return fallback;
  }
}
