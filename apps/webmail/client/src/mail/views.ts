/** Mail views (Gmail "#inbox", "#label/X", "#search/q" …) ↔ URLs ↔ JMAP filters. */
import type { EmailFilter, EmailFilterCondition, Comparator } from '../jmap/types';
import { CATEGORY_KEYWORDS, KW, type Category } from './mapping';
import type { MailboxModel } from './mailboxes';
import { searchToFilter } from './searchParser';

export type View =
  | { kind: 'folder'; key: 'inbox' | 'starred' | 'snoozed' | 'sent' | 'drafts' | 'imp' | 'scheduled' | 'all' | 'spam' | 'trash' }
  | { kind: 'category'; key: Exclude<Category, 'primary'> }
  | { kind: 'label'; key: string /* label path */ }
  | { kind: 'search'; key: string /* query */ };

export const FOLDER_KEYS = ['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'imp', 'scheduled', 'all', 'spam', 'trash'] as const;

export interface ParsedRoute {
  view: View;
  threadId?: string;
  page: number;
  settings?: string;
}

/** Parse `/mail/...` (pathname without the `/mail` prefix handled here). */
export function parseMailPath(pathname: string, search = ''): ParsedRoute {
  const segs = pathname
    .replace(/^\/mail\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  const page = Math.max(1, Number(new URLSearchParams(search).get('p') ?? 1) || 1);
  const head = segs[0] ?? 'inbox';
  if (head === 'settings') return { view: { kind: 'folder', key: 'inbox' }, page: 1, settings: segs[1] ?? 'general' };
  if ((FOLDER_KEYS as readonly string[]).includes(head)) {
    return { view: { kind: 'folder', key: head as (typeof FOLDER_KEYS)[number] }, threadId: segs[1], page };
  }
  if (head === 'category' && segs[1] && segs[1] in CATEGORY_KEYWORDS) {
    return { view: { kind: 'category', key: segs[1] as Exclude<Category, 'primary'> }, threadId: segs[2], page };
  }
  if (head === 'label' && segs[1]) return { view: { kind: 'label', key: segs[1] }, threadId: segs[2], page };
  if (head === 'search' && segs[1] !== undefined) return { view: { kind: 'search', key: segs[1] }, threadId: segs[2], page };
  return { view: { kind: 'folder', key: 'inbox' }, page };
}

export function viewBase(view: View): string {
  switch (view.kind) {
    case 'folder':
      return `/mail/${view.key}`;
    case 'category':
      return `/mail/category/${view.key}`;
    case 'label':
      return `/mail/label/${encodeURIComponent(view.key)}`;
    case 'search':
      return `/mail/search/${encodeURIComponent(view.key)}`;
  }
}

export function viewUrl(view: View, opts: { threadId?: string; page?: number } = {}): string {
  let u = viewBase(view);
  if (opts.threadId) u += `/${encodeURIComponent(opts.threadId)}`;
  if (opts.page && opts.page > 1) u += `?p=${opts.page}`;
  return u;
}

export function sameView(a: View, b: View): boolean {
  return a.kind === b.kind && a.key === b.key;
}

const FOLDER_TITLES: Record<string, string> = {
  inbox: 'Inbox',
  starred: 'Starred',
  snoozed: 'Snoozed',
  sent: 'Sent',
  drafts: 'Drafts',
  imp: 'Important',
  scheduled: 'Scheduled',
  all: 'All Mail',
  spam: 'Spam',
  trash: 'Trash',
};
const CATEGORY_TITLES: Record<string, string> = { primary: 'Primary', promotions: 'Promotions', social: 'Social', updates: 'Updates', forums: 'Forums' };

export function viewTitle(view: View): string {
  switch (view.kind) {
    case 'folder':
      return FOLDER_TITLES[view.key]!;
    case 'category':
      return CATEGORY_TITLES[view.key]!;
    case 'label':
      return view.key.split('/').pop()!;
    case 'search':
      return 'Search results';
  }
}

export function categoryTitle(c: Category): string {
  return CATEGORY_TITLES[c]!;
}

export interface ViewQuery {
  filter: EmailFilter;
  sort: Comparator[];
  collapseThreads: boolean;
  /** Whether to fetch SearchSnippets for highlighting. */
  snippets: boolean;
  /** Mailbox id the view is "in" (for archive/remove-label semantics). */
  mailboxId?: string;
  /** Trash/spam views show only messages in that mailbox inside threads. */
  scopeMailboxId?: string;
  /** If false the impossible-filter guard kicked in (missing role mailbox) — render empty. */
  valid: boolean;
}

export interface ViewContext {
  model: MailboxModel;
  /** The user's own addresses (identities), for from:me / to:me. */
  me: string[];
  categoriesEnabled: boolean;
  enabledCategories: Category[];
  conversationView: boolean;
  /** Inbox type sort (Default / Unread first / Starred first / Important first). */
  inboxType?: 'default' | 'unread' | 'starred' | 'important';
}

const NONE = 'zzzzzzzzzzzz'; // syntactically valid id that never exists

function and(...conds: (EmailFilter | undefined | null)[]): EmailFilter {
  const c = conds.filter(Boolean) as EmailFilter[];
  if (c.length === 1) return c[0]!;
  return { operator: 'AND', conditions: c };
}

export function primaryExclusion(enabled: Category[]): EmailFilter | undefined {
  const kws = enabled.filter((c) => c !== 'primary').map((c) => CATEGORY_KEYWORDS[c as keyof typeof CATEGORY_KEYWORDS]);
  if (!kws.length) return undefined;
  return { operator: 'NOT', conditions: kws.map((k) => ({ hasKeyword: k })) };
}

export function viewQuery(view: View, ctx: ViewContext): ViewQuery {
  const { model } = ctx;
  const trash = model.roleId('trash');
  const junk = model.roleId('junk');
  const notTrashSpam: EmailFilterCondition = { inMailboxOtherThan: [trash, junk].filter(Boolean) as string[] };
  const byDate: Comparator[] = [{ property: 'receivedAt', isAscending: false }];
  const base = { sort: byDate, collapseThreads: ctx.conversationView, snippets: false, valid: true };
  const inRole = (role: string): ViewQuery => {
    const id = model.roleId(role);
    return { ...base, filter: { inMailbox: id ?? NONE }, mailboxId: id, valid: !!id };
  };

  switch (view.kind) {
    case 'folder':
      switch (view.key) {
        case 'inbox': {
          const q = inRole('inbox');
          if (ctx.categoriesEnabled) q.filter = and(q.filter, primaryExclusion(ctx.enabledCategories));
          return q;
        }
        case 'starred':
          return { ...base, filter: and({ hasKeyword: KW.flagged }, notTrashSpam) };
        case 'imp':
          return { ...base, filter: and({ hasKeyword: KW.important }, notTrashSpam) };
        case 'all':
          return { ...base, filter: notTrashSpam };
        case 'sent':
          return inRole('sent');
        case 'drafts':
          return { ...inRole('drafts'), collapseThreads: false };
        case 'scheduled':
          return { ...inRole('scheduled'), collapseThreads: false };
        case 'snoozed':
          return inRole('snoozed');
        case 'spam':
          return { ...inRole('junk'), scopeMailboxId: junk };
        case 'trash':
          return { ...inRole('trash'), scopeMailboxId: trash };
      }
      break;
    case 'category': {
      const inbox = model.roleId('inbox');
      return { ...base, filter: and({ inMailbox: inbox ?? NONE }, { hasKeyword: CATEGORY_KEYWORDS[view.key] }), mailboxId: inbox, valid: !!inbox };
    }
    case 'label': {
      const id = model.idByPath(view.key);
      return { ...base, filter: { inMailbox: id ?? NONE }, mailboxId: id, valid: !!id };
    }
    case 'search': {
      const compiled = searchToFilter(view.key, {
        roleId: model.roleId,
        labelId: model.idByPath,
        me: ctx.me,
        systemMailboxIds: model.list.filter((m) => m.role).map((m) => m.id),
      });
      const filter = compiled.includesTrashOrSpam ? (compiled.filter ?? {}) : and(compiled.filter, notTrashSpam);
      return { ...base, filter, snippets: compiled.hasText };
    }
  }
  throw new Error('unreachable');
}

/** Gmail "inbox type" sorts — JMAP `hasKeyword` comparator (Stalwart advertises it). */
export function inboxTypeSort(type: ViewContext['inboxType']): Comparator[] {
  const byDate: Comparator = { property: 'receivedAt', isAscending: false };
  switch (type) {
    case 'unread':
      return [{ property: 'hasKeyword', keyword: KW.seen, isAscending: true }, byDate];
    case 'starred':
      return [{ property: 'hasKeyword', keyword: KW.flagged, isAscending: false }, byDate];
    case 'important':
      return [{ property: 'hasKeyword', keyword: KW.important, isAscending: false }, byDate];
    default:
      return [byDate];
  }
}
