import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu as M } from '@base-ui/react/menu';
import { Check, ChevronDown, Download, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input } from './Input';
import { Button, buttonClass } from './Button';
import { ITEM_CLASS, POPUP_CLASS } from './Menu';
import { Select } from './Select';
import { Tooltip } from './Tooltip';

/** Debounced search field (focus with "/"). */
export function SearchInput({ value, onChange, placeholder = 'Search...', className, delay = 250 }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; delay?: number }) {
  const [v, setV] = useState(value);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <Input
      wrapperClassName={className}
      left={<Search size={16} className="text-default" />}
      right={
        v ? (
          <button
            type="button"
            aria-label="Clear search"
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-default hover:bg-interactive-hover hover:text-emphasis"
            onClick={() => {
              setV('');
              onChange('');
            }}
          >
            <X size={14} />
          </button>
        ) : undefined
      }
      rightWidth={v ? 32 : 12}
      placeholder={placeholder}
      type="text"
      value={v}
      data-page-search=""
      aria-label={placeholder.replace(/\.+$/, '')}
      onChange={(e) => {
        const nv = e.target.value;
        setV(nv);
        window.clearTimeout(t.current);
        t.current = window.setTimeout(() => onChange(nv.trim()), delay);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && v) {
          e.stopPropagation();
          setV('');
          onChange('');
        }
      }}
    />
  );
}

export interface FilterOption<V extends string> {
  value: V;
  label: string;
  dot?: string;
}

/** Menu-style filter ("All Statuses") with coloured dots and a check on the active option. */
export function FilterMenu<V extends string>({ value, onChange, options, allLabel, className }: { value: V | ''; onChange: (v: V | '') => void; options: FilterOption<V>[]; allLabel: string; className?: string }) {
  const current = options.find((o) => o.value === value);
  const item = (val: V | '', label: string, dot?: string) => (
    <M.Item key={val || 'all'} className={cn(ITEM_CLASS, 'justify-between select-none group')} onClick={() => onChange(val)}>
      <div className="flex items-center gap-2">
        {val === '' ? <span className="block h-2 w-2 rounded-full bg-background border-gray-10 border-[1.5px]" /> : <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: dot }} />}
        <span className="text-sm font-normal text-default">{label}</span>
      </div>
      {value === val ? <Check size={14} className="text-default" /> : null}
    </M.Item>
  );
  return (
    <M.Root>
      <M.Trigger className={buttonClass('secondary', '2', cn('justify-between pr-2 font-normal group w-full', className))}>
        <span className="block truncate min-w-0 text-left">{current ? current.label : allLabel}</span>
        <span className="opacity-100 shrink-0">
          <ChevronDown size={16} className="text-default transition-transform group-aria-expanded:rotate-180" />
        </span>
      </M.Trigger>
      <M.Portal>
        <M.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className={cn(POPUP_CLASS, 'max-w-[19rem] min-w-(--anchor-width) w-56')}>
            {item('', allLabel)}
            <M.Separator className="min-h-px w-full bg-interactive-hover" />
            {options.map((o) => item(o.value, o.label, o.dot))}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}

/** Square export button (download icon) that shows "Export data" on small screens. */
export function ExportButton({ onClick, disabled, label = 'Export data' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-disabled={disabled ? '' : undefined}
        aria-label={label}
        className={buttonClass('secondary', '2', 'w-full justify-center gap-2 md:w-auto md:justify-center md:p-0 md:min-w-8')}
      >
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">
          <Download size={18} />
          <span className="md:hidden">{label}</span>
        </span>
      </button>
    </Tooltip>
  );
}

/** Cursor pagination: "Newer" / "Older" (emails, logs). */
export function CursorPager({ hasNewer, hasOlder, onNewer, onOlder, left }: { hasNewer: boolean; hasOlder: boolean; onNewer: () => void; onOlder: () => void; left?: ReactNode }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-between px-0 py-4">
      <div className="text-xs text-default">{left}</div>
      <div className="flex gap-2">
        <Button size="1" disabled={!hasNewer} onClick={onNewer}>
          Newer
        </Button>
        <Button size="1" disabled={!hasOlder} onClick={onOlder}>
          Older
        </Button>
      </div>
    </div>
  );
}

/** Client-side paging footer: "Page 1 – 1 of 3 keys – 40 items ▾" with prev/next. */
export function PageFooter({
  page,
  pageSize,
  total,
  noun,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 py-4">
      <span className="text-xs text-default font-normal inline-flex flex-wrap items-center gap-1">
        Page {page} – {Math.min(total, page * pageSize)} of {total} {noun} –{' '}
        <Select
          variant="inline"
          ariaLabel="Items per page"
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v))}
          options={[20, 40, 60, 100].map((n) => ({ value: String(n), label: `${n} items` }))}
        />
      </span>
      {pages > 1 ? (
        <div className="flex gap-2">
          <Button size="1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </Button>
          <Button size="1" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export { Download };
