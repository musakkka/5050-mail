import { describe, expect, it } from 'vitest';
import { parseMailPath, viewQuery, viewUrl, type ViewContext } from './views';
import { buildMailboxModel } from './mailboxes';
import type { Mailbox } from '../jmap/types';

const mb = (id: string, name: string, role: string | null = null, parentId: string | null = null) =>
  ({ id, name, role, parentId, sortOrder: 0 }) as unknown as Mailbox;
const model = buildMailboxModel([
  mb('in', 'Inbox', 'inbox'),
  mb('tr', 'Trash', 'trash'),
  mb('jk', 'Junk', 'junk'),
  mb('dr', 'Drafts', 'drafts'),
  mb('w', 'Work'),
  mb('k', 'Acme', null, 'w'),
]);
const ctx: ViewContext = {
  model,
  me: ['alice@dev.test'],
  categoriesEnabled: true,
  enabledCategories: ['primary', 'promotions', 'social'],
  conversationView: true,
};

describe('routes', () => {
  it('parses Gmail-like paths', () => {
    expect(parseMailPath('/mail/inbox')).toEqual({ view: { kind: 'folder', key: 'inbox' }, threadId: undefined, page: 1 });
    expect(parseMailPath('/mail/inbox/abc', '?p=3')).toEqual({ view: { kind: 'folder', key: 'inbox' }, threadId: 'abc', page: 3 });
    expect(parseMailPath('/mail/label/Work%2FAcme/t1')).toEqual({ view: { kind: 'label', key: 'Work/Acme' }, threadId: 't1', page: 1 });
    expect(parseMailPath('/mail/search/from%3Abob')).toMatchObject({ view: { kind: 'search', key: 'from:bob' } });
    expect(parseMailPath('/mail/category/social')).toMatchObject({ view: { kind: 'category', key: 'social' } });
    expect(parseMailPath('/mail/settings/labels')).toMatchObject({ settings: 'labels' });
    expect(parseMailPath('/mail/nonsense')).toMatchObject({ view: { kind: 'folder', key: 'inbox' } });
  });
  it('builds URLs', () => {
    expect(viewUrl({ kind: 'label', key: 'Work/Acme' }, { threadId: 't', page: 2 })).toBe('/mail/label/Work%2FAcme/t?p=2');
  });
});

describe('view filters', () => {
  it('Primary = inbox minus enabled category keywords', () => {
    expect(viewQuery({ kind: 'folder', key: 'inbox' }, ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'in' }, { operator: 'NOT', conditions: [{ hasKeyword: '$ff_cat_promotions' }, { hasKeyword: '$ff_cat_social' }] }],
    });
  });
  it('starred / all exclude trash and spam', () => {
    expect(viewQuery({ kind: 'folder', key: 'starred' }, ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ hasKeyword: '$flagged' }, { inMailboxOtherThan: ['tr', 'jk'] }],
    });
    expect(viewQuery({ kind: 'folder', key: 'all' }, ctx).filter).toEqual({ inMailboxOtherThan: ['tr', 'jk'] });
  });
  it('drafts are not collapsed into threads; labels resolve by path', () => {
    expect(viewQuery({ kind: 'folder', key: 'drafts' }, ctx)).toMatchObject({ filter: { inMailbox: 'dr' }, collapseThreads: false });
    expect(viewQuery({ kind: 'label', key: 'Work/Acme' }, ctx)).toMatchObject({ filter: { inMailbox: 'k' }, mailboxId: 'k', valid: true });
    expect(viewQuery({ kind: 'label', key: 'Nope' }, ctx).valid).toBe(false);
  });
  it('search excludes trash/spam unless asked and enables snippets for text', () => {
    const q = viewQuery({ kind: 'search', key: 'lisbon' }, ctx);
    expect(q.filter).toEqual({ operator: 'AND', conditions: [{ text: 'lisbon' }, { inMailboxOtherThan: ['tr', 'jk'] }] });
    expect(q.snippets).toBe(true);
    expect(viewQuery({ kind: 'search', key: 'in:trash' }, ctx).filter).toEqual({ inMailbox: 'tr' });
  });
});
