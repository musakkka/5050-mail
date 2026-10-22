/** Variable substitution (`{{{VAR}}}`, `{{VAR}}`, `{{{VAR|fallback}}}`, `{{{contact.first_name|there}}}`) and html→text. */

const VAR_RE = /\{\{\{?\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*?))?\s*\}?\}\}/g;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Names referenced in a template body. */
export function referencedVariables(...bodies: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const b of bodies) if (b) for (const m of b.matchAll(VAR_RE)) out.add(m[1]!);
  return [...out];
}

export type Vars = Record<string, string | number | boolean | null | undefined>;

/**
 * Replace variables. Unknown variables with no inline fallback are left empty and
 * reported through `missing`, so callers can turn them into validation errors.
 */
export function renderVars(body: string, vars: Vars, opts: { html?: boolean; missing?: Set<string> } = {}): string {
  return body.replace(VAR_RE, (_m, name: string, inlineFallback?: string) => {
    let v = vars[name];
    if (v === undefined || v === null || v === '') {
      if (inlineFallback !== undefined) v = inlineFallback;
      else {
        opts.missing?.add(name);
        return '';
      }
    }
    const s = String(v);
    return opts.html ? escapeHtml(s) : s;
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Plain-text fallback generated from HTML (Resend does this when `text` is omitted). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, txt: string) => {
    const t = txt.replace(/<[^>]+>/g, '').trim();
    return t && t !== href ? `${t} [${href}]` : href;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|section|article)>/gi, '\n\n');
  s = s.replace(/<li[^>]*>/gi, '* ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
