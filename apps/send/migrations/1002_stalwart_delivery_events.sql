-- Delivery feedback from the local mail server (Stalwart webhooks, POST /internal/stalwart-events).
-- smtp_queue_id: Stalwart's queue id (decimal) from the 250 reply when 5050 Send submitted the message.
alter table emails add column if not exists smtp_queue_id text;
create index if not exists emails_smtp_queue_id on emails (smtp_queue_id) where smtp_queue_id is not null;

-- Events that arrived before the worker stored the queue id (a fast local delivery can beat the
-- UPDATE that follows the 250 reply). Replayed once the id is known; purged after an hour.
create table if not exists stalwart_pending_events (
  id bigserial primary key,
  queue_id text not null,
  event jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists stalwart_pending_events_queue on stalwart_pending_events (queue_id);
create index if not exists stalwart_pending_events_created on stalwart_pending_events (created_at);
