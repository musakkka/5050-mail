import type { BadgeTone } from '@/components/ui/Badge';
import type { IconTone } from '@/components/ui/AppIcon';
import type { BroadcastStatus } from '@/api/types';

export const BROADCAST_STATUS: Record<BroadcastStatus, { label: string; badge: BadgeTone; tone: IconTone; dot: string }> = {
  draft: { label: 'Draft', badge: 'neutral', tone: 'gray', dot: 'var(--slate-a11)' },
  scheduled: { label: 'Scheduled', badge: 'info', tone: 'blue', dot: 'var(--blue-a11)' },
  queued: { label: 'Queued', badge: 'warning', tone: 'amber', dot: 'var(--sand-a11)' },
  sending: { label: 'Sending', badge: 'warning', tone: 'amber', dot: 'var(--amber-a11)' },
  sent: { label: 'Sent', badge: 'success', tone: 'green', dot: 'var(--green-a11)' },
  canceled: { label: 'Canceled', badge: 'neutral', tone: 'gray', dot: 'var(--mauve-a10)' },
  failed: { label: 'Failed', badge: 'error', tone: 'red', dot: 'var(--red-a9)' },
};

export function broadcastStatus(s: string) {
  return BROADCAST_STATUS[s as BroadcastStatus] ?? { label: s, badge: 'neutral' as BadgeTone, tone: 'gray' as IconTone, dot: 'var(--gray-9)' };
}
