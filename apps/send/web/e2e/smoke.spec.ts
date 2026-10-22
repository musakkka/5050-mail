import { test, expect } from '@playwright/test';
import { open, trackErrors, noHorizontalScroll } from './helpers';

const PAGES: [string, RegExp][] = [
  ['/emails', /Emails/],
  ['/emails/receiving', /Emails/],
  ['/emails/suppressions', /Suppressions/],
  ['/templates', /Templates/],
  ['/audience', /Audience|Contacts/],
  ['/audience/segments', /Audience|Segments/],
  ['/audience/topics', /Audience|Topics/],
  ['/audience/properties', /Audience|Properties/],
  ['/inboxes', /Inboxes/],
  ['/broadcasts', /Broadcasts/],
  ['/automations', /Automations/],
  ['/automations/events', /Automations|Events/],
  ['/metrics', /Metrics/],
  ['/domains', /Domains/],
  ['/domains/add', /domain/i],
  ['/logs', /Logs/],
  ['/api-keys', /API keys/],
  ['/webhooks', /Webhooks/],
  ['/settings/usage', /Settings|Usage/],
  ['/settings/billing', /Settings|Billing/],
  ['/settings/team', /Settings|Team/],
  ['/settings/smtp', /Settings|SMTP/],
  ['/settings/integrations', /Settings|Integrations/],
  ['/settings/integrations/mcp', /MCP/],
  ['/settings/unsubscribe-page', /Settings|Unsubscribe/],
  ['/settings/documents', /Settings|Documents/],
  ['/settings/labs', /Settings|Labs/],
  ['/onboarding', /first email/i],
];

for (const [path, heading] of PAGES) {
  test(`renders ${path} without errors or horizontal scroll`, async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(heading);
    await page.waitForLoadState('networkidle');
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });
}

for (const [w, h] of [[1280, 800], [1024, 768], [390, 844]] as const) {
  test(`${w}px: every page fits without horizontal page scroll`, async ({ page }) => {
    // ~30 page loads; generous so a busy machine doesn't turn it into a flake.
    test.setTimeout(360_000);
    await page.setViewportSize({ width: w, height: h });
    for (const [path] of PAGES) {
      await open(page, path);
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.waitForLoadState('networkidle');
      await noHorizontalScroll(page);
    }
  });
}

test('mobile 390px: pages fit and the menu opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/emails', '/domains', '/api-keys', '/metrics', '/settings/team', '/logs']) {
    await open(page, path);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    await noHorizontalScroll(page);
  }
  await page.getByRole('button', { name: 'menu' }).click();
  await page.locator('#mobile-menu').getByRole('link', { name: 'Webhooks' }).click();
  await expect(page).toHaveURL(/\/webhooks$/);
});

test('signed-out users go to login and come back after signing in', async ({ page }) => {
  await open(page, '/domains', 'signedout');
  await expect(page).toHaveURL(/\/login\?next=%2Fdomains/);
  await page.getByLabel('Email').fill('ada@northwind.dev');
  await page.getByLabel('Password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong email or password');
  await page.getByLabel('Password', { exact: true }).fill('correct horse');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/domains$/);
});

test('loading, empty and error states', async ({ page }) => {
  await open(page, '/webhooks', 'empty');
  await expect(page.getByText('No webhooks yet')).toBeVisible();
  await open(page, '/emails', 'error');
  await expect(page.getByRole('alert')).toContainText('mock error scenario', { timeout: 15_000 });
  await open(page, '/emails', 'slow');
  await expect(page.locator('[aria-busy="true"], .animate-pulse').first()).toBeVisible();
});

test('team switcher, ⌘K palette and keyboard shortcuts', async ({ page }) => {
  await open(page, '/emails');
  await page.locator('aside').getByRole('button', { name: /^Team:/ }).click();
  await page.getByRole('menuitem', { name: 'northwind-staging' }).click();
  await expect(page.locator('aside').getByRole('button', { name: /^Team:/ })).toContainText('northwind-staging');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Ask anything' }).fill('domains');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/domains$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/\/api-keys$/);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('emails filters drive the URL and the list', async ({ page }) => {
  await open(page, '/emails');
  await page.getByRole('button', { name: 'All Statuses' }).click();
  await page.getByRole('menuitem', { name: 'Bounced' }).click();
  await expect(page).toHaveURL(/status=bounced/);
  const badges = page.locator('tbody span.capitalize');
  await expect(badges.first()).toHaveText('bounced');
  await page.getByRole('textbox', { name: 'Search' }).fill('zzzz-nothing');
  await expect(page.getByText('No emails found')).toBeVisible();
});
