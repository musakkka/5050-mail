/**
 * Where to go after signing in: only a path on this origin. Anything that could leave the origin
 * (`//host`, `/\host`, `https://…`, control characters) falls back to the inbox.
 */
export function safeNext(next: string | null | undefined, origin: string = location.origin): string {
  const fallback = '/mail/inbox';
  if (!next || !next.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(next) || next.startsWith('//')) return fallback;
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return fallback;
    if (u.pathname === '/login' || u.pathname.startsWith('/login/')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
