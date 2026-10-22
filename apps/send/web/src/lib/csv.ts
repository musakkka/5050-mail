/** RFC 4180 CSV helpers (export and contact import). */

const NEEDS_QUOTE = /[",\r\n]/;

/** Guard against spreadsheet formula injection (=, +, -, @ at the start of a cell). */
function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | null | undefined) => {
    const s = safe(v === null || v === undefined ? '' : String(v));
    return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export interface ParsedContact {
  email: string;
  first_name?: string;
  last_name?: string;
  unsubscribed?: boolean;
}

/** Map a CSV with a header row to contacts (email column required). */
export function contactsFromCsv(text: string): { contacts: ParsedContact[]; invalid: number; error?: string } {
  const rows = parseCsv(text);
  if (!rows.length) return { contacts: [], invalid: 0, error: 'The file is empty.' };
  const head = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const idx = (names: string[]) => head.findIndex((h) => names.includes(h));
  const e = idx(['email', 'email_address', 'e_mail', 'mail']);
  if (e < 0) return { contacts: [], invalid: 0, error: 'Add an "email" column to the first row.' };
  const f = idx(['first_name', 'firstname', 'first', 'given_name']);
  const l = idx(['last_name', 'lastname', 'last', 'family_name', 'surname']);
  const u = idx(['unsubscribed', 'unsubscribe', 'opted_out']);
  const out: ParsedContact[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const email = (r[e] ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) {
      invalid++;
      continue;
    }
    seen.add(email);
    out.push({
      email,
      ...(f >= 0 && r[f]?.trim() ? { first_name: r[f]!.trim() } : {}),
      ...(l >= 0 && r[l]?.trim() ? { last_name: r[l]!.trim() } : {}),
      ...(u >= 0 ? { unsubscribed: /^(true|1|yes|y)$/i.test((r[u] ?? '').trim()) } : {}),
    });
  }
  return { contacts: out, invalid };
}
