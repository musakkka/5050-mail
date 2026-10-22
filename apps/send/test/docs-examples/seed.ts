/**
 * Seeds a team whose resources carry exactly the IDs used in Resend's API
 * reference examples, so every example can run unmodified (only the base URL
 * and the API key change).
 */
import type { Sql } from '../../src/db.js';
import { sha256 } from '../../src/lib/crypto.js';

export const IDS = {
  email: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', // scheduled (cancel/update/share)
  emailSent: '37e4414c-5e25-4dbc-a071-43552a4bd53b',
  emailWithAttachment: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
  attachment: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
  domain: 'd91cd9bd-1176-453e-8fc1-35364d380206',
  domain2: 'b8617ad3-b712-41d9-81a0-f7c3d879314e',
  shared: 'b6d24b8e-af0b-4c3c-be0c-359bbd97381e', // api key, contact property, topic
  topic2: '07d84122-7224-4881-9c31-1c048e204602',
  importTopic: '059ac693-2fc8-4c13-8b27-01350d638a17',
  contact: 'e169aa45-1ecf-4183-9955-b1499d5701d3', // also a suppression
  contactAcme: '520784e2-887d-4c25-b53c-4ad46ad38100',
  contactEvent: '7f2e4a3b-dfbc-4e9a-8b2c-5f3a1d6e7c8b',
  segment: '78261eea-8f8b-4381-83c6-79fa7120f1cf',
  importSegment: '78e7a5c6-9a91-4c63-9d1f-3b9c0b5b9ab6',
  contactImport: '479e3145-dd38-476b-932c-529ceb705947',
  webhook: '4dd369bc-aa82-4ff3-97de-514ae3000ee0',
  webhook2: '430eed87-632a-4ea6-90db-0aace67ec228',
  webhookEvent: 'msg_1srOrx2ZWZBpBUvZwXKQmoEYga2',
  template: '34a080c9-b17d-4187-ad80-5af20266e535',
  broadcast: '559ac32e-9ef5-46fb-82a1-b76b840c0f7b',
  automation: 'c9b16d4f-ba6c-4e2e-b044-6bf4404e57fd',
  run: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  inbox: 'b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1',
  thread: '4d8e2a1c-9b3f-4c6d-8a21-3e5f7c9c0d12',
  draft: 'c3a1e8b4-2d5f-4a7c-9e10-6b8d7f5a4c32',
  label: '7f9c1d2e-4a6b-4c3d-8e15-9b0a7c6d5e34',
  label2: '2a8b4c6d-1e3f-4a5b-9c7d-8e0f1a2b3c4d',
  inboxEmail: '5b1a9f47-2c8d-4e6f-9a03-1d2e3f4a5b60',
  grant: '650e8400-e29b-41d4-a716-446655440001',
};

export interface SeedOptions {
  /** Leave out the example.com domain (create-domain example creates it). */
  noExampleDomain?: boolean;
  /** Register example.com on another team (claim example). */
  exampleDomainOnOtherTeam?: boolean;
  noEventDefinition?: boolean;
  noTemplateAlias?: boolean;
  broadcastStatus?: 'draft' | 'scheduled';
}

export async function seed(sql: Sql, teamId: string, otherTeamId: string, o: SeedOptions = {}) {
  const ins = async (q: Promise<unknown>) => q;
  if (!o.noExampleDomain) {
    await ins(sql`insert into domains (id, team_id, name, status, cf_enabled, sending, receiving, records)
      values (${IDS.domain}, ${o.exampleDomainOnOtherTeam ? otherTeamId : teamId}, 'example.com', 'verified', true, 'enabled', 'enabled', '[]')`);
  }
  await ins(sql`insert into domains (id, team_id, name, status, cf_enabled, records) values (${IDS.domain2}, ${teamId}, 'example.org', 'verified', true, '[]')`);
  await ins(sql`insert into api_keys (id, team_id, name, permission, token_prefix, token_hash) values (${IDS.shared}, ${teamId}, 'Docs', 'full_access', 'docsdocs', ${sha256('x')})`);

  // Emails
  await ins(sql`insert into emails (id, team_id, from_addr, to_addrs, subject, html, last_event, scheduled_at, message_id)
    values (${IDS.email}, ${teamId}, 'Acme <onboarding@resend.dev>', ${['delivered@resend.dev']}, 'Scheduled', '<p>hi</p>', 'scheduled', now() + interval '1 day', '<49a3999c@resend.dev>')`);
  await ins(sql`insert into jobs (kind, payload, run_at, unique_key) values ('send_email', ${sql.json({ emailId: IDS.email })}, now() + interval '1 day', ${`email:${IDS.email}`})`);
  await ins(sql`insert into emails (id, team_id, from_addr, to_addrs, subject, html, last_event, message_id)
    values (${IDS.emailSent}, ${teamId}, 'Acme <onboarding@resend.dev>', ${['delivered@resend.dev']}, 'Hello World', '<p>Congrats</p>', 'delivered', '<37e4414c@resend.dev>')`);
  await ins(sql`insert into emails (id, team_id, from_addr, to_addrs, subject, html, last_event, message_id)
    values (${IDS.emailWithAttachment}, ${teamId}, 'Acme <onboarding@resend.dev>', ${['delivered@resend.dev']}, 'With attachment', '<img src="cid:img001">', 'delivered', '<4ef9a417@resend.dev>')`);
  await ins(sql`insert into email_attachments (id, email_id, team_id, filename, content_type, content_id, disposition, size, content)
    values (${IDS.attachment}, ${IDS.emailWithAttachment}, ${teamId}, 'avatar.png', 'image/png', 'img001', 'inline', 3, ${Buffer.from('png')})`);

  // Received emails share ids with sent ones in the docs.
  for (const id of [IDS.emailWithAttachment, IDS.emailSent]) {
    await ins(sql`insert into received_emails (id, team_id, from_addr, to_addrs, subject, html, text, message_id, raw)
      values (${id}, ${teamId}, 'onboarding@resend.dev', ${['delivered@resend.dev']}, 'Hello World', '<p>hi</p>', 'hi', '<111-222-333@email.example.com>', ${Buffer.from('Subject: Hello World\r\n\r\nhi')})`);
  }
  await ins(sql`insert into received_attachments (id, email_id, team_id, filename, content_type, content_id, disposition, size, content)
    values (${IDS.attachment}, ${IDS.emailWithAttachment}, ${teamId}, 'avatar.png', 'image/png', 'img001', 'inline', 3, ${Buffer.from('png')})`);
  await ins(sql`insert into api_logs (id, team_id, method, endpoint, response_status, user_agent) values (${IDS.emailSent}, ${teamId}, 'POST', '/emails', 200, 'resend-node:6.34.1')`);

  // Audience data
  await ins(sql`insert into segments (id, team_id, name) values (${IDS.segment}, ${teamId}, 'Registered Users'), (${IDS.importSegment}, ${teamId}, 'Imported')`);
  await ins(sql`insert into topics (id, team_id, name, description, default_subscription) values
    (${IDS.shared}, ${teamId}, 'Product Updates', 'New features', 'opt_in'),
    (${IDS.topic2}, ${teamId}, 'Newsletter', null, 'opt_out'),
    (${IDS.importTopic}, ${teamId}, 'Imported topic', null, 'opt_in')`);
  await ins(sql`insert into contact_properties (id, team_id, key, type, fallback_value) values (${IDS.shared}, ${teamId}, 'department', 'string', '"Engineering"')`);
  await ins(sql`insert into contact_properties (team_id, key, type) values (${teamId}, 'plan', 'string')`);
  await ins(sql`insert into contacts (id, team_id, email, first_name, last_name) values
    (${IDS.contact}, ${teamId}, 'steve.wozniak@gmail.com', 'Steve', 'Wozniak'),
    (${IDS.contactAcme}, ${teamId}, 'acme@example.com', 'Acme', null),
    (${IDS.contactEvent}, ${teamId}, 'events@example.com', null, null)`);
  await ins(sql`insert into contact_segments (contact_id, segment_id) values (${IDS.contact}, ${IDS.segment})`);
  await ins(sql`insert into contact_imports (id, team_id, status, completed_at) values (${IDS.contactImport}, ${teamId}, 'completed', now())`);
  await ins(sql`insert into suppressions (id, team_id, email, origin) values (${IDS.contact}, ${teamId}, 'steve.wozniak@example.com', 'manual')`);

  // Webhooks
  await ins(sql`insert into webhooks (id, team_id, endpoint, events, signing_secret) values
    (${IDS.webhook}, ${teamId}, 'https://example.com/handler', ${['email.sent']}, 'whsec_ZG9jc2RvY3Nkb2NzZG9jc2RvY3Nkb2Nz'),
    (${IDS.webhook2}, ${teamId}, 'https://example.com/other', ${['email.sent']}, 'whsec_ZG9jc2RvY3Nkb2NzZG9jc2RvY3Nkb2Nz')`);
  await ins(sql`insert into webhook_events (id, webhook_id, team_id, type, payload, status) values
    (${IDS.webhookEvent}, ${IDS.webhook}, ${teamId}, 'email.sent', ${sql.json({ type: 'email.sent', created_at: new Date().toISOString(), data: {} })}, 'success')`);
  await ins(sql`insert into webhook_attempts (id, webhook_event_id, webhook_id, team_id, http_status_code, response) values ('atmpt_docs', ${IDS.webhookEvent}, ${IDS.webhook}, ${teamId}, 200, '{"ok":true}')`);

  // Templates, broadcasts, automations, events
  const snapshot = { subject: 'Order', html: '<p>{{{PRODUCT}}}</p>', text: null, from: 'Acme <onboarding@resend.dev>', reply_to: null, variables: [{ key: 'PRODUCT', type: 'string', fallback_value: 'item' }] };
  await ins(sql`insert into templates (id, team_id, name, alias, status, subject, html, from_addr, variables, published, published_at)
    values (${IDS.template}, ${teamId}, 'welcome', ${o.noTemplateAlias ? null : 'docs-welcome'}, 'published', 'Order', '<p>{{{PRODUCT}}}</p>', 'Acme <onboarding@resend.dev>',
            ${sql.json(snapshot.variables as never)}, ${sql.json(snapshot as never)}, now())`);
  await ins(sql`insert into broadcasts (id, team_id, name, segment_id, from_addr, subject, html, status, scheduled_at)
    values (${IDS.broadcast}, ${teamId}, 'Docs broadcast', ${IDS.segment}, 'Acme <onboarding@resend.dev>', 'hello world', '<p>Hi {{{contact.first_name|there}}}</p>',
            ${o.broadcastStatus ?? 'draft'}, ${o.broadcastStatus === 'scheduled' ? new Date(Date.now() + 86400_000).toISOString() : null})`);
  await ins(sql`insert into broadcasts (id, team_id, name, segment_id, from_addr, subject, html, status)
    values (${IDS.email}, ${teamId}, 'Docs draft', ${IDS.segment}, 'Acme <onboarding@resend.dev>', 'hello', '<p>Hi</p>', 'draft')`);
  if (!o.noEventDefinition) await ins(sql`insert into event_definitions (team_id, name, schema) values (${teamId}, 'user.created', ${sql.json({ plan: 'string' })})`);
  const steps = [
    { key: 'start', type: 'trigger', config: { event_name: 'user.created' } },
    { key: 'welcome', type: 'send_email', config: { template: { id: IDS.template } } },
  ];
  await ins(sql`insert into automations (id, team_id, name, status, steps, connections)
    values (${IDS.automation}, ${teamId}, 'Welcome series', 'disabled', ${sql.json(steps as never)}, ${sql.json([{ from: 'start', to: 'welcome', type: 'default' }] as never)})`);
  await ins(sql`insert into automation_runs (id, automation_id, team_id, status, completed_at, steps)
    values (${IDS.run}, ${IDS.automation}, ${teamId}, 'completed', now(), '[]')`);

  // Inboxes
  await ins(sql`insert into inboxes (id, team_id, domain_id, email_address, name) values (${IDS.inbox}, ${teamId}, ${IDS.domain2}, 'help@example.org', 'Help')`);
  await ins(sql`insert into inbox_labels (id, inbox_id, team_id, name, color) values (${IDS.label}, ${IDS.inbox}, ${teamId}, 'Important', '#E93D82'), (${IDS.label2}, ${IDS.inbox}, ${teamId}, 'Billing', '#F76B15')`);
  await ins(sql`insert into inbox_threads (id, inbox_id, team_id, subject) values (${IDS.thread}, ${IDS.inbox}, ${teamId}, 'Invoice question')`);
  await ins(sql`insert into inbox_thread_labels (thread_id, label_id) values (${IDS.thread}, ${IDS.label})`);
  await ins(sql`insert into inbox_messages (id, thread_id, inbox_id, team_id, direction, from_addr, to_addrs, subject, message_id, text)
    values (${IDS.inboxEmail}, ${IDS.thread}, ${IDS.inbox}, ${teamId}, 'inbound', 'isabella@example.com', ${['help@example.org']}, 'Invoice question', '<inv-1@example.com>', 'Where is my invoice?')`);
  await ins(sql`insert into inbox_drafts (id, inbox_id, team_id, to_addrs, subject, html) values (${IDS.draft}, ${IDS.inbox}, ${teamId}, ${['ada@example.org']}, 'Refund', '<p>Refund issued.</p>')`);

  await ins(sql`insert into oauth_grants (id, team_id, client_id, client_name, scopes) values (${IDS.grant}, ${teamId}, 'client_docs', 'Docs App', ${['emails:send']})`);
}
