/**
 * Shapes of the 5050 Send API as seen by the dashboard.
 * Resend-compatible objects come through /api/internal/teams/:teamId/resend/*
 * (same JSON as the public API); internal objects come from /api/internal/*.
 * See send/docs/resend-api-spec.md, send/docs/internal-api.md and send/docs/dashboard-needs.md.
 */

export interface List<T> {
  object: 'list';
  has_more: boolean;
  data: T[];
}

// ---------------------------------------------------------------- session / teams
export type Role = 'admin' | 'member' | 'superadmin';

export interface Team {
  id: string;
  name: string;
  monthly_quota: number;
  daily_quota: number | null;
  rate_limit: number;
  created_at: string;
  role?: Role;
  members?: number;
  settings?: TeamSettings;
}

export interface TeamSettings {
  unsubscribe_page?: UnsubscribePageSettings;
  labs?: Record<string, boolean>;
  [k: string]: unknown;
}

export interface Me {
  email: string;
  name: string;
  isAdmin: boolean;
  teams: Team[];
}

export interface Member {
  email: string;
  role: 'admin' | 'member';
  added_by: string | null;
  created_at: string;
}

export interface SystemInfo {
  apiBase: string;
  dashboardBase: string;
  docsBase?: string;
  supportEmail?: string | null;
  transport: string;
  cloudflareConfigured: boolean;
  analytics?: unknown;
  warnings: { code: string; message: string }[];
}

// ---------------------------------------------------------------- emails
export type EmailStatus =
  | 'bounced'
  | 'canceled'
  | 'clicked'
  | 'complained'
  | 'delivered'
  | 'delivery_delayed'
  | 'failed'
  | 'opened'
  | 'queued'
  | 'scheduled'
  | 'sent'
  | 'suppressed';

export interface Tag {
  name: string;
  value: string;
}

export interface EmailListItem {
  object?: 'email';
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  bcc: string[] | null;
  cc: string[] | null;
  reply_to: string[] | null;
  last_event: EmailStatus;
  scheduled_at: string | null;
  /** Internal list only (filter by key). */
  api_key_id?: string | null;
}

export interface Email extends EmailListItem {
  html: string | null;
  text: string | null;
  tags?: Tag[] | null;
  headers?: Record<string, string> | null;
  broadcast_id?: string | null;
  template_id?: string | null;
  /** Internal: id of the api_logs row that created the email. */
  log_id?: string | null;
}

export interface EmailEvent {
  type: EmailStatus | 'queued';
  recipient: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface ReceivedEmail {
  object?: 'email';
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  bcc: string[] | null;
  cc: string[] | null;
  reply_to: string[] | null;
  message_id?: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string> | null;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  content_id?: string | null;
  content_disposition?: string | null;
  download_url?: string;
}

export interface Suppression {
  object?: 'suppression';
  id: string;
  email: string;
  reason: 'bounce' | 'complaint' | 'manual' | 'unsubscribe' | string;
  source?: string | null;
  email_id?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- domains
export type DomainStatus =
  | 'not_started'
  | 'pending'
  | 'verified'
  | 'failed'
  | 'temporary_failure'
  | 'partially_verified'
  | 'partially_failed';

export interface DomainRecord {
  record: 'SPF' | 'DKIM' | 'DMARC' | 'Receiving' | 'Tracking' | 'MX' | string;
  name: string;
  type: 'MX' | 'TXT' | 'CNAME' | string;
  ttl: string;
  status: 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure' | string;
  value: string;
  priority?: number;
}

export interface Domain {
  object?: 'domain';
  id: string;
  name: string;
  status: DomainStatus;
  created_at: string;
  region: string;
  records?: DomainRecord[];
  capabilities?: { sending: 'enabled' | 'disabled'; receiving: 'enabled' | 'disabled' };
  open_tracking?: boolean;
  click_tracking?: boolean;
  tls?: 'opportunistic' | 'enforced';
  custom_return_path?: string | null;
  tracking_subdomain?: string | null;
}

export interface DomainCloudflare {
  zone_id: string | null;
  zone: string | null;
  managed: boolean;
  sending_enabled: boolean;
  last_error: string | null;
  last_checked_at: string | null;
  verified_at: string | null;
}

// ---------------------------------------------------------------- api keys
export type Permission = 'full_access' | 'sending_access';

export interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** Dashboard extras (see dashboard-needs.md). */
  permission?: Permission;
  domain_id?: string | null;
  token_preview?: string;
  created_by?: string | null;
}

export interface CreatedApiKey {
  id: string;
  object?: 'api_key';
  token: string;
}

// ---------------------------------------------------------------- webhooks
export type WebhookEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.complained'
  | 'email.bounced'
  | 'email.opened'
  | 'email.clicked'
  | 'email.received'
  | 'email.failed'
  | 'email.scheduled'
  | 'email.suppressed'
  | 'contact.created'
  | 'contact.updated'
  | 'contact.deleted'
  | 'domain.created'
  | 'domain.updated'
  | 'domain.deleted';

export interface Webhook {
  object?: 'webhook';
  id: string;
  endpoint: string;
  events: WebhookEventType[];
  status: 'enabled' | 'disabled';
  created_at: string;
  signing_secret?: string;
  disabled_reason?: string | null;
}

export interface WebhookDelivery {
  id: string;
  type: WebhookEventType;
  status: 'success' | 'failed' | 'pending' | 'attempting';
  created_at: string;
  attempts?: number;
  last_attempt_at?: string | null;
  payload?: unknown;
}

export interface WebhookAttempt {
  id: string;
  http_status_code: number | null;
  response: string | null;
  error: string | null;
  duration_ms: number | null;
  is_replay: boolean;
  sent_at: string;
}

// ---------------------------------------------------------------- logs
export interface ApiLog {
  id: string;
  created_at: string;
  method: string;
  endpoint: string;
  response_status: number;
  user_agent: string | null;
  api_key_id: string | null;
  source?: string | null;
  duration_ms?: number | null;
  ip?: string | null;
  request_body?: unknown;
  request_headers?: Record<string, string> | null;
  response_body?: unknown;
  response_headers?: Record<string, string> | null;
}

// ---------------------------------------------------------------- audience
export interface Contact {
  object?: 'contact';
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  unsubscribed: boolean;
  properties?: Record<string, string | number | null>;
  segments?: { id: string; name: string }[];
}

export interface Segment {
  object?: 'segment';
  id: string;
  name: string;
  created_at: string;
  contacts_count?: number;
  unsubscribed_count?: number;
}

export interface Topic {
  object?: 'topic';
  id: string;
  name: string;
  description: string | null;
  default_subscription: 'opt_in' | 'opt_out';
  visibility?: 'public' | 'private';
  created_at: string;
}

export interface ContactProperty {
  object?: 'contact_property';
  id: string;
  key: string;
  type: 'string' | 'number';
  fallback_value: string | number | null;
  created_at: string;
}

// ---------------------------------------------------------------- broadcasts / templates
export type BroadcastStatus = 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'canceled' | 'failed';

export interface Broadcast {
  object?: 'broadcast';
  id: string;
  name: string | null;
  segment_id: string | null;
  topic_id?: string | null;
  from: string | null;
  subject: string | null;
  reply_to: string[] | null;
  preview_text: string | null;
  html?: string | null;
  text?: string | null;
  status: BroadcastStatus;
  created_at: string;
  scheduled_at: string | null;
  sent_at: string | null;
}

export type TemplateVariableType = 'string' | 'number' | 'boolean' | 'object' | 'list';

export interface TemplateVariable {
  id?: string;
  key: string;
  type: TemplateVariableType;
  fallback_value: string | number | boolean | null | unknown;
}

/** GET /templates/:id (list items carry only id, name, alias, status, published_at, created_at, updated_at). */
export interface Template {
  object?: 'template';
  id: string;
  current_version_id?: string;
  name: string;
  alias: string | null;
  status: 'draft' | 'published';
  from?: string | null;
  subject?: string | null;
  reply_to?: string | string[] | null;
  html?: string;
  text?: string | null;
  variables?: TemplateVariable[];
  created_at: string;
  updated_at: string;
  published_at: string | null;
  has_unpublished_versions?: boolean;
}

// ---------------------------------------------------------------- automations / events / inboxes
export type EventPropertyType = 'string' | 'number' | 'boolean' | 'date';

export interface EventDefinition {
  object?: 'event';
  id: string;
  name: string;
  schema: Record<string, EventPropertyType> | null;
  created_at: string;
  updated_at?: string;
}

export type AutomationStepType = 'trigger' | 'delay' | 'wait_for_event' | 'condition' | 'send_email' | 'contact_update' | 'contact_delete' | 'add_to_segment';

export interface AutomationStep {
  key: string;
  type: AutomationStepType;
  config: Record<string, unknown>;
}

export interface AutomationConnection {
  from: string;
  to: string;
  type?: 'default' | 'condition_met' | 'condition_not_met' | 'event_received' | 'timeout';
}

/** List items omit steps/connections. */
export interface Automation {
  object?: 'automation';
  id: string;
  name: string;
  status: 'enabled' | 'disabled';
  created_at: string;
  updated_at?: string;
  steps?: AutomationStep[];
  connections?: AutomationConnection[];
}

export interface Inbox {
  object?: 'inbox';
  id: string;
  name: string | null;
  email_address: string;
  from_name: string | null;
  domain_id?: string | null;
  receiving_address?: string | null;
  unread: number;
  drafts?: number;
  last_received: string | null;
  created_at: string;
  updated_at?: string;
}

// ---------------------------------------------------------------- metrics / usage
export interface MetricsRow {
  period: string;
  domain_id?: string | null;
  sent?: number;
  delivered?: number;
  bounced?: number;
  complained?: number;
  opened?: number;
  clicked?: number;
  failed?: number;
  delivery_delayed?: number;
  suppressed?: number;
  [k: string]: unknown;
}

export interface MetricsResponse {
  object?: 'metrics';
  data: MetricsRow[];
  totals?: Partial<Record<string, number>>;
  start_date?: string;
  end_date?: string;
  granularity?: string;
}

export interface Quota {
  used: number;
  limit: number | null;
  resets_at?: string | null;
}

/** GET /api/internal/teams/:id/usage (send/src/api/routes/misc.ts usageObject). */
export interface Usage {
  object?: 'usage';
  emails: {
    daily: Quota & { sent?: number; received?: number };
    monthly: Quota & { sent?: number; received?: number };
  };
  contacts: Quota;
  segments: Quota;
  broadcasts: Quota;
  ai_credits?: Quota & { next_increase_at?: string | null };
  automation_runs?: Quota;
  domains: Quota;
  rate_limit: { limit: number; duration: string };
}

export interface SmtpInfo {
  host: string;
  username: string;
  password: string;
  ports: { port: number; security: 'tls' | 'starttls' | string; description?: string }[];
  max_message_bytes?: number;
  notes?: string[];
}

export interface IntegrationSnippet {
  id: string;
  name: string;
  category: 'smtp' | 'sdk' | 'framework' | 'platform';
  docs_url: string;
  language?: string;
  snippet: string;
  notes?: string;
}

export interface OAuthGrant {
  id: string;
  client_name: string;
  client_uri?: string | null;
  scopes: string[];
  created_at: string;
  last_used_at?: string | null;
}

export interface UnsubscribePageSettings {
  title?: string;
  description?: string;
  logo_url?: string | null;
  accent_color?: string;
  background_color?: string;
  show_topics?: boolean;
}
