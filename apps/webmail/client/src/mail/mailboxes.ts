import type { Mailbox } from '../jmap/types';
import { ROLE_MAILBOX_NAMES } from './mapping';
import type { IconName } from '../components/icons/paths';

export interface LabelNode {
  mailbox: Mailbox;
  path: string;
  depth: number;
  children: LabelNode[];
}

export interface MailboxModel {
  list: Mailbox[];
  byId: Map<string, Mailbox>;
  byRole: Map<string, Mailbox>;
  /** User labels (mailboxes without a role), as a tree sorted by name. */
  labelTree: LabelNode[];
  /** Flattened label list in tree order. */
  labels: LabelNode[];
  pathOf(id: string): string;
  idByPath(path: string): string | undefined;
  roleId(role: string): string | undefined;
}

/** Roles that are Gmail system folders (not shown as user labels). */
const SYSTEM_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'snoozed', 'scheduled', 'important', 'all', 'flagged']);

export function buildMailboxModel(list: Mailbox[]): MailboxModel {
  const byId = new Map(list.map((m) => [m.id, m]));
  const byRole = new Map<string, Mailbox>();
  for (const m of list) if (m.role && !byRole.has(m.role)) byRole.set(m.role, m);

  const pathCache = new Map<string, string>();
  const pathOf = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const m = byId.get(id);
    if (!m) return '';
    const p = m.parentId && byId.has(m.parentId) ? `${pathOf(m.parentId)}/${m.name}` : m.name;
    pathCache.set(id, p);
    return p;
  };

  const isLabel = (m: Mailbox) => !m.role || !SYSTEM_ROLES.has(m.role);
  const nodes = new Map<string, LabelNode>();
  for (const m of list) if (isLabel(m)) nodes.set(m.id, { mailbox: m, path: pathOf(m.id), depth: 0, children: [] });
  const roots: LabelNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.mailbox.parentId ? nodes.get(n.mailbox.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sortRec = (arr: LabelNode[], depth: number) => {
    arr.sort((a, b) => a.mailbox.sortOrder - b.mailbox.sortOrder || a.mailbox.name.localeCompare(b.mailbox.name, undefined, { sensitivity: 'base' }));
    for (const n of arr) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  const flat: LabelNode[] = [];
  const walk = (arr: LabelNode[]) => arr.forEach((n) => (flat.push(n), walk(n.children)));
  walk(roots);

  const byPath = new Map<string, string>();
  for (const m of list) byPath.set(pathOf(m.id).toLowerCase(), m.id);

  return {
    list,
    byId,
    byRole,
    labelTree: roots,
    labels: flat,
    pathOf,
    idByPath: (p) => byPath.get(p.toLowerCase()),
    roleId: (r) => byRole.get(r)?.id,
  };
}

export interface SystemFolder {
  key: string; // view key
  label: string;
  icon: IconName;
  role?: string;
  /** Which count to show in the nav. */
  count?: 'unreadThreads' | 'totalEmails' | 'unreadEmails';
  /** Shown only after expanding "More". */
  more?: boolean;
}

/** Gmail nav order (02-components §3). */
export const SYSTEM_FOLDERS: SystemFolder[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox', role: 'inbox', count: 'unreadThreads' },
  { key: 'starred', label: 'Starred', icon: 'star' },
  { key: 'snoozed', label: 'Snoozed', icon: 'schedule', role: 'snoozed' },
  { key: 'sent', label: 'Sent', icon: 'send', role: 'sent' },
  { key: 'drafts', label: 'Drafts', icon: 'draft', role: 'drafts', count: 'totalEmails' },
  { key: 'imp', label: 'Important', icon: 'label_important', more: true },
  { key: 'scheduled', label: 'Scheduled', icon: 'schedule_send', role: 'scheduled', count: 'totalEmails', more: true },
  { key: 'all', label: 'All Mail', icon: 'mail', more: true },
  { key: 'spam', label: 'Spam', icon: 'report', role: 'junk', count: 'unreadEmails', more: true },
  { key: 'trash', label: 'Trash', icon: 'delete', role: 'trash', more: true },
];

export const ROLE_FOR_VIEW: Record<string, string> = {
  inbox: 'inbox',
  snoozed: 'snoozed',
  sent: 'sent',
  drafts: 'drafts',
  scheduled: 'scheduled',
  spam: 'junk',
  trash: 'trash',
};

export function roleMailboxName(role: string): string {
  return ROLE_MAILBOX_NAMES[role] ?? role[0]!.toUpperCase() + role.slice(1);
}
