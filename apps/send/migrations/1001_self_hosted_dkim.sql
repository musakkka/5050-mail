-- Self-hosted (TRANSPORT=smtp): 5050 Send signs each domain's mail with its own DKIM key.
alter table domains add column if not exists dkim_selector text;
alter table domains add column if not exists dkim_public_key text;
-- AES-256-GCM with SESSION_SECRET (lib/crypto.ts encrypt)
alter table domains add column if not exists dkim_private_key text;
