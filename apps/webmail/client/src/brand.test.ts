import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import manifestJson from '../public/site.webmanifest?raw';

// Keys are paths like "../public/brand/icon-192.png"; used to check referenced files exist.
const publicFiles = new Set(Object.keys(import.meta.glob('../public/**/*', { query: '?url' })).map((k) => k.replace('../public', '')));
const meta = (attr: 'name' | 'property', key: string) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1];

describe('index.html branding', () => {
  it('has the 5050 Mail title and description', () => {
    expect(html).toContain('<title>5050 Mail</title>');
    expect(meta('name', 'description')).toMatch(/^5050 Mail: .*email/);
    expect(html).not.toContain('rel="canonical"'); // self-hosted: no fixed origin
    expect(html.match(/<meta name="theme-color"[^>]*media="\(prefers-color-scheme: (light|dark)\)"/g)).toHaveLength(2);
  });

  it('has Open Graph and Twitter card tags with origin-relative images', () => {
    expect(meta('property', 'og:title')).toBe('5050 Mail');
    expect(meta('property', 'og:site_name')).toBe('5050 Mail');
    expect(meta('property', 'og:image')).toBe('/brand/og-image.png');
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(meta('name', 'twitter:image')).toBe(meta('property', 'og:image'));
  });

  it('references only icons that exist in public/', () => {
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    const manifest = JSON.parse(manifestJson) as { name: string; icons: { src: string; sizes: string }[] };
    expect(manifest.name).toBe('5050 Mail');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const p of [...hrefs, ...manifest.icons.map((i) => i.src), '/brand/og-image.png']) expect(publicFiles.has(p), p).toBe(true);
  });

  it('carries no leftover private-deployment names or Vite defaults', () => {
    expect(html).not.toMatch(/cloud mail|vite/i);
  });
});
