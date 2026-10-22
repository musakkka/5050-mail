/**
 * Gmail search-operator parser → JMAP Email/query FilterCondition (RFC 8621 §4.4.1).
 *
 * Supports: bare words, "exact phrases", -negation, OR / |, {a b} (any of),
 * ( ) grouping, AND, and the operators
 *   from: to: cc: bcc: subject: label: in: is: has: filename: list: deliveredto:
 *   rfc822msgid: category: after: before: older: newer: older_than: newer_than:
 *   larger: smaller: size:
 */
import type { EmailFilter, EmailFilterCondition, FilterOperator } from '../jmap/types';
import { CATEGORY_KEYWORDS, KW } from './mapping';

export type Node =
  | { type: 'and'; children: Node[] }
  | { type: 'or'; children: Node[] }
  | { type: 'not'; child: Node }
  | { type: 'term'; op?: string; value: string; quoted?: boolean };

// ------------------------------------------------------------------ lexer
type Tok = { t: 'word'; v: string; quoted: boolean; op?: string } | { t: '(' | ')' | '{' | '}' | '-' | 'OR' | 'AND' };

export function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = input;
  const readQuoted = (): string => {
    // assumes s[i] === '"'
    i++;
    let v = '';
    while (i < s.length && s[i] !== '"') v += s[i++];
    i++; // closing quote (or end)
    return v;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      out.push({ t: c });
      i++;
      continue;
    }
    if (c === '-' && i + 1 < s.length && !/\s/.test(s[i + 1]!)) {
      // "-" only negates at the start of a term
      const prev = s[i - 1];
      if (prev === undefined || /[\s({]/.test(prev)) {
        out.push({ t: '-' });
        i++;
        continue;
      }
    }
    if (c === '|') {
      out.push({ t: 'OR' });
      i++;
      continue;
    }
    if (c === '"') {
      out.push({ t: 'word', v: readQuoted(), quoted: true });
      continue;
    }
    // bare word, possibly op:value
    let w = '';
    while (i < s.length && !/[\s(){}"]/.test(s[i]!)) w += s[i++];
    const m = /^([a-z_0-9]+):(.*)$/i.exec(w);
    if (m) {
      const op = m[1]!.toLowerCase();
      let v = m[2]!;
      if (!v && s[i] === '"') {
        v = readQuoted();
        out.push({ t: 'word', v, quoted: true, op });
        continue;
      }
      if (!v && s[i] === '(') {
        // op:(a b) → group of op terms
        i++;
        let depth = 1;
        let inner = '';
        while (i < s.length && depth > 0) {
          if (s[i] === '(') depth++;
          if (s[i] === ')') depth--;
          if (depth > 0) inner += s[i];
          i++;
        }
        out.push({ t: '(' });
        for (const part of tokenize(inner)) {
          if (part.t === 'word' && !part.op) out.push({ ...part, op });
          else out.push(part);
        }
        out.push({ t: ')' });
        continue;
      }
      out.push({ t: 'word', v, quoted: false, op });
      continue;
    }
    if (w === 'OR') out.push({ t: 'OR' });
    else if (w === 'AND') out.push({ t: 'AND' });
    else if (w) out.push({ t: 'word', v: w, quoted: false });
  }
  return out;
}

// ------------------------------------------------------------------ parser
export function parse(input: string): Node | null {
  const toks = tokenize(input);
  let p = 0;
  const peek = () => toks[p];

  function orExpr(stop?: string): Node | null {
    const parts: Node[] = [];
    let cur = andExpr(stop);
    if (cur) parts.push(cur);
    while (peek()?.t === 'OR') {
      p++;
      cur = andExpr(stop);
      if (cur) parts.push(cur);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0]! : { type: 'or', children: parts };
  }

  function andExpr(stop?: string): Node | null {
    const parts: Node[] = [];
    while (p < toks.length) {
      const t = peek()!;
      if (t.t === 'OR' || t.t === stop) break;
      if (t.t === ')' || t.t === '}') {
        p++; // unbalanced closer; skip
        if (!stop) continue;
        break;
      }
      if (t.t === 'AND') {
        p++;
        continue;
      }
      const u = unary();
      if (u) parts.push(u);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0]! : { type: 'and', children: parts };
  }

  function unary(): Node | null {
    const t = peek();
    if (!t) return null;
    if (t.t === '-') {
      p++;
      const c = unary();
      return c ? { type: 'not', child: c } : null;
    }
    return primary();
  }

  function primary(): Node | null {
    const t = toks[p++];
    if (!t) return null;
    if (t.t === '(') {
      const e = orExpr(')');
      if (peek()?.t === ')') p++;
      return e;
    }
    if (t.t === '{') {
      const items: Node[] = [];
      while (p < toks.length && peek()!.t !== '}') {
        if (peek()!.t === 'OR' || peek()!.t === 'AND') {
          p++;
          continue;
        }
        const u = unary();
        if (u) items.push(u);
      }
      if (peek()?.t === '}') p++;
      if (!items.length) return null;
      return items.length === 1 ? items[0]! : { type: 'or', children: items };
    }
    if (t.t === 'word') return { type: 'term', op: t.op, value: t.v, quoted: t.quoted };
    return null;
  }

  const root = orExpr();
  return root;
}

// ------------------------------------------------------------------ compile
export interface ResolveContext {
  /** Mailbox id for a role (inbox, sent, drafts, trash, junk, archive, snoozed, scheduled). */
  roleId(role: string): string | undefined;
  /** Mailbox id for a label path ("Work", "Projects/Alpha"; Gmail-style "projects-alpha" also tried). */
  labelId(name: string): string | undefined;
  /** Ids of all role (system) mailboxes, for has:userlabels / has:nouserlabels. */
  systemMailboxIds?: string[];
  now?: Date;
}

export interface CompiledSearch {
  filter: EmailFilter | null;
  /** True if the query explicitly targets Trash/Spam or in:anywhere — then don't exclude them. */
  includesTrashOrSpam: boolean;
  /** Free-text terms, used to decide whether to fetch SearchSnippets. */
  hasText: boolean;
}

const NEVER: EmailFilterCondition = { inMailbox: 'zzzzzzzzzzzz' };

const ROLE_ALIASES: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sent',
  sentmail: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  trash: 'trash',
  bin: 'trash',
  spam: 'junk',
  junk: 'junk',
  archive: 'archive',
  snoozed: 'snoozed',
  scheduled: 'scheduled',
};

export function parseDate(v: string): Date | undefined {
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
  return undefined;
}

export function parseRelative(v: string, now: Date): Date | undefined {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const d = new Date(now);
  const unit = m[2]!.toLowerCase();
  if (unit === 'd') d.setDate(d.getDate() - n);
  if (unit === 'm') d.setMonth(d.getMonth() - n);
  if (unit === 'y') d.setFullYear(d.getFullYear() - n);
  return d;
}

export function parseSize(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kmg]b?|b(?:ytes)?)?$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] ?? '').toLowerCase()[0];
  return Math.round(n * (u === 'k' ? 1024 : u === 'm' ? 1024 ** 2 : u === 'g' ? 1024 ** 3 : 1));
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function compile(node: Node | null, ctx: ResolveContext): CompiledSearch {
  let includesTrashOrSpam = false;
  let hasText = false;
  const now = ctx.now ?? new Date();

  const term = (op: string | undefined, raw: string, quoted = false): EmailFilter => {
    const v = raw.trim();
    const lv = v.toLowerCase();
    switch (op) {
      case undefined:
        hasText = true;
        return { text: quoted && /\s/.test(v) ? `"${v}"` : v };
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'subject':
        if (op === 'from' && lv === 'me') return { from: '\u0000me' };
        if (op === 'to' && lv === 'me') return { to: '\u0000me' };
        hasText ||= op === 'subject';
        return { [op]: v } as EmailFilterCondition;
      case 'label': {
        const id = ctx.labelId(v) ?? ctx.labelId(v.replace(/-/g, '/')) ?? ctx.roleId(ROLE_ALIASES[lv] ?? '');
        return id ? { inMailbox: id } : NEVER;
      }
      case 'in': {
        if (lv === 'anywhere' || lv === 'all') {
          includesTrashOrSpam = lv === 'anywhere';
          return {};
        }
        const role = ROLE_ALIASES[lv];
        if (role === 'trash' || role === 'junk') includesTrashOrSpam = true;
        if (lv === 'starred') return { hasKeyword: KW.flagged };
        if (lv === 'archive') {
          const inbox = ctx.roleId('inbox');
          return inbox ? { operator: 'NOT', conditions: [{ inMailbox: inbox }] } : {};
        }
        if (lv === 'important') return { hasKeyword: KW.important };
        const id = role ? ctx.roleId(role) : ctx.labelId(v);
        return id ? { inMailbox: id } : NEVER;
      }
      case 'is':
        switch (lv) {
          case 'unread':
            return { notKeyword: KW.seen };
          case 'read':
            return { hasKeyword: KW.seen };
          case 'starred':
            return { hasKeyword: KW.flagged };
          case 'unstarred':
            return { notKeyword: KW.flagged };
          case 'important':
            return { hasKeyword: KW.important };
          case 'muted':
            return { hasKeyword: KW.muted };
          case 'snoozed': {
            const id = ctx.roleId('snoozed');
            return id ? { inMailbox: id } : NEVER;
          }
          case 'draft':
          case 'drafts':
            return { hasKeyword: KW.draft };
          case 'answered':
          case 'replied':
            return { hasKeyword: KW.answered };
          default:
            return NEVER;
        }
      case 'has':
        switch (lv) {
          case 'attachment':
          case 'attachments':
            return { hasAttachment: true };
          case 'star':
          case 'yellow-star':
            return { hasKeyword: KW.flagged };
          case 'userlabels':
            return { inMailboxOtherThan: ctx.systemMailboxIds ?? [] };
          case 'nouserlabels':
            return { operator: 'NOT', conditions: [{ inMailboxOtherThan: ctx.systemMailboxIds ?? [] }] };
          default:
            return { hasAttachment: true };
        }
      case 'filename':
        // No attachment-name filter in RFC 8621, and Stalwart's full-text index skips attachment
        // names: resolved against attachment metadata before querying (mail/filenameFilter.ts).
        return { acme_filename: v.toLowerCase() };
      case 'list':
        return { header: ['List-Id', v] };
      case 'header': {
        // header:Name:value  (Gmail) → { header: [Name, value] }
        const i = v.indexOf(':');
        if (i <= 0) return v ? { header: [v] } : NEVER;
        return { header: [v.slice(0, i), v.slice(i + 1)] };
      }
      case 'deliveredto':
        return { header: ['Delivered-To', v] };
      case 'rfc822msgid':
        return { header: ['Message-ID', v.replace(/^<|>$/g, '')] };
      case 'category': {
        if (lv === 'primary' || lv === 'personal') {
          return { operator: 'NOT', conditions: Object.values(CATEGORY_KEYWORDS).map((k) => ({ hasKeyword: k })) };
        }
        const kw = CATEGORY_KEYWORDS[lv as keyof typeof CATEGORY_KEYWORDS];
        return kw ? { hasKeyword: kw } : NEVER;
      }
      case 'after':
      case 'newer': {
        const d = parseDate(v);
        return d ? { after: iso(d) } : NEVER;
      }
      case 'before':
      case 'older': {
        const d = parseDate(v);
        return d ? { before: iso(d) } : NEVER;
      }
      case 'newer_than': {
        const d = parseRelative(v, now);
        return d ? { after: iso(d) } : NEVER;
      }
      case 'older_than': {
        const d = parseRelative(v, now);
        return d ? { before: iso(d) } : NEVER;
      }
      case 'larger':
      case 'size': {
        const n = parseSize(v);
        return n !== undefined ? { minSize: n } : NEVER;
      }
      case 'smaller': {
        const n = parseSize(v);
        return n !== undefined ? { maxSize: n } : NEVER;
      }
      default:
        // Unknown operator: treat the whole thing as text (Gmail does the same).
        hasText = true;
        return { text: `${op}:${v}` };
    }
  };

  const walk = (n: Node): EmailFilter => {
    switch (n.type) {
      case 'term':
        return term(n.op, n.value, n.quoted);
      case 'not':
        return { operator: 'NOT', conditions: [walk(n.child)] };
      case 'and':
      case 'or': {
        const conds = n.children.map(walk).filter((c) => !isEmpty(c));
        if (conds.length === 1) return conds[0]!;
        return { operator: n.type === 'and' ? 'AND' : 'OR', conditions: conds };
      }
    }
  };

  const filter = node ? walk(node) : null;
  return { filter: filter && !isEmpty(filter) ? filter : null, includesTrashOrSpam, hasText };
}

function isEmpty(f: EmailFilter): boolean {
  if ('operator' in f) return (f as FilterOperator<EmailFilterCondition>).conditions.length === 0;
  return Object.keys(f).length === 0;
}

/**
 * Replace the `\u0000me` placeholder used for from:me / to:me with the user's
 * address(es); several identities are OR'd.
 */
export function bindMe(filter: EmailFilter | null, me: string | string[]): EmailFilter | null {
  if (!filter) return filter;
  const mine = (Array.isArray(me) ? me : [me]).filter(Boolean);
  const rec = (f: EmailFilter): EmailFilter => {
    if ('operator' in f) return { ...f, conditions: f.conditions.map(rec) } as EmailFilter;
    const c = f as EmailFilterCondition;
    for (const k of ['from', 'to'] as const) {
      if (c[k] === '\u0000me') {
        if (mine.length === 1) return { ...c, [k]: mine[0] };
        return { operator: 'OR', conditions: mine.map((m) => ({ ...c, [k]: m })) };
      }
    }
    return c;
  };
  return rec(filter);
}

/** Parse + compile in one go. */
export function searchToFilter(query: string, ctx: ResolveContext & { me?: string | string[] }): CompiledSearch {
  const res = compile(parse(query), ctx);
  return { ...res, filter: ctx.me ? bindMe(res.filter, ctx.me) : res.filter };
}

// ------------------------------------------------------------------ advanced search form <-> query
export interface AdvancedSearch {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  sizeOp: 'larger' | 'smaller';
  size: string;
  sizeUnit: 'MB' | 'KB' | 'Bytes';
  dateWithin: '' | '1d' | '3d' | '1w' | '2w' | '1m' | '2m' | '6m' | '1y';
  date: string; // yyyy-mm-dd
  searchIn: string; // '' = All Mail, else in:/is:/label: value
  hasAttachment: boolean;
}

export const EMPTY_ADVANCED: AdvancedSearch = {
  from: '',
  to: '',
  subject: '',
  hasWords: '',
  doesntHave: '',
  sizeOp: 'larger',
  size: '',
  sizeUnit: 'MB',
  dateWithin: '',
  date: '',
  searchIn: '',
  hasAttachment: false,
};

const q = (v: string) => (/[\s()]/.test(v) ? `(${v})` : v);

export function buildQuery(a: AdvancedSearch): string {
  const parts: string[] = [];
  if (a.from.trim()) parts.push(`from:${q(a.from.trim())}`);
  if (a.to.trim()) parts.push(`to:${q(a.to.trim())}`);
  if (a.subject.trim()) parts.push(`subject:${q(a.subject.trim())}`);
  if (a.hasWords.trim()) parts.push(a.hasWords.trim());
  if (a.doesntHave.trim())
    parts.push(
      ...a.doesntHave
        .trim()
        .split(/\s+/)
        .map((w) => `-${w}`),
    );
  if (a.size.trim() && Number(a.size) > 0) parts.push(`${a.sizeOp}:${a.size.trim()}${a.sizeUnit === 'MB' ? 'M' : a.sizeUnit === 'KB' ? 'K' : ''}`);
  if (a.dateWithin && a.date) {
    const center = new Date(`${a.date}T00:00:00`);
    const days = { '1d': 1, '3d': 3, '1w': 7, '2w': 14, '1m': 30, '2m': 60, '6m': 182, '1y': 365 }[a.dateWithin];
    const fmt = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    parts.push(`after:${fmt(new Date(center.getTime() - days * 86400_000))}`, `before:${fmt(new Date(center.getTime() + (days + 1) * 86400_000))}`);
  }
  if (a.searchIn) parts.push(a.searchIn);
  if (a.hasAttachment) parts.push('has:attachment');
  return parts.join(' ');
}

/** Best-effort reverse mapping (for pre-filling the advanced panel from the current query). */
export function parseAdvanced(query: string): AdvancedSearch {
  const a: AdvancedSearch = { ...EMPTY_ADVANCED };
  const rest: string[] = [];
  const neg: string[] = [];
  for (const t of tokenize(query)) {
    if (t.t !== 'word') continue;
    const val = t.quoted ? `"${t.v}"` : t.v;
    switch (t.op) {
      case 'from':
        a.from = a.from ? `${a.from} ${t.v}` : t.v;
        break;
      case 'to':
        a.to = a.to ? `${a.to} ${t.v}` : t.v;
        break;
      case 'subject':
        a.subject = a.subject ? `${a.subject} ${t.v}` : t.v;
        break;
      case 'has':
        if (/^attachments?$/i.test(t.v)) a.hasAttachment = true;
        break;
      case 'larger':
      case 'smaller': {
        a.sizeOp = t.op;
        const m = /^(\d+)([km]?)/i.exec(t.v);
        if (m) {
          a.size = m[1]!;
          a.sizeUnit = m[2]?.toLowerCase() === 'k' ? 'KB' : m[2]?.toLowerCase() === 'm' ? 'MB' : 'Bytes';
        }
        break;
      }
      case 'in':
      case 'is':
      case 'label':
        a.searchIn = `${t.op}:${t.v}`;
        break;
      case undefined:
        rest.push(val);
        break;
      default:
        rest.push(`${t.op}:${val}`);
    }
  }
  // negations: tokens following '-'
  const toks = tokenize(query);
  toks.forEach((t, i) => {
    if (t.t === '-' && toks[i + 1]?.t === 'word') neg.push((toks[i + 1] as { v: string }).v);
  });
  a.hasWords = rest.filter((r) => !neg.includes(r)).join(' ');
  a.doesntHave = neg.join(' ');
  return a;
}
