import { GalleryVerticalEnd } from 'lucide-react';
import { AppIcon, type IconTone } from '@/components/ui/AppIcon';
import type { BadgeTone } from '@/components/ui/Badge';

export function statusTone(code: number): { badge: BadgeTone; tone: IconTone } {
  if (code >= 500) return { badge: 'error', tone: 'red' };
  if (code >= 400) return { badge: 'warning', tone: 'amber' };
  if (code >= 300) return { badge: 'info', tone: 'blue' };
  return { badge: 'success', tone: 'green' };
}

export function LogIcon({ status, size = 32 }: { status: number; size?: number }) {
  return (
    <AppIcon size={size} tone={statusTone(status).tone} glyphSize={size === 32 ? 17 : 36}>
      <GalleryVerticalEnd strokeWidth={2} />
    </AppIcon>
  );
}

/** "resend-node:6.34.1" → "node", "curl/8.7.1" → "curl". */
export function shortUserAgent(ua: string | null | undefined): string {
  if (!ua) return '—';
  const m = ua.match(/^resend-([a-z.]+)[:/]/i);
  if (m) return m[1]!.toLowerCase();
  const first = ua.split(/[\s/:;(]/)[0] ?? ua;
  return first.toLowerCase() || ua;
}

export const USER_AGENTS = [
  { value: 'resend-node', label: 'Node.js' },
  { value: 'resend-python', label: 'Python' },
  { value: 'resend-php', label: 'PHP' },
  { value: 'resend-ruby', label: 'Ruby' },
  { value: 'resend-go', label: 'Go' },
  { value: 'resend-rust', label: 'Rust' },
  { value: 'resend-java', label: 'Java' },
  { value: 'resend-dotnet', label: '.NET' },
  { value: 'curl', label: 'cURL' },
];

export const LOG_STATUSES = [
  { value: '2xx', label: '2xx Success', dot: 'var(--green-a11)' },
  { value: '4xx', label: '4xx Client errors', dot: 'var(--amber-a11)' },
  { value: '5xx', label: '5xx Server errors', dot: 'var(--red-a11)' },
  { value: '200', label: '200 OK', dot: 'var(--green-a11)' },
  { value: '400', label: '400 Bad Request', dot: 'var(--amber-a11)' },
  { value: '401', label: '401 Unauthorized', dot: 'var(--amber-a11)' },
  { value: '403', label: '403 Forbidden', dot: 'var(--amber-a11)' },
  { value: '404', label: '404 Not Found', dot: 'var(--amber-a11)' },
  { value: '422', label: '422 Unprocessable', dot: 'var(--amber-a11)' },
  { value: '429', label: '429 Too Many Requests', dot: 'var(--amber-a11)' },
  { value: '500', label: '500 Internal Error', dot: 'var(--red-a11)' },
] as const;
