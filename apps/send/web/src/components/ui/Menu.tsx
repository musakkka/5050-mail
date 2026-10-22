import { Menu as M } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const POPUP_CLASS =
  'flex flex-col gap-1 bg-background border border-interactive py-1 shadow-lg outline-hidden focus-visible:outline-hidden overflow-auto rounded-2xl z-50 max-h-[var(--available-height)] origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0';

export const ITEM_CLASS =
  'flex items-center gap-1.5 rounded-xl px-2 text-sm focus-visible:outline-hidden mx-1 min-h-8 text-default cursor-pointer select-none not-data-disabled:hover:bg-interactive not-data-disabled:hover:text-emphasis not-data-disabled:focus-visible:bg-interactive not-data-disabled:focus-visible:text-emphasis not-data-disabled:data-highlighted:bg-interactive not-data-disabled:data-highlighted:text-emphasis data-selected:text-emphasis data-disabled:text-muted data-disabled:cursor-not-allowed data-disabled:[&>svg]:opacity-50 outline-none';

export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  className,
  modal = false,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  modal?: boolean;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  return (
    <M.Root modal={modal} open={open} onOpenChange={onOpenChange}>
      <M.Trigger render={trigger} />
      <M.Portal>
        <M.Positioner side={side} align={align} sideOffset={8} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className={cn(POPUP_CLASS, 'min-w-(--anchor-width) w-56 max-w-[min(19rem,calc(100vw-16px))]', className)}>
            {children}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  className,
  icon,
  right,
  closeOnClick = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
  icon?: ReactNode;
  right?: ReactNode;
  closeOnClick?: boolean;
}) {
  return (
    <M.Item
      disabled={disabled}
      onClick={onClick}
      closeOnClick={closeOnClick}
      className={cn(ITEM_CLASS, danger && 'text-error not-data-disabled:data-highlighted:text-error not-data-disabled:hover:text-error', right ? 'justify-between' : '', className)}
    >
      {icon ? <span className="inline-flex shrink-0 [&_svg]:size-4">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right}
    </M.Item>
  );
}

export function MenuLinkItem({ href, children, icon, external }: { href: string; children: ReactNode; icon?: ReactNode; external?: boolean }) {
  return (
    <M.LinkItem
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className={ITEM_CLASS}
    >
      {icon ? <span className="inline-flex shrink-0 [&_svg]:size-4">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </M.LinkItem>
  );
}

export function MenuSeparator() {
  return <M.Separator className="min-h-px w-full bg-interactive-hover" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-1 pb-0.5 text-xs text-muted select-none">{children}</div>;
}

export const MenuRadioGroup = M.RadioGroup;
export const MenuRadioItem = M.RadioItem;
export const MenuCheckboxItem = M.CheckboxItem;
