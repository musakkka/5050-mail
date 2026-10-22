import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconKey } from '../icons/Icon';

export type Anchor = Element | DOMRect | { x: number; y: number };

function rectOf(a: Anchor): DOMRect {
  if (a instanceof Element) return a.getBoundingClientRect();
  if ('width' in a) return a;
  return new DOMRect(a.x, a.y, 0, 0);
}

export type Placement = 'bottom-start' | 'bottom-end' | 'right-start' | 'top-start' | 'bottom-stretch';

/** Fixed-position popover in a portal; closes on outside press / Esc. */
export function Popover({
  anchor,
  onClose,
  placement = 'bottom-start',
  children,
  className,
  role,
  offset = 4,
  autoFocus = true,
  label,
  style,
}: {
  anchor: Anchor;
  onClose: () => void;
  placement?: Placement;
  children: ReactNode;
  className?: string;
  role?: string;
  offset?: number;
  autoFocus?: boolean;
  label?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = rectOf(anchor);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = placement === 'bottom-end' ? r.right - w : placement === 'right-start' ? r.right + offset : r.left;
    let top = placement === 'right-start' ? r.top - 8 : placement === 'top-start' ? r.top - h - offset : r.bottom + offset;
    const extra: CSSProperties = {};
    if (placement === 'bottom-stretch') extra.width = r.width;
    if (placement === 'right-start' && left + w > vw - 8) left = r.left - w - offset;
    if (left + w > vw - 8) left = vw - w - 8;
    if (left < 8) left = 8;
    if (top + h > vh - 8) {
      const flipped = placement === 'right-start' ? vh - h - 8 : r.top - h - offset;
      top = flipped >= 8 ? flipped : Math.max(8, vh - h - 8);
    }
    setPos({ left, top, ...extra, maxHeight: vh - 16 });
  }, [anchor, placement, offset]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof Element && anchor.contains(t)) return;
      // Nested popovers (submenus) are separate portals: ignore presses inside any popover opened after us.
      if ((t as Element).closest?.('.popover') && (t as Element).closest('.popover') !== ref.current) {
        const all = [...document.querySelectorAll('.popover')];
        if (all.indexOf((t as Element).closest('.popover')!) > all.indexOf(ref.current!)) return;
      }
      closeRef.current();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        const all = [...document.querySelectorAll('.popover')];
        if (all.at(-1) !== ref.current) return;
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [anchor]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, [role=menuitem]:not([aria-disabled=true]), [role=menuitemcheckbox], [role=menuitemradio], button');
    (first ?? el)?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n]!.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className={`popover${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={label}
      tabIndex={-1}
      style={{ ...pos, ...style }}
      onKeyDown={onKey}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Menu({
  anchor,
  onClose,
  children,
  placement,
  className,
  label,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  className?: string;
  label?: string;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} className={`menu${className ? ` ${className}` : ''}`} role="menu" label={label}>
      {children}
    </Popover>
  );
}

export function MenuItem({
  icon,
  label,
  onSelect,
  disabled,
  checked,
  trailing,
  submenu,
  hint,
  danger,
}: {
  icon?: IconKey | null;
  label: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  trailing?: ReactNode;
  submenu?: (anchor: Element, close: () => void) => ReactNode;
  hint?: string;
  danger?: boolean;
}) {
  const [sub, setSub] = useState<Element | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  return (
    <>
      <div
        ref={ref}
        role={checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-haspopup={submenu ? 'menu' : undefined}
        tabIndex={-1}
        className={`menu-item${disabled ? ' menu-item--disabled' : ''}${danger ? ' menu-item--danger' : ''}`}
        onClick={() => {
          if (disabled) return;
          if (submenu) setSub(ref.current);
          else onSelect?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (submenu) setSub(ref.current);
            else if (!disabled) onSelect?.();
          }
          if (e.key === 'ArrowRight' && submenu) setSub(ref.current);
        }}
        onPointerEnter={() => {
          if (!submenu) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setSub(ref.current), 150);
        }}
        onPointerLeave={() => clearTimeout(timer.current)}
      >
        {checked !== undefined ? (
          <span className="menu-item__icon">{checked ? <Icon name="check" /> : null}</span>
        ) : icon !== undefined ? (
          <span className="menu-item__icon">{icon ? <Icon name={icon} /> : null}</span>
        ) : null}
        <span className="menu-item__label">{label}</span>
        {hint ? <span className="menu-item__hint">{hint}</span> : null}
        {trailing}
        {submenu ? <Icon name="chevron_right" className="menu-item__chevron" /> : null}
      </div>
      {sub && submenu ? submenu(sub, () => setSub(null)) : null}
    </>
  );
}

export function MenuDivider() {
  return <div className="menu-divider" role="separator" />;
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="menu-header">{children}</div>;
}
