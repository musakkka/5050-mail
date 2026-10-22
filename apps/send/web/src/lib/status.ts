import type { BadgeTone } from '@/components/ui/Badge';
import type { IconTone } from '@/components/ui/AppIcon';
import type { DomainStatus, EmailStatus } from '@/api/types';

export interface StatusInfo {
  label: string;
  /** Menu dot colour (same Radix steps as the reference filters). */
  dot: string;
  badge: BadgeTone;
  tone: IconTone;
}

export const EMAIL_STATUS: Record<EmailStatus, StatusInfo> = {
  bounced: { label: 'Bounced', dot: 'var(--red-a11)', badge: 'error', tone: 'red' },
  canceled: { label: 'Canceled', dot: 'var(--mauve-a10)', badge: 'neutral', tone: 'gray' },
  clicked: { label: 'Clicked', dot: 'var(--violet-a11)', badge: 'violet', tone: 'violet' },
  complained: { label: 'Complained', dot: 'var(--amber-a11)', badge: 'warning', tone: 'amber' },
  delivered: { label: 'Delivered', dot: 'var(--green-a11)', badge: 'success', tone: 'green' },
  delivery_delayed: { label: 'Delivery delayed', dot: 'var(--sand-a11)', badge: 'warning', tone: 'amber' },
  failed: { label: 'Failed', dot: 'var(--red-a9)', badge: 'error', tone: 'red' },
  opened: { label: 'Opened', dot: 'var(--blue-a11)', badge: 'info', tone: 'blue' },
  scheduled: { label: 'Scheduled', dot: 'var(--mauve-a11)', badge: 'neutral', tone: 'gray' },
  sent: { label: 'Sent', dot: 'var(--slate-a11)', badge: 'neutral', tone: 'gray' },
  queued: { label: 'Queued', dot: 'var(--sand-a11)', badge: 'neutral', tone: 'gray' },
  suppressed: { label: 'Suppressed', dot: 'var(--slate-a11)', badge: 'neutral', tone: 'gray' },
};

export const EMAIL_STATUS_ORDER: EmailStatus[] = ['bounced', 'canceled', 'clicked', 'complained', 'delivered', 'delivery_delayed', 'failed', 'opened', 'scheduled', 'sent', 'queued', 'suppressed'];

export function emailStatus(s: string): StatusInfo {
  return EMAIL_STATUS[s as EmailStatus] ?? { label: s.replace(/_/g, ' '), dot: 'var(--gray-9)', badge: 'neutral', tone: 'gray' };
}

export const DOMAIN_STATUS: Record<DomainStatus, { label: string; badge: BadgeTone; tone: IconTone }> = {
  verified: { label: 'Verified', badge: 'success', tone: 'green' },
  pending: { label: 'Pending', badge: 'warning', tone: 'amber' },
  not_started: { label: 'Not started', badge: 'neutral', tone: 'gray' },
  failed: { label: 'Failed', badge: 'error', tone: 'red' },
  temporary_failure: { label: 'Temporary failure', badge: 'warning', tone: 'amber' },
  partially_verified: { label: 'Partially verified', badge: 'warning', tone: 'amber' },
  partially_failed: { label: 'Partially failed', badge: 'error', tone: 'red' },
};

export function domainStatus(s: string) {
  return DOMAIN_STATUS[s as DomainStatus] ?? { label: s.replace(/_/g, ' '), badge: 'neutral' as BadgeTone, tone: 'gray' as IconTone };
}

export const REGIONS: Record<string, { label: string; flag: string }> = {
  'us-east-1': { label: 'North Virginia', flag: '🇺🇸' },
  'eu-west-1': { label: 'Ireland', flag: '🇮🇪' },
  'sa-east-1': { label: 'São Paulo', flag: '🇧🇷' },
  'ap-northeast-1': { label: 'Tokyo', flag: '🇯🇵' },
};

export function httpTone(status: number): BadgeTone {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';
  if (status >= 200 && status < 300) return 'success';
  return 'neutral';
}
