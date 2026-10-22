/**
 * Capture admin-console screenshots at 1440×900 into web/screenshots/admin-*.png.
 *   BASE_URL=http://localhost:3000 npm run screenshots:admin
 *
 * Signs in as the seeded admin (alice@dev.test) and makes sure a little demo
 * data exists (a group and a mailing list on dev.test) so the pages aren't empty.
 * Everything goes through the BFF with alice's own session.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const USER = process.env.MAIL_USER ?? 'alice@dev.test';
const PASS = process.env.MAIL_PASS ?? 'Demo-Alice-Orchid-2026';
const OUT = new URL('../screenshots/', import.meta.url).pathname;

async function login(page: Page, email = USER, password = PASS) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/mail\//);
}

/** A JMAP caller that goes through the BFF with a real cookie session (same path as the browser). */
async function bffJmap(email: string, password: string) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = { Cookie: cookie, 'X-Requested-With': '5050', 'Content-Type': 'application/json' };
  const session = await (await fetch(`${BASE}/jmap/session`, { headers })).json();
  const accountId = session.primaryAccounts['urn:stalwart:jmap'];
  return async (calls: [string, Record<string, unknown>, string][]) => {
    const r = await fetch(`${BASE}/jmap/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls.map(([m, a, id]) => [m, { accountId, ...a }, id]) }),
    });
    const out = (await r.json()).methodResponses as [string, any, string][];
    for (const x of out) if (x[0] === 'error') throw new Error(JSON.stringify(x[1]));
    return out;
  };
}

/** Idempotently create support@dev.test (group: alice, bob) and team@dev.test (list). */
async function ensureDemoData(): Promise<{ groupId: string; devTestId: string; bobId: string }> {
  const call = await bffJmap(USER, PASS);
  const [, [, ag], [, lg]] = await call([
    ['x:Account/query', {}, 'a'],
    ['x:Account/get', { '#ids': { resultOf: 'a', name: 'x:Account/query', path: '/ids' }, properties: ['name', 'domainId', 'emailAddress'] }, 'g'],
    ['x:MailingList/get', { ids: null, properties: ['emailAddress'] }, 'l'],
  ]);
  const accounts = ag.list as { id: string; domainId: string; emailAddress: string }[];
  const alice = accounts.find((a) => a.emailAddress === 'alice@dev.test')!;
  const bob = accounts.find((a) => a.emailAddress === 'bob@dev.test')!;
  const devTestId = alice.domainId;
  let groupId = accounts.find((a) => a.emailAddress === 'support@dev.test')?.id;
  if (!groupId) {
    const [[, r]] = await call([
      ['x:Account/set', { create: { g: { '@type': 'Group', name: 'support', domainId: devTestId, description: 'Customer support inbox' } } }, 's'],
    ]);
    groupId = r.created.g.id as string;
  }
  await call([['x:Account/set', { update: { [alice.id]: { [`memberGroupIds/${groupId}`]: true }, [bob.id]: { [`memberGroupIds/${groupId}`]: true } } }, 'm']]);
  if (!(lg.list as { emailAddress: string }[]).some((l) => l.emailAddress === 'team@dev.test')) {
    const recipients = { 'alice@dev.test': true, 'bob@dev.test': true, 'carol@dev.test': true, 'dana@lumenlabs.example': true };
    await call([['x:MailingList/set', { create: { l: { name: 'team', domainId: devTestId, description: 'Everyone on the team', recipients } } }, 'l']]);
  }
  return { groupId, devTestId, bobId: bob.id };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const ids = await ensureDemoData();
  await login(page);
  await page.evaluate(() => document.fonts.ready);

  const shot = async (name: string) => {
    await page.mouse.move(1430, 890);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}admin-${name}.png` });
    console.log(`saved admin-${name}.png`);
  };
  const go = async (path: string, ready: string) => {
    await page.goto(`${BASE}${path}`);
    await page.waitForSelector(ready, { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
  };

  await go('/admin', '.adm-stat');
  await shot('overview');

  await go('/admin/domains', '.adm-table');
  await shot('domains');
  await page.getByRole('button', { name: 'Add a domain' }).first().click();
  await page.getByRole('dialog').getByLabel('Domain name').fill('mail.newco.test');
  await shot('domain-add');
  await page.keyboard.press('Escape');

  await go(`/admin/domains/${ids.devTestId}`, '.adm-records');
  await shot('domain');

  await go('/admin/users', '.adm-table');
  await shot('users');
  await page.getByRole('button', { name: 'Add a user' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Erin Okafor');
  await shot('user-add');
  await page.keyboard.press('Escape');

  await go(`/admin/users/${ids.bobId}`, '.adm-grid2');
  await shot('user');

  await go('/admin/groups', '.adm-table');
  await shot('groups');
  await go(`/admin/groups/${ids.groupId}`, '.adm-list--people');
  await shot('group');

  // dark mode
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('ff:settings:'));
    const v = JSON.parse((k && localStorage.getItem(k)) || '{}');
    v.theme = 'dark';
    localStorage.setItem(k ?? 'ff:settings:alice@dev.test', JSON.stringify(v));
  });
  await go(`/admin/domains/${ids.devTestId}`, '.adm-records');
  await shot('domain-dark');
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('ff:settings:'));
    if (!k) return;
    const v = JSON.parse(localStorage.getItem(k) || '{}');
    v.theme = 'light';
    localStorage.setItem(k, JSON.stringify(v));
  });

  // Non-admin view
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage();
  await login(p2, 'bob@dev.test', 'Demo-Bob-Granite-2026');
  await p2.goto(`${BASE}/admin`);
  await p2.waitForSelector('.adm-denied');
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}admin-denied.png` });
  console.log('saved admin-denied.png');

  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
