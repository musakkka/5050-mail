import { Tabs as T } from '@base-ui/react/tabs';
import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { SCROLL_FADE as TAB_STRIP_FADE, useScrollFade as useTabStrip } from '@/lib/useScrollFade';

export { TAB_STRIP_FADE, useTabStrip };
import { cn } from '@/lib/cn';

export const TAB_CLASS =
  'inline-flex shrink-0 cursor-pointer select-none items-center whitespace-nowrap text-sm font-semibold hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden focus-visible:bg-interactive-hover text-default data-active:bg-interactive data-active:text-emphasis data-active:hover:bg-interactive-hover h-8 rounded-xl px-3';

/** Route-driven tabs (Sending / Receiving, Contacts / Segments …). */
export function LinkTabs({ tabs, className }: { tabs: { to: string; label: ReactNode; end?: boolean; match?: (path: string) => boolean }[]; className?: string }) {
  const { pathname } = useLocation();
  const strip = useTabStrip(pathname);
  return (
    <div className={cn('w-fit max-w-full', className)}>
      <div ref={strip} role="tablist" className={cn('flex flex-nowrap items-center gap-2 p-1 -m-1 overflow-x-auto [scrollbar-width:none]', TAB_STRIP_FADE)}>
        {tabs.map((t) => {
          const active = t.match ? t.match(pathname) : t.end ? pathname === t.to : pathname === t.to || pathname.startsWith(t.to + '/');
          return (
            <NavLink
              key={t.to}
              to={t.to}
              role="tab"
              aria-selected={active}
              data-active={active ? '' : undefined}
              className={TAB_CLASS}
            >
              {t.label}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

/** In-page tabs (Records / Configuration, Preview / Plain Text / Raw / Insights …). */
export function Tabs<V extends string>({
  value,
  onChange,
  tabs,
  right,
  className,
  listClassName,
  children,
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: { value: V; label: ReactNode; disabled?: boolean }[];
  right?: ReactNode;
  className?: string;
  listClassName?: string;
  children?: ReactNode;
}) {
  const strip = useTabStrip(value);
  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} className={className}>
      <T.List className={cn('flex flex-nowrap items-center gap-2', right && 'relative w-full justify-between', listClassName)}>
        <div ref={strip} className={cn('flex w-max min-w-0 max-w-full items-center gap-2 overflow-x-auto [scrollbar-width:none] p-1 -m-1', TAB_STRIP_FADE)}>
          {tabs.map((t) => (
            <T.Tab key={t.value} value={t.value} disabled={t.disabled} className={TAB_CLASS}>
              {t.label}
            </T.Tab>
          ))}
        </div>
        {right}
      </T.List>
      {children}
    </T.Root>
  );
}

export const TabPanel = T.Panel;
