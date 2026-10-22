import { expect, test } from '@playwright/test';
import { ALICE, createEmails, destroyEmails, findEmails, jmap, login, roleIds } from './helpers';

/**
 * Regression tests for the webmail polish pass (against local Stalwart, see README).
 * Each test creates its own uniquely-named mail and removes it afterwards.
 */
test.describe.configure({ timeout: 120_000 });

const token = () => `pz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test('sign-in continues to the page that asked for it (?next=), never off-origin', async ({ page }) => {
  await page.goto('/mail/sent');
  await expect(page).toHaveURL(/\/login\?next=%2Fmail%2Fsent/);
  await page.getByLabel('Email').fill(ALICE.email);
  await page.getByLabel('Password', { exact: true }).fill(ALICE.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/mail\/sent$/);
  // Already signed in: a hostile next falls back to the inbox.
  await page.goto('/login?next=%2F%5Cevil.test');
  await expect(page).toHaveURL(/\/mail\/inbox$/);
});

test('snoozed conversation wakes on time: back at the top of the Inbox, unread (server-side worker)', async ({ page }) => {
  await login(page);
  const t = token();
  const ids = await createEmails(page, [{ subject: `Snooze me ${t}`, receivedAt: '2026-01-02T10:00:00Z', seen: true }]);
  try {
    await page.goto(`/mail/search/${encodeURIComponent(t)}`);
    const row = page.locator('.row', { hasText: t });
    await row.locator('.row__check').click();
    await page.getByRole('button', { name: 'Snooze' }).first().click();
    await page.getByRole('menu', { name: 'Snooze until' }).getByRole('menuitem').first().click();
    await expect(page.locator('.snackbar')).toContainText(/snoozed until/i);
    const roles = await roleIds(page);
    let [e] = await findEmails(page, t);
    expect(e!.mailboxIds).toEqual({ [roles.snoozed!]: true });
    // Make it due: rewrite the wake keyword into the past.
    const wake = Object.keys(e!.keywords).find((k) => k.startsWith('$ff_wake_'))!;
    await jmap(page, [['Email/set', { update: { [e!.id]: { [`keywords/${wake}`]: null, 'keywords/$ff_wake_20260101t0000z': true } } }, 'u']]);
    // The app asks the BFF worker to sweep when it loads.
    await page.goto('/mail/inbox');
    await expect(page.locator('.row').first()).toContainText(t, { timeout: 30_000 });
    await expect(page.locator('.row').first()).toHaveClass(/row--unread/);
    [e] = await findEmails(page, t);
    expect(e!.mailboxIds).toEqual({ [roles.inbox!]: true });
    expect(Object.keys(e!.keywords).some((k) => k.startsWith('$ff_wake_'))).toBe(false);
    expect(Date.now() - new Date(e!.receivedAt).getTime()).toBeLessThan(10 * 60_000);
    ids.splice(0, 1, e!.id);
  } finally {
    await destroyEmails(page, ids);
  }
});

test('"Select all N conversations" applies labels (and move, snooze, keyboard actions) to every match, not just the page', async ({ page }) => {
  await login(page, ALICE, { settings: { pageSize: 10 } });
  const t = token();
  const ids = await createEmails(
    page,
    Array.from({ length: 13 }, (_, i) => ({ subject: `Bulk ${t} #${i}` })),
  );
  try {
    await page.goto(`/mail/search/${encodeURIComponent(`subject:${t}`)}`);
    await expect(page.locator('.row')).toHaveCount(10);
    await page.getByRole('checkbox', { name: 'Select' }).first().click();
    await page.getByRole('button', { name: /Select all 13 conversations/ }).click();
    await expect(page.locator('.select-banner')).toContainText('All 13 conversations');
    await page.getByRole('button', { name: 'Labels' }).click();
    const picker = page.getByRole('menu', { name: 'Label as' });
    await picker.getByRole('menuitemcheckbox', { name: 'Receipts' }).click();
    await picker.getByRole('menuitem', { name: 'Apply' }).click();
    const roles = await roleIds(page);
    await expect.poll(async () => (await findEmails(page, t)).filter((e) => e.mailboxIds[roles['name:Receipts']!]).length).toBe(13);
  } finally {
    await destroyEmails(page, ids);
  }
});

test('phones: the letter avatar selects conversations; no stuck hover actions', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await login(page);
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator('.row__check').first()).toBeHidden();
  const avatar = page.locator('.row__avatar').first();
  await avatar.tap();
  await expect(avatar).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.row').first()).toHaveClass(/row--selected/);
  await expect(page.getByRole('button', { name: 'Archive' }).first()).toBeVisible();
  await expect(page.locator('.row').first().locator('.row__actions')).toBeHidden();
  await avatar.tap();
  await expect(avatar).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await ctx.close();
});

test('modals trap focus, close on Esc and lock page scroll', async ({ page }) => {
  await login(page);
  await expect(page.locator('.row').first()).toBeVisible();
  const search = page.getByLabel('Search mail');
  await search.focus();
  await search.press('Escape');
  await page.locator('body').press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('button', { name: /Enable|Disable/ })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.classList.contains('scroll-locked'))).toBe(true);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await help.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await help.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.classList.contains('scroll-locked'))).toBe(false);
});

test('right-to-left mail reads right-to-left (subject, sender, plain-text lines)', async ({ page }) => {
  await login(page);
  const t = token();
  const ids = await createEmails(page, [
    { subject: `שלום עליכם ${t}`, body: 'Hi Alice,\nהאם את פנויה ביום שלישי?\nمرحبا', from: { name: 'דוד כהן', email: 'david@il.example' } },
  ]);
  try {
    await page.goto(`/mail/search/${encodeURIComponent(t)}`);
    await page.locator('.row', { hasText: t }).click();
    await expect(page.locator('.conv__subject-text')).toHaveAttribute('dir', 'auto');
    const frame = page.frameLocator('.msg--expanded .msg-body__frame').last();
    const dirs = await frame.locator('.ff-plain > div').evaluateAll((els) => els.map((e) => getComputedStyle(e).direction));
    expect(dirs).toEqual(['ltr', 'rtl', 'rtl']);
  } finally {
    await destroyEmails(page, ids);
  }
});

test('search: filename: finds attachments by name or extension (not indexed by the server)', async ({ page }) => {
  await login(page);
  await page.goto(`/mail/search/${encodeURIComponent('filename:pdf')}`);
  await expect(page.locator('.row').first()).toBeVisible();
  const chips = await page.locator('.row .att-chip__name').allInnerTexts();
  expect(chips.length).toBeGreaterThan(0);
  expect(chips.some((n) => /\.pdf$/i.test(n))).toBe(true);
  await page.goto(`/mail/search/${encodeURIComponent('filename:no-such-file-zz.xyz')}`);
  await expect(page.getByText('No messages matched your search.')).toBeVisible();
});

test('admin console on a phone: headers wrap their actions, DNS records are readable cards', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await login(page);
  await page.goto('/admin/users');
  await page.getByText('Bob Builder').click();
  const email = page.locator('.adm-head__email');
  await expect(email).toHaveText('bob@dev.test');
  expect((await email.boundingBox())!.width).toBeGreaterThan(80);
  expect((await email.boundingBox())!.height).toBeLessThan(30); // one line, not a letter per line
  await page.goto('/admin/domains');
  await page.getByRole('link', { name: 'dev.test' }).or(page.getByText('dev.test', { exact: true })).first().click();
  const value = page.locator('.adm-records__value').first();
  await expect(value).toBeVisible();
  expect((await value.boundingBox())!.width).toBeGreaterThan(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await ctx.close();
});

test('Gmail keyboard shortcuts: j/k, x, s, e + z (undo), g then t / g then i, Shift+u', async ({ page }) => {
  await login(page);
  const t = token();
  const ids = await createEmails(page, [
    { subject: `Kbd older ${t}`, receivedAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), seen: true },
    { subject: `Kbd newest ${t}`, receivedAt: new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), seen: true },
  ]);
  try {
    await page.goto('/mail/inbox');
    const rows = page.locator('.row');
    await expect(rows.first()).toContainText(`Kbd newest ${t}`);
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveClass(/row--cursor/);
    await page.keyboard.press('k');
    await expect(rows.first()).toHaveClass(/row--cursor/);
    await page.keyboard.press('x');
    await expect(rows.first()).toHaveClass(/row--selected/);
    await page.keyboard.press('s');
    await expect(rows.first().locator('.row__star')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('e');
    await expect(page.locator('.row', { hasText: `Kbd newest ${t}` })).toHaveCount(0);
    await page.keyboard.press('z');
    await expect(page.locator('.row', { hasText: `Kbd newest ${t}` })).toHaveCount(1);
    // Open with Enter, mark unread with Shift+u (returns to the list), navigate with g-sequences.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/mail\/inbox\/.+/);
    await expect(page.locator('.conv__subject-text')).toContainText(`Kbd newest ${t}`);
    await page.keyboard.press('Shift+U');
    await expect(page).toHaveURL(/\/mail\/inbox$/);
    await expect(page.locator('.row', { hasText: `Kbd newest ${t}` })).toHaveClass(/row--unread/);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/mail\/sent$/);
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/mail\/inbox$/);
  } finally {
    await destroyEmails(page, ids);
  }
});

test('mail server errors show a retryable error state instead of an empty list', async ({ page }) => {
  await login(page);
  await expect(page.locator('.row').first()).toBeVisible();
  let failing = true;
  await page.route('**/jmap/', async (route) => {
    const body = route.request().postData() ?? '';
    if (failing && body.includes('Email/query')) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"Mail server unavailable"}' });
    return route.continue();
  });
  await page.goto('/mail/starred');
  await expect(page.getByText("Couldn't load conversations.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('No starred messages.')).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.getByText("Couldn't load conversations.")).toHaveCount(0);
});
