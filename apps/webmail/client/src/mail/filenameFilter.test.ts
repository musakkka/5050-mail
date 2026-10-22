import { describe, expect, it } from 'vitest';
import { filenameMatches, replaceFilenameFilters, resolveFilenameFilters } from './filenameFilter';
import type { JmapClient } from '../jmap/client';

describe('filename: search', () => {
  it('matches extensions, parts of names and full names, case-insensitively', () => {
    expect(filenameMatches('Invoice-2291.PDF', 'pdf')).toBe(true);
    expect(filenameMatches('invoice-2291.pdf', '.pdf')).toBe(true);
    expect(filenameMatches('invoice-2291.pdf', '*.pdf')).toBe(true);
    expect(filenameMatches('invoice-2291.pdf', 'invoice')).toBe(true);
    expect(filenameMatches('invoice-2291.pdf', 'invoice-2291.pdf')).toBe(true);
    expect(filenameMatches('hike.png', 'pdf')).toBe(false);
    expect(filenameMatches(null, 'pdf')).toBe(false);
  });

  it('replaces placeholders with id filters (or an impossible filter) inside boolean trees', () => {
    const f = { operator: 'AND' as const, conditions: [{ from: 'bob' }, { acme_filename: 'pdf' }, { operator: 'NOT' as const, conditions: [{ acme_filename: 'png' }] }] };
    expect(replaceFilenameFilters(f, new Map([['pdf', ['e1', 'e2']], ['png', []]]))).toEqual({
      operator: 'AND',
      conditions: [{ from: 'bob' }, { id: ['e1', 'e2'] }, { operator: 'NOT', conditions: [{ inMailbox: 'zzzzzzzzzzzz' }] }],
    });
  });

  it('scans attachment names of emails with attachments', async () => {
    const calls: string[] = [];
    const client = {
      limits: { maxObjectsInGet: 2 },
      batch() {
        return {
          call: (m: string) => (calls.push(m), { m }),
          send: async () => ({ get: () => ({ ids: ['a', 'b', 'c'] }) }),
        };
      },
      call: async (m: string, args: { ids: string[] }) => {
        calls.push(m);
        const names: Record<string, string> = { a: 'report.pdf', b: 'photo.jpg', c: 'Q3 report.PDF' };
        return { list: args.ids.map((id) => ({ id, attachments: [{ name: names[id] }] })) };
      },
    } as unknown as JmapClient;
    expect(await resolveFilenameFilters(client, { acme_filename: 'pdf' })).toEqual({ id: ['a', 'c'] });
    expect(calls).toEqual(['Email/query', 'Email/get', 'Email/get']);
    // No placeholder: no requests.
    calls.length = 0;
    expect(await resolveFilenameFilters(client, { from: 'x' })).toEqual({ from: 'x' });
    expect(calls).toEqual([]);
  });
});
