import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/Button';

const GO: Record<string, [string, string]> = {
  e: ['/emails', 'Emails'],
  t: ['/templates', 'Templates'],
  a: ['/audience', 'Audience'],
  i: ['/inboxes', 'Inboxes'],
  b: ['/broadcasts', 'Broadcasts'],
  u: ['/automations', 'Automations'],
  m: ['/metrics', 'Metrics'],
  d: ['/domains', 'Domains'],
  l: ['/logs', 'Logs'],
  k: ['/api-keys', 'API keys'],
  w: ['/webhooks', 'Webhooks'],
  s: ['/settings', 'Settings'],
};

const EVT = 'send:shortcuts';
export function openShortcuts() {
  window.dispatchEvent(new Event(EVT));
}

function typingIn(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/** Global keyboard shortcuts: `g` + letter to navigate, `/` to search, `?` for this list. */
export function Shortcuts() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const pendingG = useRef(0);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(EVT, show);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      if (document.querySelector('[role="dialog"][data-open],[role="menu"][data-open],[role="listbox"]') && e.key !== 'Escape') return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('input[data-page-search]');
        if (search) {
          e.preventDefault();
          search.focus();
        }
        return;
      }
      if (e.key === 'g') {
        pendingG.current = Date.now();
        return;
      }
      if (Date.now() - pendingG.current < 1200 && GO[e.key]) {
        e.preventDefault();
        pendingG.current = 0;
        nav(GO[e.key]![0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(EVT, show);
      window.removeEventListener('keydown', onKey);
    };
  }, [nav]);
  const rows: [string[], string][] = [
    [['⌘', 'K'], 'Ask anything / jump to a page'],
    [['/'], 'Focus search'],
    [['?'], 'Show keyboard shortcuts'],
    [['⌘', '↩︎'], 'Submit the open dialog'],
    [['Esc'], 'Close dialog or menu'],
    ...Object.entries(GO).map(([k, [, label]]) => [['G', k.toUpperCase()], `Go to ${label}`] as [string[], string]),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Keyboard shortcuts" size="md">
      <ul className="mt-4 flex flex-col divide-y divide-gray-3">
        {rows.map(([keys, label]) => (
          <li key={label} className="flex items-center justify-between gap-4 py-2 text-sm text-default">
            <span>{label}</span>
            <span className="flex gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
