import { expect, type Page } from '@playwright/test';

/** Fresh mock state per test: scenario + dark theme, then open `path`. */
export async function open(page: Page, path: string, mock = '') {
  await page.goto('/login');
  await page.evaluate((m) => {
    localStorage.clear();
    localStorage.setItem('send.theme', 'dark');
    localStorage.setItem('send.mock', m);
  }, mock);
  await page.goto(path);
}

/** Fail the test on uncaught page errors / console errors. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // "Blocked script execution in 'about:srcdoc'" comes from Playwright's trace snapshotter
    // probing our script-less sandboxed preview iframes, not from the app.
    if (m.type() === 'error' && !/Failed to load resource|Blocked script execution in 'about:srcdoc'/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

export async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const main = document.querySelector('.scrollContainer');
    const m = main ? main.scrollWidth - main.clientWidth : 0;
    return Math.max(doc, m);
  });
  expect(over, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}
