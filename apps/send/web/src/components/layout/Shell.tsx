import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import {
  ChartNoAxesColumn,
  GalleryHorizontal,
  GalleryVerticalEnd,
  Globe,
  Inbox,
  KeyRound,
  Mail,
  Menu as MenuIcon,
  Radio,
  Settings,
  Users,
  Webhook,
  Workflow,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSession } from '@/state/session';
import { TeamSwitcher } from './TeamSwitcher';
import { SidebarFooter, AppearanceToggle } from './SidebarFooter';
import { BottomBar } from './BottomBar';
import { docsPathFor } from './docs';

type NavItem = { to: string; label: string; icon: typeof Mail; match?: string[] };

export const NAV: NavItem[][] = [
  [
    { to: '/emails', label: 'Emails', icon: Mail },
    { to: '/templates', label: 'Templates', icon: GalleryHorizontal },
    { to: '/audience', label: 'Audience', icon: Users },
  ],
  [
    { to: '/inboxes', label: 'Inboxes', icon: Inbox },
    { to: '/broadcasts', label: 'Broadcasts', icon: Radio },
    { to: '/automations', label: 'Automations', icon: Workflow },
  ],
  [
    { to: '/metrics', label: 'Metrics', icon: ChartNoAxesColumn },
    { to: '/domains', label: 'Domains', icon: Globe },
    { to: '/logs', label: 'Logs', icon: GalleryVerticalEnd },
    { to: '/api-keys', label: 'API keys', icon: KeyRound },
    { to: '/webhooks', label: 'Webhooks', icon: Webhook },
    { to: '/settings', label: 'Settings', icon: Settings },
  ],
];

function SideLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <li>
      <NavLink
        to={item.to}
        className={({ isActive }) =>
          cn(
            'group/nav flex h-8 items-center gap-2 rounded-xl px-3 text-sm focus-visible:ring-2 focus-visible:ring-gray-a3 focus-visible:outline-hidden focus-visible:bg-gray-a2',
            isActive ? 'bg-gray-a2 text-emphasis' : 'text-gray-11 hover:bg-gray-a2 hover:text-emphasis',
          )
        }
      >
        {({ isActive }) => (
          <>
            <span className={cn('opacity-80 inline-flex', isActive ? 'text-emphasis' : 'text-gray-11')} style={{ width: 18, height: 18 }}>
              <Icon
                size={18}
                strokeWidth={1.75}
                className="transition-transform duration-300 ease-out group-hover/nav:scale-110 group-active/nav:scale-95 motion-reduce:transition-none"
              />
            </span>
            {item.label}
          </>
        )}
      </NavLink>
    </li>
  );
}

function Sidebar() {
  return (
    <aside className="bg-background hidden h-full w-[250px] shrink-0 flex-col justify-between border-r border-gray-3 px-4 py-4 @3xl:flex">
      <div className="flex h-[30px] items-center justify-between gap-2">
        <TeamSwitcher />
      </div>
      <nav aria-label="Main" className="-mx-0.5 mt-3.5 -mb-0.5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5 data-scrollable:scroll-shadow-line-y">
        {NAV.map((group, i) => (
          <div key={i} className="contents">
            {i > 0 ? <hr aria-hidden="true" className="mx-3 my-4 border-t border-default" /> : null}
            <ul className="flex flex-col gap-2">
              {group.map((item) => (
                <SideLink key={item.to} item={item} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <SidebarFooter />
    </aside>
  );
}

function MobileBar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { logout } = useSession();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className={cn('bg-background absolute top-0 left-0 z-40 flex w-full flex-col items-center @3xl:hidden', open && 'h-full')}>
      <div className="flex w-full items-center justify-between px-6 py-3.5 gap-2">
        <div className="-ml-2 min-w-0">
          <TeamSwitcher />
        </div>
        <button
          aria-controls="mobile-menu"
          aria-expanded={open}
          aria-label="menu"
          className="-mr-2 inline-flex items-center justify-center rounded-md p-3 text-default transition ease-in-out hover:bg-gray-a3 hover:text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-gray-a4"
          type="button"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="sr-only">{open ? 'Close main menu' : 'Open main menu'}</span>
          {open ? <X size={20} aria-hidden /> : <MenuIcon size={20} aria-hidden />}
        </button>
      </div>
      <div className={cn('w-full min-h-0 flex-1 overflow-y-auto px-6 py-4 @3xl:hidden', !open && 'hidden')} id="mobile-menu">
        {NAV.map((group, gi) => (
          <div key={gi}>
            {gi > 0 ? <hr aria-hidden="true" className="md:my-2 border-t border-default" /> : null}
            {group.map((item, i) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'text-base block w-full py-4 font-semibold text-default transition duration-200 ease-in-out hover:text-emphasis',
                  i < group.length - 1 && 'border-b border-gray-3',
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
        <Link to="/help" className="text-base block w-full border-t border-gray-3 py-4 font-semibold text-default transition duration-200 ease-in-out hover:text-emphasis">
          Help
        </Link>
        <div className="text-base flex w-full items-center justify-between border-b border-gray-3 py-4 font-semibold text-default">
          Appearance
          <span className="-my-2">
            <AppearanceToggle />
          </span>
        </div>
        <Link to="/onboarding" className="text-base block w-full py-4 font-semibold text-default border-b border-gray-3 transition duration-200 ease-in-out hover:text-emphasis">
          Onboarding
        </Link>
        <button type="button" onClick={() => void logout()} className="text-base block w-full py-4 text-left font-semibold text-default transition duration-200 ease-in-out hover:text-emphasis">
          Log out
        </button>
      </div>
    </div>
  );
}

/**
 * App chrome: a rounded black workspace panel (sidebar + scrolling page) over a
 * 40px bottom bar with the docs link and "Ask anything".
 */
export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // New page → scroll the page container back to the top.
  useEffect(() => {
    document.querySelector('.scrollContainer')?.scrollTo({ top: 0 });
  }, [pathname]);
  return (
    <div className="fixed inset-0 bg-white [--workspace-panel-bg:white] dark:bg-subtle dark:[--workspace-panel-bg:var(--gray-1)]">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-xl focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:text-emphasis focus:ring-2 focus:ring-focus focus:outline-hidden"
      >
        Skip to content
      </a>
      <div className="absolute inset-0 z-10" style={{ top: 0, left: 0, right: 0, bottom: 40 }}>
        <div className="h-full w-full transform-gpu overflow-clip border border-subtle bg-background [container-type:size] rounded-b-2xl border-none drop-shadow-[0px_1px_3px_rgba(0,0,0,0.08)]">
          <div className="flex h-full flex-col overflow-clip pt-[4.5rem] @3xl:pt-0">
            <div className="flex min-h-0 flex-1 @3xl:[--bottom-bar-inset-left:250px]">
              <div className="h-full shrink-0">
                <Sidebar />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <MobileBar />
                <main className="scrollContainer min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain pb-10 outline-hidden" id="main" tabIndex={-1}>
                  {children}
                </main>
              </div>
            </div>
          </div>
        </div>
      </div>
      <BottomBar docsPath={docsPathFor(pathname)} />
    </div>
  );
}

