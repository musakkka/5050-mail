/**
 * Drives the local demo stack (see stack/up.sh) through the storyboard and records it.
 *
 *   MAIL_URL=http://localhost:3100 SEND_URL=http://localhost:3200 OUT=.work/capture npx tsx record.ts
 *
 * Output: $OUT/capture.json (frames + events) and $OUT/frames/*.jpg. compose.py turns that into video.
 */
import fs from 'node:fs';
import { chromium, type Page, type Route } from 'playwright';
import { Recorder, VH, VW, DSF } from './lib/recorder.ts';

const MAIL = process.env.MAIL_URL ?? 'http://localhost:3100';
const SEND = process.env.SEND_URL ?? 'http://localhost:3200';
const OUT = process.env.OUT ?? '.work/capture';
const K = Number(process.env.DEMO_SLOW ?? 3);
const ONLY = process.env.ONLY?.split(',');
const USER = { email: 'maya@acme.test', password: 'Demo-Maya-Lantern-2026' };
const NEW_DOMAIN = 'example.com';

fs.rmSync(OUT, { recursive: true, force: true });
const rec = new Recorder(OUT, K);
const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await rec.attach(page);

// Hide hover tooltips and text carets' blink noise; nothing else about the apps is changed.
const POLISH_CSS = `
  .tooltip, [role="tooltip"], .gm-tooltip { display: none !important; }
  .list-footer__links { visibility: hidden !important; }
  * { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; }
`;
await context.addInitScript((css) => {
  const add = () => {
    const s = document.createElement('style');
    s.dataset.demo = '1';
    s.textContent = css;
    document.head.appendChild(s);
  };
  if (document.head) add();
  else document.addEventListener('DOMContentLoaded', add);
}, POLISH_CSS);

const want = (s: string) => !ONLY || ONLY.includes(s);

// ------------------------------------------------------------------ one-click DNS mock
/**
 * Locally there is no real Cloudflare or ACME, so the setup checklist would never finish.
 * During the "add a domain" step we let the real calls through and only rewrite the status the UI
 * polls for (records present → DKIM active → certificate issued), revealed over a few seconds.
 */
const connect = { active: false, start: 0 };
const stage = () => (connect.active ? ((Date.now() / 1000 - connect.start) / K) : -1);
async function jmapMock(route: Route) {
  if (!connect.active || route.request().method() !== 'POST') return route.continue();
  const res = await route.fetch();
  let body = await res.text();
  try {
    const json = JSON.parse(body) as { methodResponses: [string, Record<string, unknown>, string][] };
    const s = stage();
    for (const [name, args] of json.methodResponses) {
      if (name === 'x:Task/get') args.list = [];
      if (name === 'x:Domain/get')
        for (const d of args.list as { name: string; certificateManagement?: unknown }[]) if (d.name === NEW_DOMAIN) d.certificateManagement = { '@type': 'Automatic' };
      if (name === 'x:DkimSignature/get' && s > 1.2) for (const k of args.list as { stage: string }[]) k.stage = 'active';
      if (name === 'x:Certificate/get' && s > 3.0) {
        const now = Date.now();
        (args.list as unknown[]).push({
          id: 'demo-cert',
          subjectAlternativeNames: { [NEW_DOMAIN]: true, [`mail.${NEW_DOMAIN}`]: true },
          notValidBefore: new Date(now - 60_000).toISOString(),
          notValidAfter: new Date(now + 89 * 86400_000).toISOString(),
          issuer: "Let's Encrypt",
        });
      }
    }
    body = JSON.stringify(json);
  } catch {
    /* not JSON: pass through */
  }
  return route.fulfill({ response: res, body });
}
async function statusMock(route: Route) {
  if (!connect.active) return route.continue();
  const res = await route.fetch();
  const json = (await res.json()) as { stalwartRecords?: { present: boolean }[] };
  if (stage() > 0.7) for (const r of json.stalwartRecords ?? []) r.present = true;
  return route.fulfill({ response: res, body: JSON.stringify(json) });
}

async function settle(p: Page) {
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await p.waitForTimeout(300);
}

await rec.startCapture();

// ================================================================== 5050 Mail
if (want('mail')) {
  await page.goto(`${MAIL}/login`);
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/mail\/inbox/);
  // warm the search index so the on-camera search answers instantly
  await page.goto(`${MAIL}/mail/search/invoice`);
  await page.getByText('Invoice INV-1042 for October').first().waitFor({ timeout: 30_000 });
  await page.goto(`${MAIL}/mail/inbox`);
  await page.getByText('Launch plan for the new pricing page').first().waitFor();
  await settle(page);
  rec.pos = { x: 760, y: 470 };
  await page.mouse.move(rec.pos.x, rec.pos.y);
  await rec.wait(0.3);

  rec.clip('mail');
  await rec.wait(1.0);
  // open a thread
  const row = page.getByText('Launch plan for the new pricing page').first();
  await rec.click(row);
  await rec.wait(0.1);
  rec.log('cutStart'); // skip the thread's loading frame
  await page.getByRole('heading', { name: 'Launch plan for the new pricing page' }).waitFor();
  await page.getByText('pricing-launch-plan.pdf').last().waitFor();
  await page.waitForTimeout(300);
  rec.log('cutEnd');
  rec.cam(1.32, { x: 660, y: 330 }, 1.0);
  await rec.wait(2.0);
  rec.cam(1, undefined, 0.9);
  await rec.wait(0.4);

  // compose & send
  await rec.click(page.getByRole('button', { name: 'Compose' }));
  const compose = page.locator('.compose[role=dialog]').first();
  await compose.waitFor();
  await rec.wait(0.4);
  const cbox = await compose.boundingBox();
  rec.cam(1.45, { x: cbox!.x + cbox!.width / 2, y: cbox!.y + 200 }, 1.0);
  await rec.click(compose.getByLabel('To recipients'));
  await rec.type('jordan@acme.test', 22);
  await page.keyboard.press('Tab');
  await rec.wait(0.25);
  await rec.click(compose.getByLabel('Subject'));
  await rec.type('Pricing page is live', 22);
  await rec.click(compose.getByLabel('Message Body'), { fy: 0.15 });
  await rec.type('Hi Jordan,\n\nThe new pricing page is live. Thanks for the help!\n\nMaya', 30);
  await rec.wait(0.3);
  const cb = await compose.boundingBox();
  rec.cam(1.3, { x: cb!.x + cb!.width / 2, y: cb!.y + cb!.height - 120 }, 0.7);
  await rec.wait(0.3);
  await rec.click(compose.getByRole('button', { name: 'Send', exact: true }));
  await page.getByText('Message sent').first().waitFor().catch(() => undefined);
  rec.cam(1, undefined, 0.9);
  await rec.wait(1.2);

  // search
  await rec.click(page.getByPlaceholder('Search mail'), { fx: 0.2 });
  await rec.type('invoice', 12);
  await rec.wait(0.2);
  await page.keyboard.press('Enter');
  await page.getByText('Invoice INV-1042 for October').first().waitFor();
  await rec.wait(0.3);
  rec.cam(1.28, { x: 760, y: 220 }, 0.9);
  await rec.wait(1.8);
  rec.cam(1, undefined, 0.8);

  // labels
  await rec.click(page.getByRole('link', { name: /^Clients/ }).first());
  await rec.wait(0.5);
  rec.cam(1.22, { x: 560, y: 260 }, 0.9);
  await rec.wait(1.8);
  rec.cam(1, undefined, 0.8);
  await rec.wait(0.6);
  await rec.hover(page.getByRole('link', { name: 'Admin console' }));
  await rec.wait(0.3);
  rec.endClip();
}

// ================================================================== Admin console
if (want('admin')) {
  if (!page.url().startsWith(MAIL)) {
    await page.goto(`${MAIL}/login`);
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password', { exact: true }).fill(USER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/mail\//);
  }
  await page.route('**/jmap/', jmapMock);
  await page.route('**/api/admin/cloudflare/domain-status**', statusMock);
  await page.goto(`${MAIL}/admin/domains`);
  await page.getByRole('heading', { name: 'Domains' }).first().waitFor();
  await settle(page);
  // open the dialog once off camera so the Cloudflare zones are cached (no layout jump on camera)
  await page.getByRole('button', { name: 'Add a domain' }).first().click();
  await page.getByRole('dialog', { name: 'Add a domain' }).getByLabel(/Domain on Cloudflare/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Add a domain' }).waitFor({ state: 'hidden' });
  await page.waitForTimeout(500);
  rec.pos = { x: 900, y: 400 };
  await page.mouse.move(rec.pos.x, rec.pos.y);

  rec.clip('admin');
  await rec.wait(0.8);
  await rec.click(page.getByRole('button', { name: 'Add a domain' }).first());
  const add = page.getByRole('dialog', { name: 'Add a domain' });
  await add.waitFor();
  await rec.wait(0.3);
  const ab = await add.boundingBox();
  rec.cam(1.3, { x: ab!.x + ab!.width / 2, y: ab!.y + ab!.height / 2 - 20 }, 1.0);
  await rec.click(add.getByLabel('Domain name'));
  await rec.type(NEW_DOMAIN, 13);
  await rec.wait(0.5);
  connect.active = true;
  connect.start = Date.now() / 1000;
  await rec.click(add.getByRole('button', { name: 'Add & connect' }));
  const progress = page.getByRole('dialog', { name: `Setting up ${NEW_DOMAIN}` });
  await progress.waitFor();
  const pb = await progress.boundingBox();
  rec.cam(1.3, { x: pb!.x + pb!.width / 2, y: pb!.y + 260 }, 0.8);
  await progress.locator('[data-step="ready"][data-state="done"]').waitFor({ timeout: 60_000 });
  await rec.wait(1.1);
  rec.cam(1, undefined, 0.9);
  await rec.click(progress.getByRole('button', { name: 'Close' }).first());
  connect.active = false;
  await rec.wait(0.6);

  // create a mailbox on the new domain
  await rec.click(page.getByRole('link', { name: 'Users' }));
  await page.getByRole('button', { name: 'Add a user' }).waitFor();
  await rec.wait(0.5);
  await rec.click(page.getByRole('button', { name: 'Add a user' }));
  const user = page.getByRole('dialog', { name: 'Add a user' });
  await user.waitFor();
  await rec.wait(0.3);
  const ub = await user.boundingBox();
  rec.cam(1.3, { x: ub!.x + ub!.width / 2, y: ub!.y + Math.min(ub!.height / 2, 260) }, 1.0);
  await rec.click(user.getByLabel('Name', { exact: true }));
  await rec.type('Alex Kim', 14);
  // the address (alex.kim) and a strong password are filled in automatically; pick the new domain
  await rec.wait(0.3);
  await rec.click(user.getByLabel('Email address domain'));
  await user.getByLabel('Email address domain').selectOption({ label: NEW_DOMAIN });
  await rec.wait(0.5);
  await rec.click(user.getByRole('button', { name: 'Add user' }));
  const created = page.getByRole('dialog', { name: 'User added' });
  await created.waitFor();
  const crb = await created.boundingBox();
  rec.cam(1.3, { x: crb!.x + crb!.width / 2, y: crb!.y + crb!.height / 2 }, 0.8);
  await rec.wait(1.6);
  rec.cam(1, undefined, 0.8);
  await rec.wait(0.5);
  rec.endClip();
  await page.unroute('**/jmap/');
  await page.unroute('**/api/admin/cloudflare/domain-status**');
}

// ================================================================== 5050 Send
let emailId = '';
if (want('send')) {
  await page.goto(`${SEND}/`);
  await page.locator('#email').fill(USER.email);
  await page.locator('#password').fill(USER.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/emails/);
  // prefetch the metrics (cached by the dashboard) and settle on the Emails page
  await page.goto(`${SEND}/metrics`);
  await page.locator('.recharts-surface').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.getByRole('link', { name: 'Emails', exact: true }).first().click();
  await page.locator('a[href^="/emails/"][href*="-"]').first().waitFor();
  await settle(page);
  rec.pos = { x: 820, y: 430 };
  await page.mouse.move(rec.pos.x, rec.pos.y);

  rec.clip('send');
  await rec.wait(1.2);
  // API key
  await rec.click(page.getByRole('link', { name: 'API keys' }));
  await page.getByRole('button', { name: 'Create API key' }).waitFor();
  await rec.wait(0.4);
  await rec.click(page.getByRole('button', { name: 'Create API key' }));
  const kd = page.getByRole('dialog');
  await kd.waitFor();
  await rec.wait(0.3);
  const kdb = await kd.boundingBox();
  rec.cam(1.35, { x: kdb!.x + kdb!.width / 2, y: kdb!.y + kdb!.height / 2 }, 0.9);
  await rec.click(kd.locator('#name'));
  await rec.type('Website', 12);
  await rec.wait(0.2);
  await rec.click(kd.getByRole('button', { name: /^Add/ }));
  const view = page.getByRole('dialog', { name: /View API Key/ });
  await view.waitFor();
  const token = (await view.locator('code, input, [class*=mono]').first().evaluate((e) => (e as HTMLInputElement).value || e.textContent || '')).trim();
  if (!/^re_/.test(token)) throw new Error(`could not read the new API key (${token})`);
  await rec.wait(1.3);
  rec.cam(1, undefined, 0.8);
  await rec.click(view.getByRole('button', { name: /^Done/ }));
  await rec.wait(0.5);

  // webhook
  await rec.click(page.getByRole('link', { name: 'Webhooks' }));
  await page.getByRole('button', { name: 'Add webhook' }).first().waitFor();
  await rec.wait(0.4);
  await rec.click(page.getByRole('button', { name: 'Add webhook' }).first());
  const wd = page.getByRole('dialog');
  await wd.waitFor();
  await rec.wait(0.3);
  const wdb = await wd.boundingBox();
  rec.cam(1.35, { x: wdb!.x + wdb!.width / 2, y: wdb!.y + wdb!.height / 2 }, 0.9);
  await rec.click(wd.locator('#endpoint'));
  await rec.type('https://api.acme.test/webhooks/email', 30);
  await rec.click(wd.locator('#events'));
  await rec.wait(0.4);
  for (const ev of ['email.sent', 'email.delivered']) {
    await rec.click(page.getByText(ev, { exact: true }).first());
    await rec.wait(0.15);
  }
  await page.keyboard.press('Escape');
  await rec.wait(0.4);
  await rec.click(wd.getByRole('button', { name: /^Add/ }));
  await wd.waitFor({ state: 'hidden' });
  rec.cam(1, undefined, 0.8);
  await rec.wait(0.7);

  // terminal: send an email with the new key through the real local API
  const lines = [
    { p: '$ ', s: `export SEND_API_KEY=${token}` },
    { p: '$ ', s: 'curl https://api.send.acme.test/emails \\' },
    { p: '    ', s: '-H "Authorization: Bearer $SEND_API_KEY" \\' },
    { p: '    ', s: '-H "Content-Type: application/json" \\' },
    { p: '    ', s: `-d '{"from":"Acme <hello@acme.test>","to":"jordan@example.com",` },
    { p: '        ', s: `"subject":"Your order has shipped","html":"<p>It is on its way!</p>"}'` },
  ];
  rec.cursorVisible(false);
  rec.term({ open: true, lines: [] });
  // The terminal is drawn by the compositor, so its keystrokes are scheduled ahead instead of typed.
  let at = rec.now() + 0.6 * K;
  const done: { p: string; s: string }[] = [];
  for (const [i, l] of lines.entries()) {
    const due = Recorder.schedule(l.s, i === 0 ? 48 : 80, false);
    for (let c = 1; c <= l.s.length; c++) {
      if (c % 2 && c !== l.s.length) continue;
      rec.logAt(at + due[c - 1]! * K, 'term', { open: true, lines: [...done, { p: l.p, s: l.s.slice(0, c) }], caret: true });
    }
    at += (due.at(-1)! + (i === 0 ? 0.35 : 0.1)) * K;
    done.push(l);
  }
  await page.waitForTimeout((at - rec.now()) * 1000);
  await rec.wait(0.3);
  const r = await fetch(`${SEND}/v/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1' },
    body: JSON.stringify({ from: 'Acme <hello@acme.test>', to: 'jordan@example.com', subject: 'Your order has shipped', html: '<p>It is on its way!</p>' }),
  });
  const out = (await r.json()) as { id?: string };
  emailId = out.id ?? '';
  if (!emailId) throw new Error(`send failed: ${JSON.stringify(out)}`);
  rec.term({ open: true, lines: [...done, { p: '', s: `{"id":"${emailId}"}`, out: true }], caret: false, status: r.status });
  await rec.wait(2.2);
  rec.term({ open: false });
  rec.cursorVisible(true);
  await rec.wait(0.6);

  // the email shows up, delivered
  await rec.click(page.getByRole('link', { name: 'Emails', exact: true }).first());
  const newRow = page.locator(`a[href="/emails/${emailId}"]`).first();
  await newRow.waitFor();
  await page.waitForTimeout(400);
  const rowBox = await newRow.boundingBox();
  rec.cam(1.4, { x: 760, y: rowBox!.y + rowBox!.height / 2 + 40 }, 0.9);
  await rec.wait(1.6);
  await rec.click(newRow);
  await page.waitForURL(new RegExp(emailId));
  // the detail page shows a skeleton while it loads: cut that out of the video
  await rec.wait(0.15);
  rec.log('cutStart');
  await page.getByText('POST /emails').first().waitFor().catch(() => undefined);
  await settle(page);
  rec.log('cutEnd');
  rec.cam(1, undefined, 0.8);
  await rec.wait(1.8);

  // metrics
  await rec.click(page.getByRole('link', { name: 'Metrics' }));
  await page.locator('.recharts-surface').first().waitFor({ timeout: 60_000 });
  await rec.wait(0.4);
  rec.cam(1.18, { x: 840, y: 330 }, 1.2);
  await rec.wait(2.0);
  rec.endClip();
}

await rec.stopCapture();
rec.save({ hosts: { [new URL(MAIL).host]: 'mail.acme.test', [new URL(SEND).host]: 'send.acme.test' }, emailId });
await browser.close();
console.log(`recorded ${rec.frames.length} frames, ${rec.events.length} events → ${OUT}`);
