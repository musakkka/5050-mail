import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';

export const INPUT_CLASS =
  'relative w-full select-none appearance-none transition ease-in-out duration-200 disabled:cursor-not-allowed disabled:opacity-70 disabled:text-default h-8 rounded-xl px-3 text-sm bg-interactive border-interactive placeholder:text-placeholder text-emphasis focus-visible:ring-focus border pl-[var(--text-field-left-slot-width,.75rem)] pr-[var(--text-field-right-slot-width,.75rem)] outline-hidden focus-visible:ring-2 data-[state="read-only"]:cursor-default data-[state="read-only"]:border-interactive data-[state="read-only"]:bg-interactive-hover data-[state="read-only"]:text-emphasis data-[state="read-only"]:focus-visible:ring-0 data-[state="invalid"]:bg-error data-[state="invalid"]:border-error data-[state="invalid"]:focus-visible:ring-error';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  left?: ReactNode;
  right?: ReactNode;
  invalid?: boolean;
  wrapperClassName?: string;
  /** Pixel width reserved for the left/right slot. */
  leftWidth?: number;
  rightWidth?: number;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { left, right, invalid, wrapperClassName, leftWidth = 28, rightWidth = 12, className, readOnly, ...rest },
  ref,
) {
  const state = invalid ? 'invalid' : readOnly ? 'read-only' : 'normal';
  const style = {
    ...(left ? { '--text-field-left-slot-width': `${leftWidth}px` } : {}),
    ...(right ? { '--text-field-right-slot-width': `${rightWidth}px` } : {}),
  } as CSSProperties;
  return (
    <div className={cn('relative', wrapperClassName)} data-size="2" data-state={state} style={style}>
      {left ? (
        <div className="absolute bottom-0 top-0 flex items-center gap-0.5 text-default z-10 left-2 pointer-events-none" data-side="left">
          {left}
        </div>
      ) : null}
      <input
        ref={ref}
        className={cn(INPUT_CLASS, className)}
        data-1p-ignore="true"
        data-state={state}
        aria-invalid={invalid ? 'true' : 'false'}
        readOnly={readOnly}
        {...rest}
      />
      {right ? (
        <div className="absolute bottom-0 top-0 flex items-center gap-0.5 text-default z-10 right-1.5" data-side="right">
          {right}
        </div>
      ) : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        data-state={invalid ? 'invalid' : 'normal'}
        aria-invalid={invalid ? 'true' : 'false'}
        className={cn(
          'w-full min-h-20 rounded-xl px-3 py-2 text-sm bg-interactive border border-interactive placeholder:text-placeholder text-emphasis outline-hidden focus-visible:ring-2 focus-visible:ring-focus transition ease-in-out duration-200 disabled:cursor-not-allowed disabled:opacity-70 data-[state="invalid"]:bg-error data-[state="invalid"]:border-error',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Label({ htmlFor, children, className }: { htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-sm text-default', className)}>
      {children}
    </label>
  );
}

/** Label + control + optional hint/error, stacked like the reference forms (mt-6 between fields). */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  info,
  children,
  className,
}: {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  info?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(className && /(^|\s)mt-/.test(className) ? '' : 'mt-6', 'flex flex-col space-y-2', className)}>
      {label ? (
        info ? (
          <div className="flex items-center gap-1">
            <Label htmlFor={htmlFor} className="flex items-center">
              {label}
            </Label>
            {info}
          </div>
        ) : (
          <Label htmlFor={htmlFor}>{label}</Label>
        )
      ) : null}
      {/* Wrapper keeps hidden form inputs (Base UI Select) out of the space-y rhythm. */}
      <div className="min-w-0">{children}</div>
      {error ? (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
