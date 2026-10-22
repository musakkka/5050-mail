import { expect, test, type Page } from '@playwright/test';

/**
 * Admin console against a local Stalwart (see scripts/seed.ts). alice@dev.test is an admin;
 * bob@dev.test is not. The test domain and user are removed first so the spec is re-runnable.
 */
const ADMIN = { email: process.env.MAIL_USER ?? 'alice@dev.test', password: process.env.MAIL_PASS ?? 'Demo-Alice-Orchid-2026' };
const NON_ADMIN = { email: 'bob@dev.test', password: 'Demo-Bob-Granite-2026' };
const DOMAIN = 'example.test';
const DAVE = { local: 'dave', name: 'Dave Example', password: 'Demo-Dave-Harbor-2026' };
const ALIAS = { local: 'dg', domain: 'dev.test' };

// Several sign-ins per test (one fresh browser context each).
test.describe.configure({ timeout: 180_000 });

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/mail\//);
}

/** Remove a test domain (default example.test) and everything on it, through the BFF's JMAP proxy with the signed-in admin's session. */
async function resetTestDomain(page: Page, name = DOMAIN) {
  await page.evaluate(async (domainName) => {
    const session = await (await fetch('/jmap/session')).json();
    const accountId = session.primaryAccounts['urn:stalwart:jmap'];
    const call = async (calls: [string, Record<string, unknown>, string][]) => {
      const r = await fetch('/jmap/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
        body: JSON.stringify({
          using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
          methodCalls: calls.map(([m, a, id]) => [m, { accountId, ...a }, id]),
        }),
      });
      return (await r.json()).methodResponses as [string, Record<string, any>, string][];
    };
    const [, [, dg]] = await call([
      ['x:Domain/query', {}, 'q'],
      ['x:Domain/get', { '#ids': { resultOf: 'q', name: 'x:Domain/query', path: '/ids' }, properties: ['name'] }, 'g'],
    ]);
    const domain = (dg.list as { id: string; name: string }[]).find((d) => d.name === domainName);
    if (!domain) return;
    const [[, accounts], [, lists], [, sigs]] = await call([
      ['x:Account/query', { filter: { domainId: domain.id } }, 'a'],
      ['x:MailingList/get', { ids: null, properties: ['domainId'] }, 'l'],
      ['x:DkimSignature/query', { filter: { domainId: domain.id } }, 'k'],
    ]);
    await call([
      ['x:Account/set', { destroy: accounts.ids }, 'a'],
      ['x:MailingList/set', { destroy: (lists.list as { id: string; domainId: string }[]).filter((l) => l.domainId === domain.id).map((l) => l.id) }, 'l'],
      ['x:DkimSignature/set', { destroy: sigs.ids }, 'k'],
      ['x:Domain/set', { destroy: [domain.id] }, 'd'],
    ]);
  }, name);
}

test('admin creates a domain, a user and an alias; the user can sign in', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await login(page, ADMIN.email, ADMIN.password);
  await resetTestDomain(page);

  // The admin entry point in the mail UI leads to the console.
  await page.getByRole('link', { name: 'Admin console' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // Domain
  await page.getByRole('link', { name: 'Domains' }).click();
  await page.getByRole('button', { name: 'Add a domain' }).first().click();
  const addDomain = page.getByRole('dialog', { name: 'Add a domain' });
  await addDomain.getByLabel('Domain name').fill(DOMAIN);
  // With Cloudflare configured the one-click mode is the default; this test covers the manual path.
  const otherDns = addDomain.getByLabel(/Another DNS provider/);
  if (await otherDns.count()) await otherDns.check();
  // Exercise the manual-DNS path when automatic DNS is offered (it can't reach a real provider locally).
  const manual = addDomain.getByLabel("I'll add the records myself");
  if (await manual.count()) await manual.check();
  await addDomain.getByRole('button', { name: 'Add domain' }).click();
  await expect(page).toHaveURL(/\/admin\/domains\/[^/]+$/);
  await expect(page.getByRole('heading', { name: DOMAIN, level: 1 })).toBeVisible();
  await expect(page.locator('.adm-records')).toContainText(`mx`, { ignoreCase: true });
  await expect(page.getByRole('button', { name: 'Copy value' }).first()).toBeVisible();

  // User
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'Add a user' }).click();
  const addUser = page.getByRole('dialog', { name: 'Add a user' });
  await addUser.getByLabel('Name', { exact: true }).fill(DAVE.name);
  await addUser.getByLabel('Email address', { exact: true }).fill(DAVE.local);
  await addUser.getByLabel('Email address domain').selectOption({ label: DOMAIN });
  await addUser.getByLabel('Password', { exact: true }).fill(DAVE.password);
  await addUser.getByRole('button', { name: 'Add user' }).click();
  const created = page.getByRole('dialog', { name: 'User added' });
  await expect(created).toContainText(`${DAVE.local}@${DOMAIN}`);
  // "Copy login details": webmail URL, credentials and client settings in one paste.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await created.getByRole('button', { name: 'Copy login details' }).click();
  const details = await page.evaluate(() => navigator.clipboard.readText());
  expect(details).toContain(`Webmail: ${new URL(page.url()).origin}`);
  expect(details).toContain(`Email: ${DAVE.local}@${DOMAIN}`);
  expect(details).toContain(`Password: ${DAVE.password}`);
  expect(details).toMatch(/IMAP: \S+:993 \(SSL\/TLS\)/);
  expect(details).toMatch(/SMTP: \S+:465 \(SSL\/TLS\)/);
  await created.getByRole('button', { name: 'Open user' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(DAVE.name) })).toBeVisible();

  // Alias on another domain
  await page.getByLabel('Add an alias', { exact: true }).fill(ALIAS.local);
  await page.getByLabel('Add an alias domain').selectOption({ label: ALIAS.domain });
  await page.getByRole('button', { name: 'Add alias' }).click();
  await expect(page.locator('.adm-list')).toContainText(`${ALIAS.local}@${ALIAS.domain}`);

  // The user shows up in search.
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByLabel('Search users').fill('dave ex');
  await expect(page.locator('.adm-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.adm-table')).toContainText(`${DAVE.local}@${DOMAIN}`);
  expect(errors).toEqual([]);

  // Dave can sign in, with his address and with the alias.
  for (const email of [`${DAVE.local}@${DOMAIN}`, `${ALIAS.local}@${ALIAS.domain}`]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, email, DAVE.password);
    await expect(p).toHaveURL(/\/mail\/inbox/);
    // Not an admin: no console link, and /admin explains why.
    await p.goto('/admin');
    await expect(p.getByRole('heading', { name: "You don't have access to the admin console" })).toBeVisible();
    await ctx.close();
  }
});

/** Delete accounts / mailing lists by address (re-runnable setup). */
async function removeAddresses(page: Page, addresses: string[]) {
  await page.evaluate(async (addrs) => {
    const session = await (await fetch('/jmap/session')).json();
    const accountId = session.primaryAccounts['urn:stalwart:jmap'];
    const call = async (calls: [string, Record<string, unknown>, string][]) => {
      const r = await fetch('/jmap/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
        body: JSON.stringify({
          using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
          methodCalls: calls.map(([m, a, id]) => [m, { accountId, ...a }, id]),
        }),
      });
      return (await r.json()).methodResponses as [string, Record<string, any>, string][];
    };
    const [, [, ag], [, lg]] = await call([
      ['x:Account/query', {}, 'q'],
      ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' }, properties: ['emailAddress', 'memberGroupIds'] }, 'g'],
      ['x:MailingList/get', { ids: null, properties: ['emailAddress'] }, 'l'],
    ]);
    const all = ag.list as { id: string; emailAddress: string; memberGroupIds?: Record<string, boolean> }[];
    const doomed = all.filter((a) => addrs.includes(a.emailAddress));
    const doomedIds = new Set(doomed.map((a) => a.id));
    // Groups can't be destroyed while they have members.
    const update: Record<string, Record<string, null>> = {};
    for (const a of all)
      for (const g of Object.keys(a.memberGroupIds ?? {})) if (doomedIds.has(g)) update[a.id] = { ...(update[a.id] ?? {}), [`memberGroupIds/${g}`]: null };
    await call([
      ['x:Account/set', { update }, 'u'],
      ['x:Account/set', { destroy: [...doomedIds] }, 'a'],
      [
        'x:MailingList/set',
        { destroy: (lg.list as { id: string; emailAddress: string }[]).filter((l) => addrs.includes(l.emailAddress)).map((l) => l.id) },
        'l',
      ],
    ]);
  }, addresses);
}

test('admin suspends, resets a password, manages a group and a list, then cleans up', async ({ page, browser }) => {
  const ERIN = { email: 'erin@dev.test', password: 'Demo-Erin-Meadow-2026', next: 'Demo-Erin-Canyon-2027' };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page, ADMIN.email, ADMIN.password);
  await removeAddresses(page, [ERIN.email, 'qa@dev.test', 'news@dev.test']);

  const tryLogin = async (email: string, password: string) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.getByLabel('Email').fill(email);
    await p.getByLabel('Password', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Sign in' }).click();
    const ok = await p
      .waitForURL(/\/mail\//, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await ctx.close();
    return ok;
  };

  // Create Erin.
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add a user' }).click();
  const addUser = page.getByRole('dialog', { name: 'Add a user' });
  await addUser.getByLabel('Name', { exact: true }).fill('Erin Okafor');
  await addUser.getByLabel('Email address', { exact: true }).fill('erin');
  await addUser.getByLabel('Email address domain').selectOption({ label: 'dev.test' });
  await addUser.getByLabel('Password', { exact: true }).fill(ERIN.password);
  await addUser.getByRole('button', { name: 'Add user' }).click();
  await page.getByRole('dialog', { name: 'User added' }).getByRole('button', { name: 'Open user' }).click();
  await expect(page.getByRole('heading', { name: /Erin Okafor/ })).toBeVisible();

  // Suspend: she can't sign in; reactivate: she can.
  await page.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByText('This user is suspended')).toBeVisible();
  expect(await tryLogin(ERIN.email, ERIN.password)).toBe(false);
  await page.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByText('This user is suspended')).toHaveCount(0);
  expect(await tryLogin(ERIN.email, ERIN.password)).toBe(true);

  // Reset the password.
  await page.getByRole('button', { name: 'Reset password' }).click();
  const reset = page.getByRole('dialog', { name: /Reset password/ });
  await reset.getByLabel('New password', { exact: true }).fill(ERIN.next);
  await reset.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('dialog', { name: 'Password changed' })).toContainText(ERIN.next);
  await page.getByRole('button', { name: 'Done' }).click();
  expect(await tryLogin(ERIN.email, ERIN.next)).toBe(true);

  // Group with Erin as a member.
  await page.getByRole('link', { name: 'Groups & lists' }).click();
  await page.getByRole('button', { name: 'Create group' }).click();
  const cg = page.getByRole('dialog', { name: 'Create a group' });
  await cg.getByLabel('Group address', { exact: true }).fill('qa');
  await cg.getByLabel('Group address domain').selectOption({ label: 'dev.test' });
  await cg.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'qa@dev.test' })).toBeVisible();
  await page.getByLabel('Search users to add').fill('erin');
  await page.getByRole('option', { name: /Erin Okafor/ }).click();
  await expect(page.locator('.adm-list--people')).toContainText(ERIN.email);

  // Mailing list with an external recipient.
  await page.getByRole('link', { name: 'Groups & lists' }).click();
  await page.getByRole('tab', { name: 'Mailing lists' }).click();
  await page.getByRole('button', { name: 'Create mailing list' }).click();
  const cl = page.getByRole('dialog', { name: 'Create a mailing list' });
  await cl.getByLabel('List address', { exact: true }).fill('news');
  await cl.getByLabel('List address domain').selectOption({ label: 'dev.test' });
  await cl.getByLabel('Recipients').fill(`${ERIN.email}, someone@example.org`);
  await cl.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Recipients (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove someone@example.org' }).click();
  await expect(page.getByRole('heading', { name: 'Recipients (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete list' }).click();
  await page.getByLabel('Type news@dev.test to confirm').fill('news@dev.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete list' }).click();
  await expect(page).toHaveURL(/\/admin\/groups\?tab=lists$/);

  // Deleting the group works even though it has a member.
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('row', { name: /qa@dev\.test/ }).click();
  await page.getByRole('button', { name: 'Delete group' }).click();
  await page.getByLabel('Type qa@dev.test to confirm').fill('qa@dev.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click();
  await expect(page).toHaveURL(/\/admin\/groups$/);

  // Delete Erin (the confirm button stays disabled until the address is typed).
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('row', { name: /erin@dev\.test/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /Delete erin@dev\.test/ });
  await expect(confirm.getByRole('button', { name: 'Delete user' })).toBeDisabled();
  await confirm.getByLabel(`Type ${ERIN.email} to confirm`).fill(ERIN.email);
  await confirm.getByRole('button', { name: 'Delete user' }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.locator('.adm-table')).not.toContainText(ERIN.email);
  expect(errors).toEqual([]);
});

/**
 * One-click setup. Needs the BFF started with CLOUDFLARE_FAKE=1 (in-memory Cloudflare with the
 * zones cfzone.test and acmedemo.test) and a DnsServer in Stalwart (`npm run seed -- --automation`).
 * Skipped when the BFF has no Cloudflare configured.
 */
test('one click: add & connect a subdomain of a Cloudflare zone', async ({ page }) => {
  const CF_DOMAIN = 'mail.cfzone.test';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page, ADMIN.email, ADMIN.password);
  const zones = await page.evaluate(async () => (await fetch('/api/admin/cloudflare/zones')).status);
  test.skip(zones !== 200, 'Cloudflare is not configured on this BFF (start it with CLOUDFLARE_FAKE=1)');
  await resetTestDomain(page, CF_DOMAIN);

  await page.goto('/admin/domains');
  await page.getByRole('button', { name: 'Add a domain' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a domain' });
  await expect(dialog.getByLabel(/Domain on Cloudflare/)).toBeChecked();

  // A domain outside the account is caught before anything is created.
  await dialog.getByLabel('Domain name').fill('not-on-cloudflare.example');
  await dialog.getByRole('button', { name: 'Add & connect' }).click();
  await expect(dialog).toContainText("isn't in this server's Cloudflare account");

  // A subdomain's zone is the containing apex, picked automatically.
  await dialog.getByLabel('Domain name').fill(CF_DOMAIN);
  await expect(dialog.getByLabel('Cloudflare zone')).toHaveValue('cfzone.test');
  await dialog.getByRole('button', { name: 'Add & connect' }).click();

  const progress = page.getByRole('dialog', { name: `Setting up ${CF_DOMAIN}` });
  const step = (id: string) => progress.locator(`[data-step="${id}"]`);
  await expect(step('created')).toHaveAttribute('data-state', 'done');
  await expect(step('sending')).toHaveAttribute('data-state', 'done');
  await expect(step('sending')).toContainText(`cf-bounce.${CF_DOMAIN}`);
  // Locally Stalwart's DNS server and ACME are dummies: these never finish, but must show progress or an error, not crash.
  for (const id of ['dns', 'dkim', 'tls']) await expect(step(id)).toHaveAttribute('data-state', /done|active|error|skipped/);
  await expect(step('ready')).toBeVisible();

  await progress.getByRole('button', { name: 'Open domain' }).click();
  await expect(page.getByRole('heading', { name: CF_DOMAIN, level: 1 })).toBeVisible();
  const sending = page.locator('.adm-card', { has: page.getByRole('heading', { name: 'Sending' }) });
  await expect(sending).toContainText('Sending enabled');
  await expect(sending).toContainText('cfzone.test');
  await expect(sending).toContainText('5 of 5 present');
  await expect(sending.getByRole('button', { name: 'Fix' })).toHaveCount(0);

  // The domain was created with automatic DNS on the zone apex and no SRV records.
  await expect(page.locator('.adm-card', { has: page.getByRole('heading', { name: 'DNS', exact: true }) })).toContainText('cfzone.test');

  // Running connect again is a no-op that still reports success (idempotent).
  const again = await page.evaluate(async (domain) => {
    const r = await fetch('/api/admin/cloudflare/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
      body: JSON.stringify({ domain }),
    });
    return r.json();
  }, CF_DOMAIN);
  expect(again.ok).toBe(true);
  expect(again.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual(['zone:ok', 'sending:ok', 'records:ok', 'verify:ok']);

  await resetTestDomain(page, CF_DOMAIN);
  expect(errors).toEqual([]);
});

test('the Sending card fixes a Cloudflare-hosted domain that was added manually', async ({ page }) => {
  // Unique per run: the fake Cloudflare remembers onboarded domains for the BFF's lifetime.
  const FIX_DOMAIN = `fix-${Date.now().toString(36)}.acmedemo.test`;
  await login(page, ADMIN.email, ADMIN.password);
  const zones = await page.evaluate(async () => (await fetch('/api/admin/cloudflare/zones')).status);
  test.skip(zones !== 200, 'Cloudflare is not configured on this BFF (start it with CLOUDFLARE_FAKE=1)');
  await resetTestDomain(page, FIX_DOMAIN);

  await page.goto('/admin/domains');
  await page.getByRole('button', { name: 'Add a domain' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a domain' });
  await dialog.getByLabel(/Another DNS provider/).check();
  await expect(dialog).toContainText('Connect Cloudflare automatically');
  await dialog.getByLabel('Domain name').fill(FIX_DOMAIN);
  const manual = dialog.getByLabel("I'll add the records myself");
  if (await manual.count()) await manual.check();
  await dialog.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByRole('heading', { name: FIX_DOMAIN, level: 1 })).toBeVisible();

  const sending = page.locator('.adm-card', { has: page.getByRole('heading', { name: 'Sending' }) });
  await expect(sending).toContainText('Not enabled');
  await sending.getByRole('button', { name: 'Fix' }).click();
  await expect(sending).toContainText('Sending enabled');
  await expect(sending).toContainText('5 of 5 present');
  await resetTestDomain(page, FIX_DOMAIN);
});

test('non-admins cannot use the Cloudflare endpoints', async ({ page }) => {
  await login(page, NON_ADMIN.email, NON_ADMIN.password);
  const statuses = await page.evaluate(async () => [
    (await fetch('/api/admin/cloudflare/zones')).status,
    (
      await fetch('/api/admin/cloudflare/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': '5050' },
        body: JSON.stringify({ domain: 'cfzone.test' }),
      })
    ).status,
  ]);
  expect(statuses).toEqual([403, 403]);
});

test('non-admins get a friendly not-authorized page', async ({ page }) => {
  await login(page, NON_ADMIN.email, NON_ADMIN.password);
  await expect(page.getByRole('link', { name: 'Admin console' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: "You don't have access to the admin console" })).toBeVisible();
  await expect(page.getByText(NON_ADMIN.email)).toBeVisible();
  await page.getByRole('button', { name: 'Back to mail' }).click();
  await expect(page).toHaveURL(/\/mail\/inbox/);
});
