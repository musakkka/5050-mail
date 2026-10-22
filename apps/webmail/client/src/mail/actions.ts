/**
 * Gmail conversation actions → JMAP Email/set patches (05-jmap-mapping §4).
 * Pure: computes the update + its inverse (for Undo) from the emails in hand.
 */
import type { Id, PatchObject } from '../jmap/types';
import { CATEGORY_KEYWORDS, KW, WAKE_PREFIX, wakeKeyword, type Category } from './mapping';
import type { MailboxModel } from './mailboxes';
import type { LiteEmail } from './threads';

export type ActionKind =
  | 'archive'
  | 'removeLabel'
  | 'trash'
  | 'deleteForever'
  | 'spam'
  | 'notSpam'
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'important'
  | 'notImportant'
  | 'mute'
  | 'unmute'
  | 'moveTo'
  | 'moveToInbox'
  | 'labels'
  | 'snooze'
  | 'unsnooze'
  | 'category';

export interface ActionInput {
  kind: ActionKind;
  /** Emails per conversation (only the ones visible in the current view). */
  threads: { threadId: Id; emails: LiteEmail[] }[];
  model: MailboxModel;
  /** Mailbox the current view is "in" (inbox, label…), if any. */
  viewMailboxId?: Id;
  /** moveTo target. */
  targetMailboxId?: Id;
  /** labels: mailbox id → true (add) / false (remove). */
  labelChanges?: Record<Id, boolean>;
  snoozeUntil?: Date;
  category?: Category;
}

export interface ActionPlan {
  update: Record<Id, PatchObject>;
  destroy: Id[];
  /** Patches restoring the previous state (null when the action can't be undone). */
  undo: Record<Id, PatchObject> | null;
  /** Whether affected conversations leave the current view. */
  removesFromView: boolean;
  /** Snackbar text, e.g. "Conversation archived." */
  message: string;
  /** Optimistic new state per email id (for cache updates). */
  next: Record<Id, { mailboxIds: Record<Id, boolean>; keywords: Record<string, boolean> }>;
}

const noun = (n: number) => (n === 1 ? 'Conversation' : `${n} conversations`);

export function planAction(input: ActionInput): ActionPlan {
  const { kind, threads, model } = input;
  const role = (r: string) => model.roleId(r);
  const inbox = role('inbox');
  const archive = role('archive');
  const trash = role('trash');
  const junk = role('junk');
  const snoozed = role('snoozed');
  const n = threads.length;

  const next: ActionPlan['next'] = {};
  const update: Record<Id, PatchObject> = {};
  const undo: Record<Id, PatchObject> = {};
  const destroy: Id[] = [];

  /** Apply a transformation to one email, recording the patch + inverse. */
  const edit = (e: LiteEmail, fn: (mb: Record<Id, boolean>, kw: Record<string, boolean>) => void) => {
    const mb = { ...e.mailboxIds };
    const kw = { ...e.keywords };
    fn(mb, kw);
    if (Object.keys(mb).length === 0 && archive) mb[archive] = true;
    const patch: PatchObject = {};
    const inv: PatchObject = {};
    const mbChanged = JSON.stringify(Object.keys(mb).sort()) !== JSON.stringify(Object.keys(e.mailboxIds).sort());
    const kwChanged = JSON.stringify(Object.keys(kw).sort()) !== JSON.stringify(Object.keys(e.keywords).sort());
    if (mbChanged) {
      patch.mailboxIds = mb;
      inv.mailboxIds = e.mailboxIds;
    }
    if (kwChanged) {
      patch.keywords = kw;
      inv.keywords = e.keywords;
    }
    if (mbChanged || kwChanged) {
      update[e.id] = patch;
      undo[e.id] = inv;
    }
    next[e.id] = { mailboxIds: mb, keywords: kw };
  };

  const allEmails = threads.flatMap((t) => t.emails);
  const latestOf = (emails: LiteEmail[]) => {
    const nonDraft = emails.filter((e) => !e.keywords[KW.draft]);
    return [...(nonDraft.length ? nonDraft : emails)].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).at(-1);
  };

  let removesFromView = false;
  let message = '';
  switch (kind) {
    case 'archive':
      for (const e of allEmails) edit(e, (mb) => inbox && delete mb[inbox]);
      removesFromView = input.viewMailboxId === inbox;
      message = `${noun(n)} archived.`;
      break;
    case 'removeLabel': {
      const target = input.viewMailboxId;
      for (const e of allEmails) edit(e, (mb) => target && delete mb[target]);
      removesFromView = true;
      const name = target ? model.byId.get(target)?.name : '';
      message = target === inbox ? `${noun(n)} archived.` : `${noun(n)} removed from "${name}".`;
      break;
    }
    case 'trash':
      for (const e of allEmails) edit(e, (mb) => replace(mb, trash));
      removesFromView = input.viewMailboxId !== trash;
      message = `${noun(n)} moved to Trash.`;
      break;
    case 'deleteForever':
      destroy.push(...allEmails.map((e) => e.id));
      removesFromView = true;
      message = `${noun(n)} deleted forever.`;
      return { update, destroy, undo: null, removesFromView, message, next };
    case 'spam':
      for (const e of allEmails)
        edit(e, (mb, kw) => {
          replace(mb, junk);
          kw[KW.junk] = true;
          delete kw[KW.notJunk];
        });
      removesFromView = input.viewMailboxId !== junk;
      message = `${noun(n)} marked as spam.`;
      break;
    case 'notSpam':
      for (const e of allEmails)
        edit(e, (mb, kw) => {
          replace(mb, inbox);
          kw[KW.notJunk] = true;
          delete kw[KW.junk];
        });
      removesFromView = true;
      message = `${noun(n)} unmarked as spam and moved to Inbox.`;
      break;
    case 'moveToInbox':
      for (const e of allEmails)
        edit(e, (mb) => {
          if (trash && mb[trash]) replace(mb, inbox);
          else if (inbox) {
            mb[inbox] = true;
            if (archive) delete mb[archive];
            if (snoozed) delete mb[snoozed];
          }
        });
      removesFromView = input.viewMailboxId !== inbox;
      message = `${noun(n)} moved to Inbox.`;
      break;
    case 'read':
      for (const e of allEmails) edit(e, (_mb, kw) => (kw[KW.seen] = true));
      message = `${noun(n)} marked as read.`;
      break;
    case 'unread':
      for (const e of allEmails) edit(e, (_mb, kw) => delete kw[KW.seen]);
      message = `${noun(n)} marked as unread.`;
      break;
    case 'star':
      for (const t of threads) {
        const latest = latestOf(t.emails);
        for (const e of t.emails) edit(e, (_mb, kw) => e === latest && (kw[KW.flagged] = true));
      }
      message = `${noun(n)} starred.`;
      break;
    case 'unstar':
      for (const e of allEmails) edit(e, (_mb, kw) => delete kw[KW.flagged]);
      message = `${noun(n)} unstarred.`;
      break;
    case 'important':
      for (const e of allEmails) edit(e, (_mb, kw) => (kw[KW.important] = true));
      message = `${noun(n)} marked as important.`;
      break;
    case 'notImportant':
      for (const e of allEmails) edit(e, (_mb, kw) => delete kw[KW.important]);
      message = `${noun(n)} marked as not important.`;
      break;
    case 'mute':
      for (const e of allEmails)
        edit(e, (mb, kw) => {
          kw[KW.muted] = true;
          if (inbox) delete mb[inbox];
        });
      removesFromView = input.viewMailboxId === inbox;
      message = `${noun(n)} muted.`;
      break;
    case 'unmute':
      for (const e of allEmails) edit(e, (_mb, kw) => delete kw[KW.muted]);
      message = `${noun(n)} unmuted.`;
      break;
    case 'moveTo': {
      const target = input.targetMailboxId;
      if (!target) throw new Error('moveTo needs a target');
      if (target === trash) return planAction({ ...input, kind: 'trash' });
      if (target === junk) return planAction({ ...input, kind: 'spam' });
      const from = input.viewMailboxId ?? inbox;
      for (const e of allEmails)
        edit(e, (mb) => {
          if (from && from !== target) delete mb[from];
          if (trash) delete mb[trash];
          if (junk) delete mb[junk];
          if (archive && target !== archive) delete mb[archive];
          mb[target] = true;
        });
      removesFromView = from !== target && !!input.viewMailboxId;
      message = `${noun(n)} moved to "${target === inbox ? 'Inbox' : model.pathOf(target) || 'label'}".`;
      break;
    }
    case 'labels': {
      const changes = input.labelChanges ?? {};
      for (const e of allEmails)
        edit(e, (mb) => {
          for (const [id, on] of Object.entries(changes)) {
            if (on) mb[id] = true;
            else delete mb[id];
          }
          // A label added to an archived-only message no longer needs Archive.
          if (archive && mb[archive] && Object.keys(mb).length > 1) delete mb[archive];
        });
      const removed = Object.entries(changes).find(([, on]) => !on)?.[0];
      removesFromView = !!removed && removed === input.viewMailboxId;
      const added = Object.entries(changes)
        .filter(([, on]) => on)
        .map(([id]) => model.pathOf(id));
      message = added.length === 1 && Object.keys(changes).length === 1 ? `${noun(n)} added to "${added[0]}".` : `Labels updated for ${noun(n).toLowerCase()}.`;
      break;
    }
    case 'snooze': {
      const until = input.snoozeUntil;
      if (!until || !snoozed) throw new Error('snooze needs a time and a Snoozed mailbox');
      const wk = wakeKeyword(until);
      for (const e of allEmails)
        edit(e, (mb, kw) => {
          if (inbox) delete mb[inbox];
          mb[snoozed] = true;
          for (const k of Object.keys(kw)) if (k.toLowerCase().startsWith(WAKE_PREFIX)) delete kw[k];
          kw[wk] = true;
        });
      removesFromView = input.viewMailboxId !== snoozed;
      message = `${noun(n)} snoozed until ${until.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
      break;
    }
    case 'unsnooze':
      for (const e of allEmails)
        edit(e, (mb, kw) => {
          if (snoozed) delete mb[snoozed];
          if (inbox) mb[inbox] = true;
          for (const k of Object.keys(kw)) if (k.toLowerCase().startsWith(WAKE_PREFIX)) delete kw[k];
        });
      removesFromView = input.viewMailboxId === snoozed;
      message = `${noun(n)} unsnoozed.`;
      break;
    case 'category': {
      const cat = input.category ?? 'primary';
      for (const e of allEmails)
        edit(e, (_mb, kw) => {
          for (const k of Object.values(CATEGORY_KEYWORDS)) delete kw[k];
          if (cat !== 'primary') kw[CATEGORY_KEYWORDS[cat]] = true;
        });
      removesFromView = true;
      message = `${noun(n)} moved to ${cat[0]!.toUpperCase()}${cat.slice(1)}.`;
      break;
    }
  }
  return { update, destroy, undo, removesFromView, message, next };
}

function replace(mb: Record<Id, boolean>, id: Id | undefined) {
  for (const k of Object.keys(mb)) delete mb[k];
  if (id) mb[id] = true;
}

/** Split a large update into Email/set calls that respect maxObjectsInSet. */
export function chunkPatches(update: Record<Id, PatchObject>, max = 500): Record<Id, PatchObject>[] {
  const entries = Object.entries(update);
  const out: Record<Id, PatchObject>[] = [];
  for (let i = 0; i < entries.length; i += max) out.push(Object.fromEntries(entries.slice(i, i + max)));
  return out;
}
