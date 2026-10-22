/** Mail data layer: JMAP client context, queries, push, actions, background sweeper. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { JmapClient, JmapAuthError } from '../jmap/client';
import { CAP, type Email, type Id, type Identity, type Mailbox, type PatchObject } from '../jmap/types';
import { CSRF_HEADERS, type Me } from '../api/auth';
import { buildMailboxModel, roleMailboxName, type MailboxModel } from '../mail/mailboxes';
import { fetchConversation, fetchThreadPage, summarize, type Conversation, type LiteEmail, type ThreadPage, type ThreadSummary } from '../mail/threads';
import { inboxTypeSort, primaryExclusion, viewQuery, type View, type ViewContext } from '../mail/views';
import { resolveFilenameFilters } from '../mail/filenameFilter';
import { chunkPatches, planAction, type ActionInput, type ActionPlan } from '../mail/actions';
import { CATEGORY_KEYWORDS, KW, type Category } from '../mail/mapping';
import { useSettings } from './settings';
import { useUi } from './ui';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (n, e) => !(e instanceof JmapAuthError) && n < 2,
    },
  },
});

export interface MailCtx {
  client: JmapClient;
  me: Me;
  identities: Identity[];
  myEmails: Set<string>;
  accountId: Id;
  refreshIdentities: () => Promise<void>;
}

const Ctx = createContext<MailCtx | null>(null);

export function useMail(): MailCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useMail outside MailProvider');
  return c;
}

/** Create the role mailboxes the app needs (Archive / Snoozed / Scheduled) if the server didn't. */
async function ensureRoleMailboxes(client: JmapClient): Promise<void> {
  const { list } = await client.mailboxGet({ properties: ['id', 'name', 'role', 'parentId'] });
  const roles = new Set(list.map((m) => m.role).filter(Boolean));
  const create: Record<string, unknown> = {};
  for (const role of ['archive', 'snoozed', 'scheduled']) {
    if (roles.has(role)) continue;
    const name = roleMailboxName(role);
    const existing = list.find((m) => !m.role && !m.parentId && m.name.toLowerCase() === name.toLowerCase());
    if (existing) await client.mailboxSet({ update: { [existing.id]: { role } } });
    else create[role] = { name, role, isSubscribed: true };
  }
  if (Object.keys(create).length) await client.mailboxSet({ create });
}

export function MailProvider({ me, children, fallback }: { me: Me; children: ReactNode; fallback: ReactNode }) {
  const [ctx, setCtx] = useState<MailCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSettings = useSettings((s) => s.load);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        loadSettings(me.email);
        const client = new JmapClient({
          headers: CSRF_HEADERS,
          onUnauthorized: () => {
            if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
          },
        });
        await client.connect();
        await ensureRoleMailboxes(client);
        const ids = await client.identityGet();
        const identities = ids.list;
        const myEmails = new Set([me.email.toLowerCase(), ...identities.map((i) => i.email.toLowerCase())]);
        if (cancelled) return;
        const refreshIdentities = async () => {
          const r = await client.identityGet();
          setCtx((c) => (c ? { ...c, identities: r.list } : c));
        };
        setCtx({ client, me, identities, myEmails, accountId: client.accountId, refreshIdentities });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me, loadSettings]);

  if (error)
    return (
      <div className="boot-error">
        <p>5050 Mail couldn't connect to the mail server.</p>
        <p className="boot-error__detail">{error}</p>
        <button className="btn btn--filled" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!ctx) return <>{fallback}</>;
  return (
    <Ctx.Provider value={ctx}>
      <PushAndSweep />
      {children}
    </Ctx.Provider>
  );
}

// ------------------------------------------------------------------ queries

export function useMailboxes() {
  const { client } = useMail();
  return useQuery({
    queryKey: ['mailboxes'],
    queryFn: async () => buildMailboxModel((await client.mailboxGet()).list as Mailbox[]),
    staleTime: 60_000,
  });
}

export function useViewContext(model: MailboxModel | undefined): ViewContext | undefined {
  const { myEmails } = useMail();
  const categories = useSettings((s) => s.categories);
  const conversationView = useSettings((s) => s.conversationView);
  const inboxType = useSettings((s) => s.inboxType);
  return useMemo(
    () =>
      model
        ? {
            model,
            me: [...myEmails],
            categoriesEnabled: inboxType === 'default' && categories.length > 1,
            enabledCategories: categories,
            conversationView,
            inboxType,
          }
        : undefined,
    [model, myEmails, categories, conversationView, inboxType],
  );
}

export function threadsKey(view: View, page: number, extra: unknown[]) {
  return ['threads', view.kind, view.key, page, ...extra] as const;
}

export function useThreadPage(view: View, page: number) {
  const { client } = useMail();
  const { data: model } = useMailboxes();
  const ctx = useViewContext(model);
  const pageSize = useSettings((s) => s.pageSize);
  const inboxType = useSettings((s) => s.inboxType);
  const key = threadsKey(view, page, [pageSize, ctx?.conversationView, ctx?.inboxType, ctx?.enabledCategories.join(',')]);
  return useQuery({
    queryKey: key,
    enabled: !!ctx,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<ThreadPage> => {
      const q = viewQuery(view, ctx!);
      if (view.kind === 'search') q.filter = (await resolveFilenameFilters(client, q.filter)) ?? q.filter;
      if (view.kind === 'folder' && view.key === 'inbox' && inboxType !== 'default') q.sort = inboxTypeSort(inboxType);
      const hidden = [model!.roleId('trash'), model!.roleId('junk')].filter(Boolean) as string[];
      const page_ = await fetchThreadPage(client, q, { position: (page - 1) * pageSize, limit: pageSize, hiddenMailboxIds: hidden });
      if (view.kind === 'folder' && view.key === 'snoozed') page_.items.sort((a, b) => (a.wakeAt ?? '').localeCompare(b.wakeAt ?? ''));
      return page_;
    },
  });
}

export function useConversation(threadId: string | undefined) {
  const { client } = useMail();
  return useQuery({
    queryKey: ['thread', threadId],
    enabled: !!threadId,
    queryFn: () => fetchConversation(client, threadId!),
    staleTime: 15_000,
  });
}

export interface CategoryCount {
  unread: number;
  senders: string[];
}

/** Unread counts per inbox category (+ Primary), with sender previews for the tab badges. */
export function useCategoryCounts() {
  const { client, myEmails } = useMail();
  const { data: model } = useMailboxes();
  const categories = useSettings((s) => s.categories);
  const inbox = model?.roleId('inbox');
  return useQuery({
    queryKey: ['counts', inbox, categories.join(',')],
    enabled: !!inbox,
    staleTime: 30_000,
    queryFn: async () => {
      const b = client.batch();
      const out: Record<string, CategoryCount> = {};
      const calls = categories.map((c) => {
        const catFilter = c === 'primary' ? primaryExclusion(categories) : { hasKeyword: CATEGORY_KEYWORDS[c as keyof typeof CATEGORY_KEYWORDS] };
        const filter = { operator: 'AND', conditions: [{ inMailbox: inbox }, { notKeyword: KW.seen }, ...(catFilter ? [catFilter] : [])] };
        const q = b.call('Email/query', {
          filter,
          collapseThreads: true,
          calculateTotal: true,
          limit: 3,
          sort: [{ property: 'receivedAt', isAscending: false }],
        });
        const g = b.call('Email/get', { '#ids': q.ref('/ids'), properties: ['from'] });
        return { c, q, g };
      });
      const r = await b.send();
      for (const { c, q, g } of calls) {
        const qr = r.get(q);
        const senders = r
          .get(g)
          .list.map((e) => e.from?.[0])
          .filter((f) => f && !myEmails.has(f.email.toLowerCase()))
          .map((f) => f!.name || f!.email);
        out[c] = { unread: qr.total ?? qr.ids.length, senders: [...new Set(senders)] };
      }
      return out as Record<Category, CategoryCount>;
    },
  });
}

export interface Contact {
  name: string;
  email: string;
  score: number;
}

/** Previous correspondents, ranked by frequency (sent-to counts double). */
export function useContacts(enabled = true) {
  const { client, myEmails } = useMail();
  const { data: model } = useMailboxes();
  const sent = model?.roleId('sent');
  return useQuery({
    queryKey: ['contacts', sent],
    enabled: enabled && !!model,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const b = client.batch();
      const qa = b.call('Email/query', { sort: [{ property: 'receivedAt', isAscending: false }], limit: 400 });
      const ga = b.call('Email/get', { '#ids': qa.ref('/ids'), properties: ['from', 'replyTo'] });
      const qs = sent ? b.call('Email/query', { filter: { inMailbox: sent }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 300 }) : null;
      const gs = qs ? b.call('Email/get', { '#ids': qs.ref('/ids'), properties: ['to', 'cc', 'bcc'] }) : null;
      const r = await b.send();
      const map = new Map<string, Contact>();
      const add = (a: { name: string | null; email: string } | undefined, w: number) => {
        if (!a?.email) return;
        const k = a.email.toLowerCase();
        if (myEmails.has(k) || /no-?reply|notifications?@|mailer-daemon/i.test(k)) return;
        const c = map.get(k) ?? { name: '', email: a.email, score: 0 };
        c.score += w;
        if (a.name && !c.name) c.name = a.name;
        map.set(k, c);
      };
      for (const e of r.get(ga).list) {
        e.from?.forEach((a) => add(a, 1));
      }
      if (gs) for (const e of r.get(gs).list) [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])].forEach((a) => add(a, 3));
      return [...map.values()].sort((a, b2) => b2.score - a.score);
    },
  });
}

export function useQuota() {
  const { client } = useMail();
  return useQuery({
    queryKey: ['quota'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!client.hasCapability(CAP.quota)) return null;
      try {
        const b = client.batch();
        const h = b.call<{ list: { used: number; hardLimit: number; resourceType: string; types?: string[] }[] }>('Quota/get', { ids: null }, [CAP.quota]);
        const r = await b.send();
        const list = r.get(h).list;
        const q = list.find((x) => x.resourceType === 'octets') ?? list[0];
        return q ? { used: q.used, limit: q.hardLimit } : null;
      } catch {
        return null;
      }
    },
  });
}

// ------------------------------------------------------------------ actions

function applyNext(page: ThreadPage, plan: ActionPlan, removeIds: Set<string> | null): ThreadPage {
  let changed = false;
  const items: ThreadSummary[] = [];
  for (const it of page.items) {
    if (removeIds?.has(it.threadId)) {
      changed = true;
      continue;
    }
    if (it.emails.some((e) => plan.next[e.id])) {
      changed = true;
      const emails: LiteEmail[] = it.emails.map((e) => (plan.next[e.id] ? { ...e, ...plan.next[e.id] } : e));
      const s = summarize(it.threadId, emails.find((e) => e.id === it.emailId) ?? emails.at(-1)!, emails);
      s.snippet = it.snippet;
      s.receivedAt = it.receivedAt;
      items.push(s);
    } else items.push(it);
  }
  if (!changed) return page;
  const removed = page.items.length - items.length;
  return { ...page, items, total: page.total !== undefined ? page.total - removed : undefined };
}

export interface RunActionOptions {
  /** Current view key (`threads` query prefix) — rows are removed optimistically from it. */
  currentView?: View;
  silent?: boolean;
  /** Register for `z` / snackbar Undo (default true). Automatic mark-as-read on open is not undoable. */
  undoable?: boolean;
  /** Override snackbar text. */
  message?: string;
}

export function useActions() {
  const { client } = useMail();
  const qc = useQueryClient();
  const { data: model } = useMailboxes();
  const showSnack = useUi((s) => s.showSnack);
  const setUndo = useUi((s) => s.setUndo);

  const sendPlan = useCallback(
    async (update: Record<Id, PatchObject>, destroy: Id[] = []) => {
      const max = client.limits?.maxObjectsInSet ?? 500;
      const perRequest = client.limits?.maxCallsInRequest ?? 16;
      const calls: Record<string, unknown>[] = chunkPatches(update, max).map((u) => ({ update: u }));
      for (let i = 0; i < destroy.length; i += max) calls.push({ destroy: destroy.slice(i, i + max) });
      // Respect maxCallsInRequest: very large bulk actions go out as several sequential requests.
      for (let i = 0; i < calls.length; i += perRequest) {
        const b = client.batch();
        const hs = calls.slice(i, i + perRequest).map((args) => b.call('Email/set', args));
        const r = await b.send();
        for (const h of hs) {
          const res = r.get(h);
          const failed = Object.values(res.notUpdated ?? {}).concat(Object.values(res.notDestroyed ?? {}));
          if (failed.length) throw new Error(failed[0]!.description ?? failed[0]!.type);
        }
      }
    },
    [client],
  );

  const invalidate = useCallback(
    (threadIds: string[]) => {
      qc.invalidateQueries({ queryKey: ['threads'] });
      qc.invalidateQueries({ queryKey: ['mailboxes'] });
      qc.invalidateQueries({ queryKey: ['counts'] });
      for (const t of threadIds) qc.invalidateQueries({ queryKey: ['thread', t] });
    },
    [qc],
  );

  const run = useCallback(
    async (input: Omit<ActionInput, 'model'>, opts: RunActionOptions = {}): Promise<ActionPlan | null> => {
      if (!model || !input.threads.length) return null;
      const plan = planAction({ ...input, model });
      const threadIds = input.threads.map((t) => t.threadId);
      const removeIds = plan.removesFromView ? new Set(threadIds) : null;
      // Optimistic update of every cached list page + open conversations.
      const snapshot = qc.getQueriesData<ThreadPage>({ queryKey: ['threads'] });
      const convSnapshot = threadIds.map((t) => [t, qc.getQueryData<Conversation>(['thread', t])] as const);
      for (const [key, page] of snapshot) {
        if (!page) continue;
        const isCurrent = opts.currentView && key[1] === opts.currentView.kind && key[2] === opts.currentView.key;
        qc.setQueryData(key, applyNext(page, plan, isCurrent ? removeIds : null));
      }
      for (const t of threadIds) {
        qc.setQueryData<Conversation>(['thread', t], (c) =>
          c
            ? { ...c, emails: c.emails.filter((e) => !plan.destroy.includes(e.id)).map((e) => (plan.next[e.id] ? ({ ...e, ...plan.next[e.id] } as Email) : e)) }
            : c,
        );
      }
      try {
        await sendPlan(plan.update, plan.destroy);
      } catch (e) {
        for (const [key, page] of snapshot) qc.setQueryData(key, page);
        for (const [t, c] of convSnapshot) qc.setQueryData(['thread', t], c);
        showSnack({ text: `Couldn't complete the action: ${(e as Error).message}` });
        invalidate(threadIds);
        return null;
      }
      invalidate(threadIds);
      const undoFn = plan.undo
        ? async () => {
            setUndo(null);
            try {
              await sendPlan(plan.undo!);
              showSnack({ text: 'Action undone.' });
            } catch (e) {
              showSnack({ text: `Couldn't undo: ${(e as Error).message}` });
            }
            invalidate(threadIds);
          }
        : null;
      if (opts.undoable !== false) setUndo(undoFn);
      if (!opts.silent) showSnack({ text: opts.message ?? plan.message, actions: undoFn ? [{ label: 'Undo', run: undoFn }] : [] });
      return plan;
    },
    [model, qc, sendPlan, invalidate, showSnack, setUndo],
  );

  return { run, sendPlan, invalidate };
}

/** Mark conversation emails read (silently, no undo) — used when opening a conversation. */
export function useMarkRead() {
  const { run } = useActions();
  return useCallback(
    (threadId: string, emails: LiteEmail[]) => {
      if (!emails.some((e) => !e.keywords[KW.seen])) return;
      void run({ kind: 'read', threads: [{ threadId, emails }] }, { silent: true, undoable: false });
    },
    [run],
  );
}

// ------------------------------------------------------------------ push + sweeper

/**
 * Wake due snoozed mail and move delivered scheduled mail to Sent. The BFF's mail worker does the
 * work (server/src/worker.ts) and also runs on a timer for every account; while the app is open we
 * ask it to sweep this account promptly. Returns true when something changed.
 */
export async function sweep(): Promise<boolean> {
  const res = await fetch('/api/sweep', { method: 'POST', credentials: 'same-origin', headers: { ...CSRF_HEADERS, Accept: 'application/json' } });
  if (!res.ok) return false;
  const r = (await res.json()) as { woken?: number; sent?: number };
  return !!(r.woken || r.sent);
}

function PushAndSweep() {
  const { client, accountId } = useMail();
  const qc = useQueryClient();
  const { data: model } = useMailboxes();
  const notify = useSettings((s) => s.desktopNotifications);
  const emailState = useRef<string | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // Background sweeper (snooze wake-ups, scheduled → Sent).
  useEffect(() => {
    if (!model) return;
    let stop = false;
    const tick = async () => {
      try {
        if (await sweep()) {
          qc.invalidateQueries({ queryKey: ['threads'] });
          qc.invalidateQueries({ queryKey: ['mailboxes'] });
        }
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const t = setInterval(() => !stop && void tick(), 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!model, client, qc]);

  // EventSource push.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = { mailbox: false, email: false, submission: false };
    (async () => {
      try {
        const r = await client.call('Email/get', { ids: [], properties: ['id'] });
        emailState.current = r.state;
      } catch {
        /* ignore */
      }
    })();
    const flush = async () => {
      const p = pending;
      pending = { mailbox: false, email: false, submission: false };
      if (p.mailbox) {
        qc.invalidateQueries({ queryKey: ['mailboxes'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
      }
      if (p.email) {
        qc.invalidateQueries({ queryKey: ['threads'] });
        qc.invalidateQueries({ queryKey: ['thread'] });
        qc.invalidateQueries({ queryKey: ['counts'] });
        await notifyNew();
      }
      if (p.submission && modelRef.current) {
        try {
          if (await sweep()) {
            qc.invalidateQueries({ queryKey: ['threads'] });
            qc.invalidateQueries({ queryKey: ['mailboxes'] });
          }
        } catch {
          /* ignore */
        }
      }
    };
    const notifyNew = async () => {
      const since = emailState.current;
      if (!since) return;
      try {
        const ch = await client.emailChanges(since, 50);
        emailState.current = ch.newState;
        const inbox = modelRef.current?.roleId('inbox');
        if (!ch.created.length || !inbox || !notifyRef.current || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const got = await client.emailGet({
          ids: ch.created.slice(0, 5),
          properties: ['id', 'threadId', 'from', 'subject', 'preview', 'mailboxIds', 'keywords'],
        });
        for (const e of got.list) {
          if (!e.mailboxIds[inbox] || e.keywords[KW.seen]) continue;
          if (Object.values(CATEGORY_KEYWORDS).some((k) => e.keywords[k])) continue;
          const n = new Notification(e.from?.[0]?.name || e.from?.[0]?.email || 'New message', {
            body: `${e.subject ?? ''}\n${e.preview ?? ''}`,
            icon: '/brand/icon-192.png',
            tag: e.id,
          });
          n.onclick = () => {
            window.focus();
            location.assign(`/mail/inbox/${e.threadId}`);
          };
        }
      } catch {
        emailState.current = null;
      }
    };
    const unsub = client.subscribe(
      (change) => {
        const st = change.changed[accountId];
        if (!st) return;
        if (st.Mailbox) pending.mailbox = true;
        if (st.Email || st.Thread) pending.email = true;
        if (st.EmailSubmission) pending.submission = true;
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), 250);
      },
      { types: ['Email', 'Mailbox', 'Thread', 'EmailSubmission'], ping: 60 },
    );
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [client, accountId, qc]);

  return null;
}
