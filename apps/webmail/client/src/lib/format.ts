import type { EmailAddress } from '../jmap/types';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** List date column: today "3:41 PM"; this year "Oct 21"; older "10/21/25". */
export function formatListDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
}

/** Tooltip / full date: "Tue, Oct 21, 2026, 3:41 PM". */
export function formatFullDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "2 hours ago", "3 days ago". */
export function formatRelative(iso: string, now = new Date()): string {
  const diff = (now.getTime() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (diff < 60) return 'now';
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), 'hour');
  if (diff < 86400 * 30) return rtf.format(-Math.floor(diff / 86400), 'day');
  if (diff < 86400 * 365) return rtf.format(-Math.floor(diff / (86400 * 30)), 'month');
  return rtf.format(-Math.floor(diff / (86400 * 365)), 'year');
}

/** Conversation header date: "3:41 PM (2 hours ago)" or "Oct 21, 2026, 3:41 PM (2 days ago)". */
export function formatMessageDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const rel = formatRelative(iso, now);
  const abs = sameDay(d, now)
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${abs} (${rel})`;
}

/** Short "Tue, Oct 22, 8:00 AM" used in snooze/schedule copy. */
export function formatShortDateTime(d: Date): string {
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString(undefined);
}

/** Display name for an address, "me" for the user's own addresses. */
export function displayName(a: EmailAddress | null | undefined, myEmails?: Set<string>, opts: { short?: boolean } = {}): string {
  if (!a) return '(unknown)';
  if (myEmails?.has(a.email.toLowerCase())) return 'me';
  const name = a.name?.trim() || a.email.split('@')[0] || a.email;
  if (opts.short) return name.split(/\s+/)[0] ?? name;
  return name;
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function stripSubjectPrefix(s: string): string {
  return s.replace(/^((re|fwd?|aw|wg|sv|vs)(\[\d+\])?:\s*)+/i, '');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n === 1 ? 'one' : n} ${n === 1 ? one : many}`;
}
