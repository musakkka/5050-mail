import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconKey } from '../icons/Icon';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** Circular icon button with tooltip (02-components: 40×40, 20px icon by default). */
export const IconButton = forwardRef<
  HTMLButtonElement,
  BtnProps & { icon: IconKey; label: string; size?: number; iconSize?: number; fill?: boolean; active?: boolean; tooltip?: string | false }
>(function IconButton({ icon, label, size = 40, iconSize = 20, fill, active, tooltip, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tooltip={tooltip === false ? undefined : (tooltip ?? label)}
      className={`icon-btn${active ? ' icon-btn--active' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={iconSize} fill={fill} />
    </button>
  );
});

/** GM3 buttons: filled / outlined / text / tonal. Height 40 (36 where Gmail uses it), full radius. */
export const Button = forwardRef<
  HTMLButtonElement,
  BtnProps & { variant?: 'filled' | 'outlined' | 'text' | 'tonal'; icon?: IconKey; children: ReactNode; dense?: boolean }
>(function Button({ variant = 'text', icon, children, className, dense, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`btn btn--${variant}${icon ? ' btn--with-icon' : ''}${dense ? ' btn--dense' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon ? <Icon name={icon} size={18} /> : null}
      <span>{children}</span>
    </button>
  );
});
