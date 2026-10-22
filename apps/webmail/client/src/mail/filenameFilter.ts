/** Gmail's `filename:` operator, resolved client-side (Stalwart doesn't index attachment names). */
import type { JmapClient } from '../jmap/client';
import type { EmailFilter, EmailFilterCondition, Id } from '../jmap/types';

/** How many of the newest emails with attachments are scanned per filename: term. */
const SCAN_LIMIT = 2000;
const NONE: EmailFilterCondition = { inMailbox: 'zzzzzzzzzzzz' };

function collect(f: EmailFilter | null, out: Set<string>) {
  if (!f) return;
  if ('operator' in f) for (const c of f.conditions) collect(c as EmailFilter, out);
  else if ((f as EmailFilterCondition).acme_filename !== undefined) out.add((f as EmailFilterCondition).acme_filename!);
}

/** Does an attachment name match a Gmail filename: term ("pdf", "report", "report.pdf")? */
export function filenameMatches(name: string | null | undefined, term: string): boolean {
  if (!name || !term) return false;
  const n = name.toLowerCase();
  const t = term.toLowerCase().replace(/^\*?\.?/, (m) => (m.includes('.') ? '.' : ''));
  return n.includes(t) || n.endsWith(`.${t}`);
}

export function replaceFilenameFilters(f: EmailFilter | null, ids: Map<string, Id[]>): EmailFilter | null {
  if (!f) return f;
  if ('operator' in f) return { ...f, conditions: f.conditions.map((c) => replaceFilenameFilters(c as EmailFilter, ids)!) } as EmailFilter;
  const c = f as EmailFilterCondition;
  if (c.acme_filename === undefined) return c;
  const list = ids.get(c.acme_filename) ?? [];
  const { acme_filename: _drop, ...rest } = c;
  return list.length ? { ...rest, id: list } : NONE;
}

/** Replace every filename: placeholder with the ids of emails that have a matching attachment. */
export async function resolveFilenameFilters(client: JmapClient, filter: EmailFilter | null): Promise<EmailFilter | null> {
  const terms = new Set<string>();
  collect(filter, terms);
  if (!terms.size) return filter;
  const b = client.batch();
  const q = b.call('Email/query', { filter: { hasAttachment: true }, sort: [{ property: 'receivedAt', isAscending: false }], limit: SCAN_LIMIT });
  const r = await b.send();
  const all = r.get(q).ids as Id[];
  const ids = new Map<string, Id[]>([...terms].map((t) => [t, []]));
  const chunk = client.limits?.maxObjectsInGet ?? 500;
  for (let i = 0; i < all.length; i += chunk) {
    const g = await client.call('Email/get', {
      ids: all.slice(i, i + chunk),
      properties: ['attachments'],
      bodyProperties: ['name'],
    });
    for (const e of g.list) for (const t of terms) if (e.attachments?.some((a) => filenameMatches(a.name, t))) ids.get(t)!.push(e.id);
  }
  return replaceFilenameFilters(filter, ids);
}
