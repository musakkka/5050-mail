/**
 * Walkthrough against a REAL local send server (Postgres + 5050-dev Stalwart + fake
 * Cloudflare transport). Skipped unless REAL_BASE_URL is set:
 *
 *   cd send && CLOUDFLARE_FAKE=1 WORKER_INLINE=1 npx tsx src/index.ts      (serves send/web/dist)
 *   REAL_BASE_URL=http://localhost:3000 REAL_EMAIL=alice@dev.test REAL_PASSWORD=… npx playwright test real
 *
 * Seeds a team, domain, API key, email, webhook, contact, segment, topic, property,
 * template, broadcast, automation and event, then visits every page and the first
 * detail page of each list, failing on console errors or unexpected 5xx responses.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.REAL_BASE_URL ?? '';
const EMAIL = process.env.REAL_EMAIL ?? 'alice@dev.test';
const PASSWORD = process.env.REAL_PASSWORD ?? '';
const H = { 'X-Requested-With': 'e2e', 'Content-Type': 'application/json' };

test.skip(!BASE || !PASSWORD, 'REAL_BASE_URL / REAL_PASSWORD not set');
test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

let teamId = '';

async function api(req: APIRequestContext, method: string, path: string, data?: unknown) {
  const r = await req.fetch(`${BASE}/api/internal${path}`, { method, headers: H, data: data === undefined ? undefined : JSON.stringify(data) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status(), body };
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('seed through the dashboard API', async ({ page }) => {
  await login(page);
  const req = page.request;
  const me = await api(req, 'GET', '/me');
  expect(me.status).toBe(200);
  let team = (me.body.teams as { id: string; name: string }[]).find((t) => t.name === 'e2e-walkthrough');
  if (!team) {
    const c = await api(req, 'POST', '/teams', { name: 'e2e-walkthrough' });
    expect(c.status).toBe(201);
    team = c.body;
    await api(req, 'POST', `/teams/${team!.id}/members`, { email: EMAIL, role: 'admin' });
  }
  teamId = team!.id;
  const rs = (p: string) => `/teams/${teamId}/resend${p}`;
  const domains = await api(req, 'GET', rs('/domains'));
  let domain = (domains.body.data ?? []).find((d: { name: string }) => d.name === 'walkthrough.example.com');
  if (!domain) domain = (await api(req, 'POST', rs('/domains'), { name: 'walkthrough.example.com' })).body;
  expect(domain.id).toBeTruthy();
  const key = await api(req, 'POST', rs('/api-keys'), { name: 'walkthrough', permission: 'full_access' });
  expect(key.status).toBe(201);
  // An email through the public API with the new key (verification may be pending; any 2xx/4xx is fine).
  await req.fetch(`${BASE}/v/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.body.token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify({ from: 'Walkthrough <hi@walkthrough.example.com>', to: ['delivered@example.com'], subject: 'Walkthrough', html: '<p>Hello</p>' }),
  });
  await api(req, 'POST', rs('/webhooks'), { endpoint: 'https://hooks.example.com/walkthrough', events: ['email.sent', 'email.delivered'] });
  await api(req, 'POST', rs('/contacts'), { email: 'walker@example.com', first_name: 'Walk', last_name: 'Through' });
  await api(req, 'POST', rs('/segments'), { name: 'Walkthrough segment' });
  await api(req, 'POST', rs('/topics'), { name: 'Walkthrough topic', default_subscription: 'opt_in' });
  await api(req, 'POST', rs('/contact-properties'), { key: 'walk_company', type: 'string' });
  await api(req, 'POST', rs('/templates'), { name: 'Walkthrough template', html: '<p>Hi {{{NAME}}}</p>', variables: [{ key: 'NAME', type: 'string', fallback_value: 'there' }] });
  await api(req, 'POST', rs('/broadcasts'), { name: 'Walkthrough broadcast', from: 'hi@walkthrough.example.com', subject: 'Hi', html: '<p>Hi</p>' });
  await api(req, 'POST', rs('/events'), { name: 'walkthrough.event' });
  await api(req, 'POST', rs('/automations'), { name: 'Walkthrough automation' });
});

const PAGES = [
  '/emails', '/emails/receiving', '/emails/suppressions', '/templates', '/audience', '/audience/segments', '/audience/topics', '/audience/properties',
  '/inboxes', '/broadcasts', '/automations', '/automations/events', '/metrics', '/domains', '/domains/add', '/logs', '/api-keys', '/webhooks',
  '/settings/usage', '/settings/billing', '/settings/team', '/settings/team?tab=authorized-apps', '/settings/smtp', '/settings/integrations',
  '/settings/integrations/mcp', '/settings/unsubscribe-page', '/settings/documents', '/settings/labs', '/onboarding',
];
const DETAIL_LISTS = ['/emails', '/domains', '/api-keys', '/webhooks', '/logs', '/templates', '/broadcasts', '/automations', '/audience'];

test('every page and first detail page render without console errors or 5xx', async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()} pageerror ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Blocked script execution in 'about:srcdoc'/.test(m.text())) errors.push(`${page.url()} console ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 401) errors.push(`${page.url()} ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await login(page);
  await page.evaluate((id) => localStorage.setItem('send.team', id), teamId);
  for (const p of PAGES) {
    await page.goto(p);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    const alert = await page.getByText("Couldn't load this page").count();
    if (alert) errors.push(`${p} shows an error state`);
  }
  for (const p of DETAIL_LISTS) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    const prefix = p === '/audience' ? '/audience/contacts/' : `${p}/`;
    const link = page.locator(`main a[href^="${prefix}"]:not([aria-hidden]):not([href$="/add"])`).first();
    if (await link.count()) {
      const href = (await link.getAttribute('href'))!;
      await link.click();
      await page.waitForURL((u) => u.pathname === href);
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      // Editors with live previews may keep the network busy; settle briefly instead of networkidle.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
  }
  expect(errors).toEqual([]);
});

test('onboarding: API key then first send from a verified domain', async ({ page }) => {
  await login(page);
  const me = await api(page.request, 'GET', '/me');
  const teams = me.body.teams as { id: string; name: string }[];
  // A team with a verified domain (verify/serve.ts seeds "Team A" with verified domains).
  let target: string | null = null;
  for (const t of teams) {
    const d = await api(page.request, 'GET', `/teams/${t.id}/resend/domains`);
    if ((d.body.data ?? []).some((x: { status: string }) => x.status === 'verified')) {
      target = t.id;
      break;
    }
  }
  test.skip(!target, 'no team with a verified domain');
  await page.evaluate((id) => localStorage.setItem('send.team', id), target!);
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Add API Key' }).click();
  await expect(page.getByLabel('Your new API key')).toHaveValue(/^re_/);
  await page.getByRole('button', { name: 'Send email' }).click();
  await page.getByRole('link', { name: /View the email/ }).click();
  await expect(page).toHaveURL(/\/emails\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
});
