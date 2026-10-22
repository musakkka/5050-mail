import { describe, expect, it } from 'vitest';
import { buildQuery, EMPTY_ADVANCED, parse, parseAdvanced, parseSize, searchToFilter, tokenize } from './searchParser';

const ROLES: Record<string, string> = {
  inbox: 'mb-inbox',
  sent: 'mb-sent',
  drafts: 'mb-drafts',
  trash: 'mb-trash',
  junk: 'mb-junk',
  snoozed: 'mb-snoozed',
  archive: 'mb-archive',
};
const LABELS: Record<string, string> = { work: 'mb-work', 'projects/acme': 'mb-acme', 'big plans': 'mb-big' };
const ctx = {
  roleId: (r: string) => ROLES[r],
  labelId: (n: string) => LABELS[n.toLowerCase()],
  systemMailboxIds: Object.values(ROLES),
  now: new Date('2026-10-21T12:00:00Z'),
  me: ['alice@dev.test'],
};
const f = (q: string) => searchToFilter(q, ctx);

describe('tokenize / parse', () => {
  it('tokenizes operators, phrases, negation and groups', () => {
    expect(tokenize('from:bob "big news" -spam (a OR b)')).toEqual([
      { t: 'word', v: 'bob', quoted: false, op: 'from' },
      { t: 'word', v: 'big news', quoted: true },
      { t: '-' },
      { t: 'word', v: 'spam', quoted: false },
      { t: '(' },
      { t: 'word', v: 'a', quoted: false },
      { t: 'OR' },
      { t: 'word', v: 'b', quoted: false },
      { t: ')' },
    ]);
  });
  it('keeps hyphens inside words', () => {
    expect(parse('e-mail')).toEqual({ type: 'term', op: undefined, value: 'e-mail', quoted: false });
  });
  it('parses OR with lower precedence than implicit AND', () => {
    expect(parse('a b OR c')).toEqual({
      type: 'or',
      children: [
        {
          type: 'and',
          children: [
            { type: 'term', op: undefined, value: 'a', quoted: false },
            { type: 'term', op: undefined, value: 'b', quoted: false },
          ],
        },
        { type: 'term', op: undefined, value: 'c', quoted: false },
      ],
    });
  });
});

describe('Gmail operators → JMAP FilterCondition', () => {
  it('free text and exact phrases', () => {
    expect(f('lisbon').filter).toEqual({ text: 'lisbon' });
    expect(f('"exact phrase"').filter).toEqual({ text: '"exact phrase"' });
    expect(f('lisbon').hasText).toBe(true);
  });

  it('address and subject operators', () => {
    expect(f('from:bob@dev.test').filter).toEqual({ from: 'bob@dev.test' });
    expect(f('to:carol cc:dan bcc:eve').filter).toEqual({ operator: 'AND', conditions: [{ to: 'carol' }, { cc: 'dan' }, { bcc: 'eve' }] });
    expect(f('subject:"quarterly report"').filter).toEqual({ subject: 'quarterly report' });
    expect(f('subject:(dinner movie)').filter).toEqual({ operator: 'AND', conditions: [{ subject: 'dinner' }, { subject: 'movie' }] });
  });

  it('from:me / to:me bind to the user identities', () => {
    expect(f('from:me').filter).toEqual({ from: 'alice@dev.test' });
    expect(searchToFilter('to:me', { ...ctx, me: ['a@x', 'b@x'] }).filter).toEqual({ operator: 'OR', conditions: [{ to: 'a@x' }, { to: 'b@x' }] });
  });

  it('is: / has: / in: / label:', () => {
    expect(f('is:unread').filter).toEqual({ notKeyword: '$seen' });
    expect(f('is:read').filter).toEqual({ hasKeyword: '$seen' });
    expect(f('is:starred').filter).toEqual({ hasKeyword: '$flagged' });
    expect(f('is:important').filter).toEqual({ hasKeyword: '$important' });
    expect(f('is:muted').filter).toEqual({ hasKeyword: '$muted' });
    expect(f('is:snoozed').filter).toEqual({ inMailbox: 'mb-snoozed' });
    expect(f('has:attachment').filter).toEqual({ hasAttachment: true });
    expect(f('in:sent').filter).toEqual({ inMailbox: 'mb-sent' });
    expect(f('label:work').filter).toEqual({ inMailbox: 'mb-work' });
    expect(f('label:Projects/Acme').filter).toEqual({ inMailbox: 'mb-acme' });
    expect(f('label:projects-acme').filter).toEqual({ inMailbox: 'mb-acme' });
    expect(f('label:"big plans"').filter).toEqual({ inMailbox: 'mb-big' });
    expect(f('in:archive').filter).toEqual({ operator: 'NOT', conditions: [{ inMailbox: 'mb-inbox' }] });
    expect(f('has:userlabels').filter).toEqual({ inMailboxOtherThan: Object.values(ROLES) });
  });

  it('unknown labels match nothing (instead of everything)', () => {
    expect(f('label:doesnotexist').filter).toEqual({ inMailbox: 'zzzzzzzzzzzz' });
  });

  it('trash / spam scope', () => {
    expect(f('in:trash').includesTrashOrSpam).toBe(true);
    expect(f('in:spam').includesTrashOrSpam).toBe(true);
    expect(f('in:anywhere foo').includesTrashOrSpam).toBe(true);
    expect(f('in:anywhere foo').filter).toEqual({ text: 'foo' });
    expect(f('foo').includesTrashOrSpam).toBe(false);
  });

  it('dates, relative dates and sizes', () => {
    expect(f('after:2026/10/01').filter).toEqual({ after: new Date(2026, 9, 1).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    expect(f('before:10/15/2026').filter).toEqual({ before: new Date(2026, 9, 15).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    expect(f('older_than:2d').filter).toEqual({ before: '2026-10-19T12:00:00Z' });
    expect(f('newer_than:1y').filter).toEqual({ after: '2025-10-21T12:00:00Z' });
    expect(f('larger:10M').filter).toEqual({ minSize: 10 * 1024 * 1024 });
    expect(f('smaller:500K').filter).toEqual({ maxSize: 500 * 1024 });
    expect(f('size:1000000').filter).toEqual({ minSize: 1_000_000 });
    expect(parseSize('2.5mb')).toBe(Math.round(2.5 * 1024 * 1024));
  });

  it('boolean structure: OR, {}, -, ()', () => {
    expect(f('from:amy OR from:david').filter).toEqual({ operator: 'OR', conditions: [{ from: 'amy' }, { from: 'david' }] });
    expect(f('{from:amy from:david}').filter).toEqual({ operator: 'OR', conditions: [{ from: 'amy' }, { from: 'david' }] });
    expect(f('dinner -movie').filter).toEqual({ operator: 'AND', conditions: [{ text: 'dinner' }, { operator: 'NOT', conditions: [{ text: 'movie' }] }] });
    expect(f('subject:x (from:a OR from:b) has:attachment').filter).toEqual({
      operator: 'AND',
      conditions: [{ subject: 'x' }, { operator: 'OR', conditions: [{ from: 'a' }, { from: 'b' }] }, { hasAttachment: true }],
    });
  });

  it('categories, lists and headers', () => {
    expect(f('category:social').filter).toEqual({ hasKeyword: '$ff_cat_social' });
    expect(f('category:primary').filter).toEqual({
      operator: 'NOT',
      conditions: [
        { hasKeyword: '$ff_cat_promotions' },
        { hasKeyword: '$ff_cat_social' },
        { hasKeyword: '$ff_cat_updates' },
        { hasKeyword: '$ff_cat_forums' },
      ],
    });
    expect(f('list:info@example.com').filter).toEqual({ header: ['List-Id', 'info@example.com'] });
    expect(f('rfc822msgid:<abc@x>').filter).toEqual({ header: ['Message-ID', 'abc@x'] });
    expect(f('header:X-Mailer:Acme').filter).toEqual({ header: ['X-Mailer', 'Acme'] });
  });

  it('filename: becomes a placeholder resolved against attachment names', () => {
    expect(f('filename:PDF').filter).toEqual({ acme_filename: 'pdf' });
  });

  it('empty queries produce no filter', () => {
    expect(f('   ').filter).toBeNull();
  });
});

describe('advanced search form', () => {
  it('builds a Gmail query string', () => {
    expect(
      buildQuery({
        ...EMPTY_ADVANCED,
        from: 'bob',
        subject: 'big plans',
        hasWords: 'lisbon',
        doesntHave: 'spam ads',
        size: '5',
        sizeOp: 'larger',
        sizeUnit: 'MB',
        hasAttachment: true,
        searchIn: 'in:inbox',
      }),
    ).toBe('from:bob subject:(big plans) lisbon -spam -ads larger:5M in:inbox has:attachment');
  });
  it('round-trips the main fields', () => {
    const a = parseAdvanced('from:bob subject:hello trip -spam has:attachment in:sent larger:2M');
    expect(a).toMatchObject({
      from: 'bob',
      subject: 'hello',
      hasWords: 'trip',
      doesntHave: 'spam',
      hasAttachment: true,
      searchIn: 'in:sent',
      size: '2',
      sizeUnit: 'MB',
    });
  });
});
