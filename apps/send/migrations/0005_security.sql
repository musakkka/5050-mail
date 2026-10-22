-- Only domains created by a platform admin (or whose Cloudflare zone we created for that very
-- domain) may use the one-click path: onboarding into, publishing records in, and trusting
-- the records of a zone in the operator's Cloudflare account.
alter table domains add column if not exists cf_managed boolean not null default false;
update domains set cf_managed = true where cf_zone_id is not null and cf_enabled;

-- At-most-once delivery: a send job claims the email before handing it to the transport, so a
-- re-claimed (stale-locked) job can never send the same email twice.
alter table emails add column if not exists send_claimed_at timestamptz;
