import { expect, test } from '@playwright/test';

const USER = process.env.MAIL_USER ?? 'alice@dev.test';
const PASS = process.env.MAIL_PASS ?? 'Demo-Alice-Orchid-2026';

test('login → open thread → reply → appears in Sent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Login
  await page.goto('/mail/inbox');
  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveTitle('5050 Mail');
  await expect(page.getByRole('img', { name: '5050 Mail' })).toBeVisible();
  await page.getByLabel('Email').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/mail\/inbox/);
  await expect(page.locator('.row').first()).toBeVisible();
  // Gmail's tab title pattern: "Inbox (3) - user@domain - 5050 Mail".
  await expect(page).toHaveTitle(new RegExp(`^Inbox( \\(\\d+\\))? - ${USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} - 5050 Mail$`));
  await expect(page.getByRole('link', { name: '5050 Mail' })).toBeVisible();

  // The password is never persisted in the browser.
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(storage).not.toContain(PASS);

  // Find a conversation with Bob (local recipient, so the reply is delivered locally).
  await page.getByLabel('Search mail').fill('from:bob@dev.test');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/mail\/search\//);
  const first = page.locator('.row').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('.msg--expanded').last()).toBeVisible();
  const subject = (await page.locator('.conv__subject-text').innerText()).trim();

  // Reply inline.
  const token = `e2e-${Date.now()}`;
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const editor = page.locator('.compose--inline .compose__editor .editor').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(`Thanks Bob! ${token}`);
  await page.locator('.compose--inline .send-split__main').click();
  await expect(page.locator('.snackbar')).toContainText(/Message sent|Sending/);

  // It shows up in Sent.
  await page.goto('/mail/sent');
  const row = page.locator('.row', { hasText: subject.replace(/^(Re:\s*)+/i, '') }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('.conv')).toBeVisible();
  // The newest message (ours) is expanded; its body is in a sandboxed iframe.
  const frame = page.frameLocator('.msg--expanded .msg-body__frame').last();
  await expect(frame.locator('body')).toContainText(token);

  // Sandbox hardening: email bodies never get allow-scripts.
  const sandbox = await page.locator('.msg-body__frame').last().getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-scripts');
  expect(errors).toEqual([]);
});
