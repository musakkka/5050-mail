import { expect, type Page } from '@playwright/test';

export const ALICE = { email: process.env.MAIL_USER ?? 'alice@dev.test', password: process.env.MAIL_PASS ?? 'Demo-Alice-Orchid-2026' };

export async function login(page: Page, who = ALICE, opts: { settings?: Record<string, unknown> } = {}) {
  await page.goto('/login');
  if (opts.settings) {
    await page.evaluate(
      ([email, patch]) => {
        const k = `ff:settings:${email}`;
        const v = JSON.parse(localStorage.getItem(k) || '{}');
        localStorage.setItem(k, JSON.stringify({ ...v, ...(patch as object) }));
      },
      [who.email, opts.settings] as const,
    );
  }
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/mail\//);
}

type Call = [string, Record<string, unknown>, string];

/** JMAP through the BFF with the signed-in session (mail account by default). */
export async function jmap(page: Page, calls: Call[], using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']): Promise<[string, any, string][]> {
  return page.evaluate(
    async ([calls, using]) => {
      const session = await (await fetch('/jmap/session')).json();
      const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
      const r = await fetch('/jmap/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
        body: JSON.stringify({ using, methodCalls: (calls as Call[]).map(([m, a, id]) => [m, { accountId, ...a }, id]) }),
      });
      return (await r.json()).methodResponses;
    },
    [calls, using] as const,
  );
}

export async function roleIds(page: Page): Promise<Record<string, string>> {
  const [[, r]] = await jmap(page, [['Mailbox/get', { properties: ['role', 'name'] }, 'm']]);
  const out: Record<string, string> = {};
  for (const m of r.list as { id: string; role: string | null; name: string }[]) out[m.role ?? `name:${m.name}`] = m.id;
  return out;
}

/** Create plain-text emails in the Inbox; returns their ids. */
export async function createEmails(
  page: Page,
  emails: { subject: string; body?: string; from?: { name: string; email: string }; receivedAt?: string; seen?: boolean }[],
): Promise<string[]> {
  const roles = await roleIds(page);
  const create: Record<string, unknown> = {};
  emails.forEach((e, i) => {
    create[`e${i}`] = {
      mailboxIds: { [roles.inbox!]: true },
      keywords: e.seen ? { $seen: true } : {},
      from: [e.from ?? { name: 'E2E Sender', email: 'e2e.sender@example.test' }],
      to: [{ name: null, email: ALICE.email }],
      subject: e.subject,
      receivedAt: e.receivedAt ?? new Date(Date.now() - (emails.length - i) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      bodyValues: { t: { value: e.body ?? `Body of ${e.subject}` } },
      textBody: [{ partId: 't', type: 'text/plain' }],
    };
  });
  const [[, r]] = await jmap(page, [['Email/set', { create }, 's']]);
  expect(r.notCreated ?? {}).toEqual({});
  return emails.map((_, i) => r.created[`e${i}`].id as string);
}

export async function destroyEmails(page: Page, ids: string[]) {
  if (ids.length) await jmap(page, [['Email/set', { destroy: ids }, 'd']]);
}

/** Ids of emails whose subject contains `token`. */
export async function findEmails(page: Page, token: string, properties = ['subject', 'mailboxIds', 'keywords', 'receivedAt']) {
  const [, [, g]] = await jmap(page, [
    ['Email/query', { filter: { subject: token }, limit: 200 }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties }, 'g'],
  ]);
  return g.list as { id: string; subject: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>; receivedAt: string }[];
}
