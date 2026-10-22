import { Globe } from 'lucide-react';
import { AppIcon, type IconTone } from '@/components/ui/AppIcon';
import { REGIONS } from '@/lib/status';
import { cn } from '@/lib/cn';
import { Checkbox } from '@/components/ui/Switch';

export const REGION_OPTIONS = Object.entries(REGIONS).map(([value, r]) => ({ value, ...r }));

/** Flag + "Ireland (eu-west-1)". */
export function RegionLabel({ region, className }: { region: string; className?: string }) {
  const r = REGIONS[region];
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <span aria-hidden="true" className="inline-flex h-[18px] w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm text-[17px] leading-none">
        {r?.flag ?? '🌐'}
      </span>
      <span className="truncate text-sm text-emphasis font-normal">
        {r?.label ?? region} <span className="text-gray-11">({region})</span>
      </span>
    </span>
  );
}

export function DomainIcon({ tone, size = 32 }: { tone: IconTone; size?: number }) {
  return (
    <AppIcon size={size} tone={tone} glyphSize={size >= 64 ? 36 : 17}>
      <Globe strokeWidth={size >= 64 ? 1.75 : 2} />
    </AppIcon>
  );
}

/** Lower-cased, trimmed host; strips scheme/path someone may paste. */
export function normalizeDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

export const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

const HEAD_CHECK =
  '-ml-[5px] md:-ml-px @min-[68.6rem]/bulk-actions:ml-0 relative flex @min-[68.6rem]/bulk-actions:absolute @min-[68.6rem]/bulk-actions:-left-8 @min-[68.6rem]/bulk-actions:top-0 items-center w-8 h-7 @min-[68.6rem]/bulk-actions:opacity-0 @min-[68.6rem]/bulk-actions:group-hover:opacity-100 @min-[68.6rem]/bulk-actions:group-focus-within:opacity-100';
const ROW_CHECK =
  'flex items-center overflow-visible @min-[68.6rem]/bulk-actions:absolute @min-[68.6rem]/bulk-actions:-left-8 @min-[68.6rem]/bulk-actions:top-0 @min-[68.6rem]/bulk-actions:w-9 @min-[68.6rem]/bulk-actions:h-full @min-[68.6rem]/bulk-actions:opacity-0 @min-[68.6rem]/bulk-actions:group-hover/row:opacity-100 @min-[68.6rem]/bulk-actions:group-focus-within/row:opacity-100';

/** Bulk-selection checkbox: inline on narrow tables, hanging in the left gutter on wide ones (shows on hover or when anything is selected). */
export function BulkCheck({ head, checked, indeterminate, onChange, label, visible }: { head?: boolean; checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string; visible?: boolean }) {
  return (
    <div className={cn(head ? HEAD_CHECK : ROW_CHECK, visible && '@min-[68.6rem]/bulk-actions:!opacity-100')}>
      <Checkbox checked={checked} indeterminate={indeterminate} onChange={onChange} label={label} className="my-auto" />
    </div>
  );
}
