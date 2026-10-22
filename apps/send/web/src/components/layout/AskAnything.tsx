import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog as D } from '@base-ui/react/dialog';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookText, CornerDownLeft, Search } from 'lucide-react';
import { NAV } from './Shell';
import { docsUrl } from './docs';
import { cn } from '@/lib/cn';
import { Kbd } from '@/components/ui/Button';

const EVT = 'send:ask';
export function openAsk() {
  window.dispatchEvent(new Event(EVT));
}

type Item = { id: string; label: string; hint: string; icon: typeof Search; run: () => void; external?: boolean };

const DOCS: [string, string][] = [
  ['Send an email with Node.js', '/send-with-nodejs'],
  ['Send with SMTP', '/send-with-smtp'],
  ['Verify a domain', '/dashboard/domains/introduction'],
  ['Webhooks and signatures', '/webhooks/introduction'],
  ['API reference: emails', '/api-reference/emails/send-email'],
  ['Rate limits and quotas', '/api-reference/introduction#rate-limit'],
  ['Idempotency keys', '/dashboard/emails/idempotency-keys'],
  ['Receiving emails', '/receiving/introduction'],
];

/**
 * "Ask anything": a ⌘K palette that jumps to pages, actions and docs. It does not
 * call an AI service; free text falls through to a docs search link.
 */
export function AskAnything() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener(EVT, show);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(EVT, show);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      setOpen(false);
      nav(to);
    };
    const ext = (url: string) => () => {
      setOpen(false);
      window.open(url, '_blank', 'noopener,noreferrer');
    };
    const all: Item[] = [
      ...NAV.flat().map((n) => ({ id: n.to, label: n.label, hint: 'Page', icon: n.icon, run: go(n.to) })),
      { id: 'a-key', label: 'Create API key', hint: 'Action', icon: Search, run: go('/api-keys?new=1') },
      { id: 'a-domain', label: 'Add domain', hint: 'Action', icon: Search, run: go('/domains/new') },
      { id: 'a-webhook', label: 'Add webhook', hint: 'Action', icon: Search, run: go('/webhooks?new=1') },
      { id: 'a-onb', label: 'Send your first email', hint: 'Action', icon: Search, run: go('/onboarding') },
      { id: 'a-smtp', label: 'SMTP settings', hint: 'Page', icon: Search, run: go('/settings/smtp') },
      { id: 'a-team', label: 'Team members', hint: 'Page', icon: Search, run: go('/settings/team') },
      ...DOCS.map(([label, p]) => ({ id: p, label, hint: 'Docs', icon: BookText, run: ext(docsUrl(p)), external: true })),
    ];
    const t = q.trim().toLowerCase();
    const res = t ? all.filter((i) => i.label.toLowerCase().includes(t)) : all.slice(0, 12);
    if (t) res.push({ id: 'search-docs', label: `Search the docs for “${q.trim()}”`, hint: 'Docs', icon: BookText, run: ext(`${docsUrl('')}?q=${encodeURIComponent(q.trim())}`), external: true });
    return res;
  }, [q, nav]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <D.Popup
          aria-label="Ask anything"
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-3xl border border-default bg-background shadow-lg outline-none transition-[opacity,scale] duration-200 data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <D.Title className="sr-only">Ask anything</D.Title>
          <div className="flex items-center gap-2 border-b border-default px-4">
            <Search size={16} className="text-default shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(items.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  items[active]?.run();
                }
              }}
              placeholder="Ask anything or jump to…"
              aria-label="Ask anything"
              role="combobox"
              aria-expanded="true"
              aria-controls="ask-results"
              aria-activedescendant={items[active] ? `ask-${active}` : undefined}
              className="h-12 w-full bg-transparent text-sm text-emphasis placeholder:text-placeholder outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>
          <ul ref={listRef} id="ask-results" role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
            {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted">No results</li> : null}
            {items.map((i, idx) => (
              <li
                key={i.id}
                id={`ask-${idx}`}
                data-index={idx}
                role="option"
                aria-selected={idx === active}
                onMouseMove={() => setActive(idx)}
                onClick={i.run}
                className={cn('flex h-9 cursor-pointer items-center gap-2 rounded-xl px-2.5 text-sm text-default', idx === active && 'bg-interactive text-emphasis')}
              >
                <i.icon size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="text-xs text-muted">{i.hint}</span>
                {i.external ? <ArrowUpRight size={14} className="text-muted" /> : idx === active ? <CornerDownLeft size={14} className="text-muted" /> : null}
              </li>
            ))}
          </ul>
        </D.Popup>
      </D.Portal>
    </D.Root>
  );
}
