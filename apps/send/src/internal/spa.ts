/**
 * Serves the dashboard SPA (send/web, built with `npm run build` there) on the
 * dashboard host: hashed assets with long-lived caching, other public files as-is,
 * and index.html for every other GET (client-side routes). /api/* never falls through.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function dashboardDistDir(): string {
  if (process.env.DASHBOARD_DIST) return path.resolve(process.env.DASHBOARD_DIST);
  // src/internal or dist/internal → send/web/dist
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
}

/** Mounts the SPA. Returns false (and mounts nothing) when no build is present. */
export function mountSpa(app: Hono<any>, dir = dashboardDistDir()): boolean {
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) return false;
  const root = path.resolve(dir) + path.sep;

  const file = (c: Context, rel: string): Response | null => {
    const p = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!p.startsWith(root) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const ext = path.extname(p).toLowerCase();
    const immutable = rel.startsWith('/assets/');
    return c.body(fs.readFileSync(p), 200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  };

  app.get('*', (c) => {
    const p = c.req.path;
    if (p === '/api' || p.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
    if (p !== '/' && p !== '/index.html') {
      const hit = file(c, p);
      if (hit) return hit;
      // A missing hashed asset is a real 404, not the app shell.
      if (p.startsWith('/assets/') || /\.[a-z0-9]{2,6}$/i.test(p)) return c.text('Not found', 404);
    }
    return c.body(fs.readFileSync(indexPath), 200, { 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-cache' });
  });
  return true;
}
