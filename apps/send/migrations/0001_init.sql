-- 5050 Send: core schema. All tenant data carries team_id; every query filters on it.

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  monthly_quota integer not null default 3000,
  daily_quota integer,
  rate_limit integer not null default 2,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table team_members (
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  added_by text,
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index team_members_email on team_members (email);

create table dashboard_sessions (
  id_hash text primary key,
  email text not null,
  name text not null,
  is_admin boolean not null default false,
  -- AES-GCM encrypted Basic credential, used to re-check Stalwart admin status.
  credential text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  admin_checked_at timestamptz not null default now()
);

create table domains (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  status text not null default 'not_started',
  region text not null default 'us-east-1',
  open_tracking boolean not null default false,
  click_tracking boolean not null default false,
  tls text not null default 'opportunistic',
  tracking_subdomain text,
  custom_return_path text,
  sending text not null default 'enabled',
  receiving text not null default 'disabled',
  records jsonb not null default '[]',
  cf_zone_id text,
  cf_zone_name text,
  cf_subdomain_tag text,
  cf_enabled boolean not null default false,
  last_error text,
  last_checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index domains_name_unique on domains (lower(name));
create index domains_team on domains (team_id, created_at desc, id desc);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  permission text not null check (permission in ('full_access', 'sending_access')),
  domain_id uuid references domains(id) on delete set null,
  token_prefix text not null unique,
  token_hash bytea not null,
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index api_keys_team on api_keys (team_id, created_at desc, id desc);

create table templates (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  alias text,
  status text not null default 'draft',
  -- draft content (what GET returns) …
  subject text,
  html text not null default '',
  text text,
  from_addr text,
  reply_to text[],
  variables jsonb not null default '[]',
  -- … and the published snapshot used for sending.
  published jsonb,
  current_version_id uuid not null default gen_random_uuid(),
  has_unpublished_versions boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index templates_alias on templates (team_id, alias) where alias is not null;
create index templates_team on templates (team_id, created_at desc, id desc);

create table segments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index segments_team on segments (team_id, created_at desc, id desc);

create table topics (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  description text,
  default_subscription text not null check (default_subscription in ('opt_in', 'opt_out')),
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index topics_team on topics (team_id, created_at desc, id desc);

create table contact_properties (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  key text not null,
  type text not null check (type in ('string', 'number')),
  fallback_value jsonb,
  created_at timestamptz not null default now(),
  unique (team_id, key)
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  unsubscribed boolean not null default false,
  properties jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index contacts_email on contacts (team_id, lower(email));
create index contacts_team on contacts (team_id, created_at desc, id desc);

create table contact_segments (
  contact_id uuid not null references contacts(id) on delete cascade,
  segment_id uuid not null references segments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, segment_id)
);
create index contact_segments_segment on contact_segments (segment_id);

create table contact_topics (
  contact_id uuid not null references contacts(id) on delete cascade,
  topic_id uuid not null references topics(id) on delete cascade,
  subscription text not null check (subscription in ('opt_in', 'opt_out')),
  updated_at timestamptz not null default now(),
  primary key (contact_id, topic_id)
);

create table contact_imports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  status text not null default 'queued',
  options jsonb not null default '{}',
  file bytea,
  counts jsonb not null default '{"total":0,"created":0,"updated":0,"skipped":0,"failed":0}',
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index contact_imports_team on contact_imports (team_id, created_at desc, id desc);

create table broadcasts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text,
  segment_id uuid,
  audience_id uuid,
  from_addr text,
  subject text,
  reply_to text[],
  preview_text text,
  html text,
  text text,
  topic_id uuid,
  status text not null default 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index broadcasts_team on broadcasts (team_id, created_at desc, id desc);

create table emails (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  api_key_id uuid,
  domain_id uuid,
  source text not null default 'api',
  from_addr text not null,
  to_addrs text[] not null,
  cc text[],
  bcc text[],
  reply_to text[],
  subject text not null default '',
  html text,
  text text,
  headers jsonb,
  tags jsonb,
  topic_id uuid,
  template_id uuid,
  broadcast_id uuid,
  contact_id uuid,
  automation_run_id uuid,
  scheduled_at timestamptz,
  last_event text not null default 'queued',
  last_event_at timestamptz not null default now(),
  message_id text not null,
  provider_message_id text,
  failed_reason text,
  size_bytes integer,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index emails_team on emails (team_id, created_at desc, id desc);
create index emails_broadcast on emails (broadcast_id) where broadcast_id is not null;
create index emails_message_id on emails (message_id);
create index emails_provider_message_id on emails (provider_message_id) where provider_message_id is not null;
create index emails_scheduled on emails (scheduled_at) where last_event = 'scheduled';

create table email_attachments (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references emails(id) on delete cascade,
  team_id uuid not null,
  filename text,
  content_type text not null,
  content_id text,
  disposition text not null default 'attachment',
  size integer not null default 0,
  content bytea,
  path text,
  created_at timestamptz not null default now()
);
create index email_attachments_email on email_attachments (email_id, created_at, id);

-- Every lifecycle event of an email (the dashboard timeline, stats and webhooks derive from it).
create table email_events (
  id bigserial primary key,
  email_id uuid not null references emails(id) on delete cascade,
  team_id uuid not null,
  domain_id uuid,
  broadcast_id uuid,
  type text not null,
  recipient text,
  data jsonb not null default '{}',
  -- de-duplicates provider events polled more than once
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index email_events_email on email_events (email_id, created_at);
create index email_events_team_time on email_events (team_id, created_at);
create unique index email_events_dedupe on email_events (dedupe_key) where dedupe_key is not null;

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  email text not null,
  origin text not null check (origin in ('bounce', 'complaint', 'manual')),
  source_id uuid,
  created_at timestamptz not null default now()
);
create unique index suppressions_email on suppressions (team_id, lower(email));
create index suppressions_team on suppressions (team_id, created_at desc, id desc);

create table idempotency_keys (
  team_id uuid not null,
  key text not null,
  endpoint text not null,
  body_hash text not null,
  state text not null default 'in_progress',
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (team_id, endpoint, key)
);
create index idempotency_created on idempotency_keys (created_at);

create table webhooks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  endpoint text not null,
  events text[],
  status text not null default 'enabled',
  signing_secret text not null,
  previous_secret text,
  previous_secret_expires_at timestamptz,
  failing_since timestamptz,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index webhooks_team on webhooks (team_id, created_at desc, id desc);

create table webhook_events (
  -- one msg_ id per emitted event, shared by every endpoint it fans out to (like Svix)
  id text not null,
  webhook_id uuid not null references webhooks(id) on delete cascade,
  team_id uuid not null,
  type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (webhook_id, id)
);
create index webhook_events_webhook on webhook_events (webhook_id, created_at desc, id desc);
create index webhook_events_due on webhook_events (next_attempt_at) where status in ('pending', 'attempting');

create table webhook_attempts (
  id text primary key,
  webhook_event_id text not null,
  webhook_id uuid not null,
  team_id uuid not null,
  http_status_code integer,
  response text,
  error text,
  duration_ms integer,
  is_replay boolean not null default false,
  sent_at timestamptz not null default now(),
  foreign key (webhook_id, webhook_event_id) references webhook_events(webhook_id, id) on delete cascade
);
create index webhook_attempts_event on webhook_attempts (webhook_id, webhook_event_id, sent_at desc, id desc);

-- Generic job queue (worker role): FOR UPDATE SKIP LOCKED.
create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  unique_key text unique,
  created_at timestamptz not null default now()
);
create index jobs_due on jobs (run_at) where locked_at is null;

create table api_logs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  api_key_id uuid,
  source text not null default 'api',
  method text not null,
  endpoint text not null,
  response_status integer not null,
  user_agent text,
  ip text,
  request_body jsonb,
  response_body jsonb,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index api_logs_team on api_logs (team_id, created_at desc, id desc);
create index api_logs_created on api_logs (created_at);

-- Daily per-team, per-domain counters, rebuilt by the worker from email_events.
create table stats_daily (
  team_id uuid not null,
  day date not null,
  domain_id uuid not null default '00000000-0000-0000-0000-000000000000',
  metrics jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (team_id, day, domain_id)
);

create table system_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Custom events (automations triggers) and automations.
create table event_definitions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  schema jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index event_definitions_name on event_definitions (team_id, name);
create index event_definitions_team on event_definitions (team_id, created_at desc, id desc);

create table automations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  name text not null,
  status text not null default 'disabled',
  steps jsonb not null default '[]',
  connections jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index automations_team on automations (team_id, created_at desc, id desc);

create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  team_id uuid not null,
  contact_id uuid,
  status text not null default 'running',
  context jsonb not null default '{}',
  steps jsonb not null default '[]',
  waiting_for text,
  wait_until timestamptz,
  current_step text,
  started_at timestamptz default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index automation_runs_automation on automation_runs (automation_id, created_at desc, id desc);
create index automation_runs_waiting on automation_runs (team_id, waiting_for) where status = 'running' and waiting_for is not null;

-- Receiving (inbound) emails.
create table received_emails (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  domain_id uuid,
  from_addr text not null,
  to_addrs text[] not null default '{}',
  cc text[],
  bcc text[],
  reply_to text[],
  received_for text[] not null default '{}',
  subject text not null default '',
  html text,
  text text,
  headers jsonb,
  message_id text not null default '',
  raw bytea,
  created_at timestamptz not null default now()
);
create index received_emails_team on received_emails (team_id, created_at desc, id desc);

create table received_attachments (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references received_emails(id) on delete cascade,
  team_id uuid not null,
  filename text,
  content_type text not null,
  content_id text,
  disposition text,
  size integer not null default 0,
  content bytea,
  created_at timestamptz not null default now()
);
create index received_attachments_email on received_attachments (email_id, created_at, id);

create table domain_claims (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  domain_id uuid,
  name text not null,
  status text not null default 'pending',
  region text,
  options jsonb not null default '{}',
  token text not null,
  blocked_reason text,
  failure_reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

create table oauth_grants (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  client_id text not null,
  client_name text not null,
  client_logo_uri text,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create index oauth_grants_team on oauth_grants (team_id, created_at desc, id desc);
