import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { PageBody, PageHeader, useTitle } from '@/components/layout/Page';
import { TAB_CLASS, TAB_STRIP_FADE, useTabStrip } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';

const TABS = [
  { to: '/settings/usage', label: 'Usage' },
  { to: '/settings/billing', label: 'Billing' },
  { to: '/settings/team', label: 'Team' },
  { to: '/settings/smtp', label: 'SMTP' },
  { to: '/settings/integrations', label: 'Integrations' },
  { to: '/settings/unsubscribe-page', label: 'Unsubscribe page' },
  { to: '/settings/documents', label: 'Documents' },
  { to: '/settings/labs', label: 'Labs' },
];

/** "Settings" title + the settings tab row (+ optional right-side action), then the page content. */
export function SettingsLayout({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const { pathname } = useLocation();
  const strip = useTabStrip(pathname);
  useTitle(title);
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsTitle title={title} />
      <PageBody className="flex flex-col gap-3 md:gap-6">
        <div className="flex items-center justify-between gap-2 mb-6 md:mb-4">
          <div ref={strip} className={cn('w-full min-w-0 overflow-x-auto [scrollbar-width:none]', TAB_STRIP_FADE)}>
            <div role="tablist" aria-label="Settings" className="flex flex-nowrap items-center gap-2 w-max pl-0 md:p-1 md:-ml-1">
              {TABS.map((t) => {
                const active = pathname === t.to || pathname.startsWith(t.to + '/');
                return (
                  <NavLink key={t.to} to={t.to} role="tab" aria-selected={active} data-active={active ? '' : undefined} className={TAB_CLASS}>
                    {t.label}
                  </NavLink>
                );
              })}
            </div>
          </div>
          {right}
        </div>
        <div className="flex flex-col gap-6">{children}</div>
      </PageBody>
    </>
  );
}

/** PageHeader sets "Settings"; this runs after it so the tab name wins in document.title. */
function SettingsTitle({ title }: { title: string }) {
  useTitle(title);
  return null;
}

/** Bordered settings card: bold title, body, optional footer action row. */
export function SettingsCard({
  title,
  children,
  footer,
  className,
  bodyClassName,
  id,
  right,
}: {
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
  right?: ReactNode;
}) {
  return (
    <section id={id} className={cn('rounded-3xl border border-gray-3 min-w-0', className)}>
      {title ? (
        <div className="flex items-center justify-between gap-2 p-4 pb-2">
          <h2 className="text-base text-emphasis font-bold">{title}</h2>
          {right}
        </div>
      ) : null}
      {children !== undefined ? <div className={bodyClassName ?? 'p-4'}>{children}</div> : null}
      {footer ? <div className="flex flex-wrap gap-2 border-t border-default p-3">{footer}</div> : null}
    </section>
  );
}

/** Two-column usage section (title + blurb left, plan + quota rows right). */
export function SplitSection({ id, title, badge, description, action, children, last }: { id: string; title: string; badge?: ReactNode; description: ReactNode; action?: ReactNode; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex flex-col border-b border-gray-3 py-4 md:pb-16 md:pt-8 md:flex-row', last && 'border-none')}>
      <div className="flex w-full justify-between md:block md:w-1/2 md:pr-8">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-xl tracking-[-0.16px] text-emphasis font-bold" id={id}>
              {title}
            </h2>
            {badge}
          </div>
          <span className="text-sm text-default font-normal mb-4 hidden md:block md:w-1/2 md:min-w-64 text-balance">{description}</span>
        </div>
        {action}
      </div>
      <div className="w-full md:w-1/2 min-w-0">{children}</div>
    </div>
  );
}
