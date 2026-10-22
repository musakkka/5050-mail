import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../../state/settings';
import { useUi, emptyDraft } from '../../state/ui';
import { useKeys } from '../../state/keys';
import { useMail } from '../../state/mail';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('[contenteditable=true]');
}

/** Global Gmail keyboard shortcuts (04-keyboard.md). */
export function useShortcuts(threadOpen: boolean) {
  const nav = useNavigate();
  const { identities } = useMail();
  const enabled = useSettings((s) => s.keyboardShortcuts);
  const prefix = useRef<{ key: string; at: number } | null>(null);
  const threadOpenRef = useRef(threadOpen);
  threadOpenRef.current = threadOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const keys = useKeys.getState();
      // Compose-window cycling + focus (always on).
      if (e.ctrlKey && (e.key === '.' || e.key === ',')) {
        const docked = ui.composers.filter((c) => !c.inline);
        if (!docked.length) return;
        e.preventDefault();
        const i = docked.findIndex((c) => c.id === ui.focusedComposer);
        const n = docked[(i + (e.key === '.' ? 1 : -1) + docked.length) % docked.length]!;
        ui.focusComposer(n.id);
        return;
      }
      if (e.key === 'Escape' && e.shiftKey) {
        (document.activeElement as HTMLElement | null)?.blur?.();
        document.querySelector<HTMLElement>('.main-card')?.focus();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        (e.target as HTMLElement)?.closest?.('button, a, [role=button], [role^=menuitem], [role=tab], [role=checkbox]')
      )
        return;
      if (ui.dialog.kind !== 'none' || document.querySelector('.popover, .preview')) return;

      if (e.key === 'Escape') {
        const last = ui.composers.filter((c) => !c.inline).at(-1);
        if (last) ui.focusComposer(last.id);
        return;
      }
      // `?` always opens help so shortcuts can be enabled from there.
      if (e.key === '?') {
        e.preventDefault();
        ui.openDialog({ kind: 'shortcuts' });
        return;
      }
      // n / p (message cursor) are in the always-on group.
      if (threadOpenRef.current && (e.key === 'n' || e.key === 'p') && !prefix.current) {
        ui.setKbdNav(true);
        keys.thread?.moveMessageCursor(e.key === 'n' ? 1 : -1);
        return;
      }
      if (!enabled) return;

      const k = e.key;
      const now = Date.now();
      const pre = prefix.current && now - prefix.current.at < 1500 ? prefix.current.key : null;
      prefix.current = null;
      if (pre === 'g') {
        e.preventDefault();
        const go: Record<string, string> = { i: '/mail/inbox', s: '/mail/starred', b: '/mail/snoozed', t: '/mail/sent', d: '/mail/drafts', a: '/mail/all' };
        const dest = go[k.toLowerCase()];
        if (dest) return nav(dest);
        if (k.toLowerCase() === 'n') return keys.list?.nextPage();
        if (k.toLowerCase() === 'p') return keys.list?.prevPage();
        if (k.toLowerCase() === 'l') return window.dispatchEvent(new Event('ff:goto-label'));
        if (k.toLowerCase() === 'c') return ui.setSidePanel('contacts');
        return;
      }
      if (pre === '*') {
        e.preventDefault();
        const map: Record<string, 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred'> = {
          a: 'all',
          n: 'none',
          r: 'read',
          u: 'unread',
          s: 'starred',
          t: 'unstarred',
        };
        const p = map[k.toLowerCase()];
        if (p) keys.list?.selectBy(p);
        return;
      }
      if (k === 'g' || k === '*') {
        prefix.current = { key: k, at: now };
        return;
      }

      const t = threadOpenRef.current ? keys.thread : null;
      const l = keys.list;
      const act = (kind: Parameters<NonNullable<typeof l>['act']>[0]) => (t ? t.act(kind) : l?.act(kind));
      let handled = true;
      switch (k) {
        case 'c':
          ui.openComposer(emptyDraft(identities[0]?.id));
          break;
        case 'C':
          window.open('/mail/inbox?compose=new', '_blank', 'width=640,height=600');
          break;
        case 'd':
          window.open('/mail/inbox?compose=new', '_blank');
          break;
        case '/':
          window.dispatchEvent(new Event('ff:focus-search'));
          break;
        case 'j':
        case 'k':
          ui.setKbdNav(true);
          if (t) t.sibling(k === 'j' ? 1 : -1);
          else l?.moveCursor(k === 'j' ? 1 : -1);
          break;
        case 'o':
        case 'Enter':
          if (t) t.toggleCursorMessage();
          else l?.openCursor();
          break;
        case 'u':
          if (t) t.back();
          else l?.refresh();
          break;
        case 'x':
          l?.toggleSelectCursor();
          break;
        case 's':
          act('star');
          break;
        case 'e':
          act('archive');
          break;
        case 'y':
          act('removeLabel');
          break;
        case 'm':
          act('mute');
          break;
        case '!':
          act('spam');
          break;
        case '#':
          act('trash');
          break;
        case 'I':
          act('read');
          break;
        case 'U':
          act('unread');
          break;
        case '+':
        case '=':
          act('important');
          break;
        case '-':
          act('notImportant');
          break;
        case '_':
          t?.markUnreadFromCursor();
          break;
        case 'r':
          if (t) t.reply('reply');
          else l?.reply('reply');
          break;
        case 'a':
          if (t) t.reply('replyAll');
          else l?.reply('replyAll');
          break;
        case 'f':
          if (t) t.reply('forward');
          else l?.reply('forward');
          break;
        case 'R':
        case 'A':
        case 'F':
          // "In a new window": from the list the composer opens docked (its own window in the app).
          if (t) t.reply(k === 'R' ? 'reply' : k === 'A' ? 'replyAll' : 'forward');
          else l?.reply(k === 'R' ? 'reply' : k === 'A' ? 'replyAll' : 'forward');
          break;
        case 'N':
          l?.refresh();
          break;
        case ']':
        case '[':
          t?.sibling(k === ']' ? 1 : -1, true);
          break;
        case 'z':
          void ui.undo?.();
          break;
        case 'b':
          if (t) t.openMenu('snooze');
          else l?.openMenu('snooze');
          break;
        case 'v':
          if (t) t.openMenu('move');
          else l?.openMenu('move');
          break;
        case 'l':
          if (t) t.openMenu('label');
          else l?.openMenu('label');
          break;
        case '.':
          if (t) t.openMenu('more');
          else l?.openMenu('more');
          break;
        case ',':
          l?.focusToolbar();
          break;
        case ';':
          t?.expandAll();
          break;
        case ':':
          t?.collapseAll();
          break;
        case '`':
        case '~':
          l?.cycleTab(k === '`' ? 1 : -1);
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    const onPointer = () => useUi.getState().setKbdNav(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [enabled, nav, identities]);
}
