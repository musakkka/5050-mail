/**
 * Mail worker: the server-side half of snooze and schedule send (05-jmap-mapping §8, §9).
 *
 * Stalwart has a Snoozed / Scheduled mailbox role but nothing that acts on them, so:
 *  - snooze wake-up: emails in Snoozed whose `$ff_wake_YYYYMMDDtHHMMz` keyword is due go back to
 *    the Inbox, unread. The newest message of each woken conversation is re-imported with
 *    `receivedAt = now` so the conversation comes back at the top of the Inbox, as in Gmail.
 *  - scheduled mail: Stalwart releases the held submission itself (FUTURERELEASE); once its
 *    EmailSubmission is `final` the email moves Scheduled → Sent.
 *
 * All state lives in Stalwart (mailboxes + keywords), so the worker is stateless and idempotent.
 * Accounts are swept only with the user's own credentials, held by their BFF session (no master or
 * impersonation credential). A user with no live session is swept as soon as they sign in again
 * (the app calls POST /api/sweep on load); until then IMAP clients still see the mail in Snoozed.
 */
import type { FetchFn } from './stalwart.js';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const SUBMISSION = 'urn:ietf:params:jmap:submission';

export const WAKE_PREFIX = '$ff_wake_';

export function parseWakeKeyword(kw: string): Date | undefined {
  const m = /^\$ff_wake_(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})z$/i.exec(kw);
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function wakeTimeOf(keywords: Record<string, boolean> | undefined): Date | undefined {
  for (const k of Object.keys(keywords ?? {})) {
    const d = parseWakeKeyword(k);
    if (d) return d;
  }
  return undefined;
}

type Call = [string, Record<string, unknown>, string];
type Patch = Record<string, unknown>;

export interface SweepResult {
  /** Conversations woken from Snoozed. */
  woken: number;
  /** Scheduled emails moved to Sent after delivery. */
  sent: number;
}

interface SnoozedEmail {
  id: string;
  threadId: string;
  blobId: string;
  receivedAt: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
}

export class JmapSession {
  constructor(
    private fetchFn: FetchFn,
    private stalwartUrl: string,
    private authorization: string,
    public accountId: string,
    private timeoutMs = 30_000,
  ) {}

  static async open(fetchFn: FetchFn, stalwartUrl: string, authorization: string): Promise<JmapSession | null> {
    const res = await fetchFn(`${stalwartUrl}/jmap/session`, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`session ${res.status}`);
    const s = (await res.json()) as { primaryAccounts?: Record<string, string> };
    const accountId = s.primaryAccounts?.[MAIL];
    return accountId ? new JmapSession(fetchFn, stalwartUrl, authorization, accountId) : null;
  }

  async call(calls: Call[], using = [CORE, MAIL]): Promise<Map<string, [string, Record<string, unknown>]>> {
    const res = await this.fetchFn(`${this.stalwartUrl}/jmap/`, {
      method: 'POST',
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ using, methodCalls: calls.map(([m, a, id]) => [m, { accountId: this.accountId, ...a }, id]) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`JMAP ${res.status}`);
    const json = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
    const out = new Map<string, [string, Record<string, unknown>]>();
    for (const [name, args, id] of json.methodResponses) out.set(id, [name, args]);
    return out;
  }
}

function ok(r: Map<string, [string, Record<string, unknown>]>, id: string): Record<string, unknown> {
  const x = r.get(id);
  if (!x) throw new Error(`no response ${id}`);
  if (x[0] === 'error') throw new Error(`${id}: ${String(x[1].type)}`);
  return x[1];
}

/** Wake due snoozed conversations and file delivered scheduled mail, for one account. */
export async function sweepAccount(jmap: JmapSession, now: number = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { woken: 0, sent: 0 };
  const r1 = await jmap.call([['Mailbox/get', { ids: null, properties: ['role'] }, 'm']]);
  const boxes = (ok(r1, 'm').list as { id: string; role: string | null }[]) ?? [];
  const role = (name: string) => boxes.find((b) => b.role === name)?.id;
  const inbox = role('inbox');
  const snoozed = role('snoozed');
  const scheduled = role('scheduled');
  const sent = role('sent');

  const calls: Call[] = [];
  if (snoozed && inbox) {
    calls.push(['Email/query', { filter: { inMailbox: snoozed }, limit: 1000 }, 'sq']);
    calls.push([
      'Email/get',
      { '#ids': { resultOf: 'sq', name: 'Email/query', path: '/ids' }, properties: ['threadId', 'blobId', 'receivedAt', 'mailboxIds', 'keywords'] },
      'sg',
    ]);
  }
  if (scheduled && sent) calls.push(['Email/query', { filter: { inMailbox: scheduled }, limit: 1000 }, 'cq']);
  if (!calls.length) return result;
  const r2 = await jmap.call(calls);

  // ---- snooze wake-ups
  if (snoozed && inbox) {
    const list = (ok(r2, 'sg').list as SnoozedEmail[]) ?? [];
    const due = list.filter((e) => {
      const w = wakeTimeOf(e.keywords);
      return w !== undefined && w.getTime() <= now;
    });
    const byThread = new Map<string, SnoozedEmail[]>();
    for (const e of due) byThread.set(e.threadId, [...(byThread.get(e.threadId) ?? []), e]);
    const update: Record<string, Patch> = {};
    const imports: Record<string, Record<string, unknown>> = {};
    const importedFrom = new Map<string, string>();
    for (const emails of byThread.values()) {
      emails.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      const latest = emails.at(-1)!;
      for (const e of emails) {
        const patch: Patch = { [`mailboxIds/${snoozed}`]: null, [`mailboxIds/${inbox}`]: true };
        for (const k of Object.keys(e.keywords)) if (k.toLowerCase().startsWith(WAKE_PREFIX)) patch[`keywords/${k}`] = null;
        if (e === latest) {
          // Re-import the newest message with receivedAt = now (receivedAt is immutable in JMAP) so the
          // conversation sorts to the top of the Inbox; same blob, so headers and threading are unchanged.
          const mailboxIds: Record<string, boolean> = { ...e.mailboxIds, [inbox]: true };
          delete mailboxIds[snoozed];
          const keywords: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(e.keywords)) if (v && !k.toLowerCase().startsWith(WAKE_PREFIX) && k !== '$seen') keywords[k] = true;
          const key = `w${importedFrom.size}`;
          imports[key] = { blobId: e.blobId, mailboxIds, keywords, receivedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') };
          importedFrom.set(key, e.id);
          // Fallback if the import fails: wake it in place (unread) so it never stays stuck in Snoozed.
          update[e.id] = { ...patch, 'keywords/$seen': null };
        } else update[e.id] = patch;
      }
    }
    if (importedFrom.size) {
      const r3 = await jmap.call([['Email/import', { emails: imports }, 'i']]);
      const created = (ok(r3, 'i').created ?? {}) as Record<string, { id: string }>;
      const destroy: string[] = [];
      for (const [key, origId] of importedFrom) {
        if (created[key]) {
          destroy.push(origId);
          delete update[origId];
        }
      }
      const r4 = await jmap.call([['Email/set', { update, destroy }, 'u']]);
      const res = ok(r4, 'u');
      const notDestroyed = Object.keys((res.notDestroyed ?? {}) as object);
      if (notDestroyed.length) {
        // Keep the original but take it out of Snoozed so it isn't woken (and duplicated) again.
        const fix: Record<string, Patch> = {};
        for (const id of notDestroyed) {
          const e = due.find((x) => x.id === id)!;
          fix[id] = { [`mailboxIds/${snoozed}`]: null, [`mailboxIds/${inbox}`]: true };
          for (const k of Object.keys(e.keywords)) if (k.toLowerCase().startsWith(WAKE_PREFIX)) fix[id]![`keywords/${k}`] = null;
        }
        await jmap.call([['Email/set', { update: fix }, 'f']]);
      }
      result.woken = byThread.size;
    }
  }

  // ---- scheduled → Sent once delivered
  if (scheduled && sent) {
    const ids = (ok(r2, 'cq').ids as string[]) ?? [];
    if (ids.length) {
      const r5 = await jmap.call(
        [
          ['EmailSubmission/query', { filter: { emailIds: ids, undoStatus: 'final' }, limit: 1000 }, 'q'],
          ['EmailSubmission/get', { '#ids': { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' }, properties: ['emailId', 'undoStatus'] }, 'g'],
        ],
        [CORE, MAIL, SUBMISSION],
      );
      const subs = (ok(r5, 'g').list as { emailId: string; undoStatus: string }[]) ?? [];
      const update: Record<string, Patch> = {};
      for (const s of subs) {
        if (s.undoStatus === 'final' && ids.includes(s.emailId)) update[s.emailId] = { [`mailboxIds/${scheduled}`]: null, [`mailboxIds/${sent}`]: true };
      }
      if (Object.keys(update).length) {
        const r6 = await jmap.call([['Email/set', { update }, 'u']]);
        result.sent = Object.keys((ok(r6, 'u').updated ?? {}) as object).length;
      }
    }
  }
  return result;
}

export interface Credential {
  email: string;
  authorization: string;
}

export interface WorkerOptions {
  fetch: FetchFn;
  stalwartUrl: string;
  intervalMs: number;
  /** Credentials of currently signed-in sessions (deduplicated by the worker). */
  sessions: () => Promise<Credential[]> | Credential[];
  log?: (msg: string) => void;
}

/** Periodically sweeps every reachable account; also used on demand by POST /api/sweep. */
export class MailWorker {
  private timer?: NodeJS.Timeout;
  private inFlight = new Map<string, Promise<SweepResult>>();
  private lastRun = new Map<string, { at: number; result: SweepResult }>();

  constructor(private opts: WorkerOptions) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.runOnce().catch((e) => this.opts.log?.(`[worker] sweep failed: ${(e as Error).message}`));
    this.timer = setInterval(tick, this.opts.intervalMs);
    this.timer.unref();
    setTimeout(tick, 5_000).unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sweep one account (coalesces concurrent calls; reuses a result younger than `maxAgeMs`). */
  async sweep(cred: Credential, maxAgeMs = 0): Promise<SweepResult> {
    const key = cred.email.toLowerCase();
    const last = this.lastRun.get(key);
    if (maxAgeMs && last && Date.now() - last.at < maxAgeMs) return last.result;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = (async () => {
      const jmap = await JmapSession.open(this.opts.fetch, this.opts.stalwartUrl, cred.authorization);
      if (!jmap) return { woken: 0, sent: 0 };
      return sweepAccount(jmap);
    })();
    this.inFlight.set(key, p);
    try {
      const result = await p;
      this.lastRun.set(key, { at: Date.now(), result });
      if (result.woken || result.sent) this.opts.log?.(`[worker] ${key}: woke ${result.woken}, filed ${result.sent} scheduled`);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** One credential per signed-in account. */
  async credentials(): Promise<Credential[]> {
    const out = new Map<string, Credential>();
    for (const c of await this.opts.sessions()) out.set(c.email.toLowerCase(), c);
    return [...out.values()];
  }

  async runOnce(): Promise<void> {
    for (const cred of await this.credentials()) {
      try {
        await this.sweep(cred);
      } catch (e) {
        this.opts.log?.(`[worker] ${cred.email}: ${(e as Error).message}`);
      }
    }
  }
}
