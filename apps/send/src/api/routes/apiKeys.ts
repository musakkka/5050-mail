import { E } from '../../lib/errors.js';
import { isUuid } from '../../lib/ids.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { createApiKey } from '../../services/apiKeys.js';
import { body, query, teamId, uuidParam, type Router } from '../router.js';

export function validateKeyInput(b: Record<string, unknown>) {
  if (b.name === undefined || b.name === null) throw E.missingField('name');
  if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
  if (b.name.length > 50) throw E.validation('The `name` field must be at most 50 characters.');
  const permission = b.permission ?? 'full_access';
  if (permission !== 'full_access' && permission !== 'sending_access') throw E.validation('Invalid `permission` field. It must be `full_access` or `sending_access`.');
  let domainId: string | null = null;
  if (b.domain_id !== undefined && b.domain_id !== null && b.domain_id !== '') {
    if (!isUuid(b.domain_id)) throw E.invalidUuid('domain_id');
    if (permission !== 'sending_access') throw E.validation('The `domain_id` field can only be used with `sending_access` permission.');
    domainId = b.domain_id.toLowerCase();
  }
  return { name: b.name, permission: permission as 'full_access' | 'sending_access', domainId };
}

export function registerApiKeyRoutes(r: Router) {
  r.post('/api-keys', async (c, ctx) => {
    const v = validateKeyInput(body(c));
    if (v.domainId) {
      const [d] = await ctx.sql`select id from domains where id = ${v.domainId} and team_id = ${teamId(c)}`;
      if (!d) throw E.notFound('Domain not found');
    }
    const auth = c.get('auth');
    const k = await createApiKey(ctx.sql, teamId(c), v.name, v.permission, v.domainId, auth.actor ?? (auth.apiKeyId ? `api_key:${auth.apiKeyId}` : null));
    return c.json({ id: k.id, object: 'api_key', token: k.token }, 201);
  });

  r.get('/api-keys', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'api_keys', ctx.sql`team_id = ${teamId(c)}`, page, ctx.sql`id, name, created_at, last_used_at`);
    return c.json(list(rows.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at ?? null })), hasMore));
  });

  r.patch('/api-keys/:api_key_id', async (c, ctx) => {
    const id = uuidParam(c, 'api_key_id', 'api_key_id');
    const b = body(c);
    if (b.name === undefined || b.name === null) throw E.missingField('name');
    if (typeof b.name !== 'string') throw E.validation('Invalid `name` field. It must be a string.');
    if (b.name.length > 50) throw E.validation('The `name` field must be at most 50 characters.');
    const rows = await ctx.sql`update api_keys set name = ${b.name} where id = ${id} and team_id = ${teamId(c)} returning id`;
    if (!rows.length) throw E.notFound('API key not found');
    return c.json({ object: 'api_key', id });
  });

  r.delete('/api-keys/:api_key_id', async (c, ctx) => {
    const id = uuidParam(c, 'api_key_id', 'api_key_id');
    const rows = await ctx.sql`delete from api_keys where id = ${id} and team_id = ${teamId(c)} returning id`;
    if (!rows.length) throw E.notFound('API key not found');
    return c.json({ object: 'api_key', id, deleted: true });
  });
}
