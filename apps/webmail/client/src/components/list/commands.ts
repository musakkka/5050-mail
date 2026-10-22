import { useCallback, useMemo } from 'react';
import { useActions, useMailboxes } from '../../state/mail';
import type { ActionInput, ActionKind } from '../../mail/actions';
import type { LiteEmail } from '../../mail/threads';
import type { View } from '../../mail/views';

export interface Target {
  threadId: string;
  emails: LiteEmail[];
}

/** Commands on conversations, bound to the current view (for archive/remove-label semantics). */
export function useCommands(view: View) {
  const { run } = useActions();
  const { data: model } = useMailboxes();
  const viewMailboxId = useMemo(() => {
    if (!model) return undefined;
    switch (view.kind) {
      case 'folder': {
        const role = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', spam: 'junk', trash: 'trash', snoozed: 'snoozed', scheduled: 'scheduled' }[
          view.key as string
        ];
        return role ? model.roleId(role) : undefined;
      }
      case 'category':
        return model.roleId('inbox');
      case 'label':
        return model.idByPath(view.key);
      default:
        return undefined;
    }
  }, [model, view]);

  const act = useCallback(
    (
      kind: ActionKind,
      targets: Target[],
      extra: Partial<Omit<ActionInput, 'kind' | 'threads' | 'model'>> = {},
      opts: { silent?: boolean; message?: string } = {},
    ) => run({ kind, threads: targets.map((t) => ({ threadId: t.threadId, emails: t.emails })), viewMailboxId, ...extra }, { currentView: view, ...opts }),
    [run, viewMailboxId, view],
  );

  const isTrash = view.kind === 'folder' && view.key === 'trash';
  const isSpam = view.kind === 'folder' && view.key === 'spam';
  const isSnoozed = view.kind === 'folder' && view.key === 'snoozed';
  const isInbox = (view.kind === 'folder' && view.key === 'inbox') || view.kind === 'category';
  return { act, viewMailboxId, model, isTrash, isSpam, isSnoozed, isInbox };
}

export function snoozeOptions(now = new Date()): { label: string; when: Date }[] {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const out: { label: string; when: Date }[] = [];
  if (now.getHours() < 17) out.push({ label: 'Later today', when: at(now, 18) });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  out.push({ label: 'Tomorrow', when: at(tomorrow, 8) });
  const day = now.getDay();
  if (day !== 6 && day !== 0) {
    const sat = new Date(now);
    sat.setDate(now.getDate() + ((6 - day + 7) % 7));
    out.push({ label: 'This weekend', when: at(sat, 8) });
  }
  const mon = new Date(now);
  mon.setDate(now.getDate() + ((8 - day) % 7 || 7));
  out.push({ label: 'Next week', when: at(mon, 8) });
  return out;
}
