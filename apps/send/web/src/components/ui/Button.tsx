import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type AnchorHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
export type ButtonSize = '1' | '2' | '3';

const BASE =
  'inline-flex items-center justify-center border select-none relative cursor-pointer data-disabled:cursor-not-allowed data-disabled:opacity-70 transition ease-in-out duration-200';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'font-semibold bg-accent text-on-accent not-data-disabled:hover:bg-accent-hover focus-visible:bg-accent-hover focus-visible:ring-accent focus-visible:ring-2 focus-visible:outline-hidden',
  secondary:
    'bg-interactive border-interactive text-default not-data-disabled:hover:bg-interactive-hover focus-visible:ring-focus aria-expanded:bg-interactive-hover font-medium [&_svg]:text-default focus-visible:ring-2 focus-visible:outline-hidden',
  ghost:
    'font-semibold bg-transparent border-transparent text-default not-data-disabled:hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden',
  danger:
    'font-semibold bg-error border-error-subtle text-error not-data-disabled:hover:bg-error-hover focus-visible:bg-error focus-visible:ring-error focus-visible:ring-2 focus-visible:outline-hidden',
  'danger-ghost':
    'font-semibold bg-transparent border-transparent text-error not-data-disabled:hover:bg-error focus-visible:ring-2 focus-visible:ring-error focus-visible:outline-hidden',
};

const SIZE: Record<ButtonSize, string> = {
  '1': 'text-xs h-6 px-2 rounded-lg gap-1',
  '2': 'text-sm h-8 px-3 rounded-xl gap-1',
  '3': 'text-sm h-10 px-4 rounded-xl gap-1.5',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = '2', extra?: string) {
  // An explicit justify-* in `extra` replaces the default centring (no class-order fights).
  const base = extra && /(^|\s)justify-(between|start|end)\b/.test(extra) ? BASE.replace('justify-center ', '') : BASE;
  return cn(base, VARIANT[variant], SIZE[size], extra);
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (adds the tighter left padding used by the reference buttons). */
  icon?: ReactNode;
  /** Trailing keyboard hints, e.g. ['⌘', '↩︎'] or ['Esc']. */
  kbd?: string[];
  loading?: boolean;
}

export type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>;

function Inner({ icon, kbd, loading, variant, children }: CommonProps & { children?: ReactNode }) {
  return (
    <>
      {icon || loading ? <span className="opacity-100">{loading ? <Spinner size={16} /> : icon}</span> : null}
      {children !== undefined && children !== null && children !== false ? (
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">{children}</span>
      ) : null}
      {kbd?.length ? (
        <div className="hidden md:flex items-center gap-1 pl-1 opacity-100">
          {kbd.map((k) => (
            <Kbd key={k} onAccent={variant === 'primary'}>
              {k}
            </Kbd>
          ))}
        </div>
      ) : null}
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = '2', icon, kbd, loading, className, disabled, children, type = 'button', ...rest },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      data-disabled={isDisabled ? '' : undefined}
      data-state={isDisabled ? 'disabled' : 'normal'}
      className={buttonClass(
        variant,
        size,
        cn(icon && 'pl-2.5', kbd?.length && (variant === 'primary' ? 'pr-1 md:pr-1.5' : 'md:pr-1.5'), className),
      )}
      {...rest}
    >
      <Inner icon={icon} kbd={kbd} loading={loading} variant={variant}>
        {children}
      </Inner>
    </button>
  );
});

export type LinkButtonProps = CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string };

/** Router link (internal `to`) or external anchor (`href`) styled as a button. */
export function LinkButton({ variant = 'secondary', size = '2', icon, kbd, to, href, className, children, ...rest }: LinkButtonProps) {
  const cls = buttonClass(variant, size, cn(icon && 'pl-2.5', className));
  const inner = (
    <Inner icon={icon} kbd={kbd} variant={variant}>
      {children}
    </Inner>
  );
  if (to) {
    return (
      <Link to={to} className={cls} {...rest}>
        {inner}
      </Link>
    );
  }
  return (
    <a href={href} className={cls} target="_blank" rel="noopener noreferrer" {...rest}>
      {inner}
    </a>
  );
}

const ICON_BASE =
  'inline-flex items-center justify-center border select-none relative data-disabled:cursor-not-allowed data-disabled:opacity-70 transition-colors ease-in-out duration-200 cursor-pointer';
const ICON_VARIANT = {
  secondary:
    'bg-interactive border-interactive text-default not-data-disabled:hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:ring-focus aria-expanded:bg-interactive-hover data-popup-open:bg-interactive-hover [&_svg]:text-default focus-visible:ring-2 focus-visible:outline-hidden',
  ghost:
    'bg-transparent border-transparent text-default not-data-disabled:hover:bg-interactive-hover group-hover/button:bg-interactive-hover data-popup-open:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden',
} as const;
const ICON_SIZE = { '1': 'h-6 w-6 rounded-lg', '2': 'h-8 w-8 min-w-8 rounded-xl' } as const;

export function iconButtonClass(variant: keyof typeof ICON_VARIANT = 'secondary', size: keyof typeof ICON_SIZE = '2', extra?: string) {
  // An explicit absolute/fixed position in `extra` replaces the default `relative` (Tailwind would let `relative` win).
  const base = extra && /(^|\s)(absolute|fixed|sticky)(\s|$)/.test(extra) ? ICON_BASE.replace(' relative ', ' ') : ICON_BASE;
  return cn(base, ICON_SIZE[size], ICON_VARIANT[variant], extra);
}

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof ICON_VARIANT;
  size?: keyof typeof ICON_SIZE;
  label: string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'secondary', size = '2', label, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      disabled={disabled}
      data-disabled={disabled ? '' : undefined}
      className={iconButtonClass(variant, size, className)}
      {...rest}
    >
      <span className="inline-flex items-center justify-center opacity-100">{children}</span>
    </button>
  );
});

export function Kbd({ children, onAccent, className }: { children: ReactNode; onAccent?: boolean; className?: string }) {
  return (
    <kbd
      className={cn(
        'font-normal font-sans inline-flex pointer-coarse:hidden h-5 min-w-5 px-1 select-none items-center justify-center rounded-md text-xs',
        onAccent ? 'dark:bg-black/10 dark:text-black/60 bg-white/20 text-white/90 uppercase' : 'bg-interactive-hover text-default',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
