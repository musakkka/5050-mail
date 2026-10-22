/** Compare an API response's key set against the Resend docs' response example. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bad, ok } from './harness.js';

const DOCS = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'doc-responses.json'), 'utf8')) as Record<string, unknown>;

function diff(doc: unknown, act: unknown, at: string, out: string[]) {
  if (doc === null || act === null || act === undefined) {
    if (act === undefined) out.push(`${at}: missing`);
    return;
  }
  if (Array.isArray(doc)) {
    if (!Array.isArray(act)) return void out.push(`${at}: doc array, got ${typeof act}`);
    if (doc.length && act.length && typeof doc[0] === 'object') diff(doc[0], act[0], `${at}[0]`, out);
    return;
  }
  if (typeof doc === 'object') {
    if (typeof act !== 'object' || Array.isArray(act)) return void out.push(`${at}: doc object, got ${Array.isArray(act) ? 'array' : typeof act}`);
    const d = doc as Record<string, unknown>;
    const a = act as Record<string, unknown>;
    for (const k of Object.keys(d)) {
      if (!(k in a)) out.push(`${at}.${k}: missing`);
      else diff(d[k], a[k], `${at}.${k}`, out);
    }
    for (const k of Object.keys(a)) if (!(k in d)) out.push(`${at}.${k}: extra`);
    return;
  }
  if (typeof doc !== typeof act) out.push(`${at}: doc ${typeof doc}, got ${typeof act} (${JSON.stringify(act)?.slice(0, 40)})`);
}

/** Records a BAD only for missing keys / type changes; extras are reported in the detail. */
export function shape(page: string, actual: unknown, opts: { ignore?: RegExp } = {}) {
  const doc = DOCS[page];
  if (doc === undefined) return bad(`shape.${page}`, 'no doc example found');
  const out: string[] = [];
  diff(doc, actual, '$', out);
  const relevant = out.filter((x) => !opts.ignore || !opts.ignore.test(x));
  const missing = relevant.filter((x) => !x.endsWith(': extra'));
  const extra = relevant.filter((x) => x.endsWith(': extra'));
  if (missing.length) bad(`shape.${page}`, `${missing.join('; ')}${extra.length ? ` | extra: ${extra.join('; ')}` : ''}`);
  else ok(`shape.${page}`, extra.length ? `(extra: ${extra.join('; ')})` : '');
}
