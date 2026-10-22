import { formatDistanceToNowStrict, formatDistanceToNow, format } from 'date-fns';

/** "3h ago", "1d ago", "10mo ago" — the compact relative time used in tables. */
export function timeAgoShort(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  let out: string;
  if (a < 45) out = 'now';
  else if (a < 3600) out = `${Math.max(1, Math.round(a / 60))}m`;
  else if (a < 86400) out = `${Math.floor(a / 3600)}h`;
  else if (a < 86400 * 30) out = `${Math.floor(a / 86400)}d`;
  else if (a < 86400 * 365) out = `${Math.floor(a / (86400 * 30))}mo`;
  else out = `${Math.floor(a / (86400 * 365))}y`;
  if (out === 'now') return 'just now';
  return future ? `in ${out}` : `${out} ago`;
}

/** "about 3 hours ago" (date-fns wording). */
export function timeAgoLong(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  return formatDistanceToNow(d, { addSuffix: true });
}

export function timeAgoStrict(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

/** "Oct 22, 12:38 AM" */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(new Date(iso), 'MMM d, h:mm a');
}

/** "Oct 22, 2026, 12:38:39 AM" (tooltips). */
export function fullDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(new Date(iso), 'MMM d, yyyy, h:mm:ss a');
}

/** "Oct 22, 2026" */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return format(new Date(iso), 'MMM d, yyyy');
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatPercent(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '0%';
  const v = n * 100;
  const s = v.toFixed(digits);
  return `${digits > 0 ? String(Number(s)) : s}%`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** First character for avatars. */
export function initial(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t ? t[0]!.toUpperCase() : '?';
}

/** Mask an API key token like "re_joqCkFGS..." */
export function tokenPreview(t: string): string {
  return t.length > 11 ? `${t.slice(0, 11)}...` : t;
}
