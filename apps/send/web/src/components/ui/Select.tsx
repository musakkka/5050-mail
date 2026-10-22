import { Select as S } from '@base-ui/react/select';
import type { ReactNode } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain-text label for the trigger when `label` is rich. */
  text?: string;
  disabled?: boolean;
  description?: ReactNode;
}

export const SELECT_TRIGGER_CLASS =
  'group/select inline-flex w-full cursor-pointer select-none appearance-none items-center justify-between outline-hidden [&>span]:truncate [&>span]:min-w-0 [&>span]:block [&>span]:text-left gap-1 disabled:cursor-not-allowed disabled:opacity-70 h-8 text-sm pl-3 pr-2 rounded-xl bg-interactive border border-interactive text-default not-disabled:hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-interactive-hover';

const OPTION_CLASS =
  'rounded-xl px-2 focus-visible:outline-hidden mx-1 min-h-8 text-default cursor-pointer not-data-disabled:hover:bg-interactive not-data-disabled:hover:text-emphasis not-data-disabled:focus-visible:bg-interactive not-data-disabled:focus-visible:text-emphasis not-data-disabled:data-highlighted:bg-interactive not-data-disabled:data-highlighted:text-emphasis data-selected:text-emphasis data-disabled:text-muted data-disabled:[&>svg]:opacity-50 relative flex select-none items-center justify-between text-sm outline-hidden pr-2 data-disabled:cursor-not-allowed data-disabled:opacity-70';

export function Select<V extends string>({
  value,
  onChange,
  options,
  className,
  placeholder,
  disabled,
  id,
  name,
  ariaLabel,
  popupClassName,
  triggerClassName,
  variant = 'default',
}: {
  value: V;
  onChange: (v: V) => void;
  options: SelectOption<V>[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  popupClassName?: string;
  triggerClassName?: string;
  /** `inline` = the borderless text trigger used for "40 items" in pagination. */
  variant?: 'default' | 'inline';
}) {
  const current = options.find((o) => o.value === value);
  return (
    <S.Root value={value} onValueChange={(v) => v !== null && onChange(v as V)} disabled={disabled} name={name}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          variant === 'inline'
            ? 'group/select max-w-[30rem] cursor-pointer select-none appearance-none items-center justify-between outline-hidden [&>span]:truncate [&>span]:min-w-0 text-xs rounded-lg bg-transparent text-default inline-flex h-auto w-auto px-0 transition-colors hover:text-emphasis focus-visible:ring-2 focus-visible:ring-focus'
            : SELECT_TRIGGER_CLASS,
          className,
          triggerClassName,
        )}
      >
        <span className={cn(!current && 'text-placeholder')}>{current ? (current.text ?? current.label) : placeholder}</span>
        <ChevronDown className="text-default shrink-0 group-data-[popup-open]/select:rotate-180 transition-transform" size={16} aria-hidden />
      </S.Trigger>
      <S.Portal>
        <S.Positioner alignItemWithTrigger={false} side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <S.Popup
            className={cn(
              'bg-background rounded-2xl border border-interactive py-1 shadow-lg outline-hidden focus-visible:outline-hidden max-h-[min(24rem,var(--available-height))] max-w-[min(31.5rem,calc(100vw-16px))] w-full cursor-pointer overflow-y-auto z-50 min-w-(--anchor-width) origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0',
              popupClassName,
            )}
          >
            <S.List className="flex flex-col gap-1 z-20 outline-hidden focus-visible:outline-hidden">
              {options.map((o) => (
                <S.Item key={o.value} value={o.value} disabled={o.disabled} className={OPTION_CLASS}>
                  <S.ItemText className="truncate min-w-0">
                    {o.label}
                    {o.description ? <span className="block text-xs text-muted">{o.description}</span> : null}
                  </S.ItemText>
                  <S.ItemIndicator className="inline-flex w-6 items-center justify-center text-emphasis">
                    <Check size={14} />
                  </S.ItemIndicator>
                </S.Item>
              ))}
            </S.List>
          </S.Popup>
        </S.Positioner>
      </S.Portal>
    </S.Root>
  );
}
