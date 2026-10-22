import { useState } from 'react';
import { SUPPORT_EMAIL } from '@/lib/config';
import { Popover } from '@base-ui/react/popover';
import { Monitor, Moon, Sun, Lightbulb, CircleQuestionMark, BookText, Keyboard, Mail, Rocket } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Menu, MenuItem, MenuLinkItem, MenuSeparator, MenuLabel } from '@/components/ui/Menu';
import { iconButtonClass, Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTheme, type ThemePref } from '@/state/theme';
import { cn } from '@/lib/cn';
import { docsUrl } from './docs';
import { openShortcuts } from './Shortcuts';
import { toast } from '@/components/ui/toast';

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Segmented Light / Dark toggle (mobile menu). */
export function AppearanceToggle() {
  const [pref, setPref] = useTheme();
  return (
    <div aria-label="Appearance" className="inline-flex items-center rounded-xl bg-interactive dark:bg-elevated p-0.5 gap-1" role="radiogroup">
      {THEMES.map((t) => (
        <button
          key={t.value}
          aria-label={t.label}
          type="button"
          role="radio"
          aria-checked={pref === t.value}
          onClick={() => setPref(t.value)}
          className="flex items-center justify-center rounded-[0.62rem] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus text-emphasis dark:text-default hover:bg-interactive-hover h-8 aspect-square border border-transparent aria-checked:text-emphasis aria-checked:bg-interactive-hover dark:aria-checked:text-emphasis"
        >
          <t.icon size={16} />
        </button>
      ))}
    </div>
  );
}

function AppearanceMenu() {
  const [pref, setPref] = useTheme();
  const Current = Monitor;
  return (
    <Menu
      side="top"
      align="start"
      className="w-44"
      trigger={
        <button type="button" aria-label="Appearance" className={iconButtonClass('ghost', '2')}>
          <span className="inline-flex items-center justify-center opacity-100">
            <Current size={16} />
          </span>
        </button>
      }
    >
      <MenuLabel>Appearance</MenuLabel>
      {THEMES.map((t) => (
        <MenuItem key={t.value} icon={<t.icon />} onClick={() => setPref(t.value)} right={pref === t.value ? <span className="text-xs text-muted">✓</span> : undefined}>
          {t.label}
        </MenuItem>
      ))}
    </Menu>
  );
}

function FeedbackPopover() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('5050 Send feedback')}&body=${encodeURIComponent(text)}`;
    toast('Thanks for the feedback!');
    setText('');
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Feedback">
        <Popover.Trigger aria-label="Feedback" className={iconButtonClass('ghost', '2')}>
          <span className="inline-flex items-center justify-center opacity-100">
            <Lightbulb size={16} />
          </span>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8} className="z-[1000]">
          <Popover.Popup className="w-80 max-w-[calc(100vw-16px)] rounded-2xl border border-interactive bg-background p-3 shadow-lg outline-hidden transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0">
            <Popover.Title className="mb-2 text-sm font-semibold text-emphasis">Send feedback</Popover.Title>
            <Textarea
              autoFocus
              rows={4}
              value={text}
              placeholder="Ideas, bugs, anything…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="1" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="1" variant="primary" onClick={send} disabled={!text.trim()}>
                Send
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function HelpMenu() {
  const nav = useNavigate();
  return (
    <Menu
      side="top"
      align="end"
      className="w-56"
      trigger={
        <button type="button" aria-label="Help" className={cn(iconButtonClass('ghost', '2'))}>
          <span className="inline-flex items-center justify-center opacity-100">
            <CircleQuestionMark size={16} />
          </span>
        </button>
      }
    >
      <MenuLinkItem href={docsUrl('/introduction')} external icon={<BookText />}>
        Documentation
      </MenuLinkItem>
      <MenuItem icon={<Rocket />} onClick={() => nav('/onboarding')}>
        Onboarding
      </MenuItem>
      <MenuItem icon={<Keyboard />} onClick={openShortcuts} right={<span className="text-xs text-muted">?</span>}>
        Keyboard shortcuts
      </MenuItem>
      <MenuSeparator />
      <MenuLinkItem href={`mailto:${SUPPORT_EMAIL}`} icon={<Mail />}>
        Contact support
      </MenuLinkItem>
    </Menu>
  );
}

export function SidebarFooter() {
  return (
    <div className="flex items-center justify-between gap-2 pt-4">
      <AppearanceMenu />
      <div className="flex items-center gap-1">
        <FeedbackPopover />
        <HelpMenu />
      </div>
    </div>
  );
}
