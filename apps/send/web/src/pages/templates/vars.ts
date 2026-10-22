import type { TemplateVariable } from '@/api/types';

/** Built-in contact variables that templates may use without declaring them. */
export const RESERVED_VARS = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'UNSUBSCRIBE_URL', 'RESEND_UNSUBSCRIBE_URL', 'contact', 'this'];

const VAR_RE = /\{\{\{?\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}?\}\}/g;

/** Variable keys referenced as {{{KEY}}}, {{KEY}} or {{{KEY|fallback}}} (first segment of dotted paths). */
export function usedVariables(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(VAR_RE)) out.add(m[1]!.split('.')[0]!);
  }
  return [...out];
}

export function undeclared(vars: TemplateVariable[], ...texts: (string | null | undefined)[]): string[] {
  const keys = new Set(vars.map((v) => v.key));
  return usedVariables(...texts).filter((k) => !keys.has(k) && !RESERVED_VARS.includes(k));
}

export function isValidKey(k: string): boolean {
  return /^[A-Za-z0-9_]{1,50}$/.test(k) && !RESERVED_VARS.includes(k);
}

/** Substitute variables with their fallbacks for previews; HTML-escapes values. */
export function renderPreview(text: string, vars: TemplateVariable[], escape = true): string {
  const map = new Map(vars.map((v) => [v.key, v.fallback_value]));
  const esc = (s: string) => (escape ? s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) : s);
  return text.replace(VAR_RE, (whole, key: string, inline?: string) => {
    const base = key.split('.')[0]!;
    const v = map.get(key) ?? map.get(base);
    if (v !== undefined && v !== null && v !== '') return esc(typeof v === 'string' ? v : JSON.stringify(v));
    if (inline !== undefined) return esc(inline);
    if (base === 'FIRST_NAME' || key === 'contact.first_name') return 'Ada';
    if (base === 'LAST_NAME') return 'Lovelace';
    if (base === 'EMAIL' || key === 'contact.email') return 'ada@example.com';
    if (base.includes('UNSUBSCRIBE_URL')) return 'https://example.com/unsubscribe';
    return esc(whole);
  });
}
