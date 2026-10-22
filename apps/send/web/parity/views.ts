import type { Page } from '@playwright/test';

export interface View {
  name: string;
  /** Reference screenshot name (resend-capture/shots/<ref>.png). */
  ref?: string;
  path: string;
  mock?: string;
  action?: (page: Page, width: number) => Promise<void>;
  settle?: number;
  desktopOnly?: boolean;
}

const clickFirst = (sel: string) => async (p: Page) => {
  await p.locator(sel).first().click();
  await p.waitForLoadState('networkidle');
};
const clickText = (text: string, role: 'button' | 'tab' | 'link' = 'button') => async (p: Page) => {
  await p.getByRole(role, { name: text }).first().click();
};

export const VIEWS: View[] = [
  { name: 'login', path: '/login', mock: 'signedout' },
  { name: 'emails', ref: 'emails', path: '/emails' },
  { name: 'emails_receiving', ref: 'emails_receiving', path: '/emails/receiving' },
  { name: 'emails_suppressions', ref: 'emails_suppressions', path: '/emails/suppressions' },
  { name: 'emails_receiving-empty', ref: 'emails_receiving', path: '/emails/receiving', mock: 'empty' },
  { name: 'received-detail', path: '/emails/receiving', action: clickFirst('tbody a[href^="/emails/receiving/"]:not([aria-hidden])') },
  { name: 'email-detail', ref: 'email-detail', path: '/emails', action: clickFirst('tbody a[href^="/emails/"]:not([aria-hidden])') },
  { name: 'tab_email-plaintext', ref: 'tab_email-plaintext', path: '/emails', action: async (p) => { await clickFirst('tbody a[href^="/emails/"]:not([aria-hidden])')(p); await clickText('Plain Text', 'tab')(p); } },
  { name: 'tab_email-raw', ref: 'tab_email-raw', path: '/emails', action: async (p) => { await clickFirst('tbody a[href^="/emails/"]:not([aria-hidden])')(p); await clickText('Raw', 'tab')(p); } },
  { name: 'tab_email-insights', ref: 'tab_email-insights', path: '/emails', action: async (p) => { await clickFirst('tbody a[href^="/emails/"]:not([aria-hidden])')(p); await clickText('Insights', 'tab')(p); } },
  { name: 'suppression-detail', ref: 'suppression-detail', path: '/emails/suppressions', action: clickFirst('tbody a[href^="/emails/suppressions/"]:not([aria-hidden])') },
  { name: 'menu_emails-status', ref: 'menu_emails-status', path: '/emails', action: clickText('All Statuses'), desktopOnly: true },
  { name: 'menu_emails-date', ref: 'menu_emails-date', path: '/emails', action: clickText('Last 15 days'), desktopOnly: true },
  { name: 'menu_team-switcher', ref: 'menu_team-switcher', path: '/emails', action: async (p) => { await p.locator('aside button[aria-label^="Team"]').click(); }, desktopOnly: true },
  { name: 'dlg_suppression-add', ref: 'dlg_suppression-add', path: '/emails/suppressions', action: clickText('Add email address') },
  { name: 'templates', ref: 'templates', path: '/templates' },
  { name: 'templates-empty', ref: 'templates', path: '/templates', mock: 'empty' },
  { name: 'template-editor', path: '/templates', action: clickFirst('main a[href^="/templates/"]:not([aria-hidden])'), settle: 900 },
  { name: 'audience', ref: 'audience', path: '/audience', mock: 'empty' },
  { name: 'audience-data', path: '/audience' },
  { name: 'dlg_contacts-add', ref: 'dlg_contacts-add', path: '/audience', mock: 'empty', action: clickText('Add contacts') },
  { name: 'dlg_contacts-import', path: '/audience', action: async (p) => { await clickText('Add contacts')(p); await p.getByRole('menuitem', { name: 'Import CSV' }).click(); } },
  { name: 'contact-detail', path: '/audience', action: clickFirst('tbody a[href^="/audience/contacts/"]:not([aria-hidden])') },
  { name: 'audience_segments', ref: 'audience_segments', path: '/audience/segments' },
  { name: 'audience_topics', ref: 'audience_topics', path: '/audience/topics', mock: 'empty' },
  { name: 'audience_topics-data', path: '/audience/topics' },
  { name: 'audience_properties', ref: 'audience_properties', path: '/audience/properties', mock: 'empty' },
  { name: 'audience_properties-data', path: '/audience/properties' },
  { name: 'dlg_property-add', ref: 'dlg_property-add', path: '/audience/properties', mock: 'empty', action: clickText('Add property') },
  { name: 'inboxes', ref: 'inboxes', path: '/inboxes' },
  { name: 'inboxes-empty', ref: 'inboxes', path: '/inboxes', mock: 'empty' },
  { name: 'broadcasts', ref: 'broadcasts', path: '/broadcasts', mock: 'empty' },
  { name: 'broadcasts-data', path: '/broadcasts' },
  { name: 'broadcast-new', path: '/broadcasts/new' },
  { name: 'broadcast-editor', path: '/broadcasts', action: clickFirst('tbody a[href^="/broadcasts/"]:not([aria-hidden])') },
  { name: 'automations', ref: 'automations', path: '/automations' },
  { name: 'automations-empty', ref: 'automations', path: '/automations', mock: 'empty' },
  { name: 'automations_events', ref: 'automations_events', path: '/automations/events' },
  { name: 'dlg_event-add', ref: 'dlg_event-add', path: '/automations/events', action: clickText('Add event') },
  { name: 'automation-builder', path: '/automations', action: clickFirst('tbody a[href^="/automations/"]:not([aria-hidden])') },
  { name: 'metrics', ref: 'metrics', path: '/metrics', settle: 900 },
  { name: 'menu_metrics-events', ref: 'menu_metrics-events', path: '/metrics', action: clickText('All Events'), settle: 900, desktopOnly: true },
  { name: 'domains', ref: 'domains', path: '/domains' },
  { name: 'domains_add', ref: 'domains_add', path: '/domains/add' },
  { name: 'dlg_domain-advanced', ref: 'dlg_domain-advanced', path: '/domains/add', action: clickText('Advanced options') },
  { name: 'domain-detail', ref: 'domain-detail', path: '/domains', action: clickFirst('tbody a[href^="/domains/"]:not([aria-hidden])') },
  { name: 'tab_domain-configuration', ref: 'tab_domain-configuration', path: '/domains', action: async (p) => { await clickFirst('tbody a[href^="/domains/"]:not([aria-hidden])')(p); await clickText('Configuration', 'tab')(p); } },
  { name: 'logs', ref: 'logs', path: '/logs' },
  { name: 'log-detail', ref: 'log-detail', path: '/logs', action: clickFirst('tbody a[href^="/logs/"]:not([aria-hidden])') },
  { name: 'tab_log-request-headers', ref: 'tab_log-request-headers', path: '/logs', action: async (p) => { await clickFirst('tbody a[href^="/logs/"]:not([aria-hidden])')(p); await clickText('Headers', 'tab')(p); } },
  { name: 'api-keys', ref: 'api-keys', path: '/api-keys' },
  { name: 'dlg_api-key-create', ref: 'dlg_api-key-create', path: '/api-keys', action: clickText('Create API key') },
  { name: 'menu_api-keys-permissions', ref: 'menu_api-keys-permissions', path: '/api-keys', action: async (p) => { await p.getByRole('combobox', { name: 'Permission' }).click(); }, desktopOnly: true },
  { name: 'api-key-detail', ref: 'api-key-detail', path: '/api-keys', action: clickFirst('tbody a[href^="/api-keys/"]:not([aria-hidden])') },
  { name: 'webhooks', ref: 'webhooks', path: '/webhooks' },
  { name: 'webhooks-empty', ref: 'webhooks', path: '/webhooks', mock: 'empty' },
  { name: 'dlg_webhook-add', ref: 'dlg_webhook-add', path: '/webhooks', action: clickText('Add webhook') },
  { name: 'webhook-detail', path: '/webhooks', action: clickFirst('tbody a[href^="/webhooks/"]:not([aria-hidden])') },
  { name: 'settings', ref: 'settings', path: '/settings/usage' },
  { name: 'settings_billing', ref: 'settings_billing', path: '/settings/billing' },
  { name: 'settings_team', ref: 'settings_team', path: '/settings/team' },
  { name: 'dlg_team-invite', ref: 'dlg_team-invite', path: '/settings/team', action: clickText('Invite') },
  { name: 'tab_team-authorized-apps', ref: 'tab_team-authorized-apps', path: '/settings/team?tab=authorized-apps' },
  { name: 'settings_smtp', ref: 'settings_smtp', path: '/settings/smtp' },
  { name: 'settings_integrations', ref: 'settings_integrations', path: '/settings/integrations' },
  { name: 'settings_integrations_mcp', ref: 'settings_integrations_mcp', path: '/settings/integrations/mcp' },
  { name: 'settings_unsubscribe-page', ref: 'settings_unsubscribe-page', path: '/settings/unsubscribe-page' },
  { name: 'settings_documents', ref: 'settings_documents', path: '/settings/documents' },
  { name: 'settings_labs', ref: 'settings_labs', path: '/settings/labs' },
  { name: 'onboarding', ref: 'onboarding', path: '/onboarding' },
  { name: 'tab_onboarding-python', ref: 'tab_onboarding-python', path: '/onboarding', action: clickText('Python', 'tab') },
  { name: 'first-team', path: '/emails', mock: 'newadmin' },
  {
    name: 'onboarding-new',
    path: '/emails',
    mock: 'newadmin',
    action: async (p) => {
      await p.getByRole('button', { name: 'Create team' }).click();
      await p.getByLabel('Domain', { exact: true }).waitFor();
    },
  },
  {
    name: 'onboarding-new-domain',
    path: '/emails',
    mock: 'newadmin',
    action: async (p) => {
      await p.getByRole('button', { name: 'Create team' }).click();
      await p.getByLabel('Domain', { exact: true }).fill('updates.northwind.dev');
      await p.getByRole('button', { name: 'Add domain' }).first().click();
      await p.getByRole('link', { name: 'View DNS records' }).waitFor();
    },
  },
  { name: 'state-loading', path: '/emails', mock: 'slow', settle: 300 },
  { name: 'state-error', path: '/domains', mock: 'error', settle: 1500 },
];
