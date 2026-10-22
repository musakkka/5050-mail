import { E } from '../../lib/errors.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { createImport, importObject } from '../../services/imports.js';
import { query, teamId, uuidParam, type Router } from '../router.js';

export function registerImportRoutes(r: Router) {
  r.post('/contacts/imports', async (c, ctx) => {
    if (!(c.req.header('content-type') ?? '').startsWith('multipart/form-data')) throw E.validation('This endpoint accepts `multipart/form-data`.');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw E.validation('Invalid multipart body.');
    }
    const id = await createImport(ctx, teamId(c), form);
    return c.json({ object: 'contact_import', id }, 201);
  });

  r.get('/contacts/imports', async (c, ctx) => {
    const q = query(c);
    const page = parsePage(q, 20);
    if (q.status && !['queued', 'in_progress', 'completed', 'failed'].includes(q.status)) throw E.validation('Invalid `status` parameter. It must be queued, in_progress, completed or failed.');
    const where = q.status ? ctx.sql`team_id = ${teamId(c)} and status = ${q.status}` : ctx.sql`team_id = ${teamId(c)}`;
    const { rows, hasMore } = await paginate(ctx.sql, 'contact_imports', where, page, ctx.sql`id, status, created_at, completed_at, counts`);
    return c.json(list(rows.map(importObject), hasMore));
  });

  r.get('/contacts/imports/:id', async (c, ctx) => {
    const [row] = await ctx.sql`select id, status, created_at, completed_at, counts from contact_imports where id = ${uuidParam(c, 'id')} and team_id = ${teamId(c)}`;
    if (!row) throw E.notFound('Contact import not found');
    return c.json(importObject(row));
  });
}
