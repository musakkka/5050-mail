/** BFF auth API (cookie session; the password never touches browser storage). */
import { setMailHost } from '../admin/mailSettings';
export interface Me {
  email: string;
  name: string;
  isAdmin: boolean;
  /** Mail server hostname for IMAP/SMTP settings (MAIL_HOSTNAME). */
  mailHost?: string | null;
}

export const CSRF_HEADERS = { 'X-Requested-With': '5050' } as const;

export class AuthError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new AuthError(body.message ?? `Request failed (${res.status})`, res.status, body.error);
  return body;
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) return null;
  const me = await json<Me>(res);
  setMailHost(me.mailHost);
  return me;
}

export async function login(email: string, password: string): Promise<Me> {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify({ email, password }),
  });
  return json<Me>(res);
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: CSRF_HEADERS });
}
