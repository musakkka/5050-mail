/**
 * Capture reference screenshots at 1440×900 into web/screenshots/.
 *   BASE_URL=http://localhost:3000 npm run screenshots
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const USER = process.env.MAIL_USER ?? 'alice@dev.test';
const PASS = process.env.MAIL_PASS ?? 'Demo-Alice-Orchid-2026';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const only = process.argv[2];

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.row', { timeout: 20_000 });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  if (!only || only === 'login') {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('.login__card');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}login.png` });
    console.log('saved login.png');
  }
  await login(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const shot = async (name: string) => {
    if (only && only !== name) return;
    await page.mouse.move(1430, 890);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}${name}.png` });
    console.log(`saved ${name}.png`);
  };
  await shot('inbox');

  // thread: open the first multi-message conversation if possible
  const rows = page.locator('.row');
  const withCount = page.locator('.row:has(.row__count)').first();
  await ((await withCount.count()) ? withCount : rows.first()).click();
  await page.waitForSelector('.msg--expanded', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot('thread');

  // compose
  await page.goto(`${BASE}/mail/inbox`);
  await page.waitForSelector('.row');
  await page.getByRole('button', { name: 'Compose' }).first().click();
  await page.waitForSelector('.compose--docked');
  await page.getByLabel('To recipients').fill('bob');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.getByLabel('Subject').fill('Lunch on Thursday?');
  await page.locator('.compose__editor .editor').click();
  await page.keyboard.type('Hi Bob,\n\nAre you free for lunch on Thursday? The new ramen place opened last week.\n\nAlice');
  await page.waitForTimeout(300);
  await shot('compose');
  // close compose without leaving a draft around
  await page.getByRole('button', { name: /Discard draft/ }).click();
  await page.waitForTimeout(500);

  // dark mode
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('ff:settings:'));
    const v = JSON.parse((k && localStorage.getItem(k)) || '{}');
    v.theme = 'dark';
    localStorage.setItem(k ?? 'ff:settings:alice@dev.test', JSON.stringify(v));
  });
  await page.reload();
  await page.waitForSelector('.row');
  await page.waitForTimeout(800);
  await shot('inbox-dark');
  await page.locator('.row').nth(2).click();
  await page.waitForSelector('.msg--expanded');
  await page.waitForTimeout(1200);
  await shot('thread-dark');
  // restore light
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('ff:settings:'));
    if (!k) return;
    const v = JSON.parse(localStorage.getItem(k) || '{}');
    v.theme = 'light';
    localStorage.setItem(k, JSON.stringify(v));
  });
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
