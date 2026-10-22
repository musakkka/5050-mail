/**
 * Regenerate test/docs-examples/examples.json from Resend's docs:
 *   npx tsx scripts/extract-doc-examples.ts
 * Pulls https://resend.com/docs/llms-full.txt and keeps every Node.js and cURL
 * code block from the API reference pages.
 */
import { writeFileSync } from 'node:fs';

const txt = await (await fetch('https://resend.com/docs/llms-full.txt')).text();
const pages = txt.split(/\n(?=# [^\n]*\nSource: )/);
const out: { page: string; lang: string; code: string }[] = [];
for (const p of pages) {
  const src = /^Source: (\S+)/m.exec(p)?.[1];
  if (!src?.includes('/api-reference/')) continue;
  for (const m of p.matchAll(/```(\w+) (Node\.js|cURL)[^\n]*\n([\s\S]*?)\n```/g)) {
    out.push({ page: src.replace('https://resend.com/docs/api-reference/', ''), lang: m[2]!, code: m[3]! });
  }
}
writeFileSync(new URL('../test/docs-examples/examples.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote ${out.length} examples`);
