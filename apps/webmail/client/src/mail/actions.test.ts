import { describe, expect, it } from 'vitest';
import { planAction } from './actions';
import { buildMailboxModel } from './mailboxes';
import { prefill, buildEmail, envelopeFor, parseRecipients } from './compose';
import { wakeKeyword, parseWakeKeyword } from './mapping';
import type { Email, Identity, Mailbox } from '../jmap/types';
import type { LiteEmail } from './threads';

const mb = (id: string, name: string, role: string | null = null, parentId: string | null = null): Mailbox =>
  ({
    id,
    name,
    role,
    parentId,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {},
  }) as unknown as Mailbox;
const model = buildMailboxModel([
  mb('in', 'Inbox', 'inbox'),
  mb('ar', 'Archive', 'archive'),
  mb('tr', 'Deleted Items', 'trash'),
  mb('jk', 'Junk', 'junk'),
  mb('sn', 'Snoozed', 'snoozed'),
  mb('w', 'Work'),
  mb('k', 'Acme', null, 'w'),
]);
const email = (id: string, mailboxIds: string[], keywords: string[] = [], at = '2026-10-01T00:00:00Z'): LiteEmail =>
  ({
    id,
    threadId: 't',
    mailboxIds: Object.fromEntries(mailboxIds.map((m) => [m, true])),
    keywords: Object.fromEntries(keywords.map((k) => [k, true])),
    receivedAt: at,
  }) as LiteEmail;

describe('mailbox model', () => {
  it('builds label paths and excludes system roles', () => {
    expect(model.labels.map((l) => l.path)).toEqual(['Work', 'Work/Acme']);
    expect(model.idByPath('work/acme')).toBe('k');
    expect(model.roleId('trash')).toBe('tr');
  });
});

describe('planAction', () => {
  it('archive removes Inbox and falls back to Archive when nothing is left', () => {
    const p = planAction({ kind: 'archive', model, viewMailboxId: 'in', threads: [{ threadId: 't', emails: [email('a', ['in']), email('b', ['in', 'w'])] }] });
    expect(p.update).toEqual({ a: { mailboxIds: { ar: true } }, b: { mailboxIds: { w: true } } });
    expect(p.undo).toEqual({ a: { mailboxIds: { in: true } }, b: { mailboxIds: { in: true, w: true } } });
    expect(p.removesFromView).toBe(true);
    expect(p.message).toBe('Conversation archived.');
  });

  it('trash replaces all mailboxes; spam sets $junk', () => {
    const t = [
      { threadId: 't', emails: [email('a', ['in', 'w'])] },
      { threadId: 'u', emails: [email('b', ['in'], ['$notjunk'])] },
    ];
    expect(planAction({ kind: 'trash', model, threads: t }).update.a).toEqual({ mailboxIds: { tr: true } });
    const spam = planAction({ kind: 'spam', model, threads: t });
    expect(spam.update.b).toEqual({ mailboxIds: { jk: true }, keywords: { $junk: true } });
    expect(spam.message).toBe('2 conversations marked as spam.');
  });

  it('star flags only the latest non-draft message; unstar clears all', () => {
    const t = [
      {
        threadId: 't',
        emails: [
          email('a', ['in'], [], '2026-10-01T00:00:00Z'),
          email('b', ['in'], [], '2026-10-02T00:00:00Z'),
          email('d', ['in'], ['$draft'], '2026-10-03T00:00:00Z'),
        ],
      },
    ];
    expect(Object.keys(planAction({ kind: 'star', model, threads: t }).update)).toEqual(['b']);
    const t2 = [{ threadId: 't', emails: [email('a', ['in'], ['$flagged']), email('b', ['in'], ['$flagged'])] }];
    expect(planAction({ kind: 'unstar', model, threads: t2 }).update).toEqual({ a: { keywords: {} }, b: { keywords: {} } });
  });

  it('moveTo removes the current label and adds the target', () => {
    const p = planAction({ kind: 'moveTo', model, viewMailboxId: 'in', targetMailboxId: 'w', threads: [{ threadId: 't', emails: [email('a', ['in'])] }] });
    expect(p.update.a).toEqual({ mailboxIds: { w: true } });
    expect(p.message).toBe('Conversation moved to "Work".');
  });

  it('snooze moves Inbox → Snoozed with a wake keyword; unsnooze reverses', () => {
    const when = new Date('2026-10-22T08:00:00Z');
    const p = planAction({
      kind: 'snooze',
      model,
      viewMailboxId: 'in',
      snoozeUntil: when,
      threads: [{ threadId: 't', emails: [email('a', ['in'], ['$seen'])] }],
    });
    expect(p.update.a).toEqual({ mailboxIds: { sn: true }, keywords: { $seen: true, $ff_wake_20261022t0800z: true } });
    const back = planAction({
      kind: 'unsnooze',
      model,
      viewMailboxId: 'sn',
      threads: [{ threadId: 't', emails: [email('a', ['sn'], ['$seen', '$ff_wake_20261022t0800z'])] }],
    });
    expect(back.update.a).toEqual({ mailboxIds: { in: true }, keywords: { $seen: true } });
  });

  it('label changes add/remove mailboxes and drop Archive when a label is added', () => {
    const p = planAction({ kind: 'labels', model, labelChanges: { w: true }, threads: [{ threadId: 't', emails: [email('a', ['ar'])] }] });
    expect(p.update.a).toEqual({ mailboxIds: { w: true } });
  });

  it('deleteForever destroys and is not undoable', () => {
    const p = planAction({ kind: 'deleteForever', model, threads: [{ threadId: 't', emails: [email('a', ['tr'])] }] });
    expect(p.destroy).toEqual(['a']);
    expect(p.undo).toBeNull();
  });

  it('category replaces category keywords', () => {
    const p = planAction({ kind: 'category', category: 'social', model, threads: [{ threadId: 't', emails: [email('a', ['in'], ['$ff_cat_promotions'])] }] });
    expect(p.update.a).toEqual({ keywords: { $ff_cat_social: true } });
  });
});

describe('wake keyword', () => {
  it('round-trips', () => {
    const d = new Date('2026-12-31T23:45:00Z');
    expect(wakeKeyword(d)).toBe('$ff_wake_20261231t2345z');
    expect(parseWakeKeyword('$FF_WAKE_20261231T2345Z')?.toISOString()).toBe(d.toISOString());
  });
});

describe('compose', () => {
  const me = new Set(['alice@dev.test']);
  const ids: Identity[] = [
    { id: 'i1', name: 'Alice Example', email: 'alice@dev.test', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: false },
  ];
  const src = {
    id: 'e1',
    threadId: 't1',
    subject: 'Plans',
    messageId: ['m2@x'],
    references: ['m0@x', 'm1@x'],
    inReplyTo: ['m1@x'],
    from: [{ name: 'Bob', email: 'bob@dev.test' }],
    to: [
      { name: 'Alice Example', email: 'alice@dev.test' },
      { name: 'Carol', email: 'carol@dev.test' },
    ],
    cc: [{ name: 'Dan', email: 'dan@x.test' }],
    replyTo: null,
    receivedAt: '2026-10-21T10:00:00Z',
    sentAt: '2026-10-21T10:00:00Z',
    bodyValues: { '1': { value: 'Hello there', isTruncated: false, isEncodingProblem: false } },
    textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [{ partId: '1', type: 'text/plain' }],
    attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 10, disposition: 'attachment', cid: null }],
  } as unknown as Email;

  it('reply sets In-Reply-To / References and Re: subject', () => {
    const d = prefill('reply', src, me, ids);
    expect(d.to).toEqual([{ name: 'Bob', email: 'bob@dev.test' }]);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Plans');
    expect(d.inReplyTo).toEqual(['m2@x']);
    expect(d.references).toEqual(['m0@x', 'm1@x', 'm2@x']);
  });

  it('reply all excludes me and keeps others', () => {
    const d = prefill('replyAll', src, me, ids);
    expect(d.to!.map((r) => r.email)).toEqual(['bob@dev.test', 'carol@dev.test']);
    expect(d.cc!.map((r) => r.email)).toEqual(['dan@x.test']);
  });

  it('forward keeps attachments and uses Fwd:', () => {
    const d = prefill('forward', src, me, ids);
    expect(d.subject).toBe('Fwd: Plans');
    expect(d.attachments!.map((a) => a.blobId)).toEqual(['b1']);
    expect(d.quotedHtml).toContain('Forwarded message');
  });

  it('builds the Email object and the envelope (bcc included)', () => {
    const d = {
      mode: 'reply' as const,
      to: [{ name: 'Bob', email: 'bob@dev.test' }],
      cc: [],
      bcc: [{ name: '', email: 'eve@x.test' }],
      subject: 'Re: Plans',
      html: 'Hi <b>Bob</b>',
      quotedHtml: '',
      attachments: [],
      inReplyTo: ['m2@x'],
      references: ['m2@x'],
    };
    const e = buildEmail(d, ids[0], { drafts: true }, { draft: true });
    expect(e.keywords).toEqual({ $draft: true, $seen: true });
    expect(e.from).toEqual([{ name: 'Alice Example', email: 'alice@dev.test' }]);
    expect(e.inReplyTo).toEqual(['m2@x']);
    expect(e.bodyValues!.html!.value).toContain('<b>Bob</b>');
    const env = envelopeFor(d, ids[0]!, { HOLDFOR: '5' });
    expect(env.mailFrom).toEqual({ email: 'alice@dev.test', parameters: { HOLDFOR: '5' } });
    expect(env.rcptTo.map((r) => r.email)).toEqual(['bob@dev.test', 'eve@x.test']);
  });

  it('parses pasted recipient lists', () => {
    expect(parseRecipients('Alice <a@x.test>, b@y.test; "Carol, C" <c@z.test>')).toEqual([
      { name: 'Alice', email: 'a@x.test' },
      { name: '', email: 'b@y.test' },
      { name: 'Carol, C', email: 'c@z.test' },
    ]);
  });
});
