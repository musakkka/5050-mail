import { expect, test, type Page } from '@playwright/test';
import { ALICE, findEmails, jmap, login, roleIds } from './helpers';

/** Compose behaviours: undo send, schedule send + cancel, signatures. Local Stalwart, see README. */
test.describe.configure({ timeout: 150_000 });

const BOB = { email: 'bob@dev.test', password: 'Demo-Bob-Granite-2026' };
const token = () => `cz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function compose(page: Page, to: string, subject: string, body: string) {
  await page.getByRole('button', { name: 'Compose' }).first().click();
  const win = page.locator('.compose--docked').last();
  await win.getByLabel('To recipients').fill(to);
  await win.getByLabel('To recipients').press('Enter');
  await win.getByLabel('Subject').fill(subject);
  await win.locator('.compose__editor .editor').first().click();
  await page.keyboard.type(body);
  return win;
}

async function cleanup(page: Page, t: string) {
  const ids = (await findEmails(page, t)).map((e) => e.id);
  if (ids.length) await jmap(page, [['Email/set', { destroy: ids }, 'd']]);
}

test('undo send cancels delivery and reopens the message', async ({ page, browser }) => {
  await login(page, ALICE, { settings: { undoSendSeconds: 10 } });
  const t = token();
  try {
    const win = await compose(page, BOB.email, `Undo me ${t}`, `Do not deliver ${t}`);
    await win.locator('.send-split__main').click();
    await expect(win).toBeHidden();
    const snack = page.locator('.snackbar', { hasText: 'Message sent.' });
    await snack.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.snackbar')).toContainText('Sending undone.');
    const again = page.locator('.compose--docked').last();
    await expect(again.getByLabel('Subject')).toHaveValue(`Undo me ${t}`);
    // Back in Drafts, not in Sent.
    const roles = await roleIds(page);
    const [mine] = await findEmails(page, t);
    expect(mine!.mailboxIds).toEqual({ [roles.drafts!]: true });
    // And Bob never gets it, even after the hold would have expired.
    await page.waitForTimeout(13_000);
    const ctx = await browser.newContext();
    const bob = await ctx.newPage();
    await login(bob, BOB);
    expect(await findEmails(bob, t)).toEqual([]);
    await ctx.close();
    await again.getByRole('button', { name: /Discard draft/ }).click();
  } finally {
    await cleanup(page, t);
  }
});

test('schedule send lands in Scheduled with a banner; Cancel send turns it back into a draft', async ({ page }) => {
  await login(page);
  const t = token();
  try {
    const win = await compose(page, BOB.email, `Later ${t}`, `Scheduled body ${t}`);
    await win.getByRole('button', { name: 'More send options' }).click();
    await page.getByRole('menuitem', { name: 'Schedule send' }).click();
    const dlg = page.getByRole('dialog', { name: 'Schedule send' });
    await dlg.locator('.schedule-opt').first().click();
    await expect(page.locator('.snackbar')).toContainText('Send scheduled for');
    await page.goto('/mail/scheduled');
    await page.locator('.row', { hasText: t }).click();
    await expect(page.locator('.scheduled-banner, .conv').getByText(/Send scheduled for/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel send' }).click();
    await expect(page.locator('.snackbar')).toContainText(/now a draft/);
    const roles = await roleIds(page);
    await expect.poll(async () => (await findEmails(page, t))[0]?.mailboxIds).toEqual({ [roles.drafts!]: true });
  } finally {
    await cleanup(page, t);
  }
});

test('signature: added to new messages and replies above the quote; an untouched composer leaves no draft', async ({ page }) => {
  await login(page);
  const t = token();
  const [, [, ids]] = await jmap(
    page,
    [
      ['Identity/get', {}, 'g'],
      ['Identity/get', {}, 'g2'],
    ],
    ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
  );
  const identity = (ids.list as { id: string; email: string; htmlSignature: string; textSignature: string }[]).find((i) => i.email === ALICE.email)!;
  const setSig = (html: string, text: string) =>
    jmap(page, [['Identity/set', { update: { [identity.id]: { htmlSignature: html, textSignature: text } } }, 's']], [
      'urn:ietf:params:jmap:core',
      'urn:ietf:params:jmap:mail',
      'urn:ietf:params:jmap:submission',
    ]);
  await setSig(`<b>Alice</b> ${t}`, `Alice ${t}`);
  try {
    await page.reload();
    const roles = await roleIds(page);
    const draftsBefore = (await jmap(page, [['Email/query', { filter: { inMailbox: roles.drafts } }, 'q']]))[0]![1].ids.length;
    await page.getByRole('button', { name: 'Compose' }).first().click();
    const win = page.locator('.compose--docked').last();
    await expect(win.locator('.ff_signature')).toContainText(`Alice ${t}`);
    await page.waitForTimeout(3_000); // longer than the 2 s autosave debounce
    await win.getByRole('button', { name: 'Save & close' }).click();
    await page.waitForTimeout(1_000);
    expect((await jmap(page, [['Email/query', { filter: { inMailbox: roles.drafts } }, 'q']]))[0]![1].ids.length).toBe(draftsBefore);
    // Reply: signature sits above the (trimmed) quote.
    await page.locator('.row').first().click();
    await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
    const inline = page.locator('.compose--inline');
    await expect(inline.locator('.compose__editor').first().locator('.ff_signature')).toContainText(`Alice ${t}`);
    await expect(inline.getByRole('button', { name: 'Show trimmed content' })).toBeVisible();
    await inline.getByRole('button', { name: /Discard draft/ }).click();
  } finally {
    await setSig(identity.htmlSignature ?? '', identity.textSignature ?? '');
  }
});
