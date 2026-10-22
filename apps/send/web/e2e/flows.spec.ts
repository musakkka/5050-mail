import { test, expect } from '@playwright/test';
import { open, trackErrors, noHorizontalScroll } from './helpers';

test('create an API key: ⌘↩ submits, token shown once with copy', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '/api-keys');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add API Key' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Name')).toBeFocused();
  await dlg.getByLabel('Name').fill('E2E key');
  await page.keyboard.press('ControlOrMeta+Enter');
  const view = page.getByRole('dialog', { name: 'View API Key' });
  await expect(view).toBeVisible();
  await expect(view.locator('#new-token')).toHaveValue(/^re_[A-Za-z0-9]{8}_/);
  await expect(view.getByRole('button', { name: /copy/i }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tbody')).toContainText('E2E key');
  // the full token is never listed
  await expect(page.locator('tbody')).not.toContainText(/re_[A-Za-z0-9]{8}_[A-Za-z0-9]{10}/);
  expect(errors).toEqual([]);
});

test('dialog: Esc closes, focus is trapped, page scroll locked', async ({ page }) => {
  await open(page, '/webhooks');
  await page.getByRole('button', { name: 'Add webhook' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add webhook' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Endpoint URL')).toBeFocused();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflow + getComputedStyle(document.body).overflow))
    .toContain('hidden');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('add a webhook end to end', async ({ page }) => {
  await open(page, '/webhooks');
  await page.getByRole('button', { name: 'Add webhook' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Add webhook' });
  await dlg.getByLabel('Endpoint URL').fill('https://hooks.example.com/e2e');
  await dlg.getByRole('combobox').click();
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.keyboard.press('Escape');
  await dlg.getByRole('button', { name: /^Add/ }).click();
  await expect(page.getByRole('dialog', { name: 'Add webhook' })).toHaveCount(0);
  await expect(page.getByText('hooks.example.com/e2e').first()).toBeVisible();
});

test('dialogs fit a 390px screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page, '/api-keys');
  await page.getByRole('button', { name: /Create API key/ }).first().click();
  const box = await page.getByRole('dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
});

test('row menus inside tables are not clipped near the viewport edge', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await open(page, '/emails');
  const btn = page.getByRole('button', { name: 'More actions' }).last();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const b = (await menu.boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(1024);
  expect(b.y + b.height).toBeLessThanOrEqual(600);
  expect(b.y).toBeGreaterThanOrEqual(0);
});

test('email detail: tabs and sandboxed preview', async ({ page }) => {
  await open(page, '/emails');
  await page.locator('tbody a[href^="/emails/"]:not([aria-hidden])').first().click();
  const frame = page.locator('iframe').first();
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  await page.getByRole('tab', { name: 'Plain Text' }).click();
  await page.getByRole('tab', { name: 'Raw' }).click();
  await page.getByRole('tab', { name: 'Insights' }).click();
  await expect(page).toHaveURL(/tab=insights/);
});

test('domain add validates and navigates to the new domain', async ({ page }) => {
  await open(page, '/domains/add');
  const input = page.getByRole('textbox').first();
  await input.fill('e2e-example.com');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/domains\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('e2e-example.com');
});

test('keyboard: skip link moves focus to the page content', async ({ page }) => {
  await open(page, '/domains');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('long values: a long domain and long email detail fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/domains');
  await page.locator('main a[href^="/domains/"]', { hasText: 'contoso' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('contoso');
  await noHorizontalScroll(page);
  const h1 = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(h1!.x).toBeGreaterThanOrEqual(0);
  expect(h1!.x + h1!.width).toBeLessThanOrEqual(390);
  await open(page, '/emails/suppressions');
  await page.locator('tbody a[href^="/emails/suppressions/"]:not([aria-hidden])').first().click();
  const s = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(s!.x).toBeGreaterThanOrEqual(0);
  expect(s!.x + s!.width).toBeLessThanOrEqual(390);
});
