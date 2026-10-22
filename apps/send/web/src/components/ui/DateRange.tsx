import { useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { DayPicker, type DateRange as RdpRange } from 'react-day-picker';
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { format, startOfDay, endOfDay, subDays } from 'date-fns';
import { cn } from '@/lib/cn';
import { buttonClass } from './Button';

export type RangePreset = 'today' | 'yesterday' | '3d' | '7d' | '15d' | '30d' | 'custom';

export interface DateRangeValue {
  preset: RangePreset;
  from: Date;
  to: Date;
}

export const PRESETS: { id: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '3d', label: 'Last 3 days' },
  { id: '7d', label: 'Last 7 days' },
  { id: '15d', label: 'Last 15 days' },
  { id: '30d', label: 'Last 30 days' },
];

export function presetRange(id: Exclude<RangePreset, 'custom'>, now = new Date()): DateRangeValue {
  const today = startOfDay(now);
  switch (id) {
    case 'today':
      return { preset: id, from: today, to: endOfDay(now) };
    case 'yesterday':
      return { preset: id, from: subDays(today, 1), to: endOfDay(subDays(today, 1)) };
    case '3d':
      return { preset: id, from: subDays(today, 2), to: endOfDay(now) };
    case '7d':
      return { preset: id, from: subDays(today, 6), to: endOfDay(now) };
    case '15d':
      return { preset: id, from: subDays(today, 14), to: endOfDay(now) };
    case '30d':
      return { preset: id, from: subDays(today, 29), to: endOfDay(now) };
  }
}

export function rangeLabel(v: DateRangeValue): string {
  if (v.preset !== 'custom') return PRESETS.find((p) => p.id === v.preset)!.label;
  const same = format(v.from, 'yyyy-MM-dd') === format(v.to, 'yyyy-MM-dd');
  return same ? format(v.from, 'MMM d') : `${format(v.from, 'MMM d')} – ${format(v.to, 'MMM d')}`;
}

const PRESET_ITEM =
  'w-full text-left flex justify-between items-center rounded-xl px-2 text-sm focus-visible:outline-hidden min-h-8 text-default not-data-[disabled=true]:hover:bg-interactive not-data-[disabled=true]:hover:text-emphasis cursor-pointer focus-visible:bg-interactive focus-visible:text-emphasis data-[selected=true]:bg-interactive data-[selected=true]:text-emphasis';

/** Filter button + popover with presets and a range calendar (no future dates). */
export function DateRangePicker({ value, onChange, className, maxDays = 90 }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; className?: string; maxDays?: number }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RdpRange | undefined>({ from: value.from, to: value.to });
  const today = new Date();
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft({ from: value.from, to: value.to });
      }}
    >
      <Popover.Trigger className={buttonClass('secondary', '2', cn('justify-between pr-2 font-normal group w-full', className))}>
        <span className="block truncate min-w-0 text-left">{rangeLabel(value)}</span>
        <span className="opacity-100 shrink-0">
          <ChevronDown size={16} className="text-default transition-transform group-aria-expanded:rotate-180 group-data-[popup-open]:rotate-180" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1000]">
          <Popover.Popup className="bg-background border border-interactive shadow-lg outline-hidden focus-visible:outline-hidden z-50 px-0 py-3.5 rounded-3xl w-[min(var(--anchor-width),calc(100vw-16px))] md:w-auto max-h-[var(--available-height)] overflow-y-auto origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0">
            <div className="flex flex-col gap-4 md:flex-row w-full items-center md:items-start">
              <div className="min-w-[10.2rem] px-2 w-full flex flex-col gap-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={PRESET_ITEM}
                    data-selected={value.preset === p.id}
                    onClick={() => {
                      onChange(presetRange(p.id));
                      setOpen(false);
                    }}
                  >
                    <span>{p.label}</span>
                    <span className={cn('inline-flex w-6 items-center justify-center text-default', value.preset === p.id ? 'opacity-100' : 'opacity-0')}>
                      <Check size={14} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="px-2 md:pl-0 md:pr-3.5" style={{ width: 262 }}>
                <DayPicker
                  mode="range"
                  required={false}
                  selected={draft}
                  defaultMonth={value.to}
                  disabled={[{ after: today }, { before: subDays(today, maxDays) }]}
                  endMonth={today}
                  startMonth={subDays(today, maxDays)}
                  showOutsideDays={false}
                  formatters={{ formatWeekdayName: (d) => format(d, 'EEEEE') }}
                  onSelect={(r) => {
                    setDraft(r);
                    if (r?.from && r.to && r.from.getTime() !== r.to.getTime()) {
                      onChange({ preset: 'custom', from: startOfDay(r.from), to: endOfDay(r.to) });
                      setOpen(false);
                    }
                  }}
                  components={{
                    Chevron: ({ orientation }) => (orientation === 'left' ? <ChevronLeft size={16} /> : <ChevronRight size={16} />),
                  }}
                  classNames={{
                    root: 'relative',
                    months: 'relative flex',
                    month: 'w-full text-default',
                    month_caption: 'relative mx-10 flex h-8 items-center justify-center',
                    caption_label: 'truncate text-sm font-medium text-default',
                    nav: 'absolute inset-x-0 top-0 flex items-start justify-between z-10',
                    button_previous:
                      'inline-flex items-center justify-center h-8 w-8 rounded-xl text-default hover:bg-interactive-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus outline-hidden',
                    button_next:
                      'inline-flex items-center justify-center h-8 w-8 rounded-xl text-default hover:bg-interactive-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus outline-hidden',
                    month_grid: 'mx-auto mt-4',
                    weekdays: 'flex flex-row',
                    weekday: 'w-8 text-sm font-normal text-gray-a5 uppercase',
                    weeks: '',
                    week: 'mt-1 flex w-max items-start [&_td[aria-selected]:last-child]:rounded-r-xl [&_td[aria-selected]:first-child]:rounded-l-xl',
                    day: 'flex size-8 flex-1 items-center justify-center p-0 text-default text-xs',
                    day_button: 'size-8 rounded-xl p-0 text-emphasis transition-none hover:bg-interactive cursor-pointer disabled:cursor-not-allowed',
                    selected: 'bg-elevated [&>button]:!bg-transparent',
                    range_start: 'rounded-s-xl !bg-accent [&>button]:!text-on-accent',
                    range_end: 'rounded-e-xl !bg-accent [&>button]:!text-on-accent',
                    range_middle: 'bg-elevated',
                    today: 'relative after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:h-1 after:w-1 after:rounded-full after:bg-gray-8',
                    disabled: '[&>button]:text-gray-3 [&>button]:!bg-transparent [&>button]:cursor-not-allowed',
                    outside: 'invisible',
                    hidden: 'invisible',
                  }}
                />
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
