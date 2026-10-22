/**
 * Gmail concept → JMAP mapping constants (see docs/gmail-spec/05-jmap-mapping.md).
 * Pure data: imported by the SPA, the seed script and tests.
 */

export const KW = {
  seen: '$seen',
  flagged: '$flagged', // Gmail "Starred"
  draft: '$draft',
  answered: '$answered',
  forwarded: '$forwarded',
  important: '$important', // Gmail "Important" marker (RFC 8457)
  muted: '$muted', // RFC 8457 thread muting
  junk: '$junk',
  notJunk: '$notjunk',
  phishing: '$phishing',
} as const;

/**
 * Prefix for the keyword that stores the snooze wake-up time (05-jmap-mapping §8):
 * `$ff_wake_YYYYMMDDTHHMMZ`. JMAP lowercases keywords, so parse case-insensitively.
 */
export const WAKE_PREFIX = '$ff_wake_';

export function wakeKeyword(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${WAKE_PREFIX}${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}t${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`;
}

export function parseWakeKeyword(kw: string): Date | undefined {
  const m = /^\$ff_wake_(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})z$/i.exec(kw);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
}

/** Wake time of an email, if it carries a wake keyword. */
export function wakeTimeOf(keywords: Record<string, boolean> | undefined): Date | undefined {
  for (const k of Object.keys(keywords ?? {})) {
    const d = parseWakeKeyword(k);
    if (d) return d;
  }
  return undefined;
}

/** Inbox category tabs are emulated with keywords (05 §6); Primary = inbox emails with none of them. */
export const CATEGORY_KEYWORDS = {
  promotions: '$ff_cat_promotions',
  social: '$ff_cat_social',
  updates: '$ff_cat_updates',
  forums: '$ff_cat_forums',
} as const;
export type Category = 'primary' | keyof typeof CATEGORY_KEYWORDS;
export const CATEGORIES: Category[] = ['primary', 'promotions', 'social', 'updates', 'forums'];

/** Mailbox roles (RFC 8621 / IANA) used for Gmail system folders. */
export const ROLE = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  trash: 'trash',
  junk: 'junk',
  archive: 'archive',
  scheduled: 'scheduled',
  snoozed: 'snoozed',
} as const;

/** Names used when the app has to create a role mailbox that the server didn't provision. */
export const ROLE_MAILBOX_NAMES: Record<string, string> = {
  archive: 'Archive',
  scheduled: 'Scheduled',
  snoozed: 'Snoozed',
};
