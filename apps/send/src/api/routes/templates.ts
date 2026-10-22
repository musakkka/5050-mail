import { E } from '../../lib/errors.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import {
  createTemplate, duplicateTemplate, findTemplate, publishTemplate, templateListItem, templateObject, updateTemplate,
} from '../../services/templates.js';
import type { AppContext } from '../../context.js';
import { body, param, query, teamId, type Router } from '../router.js';

async function load(ctx: AppContext, team: string, key: string) {
  const t = await findTemplate(ctx, team, key);
  if (!t) throw E.notFound('Template not found');
  return t;
}

export function registerTemplateRoutes(r: Router) {
  r.post('/templates', async (c, ctx) => {
    const id = await createTemplate(ctx, teamId(c), body(c));
    return c.json({ id, object: 'template' }, 201);
  });

  r.get('/templates', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'templates', ctx.sql`team_id = ${teamId(c)}`, page,
      ctx.sql`id, name, status, published_at, created_at, updated_at, alias`);
    return c.json(list(rows.map(templateListItem), hasMore));
  });

  r.get('/templates/:id', async (c, ctx) => c.json(templateObject(await load(ctx, teamId(c), param(c, 'id')))));

  r.patch('/templates/:id', async (c, ctx) => {
    const t = await load(ctx, teamId(c), param(c, 'id'));
    await updateTemplate(ctx, t, body(c));
    return c.json({ object: 'template', id: t.id });
  });

  r.delete('/templates/:id', async (c, ctx) => {
    const t = await load(ctx, teamId(c), param(c, 'id'));
    await ctx.sql`delete from templates where id = ${t.id}`;
    return c.json({ object: 'template', id: t.id, deleted: true });
  });

  r.post('/templates/:id/publish', async (c, ctx) => {
    const t = await load(ctx, teamId(c), param(c, 'id'));
    await publishTemplate(ctx, t);
    return c.json({ object: 'template', id: t.id });
  });

  r.post('/templates/:id/duplicate', async (c, ctx) => {
    const t = await load(ctx, teamId(c), param(c, 'id'));
    const id = await duplicateTemplate(ctx, t);
    return c.json({ object: 'template', id });
  });
}
