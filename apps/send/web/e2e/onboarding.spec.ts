import { test, expect } from '@playwright/test';
import { open, trackErrors, noHorizontalScroll } from './helpers';

test('brand-new admin: create team → add domain → verify → API key → first send', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, '/emails', 'newadmin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your team');
  const name = page.getByLabel('Team name');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('northwind');
  await name.fill('');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a team name');
  await name.fill('Northwind');
  await page.getByRole('button', { name: 'Create team' }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Send your first email');
  await expect(page.getByRole('heading', { name: 'Add a domain' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send email' })).toBeDisabled();

  const domain = page.getByLabel('Domain', { exact: true });
  await domain.fill('not a domain');
  await page.getByRole('button', { name: 'Add domain' }).first().click();
  await expect(page.getByRole('alert')).toContainText('Enter a domain you own');
  await domain.fill('https://Updates.Northwind.dev/');
  await page.getByRole('button', { name: 'Add domain' }).first().click();
  await expect(page.getByText('updates.northwind.dev', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View DNS records' })).toHaveAttribute('href', /\/domains\/.+\?from=onboarding/);

  await page.getByRole('button', { name: 'Verify DNS records' }).click();
  await expect(page.getByText('Ready to send')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Add API Key' }).click();
  await expect(page.getByLabel('Your new API key')).toHaveValue(/^re_/);
  const send = page.getByRole('button', { name: 'Send email' });
  await expect(send).toBeEnabled();
  await expect(page.locator('pre, code').filter({ hasText: 'onboarding@updates.northwind.dev' }).first()).toBeVisible();
  await send.click();
  await page.getByRole('link', { name: /View the email/ }).click();
  await expect(page).toHaveURL(/\/emails\/[0-9a-f-]{36}$/);
  expect(errors).toEqual([]);
});

test('first-team screen and onboarding fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/emails', 'newadmin');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your team');
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Send your first email');
  await page.getByLabel('Domain', { exact: true }).fill('a-very-long-subdomain-name-for-testing.updates.some-long-company-name.example.com');
  await page.getByRole('button', { name: 'Add domain' }).first().click();
  await expect(page.getByText('Add the DNS records at your DNS provider')).toBeVisible();
  await noHorizontalScroll(page);
});
