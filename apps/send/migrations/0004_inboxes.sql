-- Inboxes: shared mailboxes on a team's receiving domain, with threads, labels and drafts.

create table inboxes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  domain_id uuid not null references domains(id) on delete cascade,
  email_address text not null,
  name text not null,
  from_name text,
  forwarding boolean not null default false,
  receiving_address text,
  agent_instructions text,
  agent_tone text,
  agent_actions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inboxes_address on inboxes (lower(email_address));
create unique index inboxes_receiving_address on inboxes (lower(receiving_address)) where receiving_address is not null;
create index inboxes_team on inboxes (team_id, created_at desc, id desc);

create table inbox_labels (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references inboxes(id) on delete cascade,
  team_id uuid not null,
  name text not null,
  color text not null,
  created_at timestamptz not null default now()
);
create unique index inbox_labels_name on inbox_labels (inbox_id, lower(name));

create table inbox_threads (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references inboxes(id) on delete cascade,
  team_id uuid not null,
  subject text,
  folder text not null default 'inbox' check (folder in ('inbox', 'archive', 'spam', 'sent', 'trash')),
  trash_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index inbox_threads_inbox on inbox_threads (inbox_id, last_activity_at desc, id desc);

create table inbox_thread_labels (
  thread_id uuid not null references inbox_threads(id) on delete cascade,
  label_id uuid not null references inbox_labels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (thread_id, label_id)
);

-- One row per message in a thread. id = received_emails.id (inbound) or emails.id (outbound).
create table inbox_messages (
  id uuid primary key,
  thread_id uuid not null references inbox_threads(id) on delete cascade,
  inbox_id uuid not null references inboxes(id) on delete cascade,
  team_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_addr text not null,
  to_addrs text[] not null default '{}',
  cc text[] not null default '{}',
  bcc text[] not null default '{}',
  reply_to text[] not null default '{}',
  subject text,
  message_id text,
  in_reply_to text,
  refs text[] not null default '{}',
  html text,
  text text,
  read boolean not null default false,
  received_at timestamptz not null default now()
);
create index inbox_messages_thread on inbox_messages (thread_id, received_at, id);
create index inbox_messages_message_id on inbox_messages (inbox_id, message_id);

create table inbox_drafts (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references inboxes(id) on delete cascade,
  team_id uuid not null,
  thread_id uuid references inbox_threads(id) on delete cascade,
  reply_to_email_id uuid,
  to_addrs text[],
  cc text[] not null default '{}',
  bcc text[] not null default '{}',
  subject text,
  html text,
  text text,
  email_id uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbox_drafts_inbox on inbox_drafts (inbox_id, updated_at desc, id desc);
create unique index inbox_drafts_reply on inbox_drafts (reply_to_email_id) where reply_to_email_id is not null and sent_at is null;

create table inbox_draft_attachments (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references inbox_drafts(id) on delete cascade,
  filename text not null,
  content_type text not null,
  size integer not null,
  content bytea not null,
  created_at timestamptz not null default now()
);
