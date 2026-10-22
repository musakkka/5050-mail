/** Email address parsing/validation shared by the API and SMTP paths. */

// Pragmatic RFC 5321-ish check: local@domain with an LDH domain and a TLD.
const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

export const isEmail = (s: string): boolean => s.length <= 320 && ADDR_RE.test(s) && !s.includes('..');

export interface ParsedAddress {
  name: string | null;
  address: string;
}

/**
 * `Name <a@b.com>`, `"Name" <a@b.com>`, `<a@b.com>` or `a@b.com`.
 * `strict` (used for `from`) requires exactly one mailbox: an unquoted display name may not
 * contain RFC 5322 specials (`,` `;` `:` `@` `<` `>` `"` `[` `]`) that would let a MIME parser
 * read it as an address list or a second mailbox.
 */
export function parseAddress(input: string, opts: { strict?: boolean } = {}): ParsedAddress | null {
  const s = input.trim();
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  if (m) {
    const rawName = m[1]!.trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(rawName);
    if (opts.strict && rawName && !quoted && /[,;:@<>"[\]\\]/.test(rawName)) return null;
    const name = (quoted ? quoted[1]!.replace(/\\(.)/g, '$1') : rawName).trim();
    if (/[\r\n\0]/.test(name)) return null;
    const address = m[2]!.trim();
    return isEmail(address) ? { name: name || null, address } : null;
  }
  return isEmail(s) ? { name: null, address: s } : null;
}

/** Structured form for MIME builders: the name is quoted/encoded by the builder, never re-parsed. */
export const mailbox = (input: string): { name: string; address: string } | string => {
  const p = parseAddress(input);
  return p ? { name: p.name ?? '', address: p.address } : input;
};

export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export function toList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}
