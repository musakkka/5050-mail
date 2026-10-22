import { describe, expect, it } from 'vitest';
import { JmapSession, MailWorker, parseWakeKeyword, sweepAccount } from '../src/worker';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemorySessionStore } from '../src/sessions';

const UP = 'http://stalwart.test';

interface Mail {
  id: string;
  threadId: string;
  blobId: string;
  receivedAt: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
}

/** In-memory JMAP account with just enough of Mailbox/Email/EmailSubmission for the worker. */
function fakeAccount(emails: Mail[], submissions: { id: string; emailId: string; undoStatus: string }[] = [], opts: { failImport?: boolean } = {}) {
  const store = new Map(emails.map((e) => [e.id, structuredClone(e)]));
  let seq = 0;
  const calls: string[] = [];
  const boxes = [
    { id: 'in', role: 'inbox' },
    { id: 'sn', role: 'snoozed' },
    { id: 'sc', role: 'scheduled' },
    { id: 'se', role: 'sent' },
    { id: 'w', role: null },
  ];
  const resolve = (args: Record<string, unknown>, results: Map<string, Record<string, unknown>>) => {
    const ref = args['#ids'] as { resultOf: string; path: string } | undefined;
    return ref ? (results.get(ref.resultOf)!.ids as string[]) : (args.ids as string[] | null);
  };
  const apply = (e: Mail, patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      const [prop, key] = k.split('/') as ['mailboxIds' | 'keywords', string];
      if (v === null) delete e[prop][key];
      else e[prop][key] = true;
    }
  };
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/jmap/session')) return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' } });
    const body = JSON.parse(String(init!.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    const results = new Map<string, Record<string, unknown>>();
    const out = body.methodCalls.map(([name, args, id]) => {
      calls.push(name);
      let r: Record<string, unknown> = {};
      if (name === 'Mailbox/get') r = { list: boxes };
      if (name === 'Email/query') {
        const mb = (args.filter as { inMailbox: string }).inMailbox;
        r = { ids: [...store.values()].filter((e) => e.mailboxIds[mb]).map((e) => e.id) };
      }
      if (name === 'Email/get') r = { list: resolve(args, results)!.map((i) => structuredClone(store.get(i))) };
      if (name === 'Email/import') {
        const created: Record<string, unknown> = {};
        const notCreated: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args.emails as Record<string, Omit<Mail, 'id' | 'threadId'>>)) {
          if (opts.failImport) {
            notCreated[k] = { type: 'serverFail' };
            continue;
          }
          const src = [...store.values()].find((e) => e.blobId === v.blobId)!;
          const nid = `new${++seq}`;
          store.set(nid, { id: nid, threadId: src.threadId, ...v });
          created[k] = { id: nid };
        }
        r = { created, notCreated };
      }
      if (name === 'Email/set') {
        const updated: Record<string, null> = {};
        for (const [eid, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          apply(store.get(eid)!, patch);
          updated[eid] = null;
        }
        for (const eid of (args.destroy ?? []) as string[]) store.delete(eid);
        r = { updated, destroyed: args.destroy ?? [] };
      }
      if (name === 'EmailSubmission/query') {
        const f = args.filter as { emailIds: string[]; undoStatus: string };
        r = { ids: submissions.filter((s) => f.emailIds.includes(s.emailId) && s.undoStatus === f.undoStatus).map((s) => s.id) };
      }
      if (name === 'EmailSubmission/get') r = { list: submissions.filter((s) => resolve(args, results)!.includes(s.id)) };
      results.set(id, r);
      return [name, r, id];
    });
    return Response.json({ methodResponses: out });
  };
  return { store, calls, fetchFn };
}

const NOW = Date.UTC(2026, 9, 22, 12, 0);
const mail = (id: string, threadId: string, receivedAt: string, mailboxIds: Record<string, boolean>, keywords: Record<string, boolean> = {}): Mail => ({
  id,
  threadId,
  blobId: `blob-${id}`,
  receivedAt,
  mailboxIds,
  keywords,
});

describe('mail worker', () => {
  it('parses wake keywords case-insensitively', () => {
    expect(parseWakeKeyword('$ff_wake_20261022t0800z')?.toISOString()).toBe('2026-10-22T08:00:00.000Z');
    expect(parseWakeKeyword('$FF_WAKE_20261022T0800Z')?.toISOString()).toBe('2026-10-22T08:00:00.000Z');
    expect(parseWakeKeyword('$ff_wake_nope')).toBeUndefined();
  });

  it('wakes due snoozed conversations to the top of the Inbox, unread; leaves future ones', async () => {
    const acc = fakeAccount([
      mail('a1', 'T1', '2026-10-01T10:00:00Z', { sn: true }, { $seen: true, $ff_wake_20261022t1100z: true }),
      mail('a2', 'T1', '2026-10-02T10:00:00Z', { sn: true, w: true }, { $seen: true, $flagged: true, $ff_wake_20261022t1100z: true }),
      mail('b1', 'T2', '2026-10-03T10:00:00Z', { sn: true }, { $seen: true, $ff_wake_20261023t0800z: true }),
    ]);
    const r = await sweepAccount(new JmapSession(acc.fetchFn, UP, 'Basic x', 'acc'), NOW);
    expect(r).toEqual({ woken: 1, sent: 0 });
    // older message moved in place
    expect(acc.store.get('a1')!.mailboxIds).toEqual({ in: true });
    expect(acc.store.get('a1')!.keywords).toEqual({ $seen: true });
    // newest message re-imported with receivedAt = now, keeps labels/flags, unread, original gone
    expect(acc.store.has('a2')).toBe(false);
    const woke = [...acc.store.values()].find((e) => e.blobId === 'blob-a2')!;
    expect(woke.receivedAt).toBe('2026-10-22T12:00:00Z');
    expect(woke.mailboxIds).toEqual({ in: true, w: true });
    expect(woke.keywords).toEqual({ $flagged: true });
    expect(woke.threadId).toBe('T1');
    // not yet due
    expect(acc.store.get('b1')!.mailboxIds).toEqual({ sn: true });
  });

  it('wakes in place when the re-import fails, so nothing stays stuck', async () => {
    const acc = fakeAccount([mail('a1', 'T1', '2026-10-01T10:00:00Z', { sn: true }, { $seen: true, $ff_wake_20261022t1100z: true })], [], { failImport: true });
    await sweepAccount(new JmapSession(acc.fetchFn, UP, 'Basic x', 'acc'), NOW);
    expect(acc.store.get('a1')!.mailboxIds).toEqual({ in: true });
    expect(acc.store.get('a1')!.keywords).toEqual({});
  });

  it('moves delivered scheduled mail to Sent and leaves pending ones', async () => {
    const acc = fakeAccount(
      [mail('s1', 'T1', '2026-10-01T10:00:00Z', { sc: true }), mail('s2', 'T2', '2026-10-01T10:00:00Z', { sc: true })],
      [
        { id: 'sub1', emailId: 's1', undoStatus: 'final' },
        { id: 'sub2', emailId: 's2', undoStatus: 'pending' },
      ],
    );
    const r = await sweepAccount(new JmapSession(acc.fetchFn, UP, 'Basic x', 'acc'), NOW);
    expect(r).toEqual({ woken: 0, sent: 1 });
    expect(acc.store.get('s1')!.mailboxIds).toEqual({ se: true });
    expect(acc.store.get('s2')!.mailboxIds).toEqual({ sc: true });
  });

  it('does nothing (one cheap request) when there is nothing to do', async () => {
    const acc = fakeAccount([mail('x', 'T', '2026-10-01T10:00:00Z', { in: true })]);
    await sweepAccount(new JmapSession(acc.fetchFn, UP, 'Basic x', 'acc'), NOW);
    expect(acc.calls).toEqual(['Mailbox/get', 'Email/query', 'Email/get', 'Email/query']);
  });

  it('sweeps each signed-in account once, with its own credentials only', async () => {
    const seen: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const auth = new Headers(init?.headers).get('authorization')!;
      if (String(input).endsWith('/jmap/session')) {
        seen.push(auth);
        return Response.json({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' } });
      }
      const body = JSON.parse(String(init!.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      return Response.json({ methodResponses: body.methodCalls.map(([name, , id]) => [name, name === 'Mailbox/get' ? { list: [] } : {}, id]) });
    };
    const w = new MailWorker({
      fetch: fetchFn,
      stalwartUrl: UP,
      intervalMs: 60_000,
      sessions: () => [
        { email: 'Alice@x.test', authorization: 'Basic alice-1' },
        { email: 'alice@x.test', authorization: 'Basic alice-2' },
        { email: 'bob@x.test', authorization: 'Basic bob' },
      ],
    });
    await w.runOnce();
    expect(seen.sort()).toEqual(['Basic alice-2', 'Basic bob']);
  });

  it('POST /api/sweep runs the worker for the signed-in account only', async () => {
    const store = new MemorySessionStore(60_000, 60_000);
    const s = await store.create({ email: 'alice@x.test', name: 'Alice', isAdmin: false, authorization: 'Basic abc' });
    const swept: string[] = [];
    const worker = { sweep: async (c: { email: string }) => (swept.push(c.email), { woken: 2, sent: 0 }) } as unknown as MailWorker;
    const app = createApp({ config: loadConfig({}), store, worker });
    const anon = await app.request('/api/sweep', { method: 'POST', headers: { 'X-Requested-With': '5050' } });
    expect(anon.status).toBe(401);
    const res = await app.request('/api/sweep', { method: 'POST', headers: { 'X-Requested-With': '5050', Cookie: `mail_sid=${s.id}` } });
    expect(await res.json()).toEqual({ woken: 2, sent: 0, worker: true });
    expect(swept).toEqual(['alice@x.test']);
    store.close();
  });
});
