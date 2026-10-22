import { Switch as S } from '@base-ui/react/switch';
import { Checkbox as C } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onChange(v)}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-interactive bg-interactive outline-hidden focus-visible:ring-4 focus-visible:ring-focus data-checked:border-success data-checked:bg-green-9 data-disabled:cursor-not-allowed data-disabled:opacity-50 transition-colors"
    >
      <S.Thumb className="block size-4 translate-x-[3px] rounded-full bg-gray-12 shadow transition-transform duration-200 data-checked:translate-x-[19px] data-checked:bg-white" />
    </S.Root>
  );
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  indeterminate,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  indeterminate?: boolean;
  className?: string;
}) {
  return (
    <C.Root
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={(v) => onChange(v)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'h-5 w-5 shrink-0 appearance-none rounded-md border border-interactive not-disabled:hover:bg-interactive-hover bg-interactive transition-colors not-disabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-focus focus-visible:ring-2 outline-none flex items-center justify-center data-checked:bg-accent data-checked:border-transparent data-indeterminate:bg-accent',
        className,
      )}
    >
      <C.Indicator className="text-on-accent">{indeterminate ? <Minus size={14} strokeWidth={3} /> : <Check size={14} strokeWidth={3} />}</C.Indicator>
    </C.Root>
  );
}
