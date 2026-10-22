import type { ReactNode } from 'react';
import { LinkTabs } from '@/components/ui/Tabs';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';

export const AUTOMATION_TABS = [
  { to: '/automations', label: 'Automations', match: (p: string) => p === '/automations' || p === '/automations/' },
  { to: '/automations/events', label: 'Events' },
];

/** Tabs row shared by Automations and Events (primary action + API drawer on the right). */
export function AutomationTabsRow({ action }: { action: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <LinkTabs tabs={AUTOMATION_TABS} />
      <div className="flex gap-2">
        {action}
        <ApiDrawerButton examples={API.automations!} />
      </div>
    </div>
  );
}
