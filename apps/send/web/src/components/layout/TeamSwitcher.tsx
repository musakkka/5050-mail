import { Menu as M } from '@base-ui/react/menu';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, LogOut, Plus } from 'lucide-react';
import { useSession } from '@/state/session';
import { TeamAvatar } from '@/components/brand/BrandMark';
import { ITEM_CLASS } from '@/components/ui/Menu';
import { initial } from '@/lib/format';
import { cn } from '@/lib/cn';

const TRIGGER =
  'font-semibold inline-flex items-center border select-none relative cursor-pointer transition ease-in-out duration-200 bg-transparent border-transparent text-default hover:bg-interactive-hover data-popup-open:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden rounded-xl justify-between p-2 w-full text-sm gap-1 h-10';

export function TeamSwitcher() {
  const { me, team, setTeam, logout } = useSession();
  const nav = useNavigate();
  return (
    <M.Root>
      <M.Trigger className={TRIGGER} aria-label={`Team: ${team.name}`}>
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0">
          <span className="flex items-center justify-start gap-2.5 overflow-hidden">
            <TeamAvatar size={24} />
            <span className="text-left flex gap-2 items-center min-w-0">
              <span className="truncate text-left tracking-tight" translate="no">
                {team.name}
              </span>
            </span>
          </span>
        </span>
        <ChevronDown size={16} className="text-default shrink-0" />
      </M.Trigger>
      <M.Portal>
        <M.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-[1000] outline-none">
          <M.Popup className="gap-1 z-20 bg-background border border-interactive py-1 shadow-lg outline-hidden focus-visible:outline-hidden rounded-2xl min-w-(--anchor-width) w-[calc(100vw-1.5em)] max-w-[19rem] md:w-auto md:min-w-[220px] md:max-w-[300px] max-h-[min(32rem,var(--available-height))] flex flex-col overflow-hidden origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0">
            <M.Group className="flex min-h-0 flex-1 flex-col">
              <M.GroupLabel className="font-normal flex select-none items-end text-xs text-default bg-background shrink-0 px-3.5 pt-2.5 pb-1">Team</M.GroupLabel>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {me.teams.map((t) => (
                  <M.Item key={t.id} title={t.name} className={ITEM_CLASS} onClick={() => setTeam(t.id)}>
                    <span className="flex flex-1 items-center gap-2 overflow-hidden font-semibold">
                      <TeamAvatar size={24} />
                      <span className="truncate tracking-tight" translate="no">
                        {t.name}
                      </span>
                    </span>
                    {t.id === team.id ? <Check size={14} className="shrink-0" /> : null}
                  </M.Item>
                ))}
              </div>
              {me.isAdmin ? (
                <M.Item className={cn(ITEM_CLASS, 'gap-2')} onClick={() => nav('/settings/team?create=1')}>
                  <span className="size-6 flex">
                    <Plus size={16} className="m-auto" />
                  </span>
                  <span className="text-sm text-default font-semibold">Create team</span>
                </M.Item>
              ) : null}
            </M.Group>
            <M.Separator className="min-h-px w-full bg-interactive-hover" />
            <M.Group className="shrink-0">
              <M.GroupLabel className="font-normal flex select-none items-end text-xs text-default bg-background px-3.5 pt-2.5 pb-1">Account</M.GroupLabel>
              <M.Item title={me.email} className={ITEM_CLASS} onClick={() => nav('/settings/team')}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="relative shrink-0 flex min-w-[24px] min-h-[24px] h-[24px] w-[24px] text-xs rounded-full border border-transparent font-medium uppercase text-default"
                    style={{ background: 'linear-gradient(42deg, var(--gray-1), var(--gray-2)) padding-box, linear-gradient(42deg, var(--gray-a2) 45%, var(--gray-a6)) border-box' }}
                  >
                    <span className="m-auto">{initial(me.email)}</span>
                  </span>
                  <span className="truncate">{me.email}</span>
                </span>
              </M.Item>
              <M.Item className={cn(ITEM_CLASS, 'gap-2')} onClick={() => void logout()}>
                <span className="size-6 flex">
                  <LogOut size={16} className="m-auto" />
                </span>
                Log out
              </M.Item>
            </M.Group>
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.Root>
  );
}
