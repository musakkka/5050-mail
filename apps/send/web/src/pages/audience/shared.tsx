import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { contacts as contactsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import type { Contact } from '@/api/types';
import { PageBody, PageHeader } from '@/components/layout/Page';
import { LinkTabs } from '@/components/ui/Tabs';
import { AppIcon } from '@/components/ui/AppIcon';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { useTeamId } from '@/state/session';
import { cn } from '@/lib/cn';

export const AUDIENCE_TABS = [
  { to: '/audience', label: 'Contacts', match: (p: string) => p === '/audience' || p === '/audience/' || p.startsWith('/audience/contacts') },
  { to: '/audience/properties', label: 'Properties' },
  { to: '/audience/segments', label: 'Segments' },
  { to: '/audience/topics', label: 'Topics' },
];

/** "Audience" title + Contacts/Properties/Segments/Topics tabs with the page's actions on the right. */
export function AudienceFrame({ title, actions, children }: { title: string; actions: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader title="Audience" actions={<div className="flex gap-2 sm:hidden">{actions}</div>} />
      <TitleOverride title={title} />
      <PageBody>
        <div className="mb-4 flex items-center justify-between gap-2">
          <LinkTabs tabs={AUDIENCE_TABS} className="min-w-0" />
          <div className="hidden sm:flex">
            <div className="flex gap-2">{actions}</div>
          </div>
        </div>
        {children}
      </PageBody>
    </>
  );
}

function TitleOverride({ title }: { title: string }) {
  // PageHeader sets "Audience"; the reference titles each tab ("Contacts · …"). Runs after PageHeader's effect.
  useEffect(() => {
    document.title = `${title} · 5050 Send`;
  }, [title]);
  return null;
}

/** All contacts of the team (paged through the API), for client-side search/filters/counts. */
export function useAllContacts() {
  return useTeamQuery(['contacts', 'all'], async (t) => {
    const out: Contact[] = [];
    let after: string | undefined;
    for (let i = 0; i < 200; i++) {
      const page = await contactsApi.list(t, { limit: 100, after });
      out.push(...page.data);
      if (!page.has_more || !page.data.length) break;
      after = page.data.at(-1)!.id;
    }
    return out;
  });
}

/** Contacts of one segment (ids), used for filters and counts. */
export function useSegmentContacts(segmentId: string | null) {
  return useTeamQuery(
    ['contacts', 'segment', segmentId],
    async (t) => {
      const out: Contact[] = [];
      let after: string | undefined;
      for (let i = 0; i < 200; i++) {
        const page = await contactsApi.list(t, { limit: 100, after, segment_id: segmentId! });
        out.push(...page.data);
        if (!page.has_more || !page.data.length) break;
        after = page.data.at(-1)!.id;
      }
      return out;
    },
    { enabled: !!segmentId },
  );
}

export function useInvalidateAudience() {
  const qc = useQueryClient();
  const t = useTeamId();
  return () =>
    Promise.all(
      ['contacts', 'segments', 'topics', 'properties'].map((k) => qc.invalidateQueries({ queryKey: ['team', t, k] })),
    );
}

export function SegmentIcon({ size = 32 }: { size?: number }) {
  return (
    <AppIcon size={size} tone="gray" glyphSize={Math.round(size * 0.53)}>
      <Users strokeWidth={2} />
    </AppIcon>
  );
}

/** Uppercase stat (ALL CONTACTS / SUBSCRIBERS …). */
export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span className="text-xs text-default font-normal uppercase">{label}</span>
      <span className="text-sm text-emphasis font-normal">{value}</span>
    </div>
  );
}

/** Dashed-underline number with a tooltip-able look (segment counts). */
export function DashedNumber({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="cursor-help border-b border-dashed border-link bg-transparent p-0 text-inherit">
      {children}
    </span>
  );
}

/** Destructive confirmation dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  loading,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} onSubmit={loading ? undefined : onConfirm} size="sm">
      <DialogActions>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} kbd={['⌘', '↩︎']}>
          {confirmLabel}
        </Button>
        <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function contactName(c: Pick<Contact, 'first_name' | 'last_name'>): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ');
}

export const BULK_CONTAINER = '@container/bulk-actions';
export const ROW_CHECK_WRAP =
  'flex items-center overflow-visible @min-[68.6rem]/bulk-actions:absolute @min-[68.6rem]/bulk-actions:-left-8 @min-[68.6rem]/bulk-actions:top-0 @min-[68.6rem]/bulk-actions:w-9 @min-[68.6rem]/bulk-actions:h-full @min-[68.6rem]/bulk-actions:opacity-0 @min-[68.6rem]/bulk-actions:group-hover:opacity-100 @min-[68.6rem]/bulk-actions:group-focus-within:opacity-100 @min-[68.6rem]/bulk-actions:group-data-active:opacity-100';
export const HEAD_CHECK_WRAP =
  '-ml-[5px] md:-ml-px @min-[68.6rem]/bulk-actions:ml-0 relative flex @min-[68.6rem]/bulk-actions:absolute @min-[68.6rem]/bulk-actions:-left-8 @min-[68.6rem]/bulk-actions:top-0 items-center w-8 h-7 @min-[68.6rem]/bulk-actions:opacity-0 @min-[68.6rem]/bulk-actions:group-hover:opacity-100 @min-[68.6rem]/bulk-actions:group-focus-within:opacity-100';
