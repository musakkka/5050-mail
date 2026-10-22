import type { AppContext } from '../../context.js';
import { normalizeDomain, txtValue } from '../../cloudflare/client.js';
import { E } from '../../lib/errors.js';
import { randomToken, uuid } from '../../lib/ids.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import {
  createDomain, deleteDomain, getDomain, startVerification, updateDomain, REGIONS, refreshFromCloudflare, domainEventData,
  type DomainRow,
} from '../../services/domains.js';
import { emit } from '../../services/webhooks.js';
import { body, query, teamId, uuidParam, type Router } from '../router.js';

export const domainObject = (d: DomainRow) => ({
  object: 'domain',
  id: d.id,
  name: d.name,
  status: d.status,
  created_at: d.created_at,
  region: d.region,
  open_tracking: d.open_tracking,
  click_tracking: d.click_tracking,
  tracking_subdomain: d.tracking_subdomain ?? null,
  capabilities: { sending: d.sending, receiving: d.receiving },
  records: d.records,
});

const domainListItem = (d: DomainRow) => ({
  id: d.id,
  name: d.name,
  status: d.status,
  created_at: d.created_at,
  region: d.region,
  open_tracking: d.open_tracking,
  click_tracking: d.click_tracking,
  capabilities: { sending: d.sending, receiving: d.receiving },
});

const claimObject = (c: Record<string, unknown>) => ({
  object: 'domain_claim',
  id: c.id,
  name: c.name,
  status: c.status,
  domain_id: c.domain_id,
  region: c.region,
  record: { type: 'TXT', name: c.name, value: `5050send-domain-verification=${c.token}`, ttl: 'Auto' },
  blocked_reason: c.blocked_reason ?? null,
  failure_reason: c.failure_reason ?? null,
  created_at: c.created_at,
  expires_at: c.expires_at,
});

async function loadDomain(ctx: AppContext, team: string, id: string): Promise<DomainRow> {
  const d = await getDomain(ctx, team, id);
  if (!d) throw E.notFound('Domain not found');
  return d;
}

export function registerDomainRoutes(r: Router) {
  r.post('/domains', async (c, ctx) => {
    const d = await createDomain(ctx, teamId(c), body(c), { platformAdmin: c.get('auth').platformAdmin === true });
    const { object: _o, ...rest } = domainObject(d);
    return c.json(
      {
        id: rest.id, name: rest.name, created_at: rest.created_at, status: rest.status,
        open_tracking: rest.open_tracking, click_tracking: rest.click_tracking,
        tracking_subdomain: d.tracking_subdomain ?? null,
        capabilities: rest.capabilities, records: rest.records, region: rest.region,
      },
      201,
    );
  });

  r.get('/domains', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'domains', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map((d) => domainListItem(d as unknown as DomainRow)), hasMore));
  });

  // Claims (static paths before /domains/:domain_id)
  r.post('/domains/claim', async (c, ctx) => {
    const b = body(c);
    if (b.name === undefined || b.name === null || b.name === '') throw E.missingField('name');
    const name = normalizeDomain(b.name);
    if (!name) throw E.validation('Invalid `name` field. It must be a valid domain name like `example.com`.');
    const region = (b.region as string | undefined) ?? 'us-east-1';
    if (!REGIONS.includes(region)) throw E.validation(`Invalid \`region\` field. It must be one of: ${REGIONS.join(', ')}.`);
    const [owner] = await ctx.sql`select team_id from domains where lower(name) = ${name}`;
    if (!owner) throw E.validation(`The ${name} domain is not registered by another team. Create it with POST /domains instead.`);
    if (owner.team_id === teamId(c)) throw E.validation(`The ${name} domain already belongs to this team.`);
    const [existing] = await ctx.sql`select * from domain_claims where team_id = ${teamId(c)} and name = ${name} and status = 'pending' and expires_at > now()`;
    if (existing) return c.json(claimObject(existing), 200);
    const [row] = await ctx.sql`
      insert into domain_claims (team_id, domain_id, name, region, options, token)
      values (${teamId(c)}, ${uuid()}, ${name}, ${region}, ${ctx.sql.json(b as never)}, ${randomToken(32).toLowerCase()})
      returning *`;
    return c.json(claimObject(row!), 201);
  });

  r.get('/domains/:domain_id/claim', async (c, ctx) => {
    const id = uuidParam(c, 'domain_id', 'domain_id');
    const [row] = await ctx.sql`select * from domain_claims where team_id = ${teamId(c)} and domain_id = ${id} order by created_at desc limit 1`;
    if (!row) throw E.notFound('Domain claim not found');
    return c.json(claimObject(row));
  });

  r.post('/domains/:domain_id/claim/verify', async (c, ctx) => {
    const id = uuidParam(c, 'domain_id', 'domain_id');
    const [claim] = await ctx.sql`select * from domain_claims where team_id = ${teamId(c)} and domain_id = ${id} order by created_at desc limit 1`;
    if (!claim) throw E.notFound('Domain claim not found');
    if (claim.status !== 'pending') return c.json(claimObject(claim));
    if (new Date(String(claim.expires_at).replace(' ', 'T').replace(/\+00$/, 'Z')) < ctx.now()) {
      const [x] = await ctx.sql`update domain_claims set status = 'expired' where id = ${claim.id as string} returning *`;
      return c.json(claimObject(x!));
    }
    const want = `5050send-domain-verification=${claim.token}`;
    const txt = (await ctx.dns.txt(claim.name as string)).map(txtValue);
    if (!txt.includes(want)) return c.json(claimObject(claim));
    const [old] = await ctx.sql`select * from domains where lower(name) = ${claim.name as string}`;
    const [pending] = old ? await ctx.sql`select count(*)::int as n from emails where domain_id = ${old.id as string} and last_event = 'scheduled'` : [{ n: 0 }];
    if ((pending!.n as number) > 0) {
      const [x] = await ctx.sql`update domain_claims set status = 'blocked', blocked_reason = 'pending_scheduled_emails' where id = ${claim.id as string} returning *`;
      return c.json(claimObject(x!));
    }
    if (old) await deleteDomain(ctx, old as unknown as DomainRow);
    const opts = (claim.options ?? {}) as Record<string, unknown>;
    const [d] = await ctx.sql`
      insert into domains (id, team_id, name, region, open_tracking, click_tracking, tracking_subdomain, custom_return_path, cf_managed)
      values (${claim.domain_id as string}, ${teamId(c)}, ${claim.name as string}, ${claim.region as string}, ${opts.open_tracking === true}, ${opts.click_tracking === true},
              ${(opts.tracking_subdomain as string | undefined) ?? null}, ${(opts.custom_return_path as string | undefined) ?? null}, ${old ? (old.cf_managed as boolean) : false})
      returning *`;
    const fresh = await refreshFromCloudflare(ctx, d as unknown as DomainRow, { onboard: true });
    await emit(ctx, teamId(c), 'domain.created', domainEventData(fresh));
    const [x] = await ctx.sql`update domain_claims set status = 'completed' where id = ${claim.id as string} returning *`;
    return c.json(claimObject(x!));
  });

  r.get('/domains/:domain_id', async (c, ctx) => {
    const d = await loadDomain(ctx, teamId(c), uuidParam(c, 'domain_id', 'id'));
    return c.json(domainObject(d));
  });

  r.patch('/domains/:domain_id', async (c, ctx) => {
    const d = await loadDomain(ctx, teamId(c), uuidParam(c, 'domain_id', 'id'));
    await updateDomain(ctx, d, body(c));
    return c.json({ object: 'domain', id: d.id });
  });

  r.delete('/domains/:domain_id', async (c, ctx) => {
    const d = await loadDomain(ctx, teamId(c), uuidParam(c, 'domain_id', 'id'));
    await deleteDomain(ctx, d);
    return c.json({ object: 'domain', id: d.id, deleted: true });
  });

  r.post('/domains/:domain_id/verify', async (c, ctx) => {
    const d = await loadDomain(ctx, teamId(c), uuidParam(c, 'domain_id', 'id'));
    await startVerification(ctx, d);
    return c.json({ object: 'domain', id: d.id });
  });
}
