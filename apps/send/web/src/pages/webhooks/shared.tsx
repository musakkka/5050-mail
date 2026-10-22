import { useMemo, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Search, Webhook as WebhookGlyph } from 'lucide-react';
import { AppIcon, type IconTone } from '@/components/ui/AppIcon';
import { Checkbox } from '@/components/ui/Switch';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { WebhookEventType } from '@/api/types';

/** Event types accepted by the server (send/src/services/webhooks.ts), grouped for the picker. */
export const EVENT_GROUPS: { label: string; events: string[] }[] = [
  { label: 'Email', events: ['email.sent', 'email.scheduled', 'email.delivered', 'email.delivery_delayed', 'email.complained', 'email.bounced', 'email.opened', 'email.clicked', 'email.received', 'email.failed', 'email.suppressed'] },
  { label: 'Contact', events: ['contact.created', 'contact.updated', 'contact.deleted', 'contact.topics.updated'] },
  { label: 'Domain', events: ['domain.created', 'domain.updated', 'domain.deleted'] },
  { label: 'Suppression', events: ['suppression.added', 'suppression.removed'] },
  { label: 'Topic', events: ['topic.created', 'topic.updated', 'topic.deleted'] },
  {
    label: 'Inbox',
    events: [
      'inbox.created', 'inbox.updated', 'inbox.deleted', 'inbox.thread.created', 'inbox.thread.folder.updated', 'inbox.thread.assigned', 'inbox.thread.unassigned',
      'inbox.thread.labels.updated', 'inbox.email.received', 'inbox.email.sent', 'inbox.draft.created', 'inbox.draft.updated', 'inbox.draft.sent', 'inbox.draft.deleted',
    ],
  },
];
export const ALL_EVENTS = EVENT_GROUPS.flatMap((g) => g.events);

export function WebhookIcon({ status, size = 32 }: { status?: string; size?: number }) {
  const tone: IconTone = status === 'disabled' ? 'gray' : 'green';
  return (
    <AppIcon size={size} tone={tone} glyphSize={size >= 100 ? 44 : size >= 80 ? 36 : 17}>
      <WebhookGlyph strokeWidth={2} />
    </AppIcon>
  );
}

/** Valid http(s) URL, no credentials. Mirrors the server's checks (private hosts are rejected server-side). */
export function endpointError(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter an endpoint URL.';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'Enter a valid URL, like https://example.com/webhooks.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with https://.';
  if (u.username || u.password) return "URLs with credentials aren't allowed.";
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return 'Enter a full domain name.';
  return null;
}

/** "Select events…" combobox: popover with grouped checkboxes and a filter. */
export function EventsPicker({ value, onChange, id }: { value: string[]; onChange: (v: WebhookEventType[]) => void; id?: string }) {
  const [q, setQ] = useState('');
  const sel = new Set(value);
  const groups = useMemo(() => EVENT_GROUPS.map((g) => ({ ...g, events: g.events.filter((e) => e.includes(q.trim().toLowerCase())) })).filter((g) => g.events.length), [q]);
  const set = (next: Set<string>) => onChange(ALL_EVENTS.filter((e) => next.has(e)) as WebhookEventType[]);
  const label = value.length === 0 ? 'Select events...' : value.length === ALL_EVENTS.length ? 'All events' : value.length <= 2 ? value.join(', ') : `${value.length} events selected`;
  return (
    <Popover.Root onOpenChange={(o) => !o && setQ('')}>
      <Popover.Trigger id={id} role="combobox" className={buttonClass('secondary', '2', 'justify-between w-full pr-2 font-normal group')}>
        <span className={cn('text-sm font-normal min-w-20 text-left truncate', value.length ? 'text-emphasis' : 'text-default')}>{label}</span>
        <ChevronDown size={16} className="shrink-0 text-default transition-transform group-data-[popup-open]:rotate-180" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8} className="z-[1100]">
          <Popover.Popup className="flex max-h-[min(24rem,var(--available-height))] w-(--anchor-width) min-w-[16rem] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-2xl border border-interactive bg-background shadow-lg outline-hidden origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0">
            <div className="flex items-center gap-2 border-b border-interactive px-3">
              <Search size={14} className="text-default" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter events…"
                aria-label="Filter events"
                className="h-9 w-full bg-transparent text-sm text-emphasis placeholder:text-placeholder outline-none"
              />
              <button
                type="button"
                className="shrink-0 text-xs text-default hover:text-emphasis"
                onClick={() => set(sel.size === ALL_EVENTS.length ? new Set() : new Set(ALL_EVENTS))}
              >
                {sel.size === ALL_EVENTS.length ? 'Clear' : 'Select all'}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {groups.length === 0 ? <p className="px-3 py-4 text-center text-sm text-muted">No events match</p> : null}
              {groups.map((g) => {
                const n = g.events.filter((e) => sel.has(e)).length;
                return (
                  <div key={g.label} className="py-1">
                    <label className="mx-1 flex min-h-8 cursor-pointer items-center gap-2 rounded-xl px-2 text-xs font-semibold text-default hover:bg-interactive">
                      <Checkbox
                        label={`All ${g.label} events`}
                        checked={n === g.events.length}
                        indeterminate={n > 0 && n < g.events.length}
                        onChange={(on) => {
                          const next = new Set(sel);
                          g.events.forEach((e) => (on ? next.add(e) : next.delete(e)));
                          set(next);
                        }}
                      />
                      {g.label}
                    </label>
                    {g.events.map((e) => (
                      <label key={e} className="mx-1 flex min-h-8 cursor-pointer items-center gap-2 rounded-xl pl-6 pr-2 text-sm text-default hover:bg-interactive hover:text-emphasis">
                        <Checkbox
                          label={e}
                          checked={sel.has(e)}
                          onChange={(on) => {
                            const next = new Set(sel);
                            if (on) next.add(e);
                            else next.delete(e);
                            set(next);
                          }}
                        />
                        <span className="font-mono text-[13px] truncate">{e}</span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
