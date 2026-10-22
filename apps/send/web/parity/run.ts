/**
 * Visual parity: screenshot every dashboard view (mock data, dark theme) and
 * compare it with the matching reference capture.
 *
 *   REF_DIR=/path/to/resend-capture/shots npm run parity [-- name1 name2]
 *   WIDTHS=1440,1280,1024,390 npm run parity      (extra widths: screenshots only)
 *
 * Writes parity/out/<width>/<name>.png (ours) and, at 1440×900 when a reference
 * exists, parity/out/1440/<name>.diff.png (reference | ours | diff) plus
 * parity/out/report.json. The reference captures are never copied into the repo.
 */
import { chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { VIEWS, type View } from './views.ts';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
const REF = process.env.REF_DIR ?? '';
const WIDTHS = (process.env.WIDTHS ?? '1440').split(',').map(Number);
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

async function waitForServer(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureServer(): Promise<{ base: string; proc?: ChildProcess }> {
  if (process.env.BASE_URL) return { base: process.env.BASE_URL };
  const base = 'http://localhost:5179';
  if (await waitForServer(base, 500)) return { base };
  const proc = spawn('npx', ['vite', '--port', '5179', '--strictPort'], { cwd: path.join(ROOT, '..'), env: { ...process.env, VITE_MOCK: '1' }, stdio: 'ignore' });
  if (!(await waitForServer(base))) throw new Error('mock server did not start');
  return { base, proc };
}

function readPng(p: string): PNG {
  return PNG.sync.read(fs.readFileSync(p));
}

/** Crop/pad to w×h so images of different heights can be compared. */
function fit(img: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  out.data.fill(0);
  for (let y = 0; y < Math.min(h, img.height); y++) {
    const srcStart = y * img.width * 4;
    img.data.copy(out.data, y * w * 4, srcStart, srcStart + Math.min(w, img.width) * 4);
  }
  return out;
}

function sideBySide(a: PNG, b: PNG, d: PNG): PNG {
  const w = a.width;
  const h = a.height;
  const out = new PNG({ width: w * 3 + 16, height: h });
  out.data.fill(40);
  [a, b, d].forEach((img, i) => {
    for (let y = 0; y < h; y++) img.data.copy(out.data, (y * out.width + i * (w + 8)) * 4, y * w * 4, (y + 1) * w * 4);
  });
  return out;
}

async function prepare(page: Page, base: string, v: View, width: number) {
  await page.goto(base + '/login');
  await page.evaluate((mock) => {
    localStorage.setItem('send.theme', 'dark');
    localStorage.setItem('send.mock', mock ?? '');
    localStorage.removeItem('send.team');
  }, v.mock ?? '');
  await page.goto(base + v.path);
  await page.waitForLoadState('networkidle');
  if (v.action) await v.action(page, width);
  await page.waitForTimeout(v.settle ?? 450);
}

async function main() {
  const { base, proc } = await ensureServer();
  const browser = await chromium.launch();
  const report: Record<string, { mismatch?: number; ref?: string }> = {};
  try {
    for (const width of WIDTHS) {
      const height = width === 390 ? 844 : 900;
      fs.mkdirSync(path.join(OUT, String(width)), { recursive: true });
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark', deviceScaleFactor: 1 });
      for (const v of VIEWS) {
        if (only.length && !only.includes(v.name)) continue;
        if (width !== 1440 && v.desktopOnly) continue;
        const page = await ctx.newPage();
        try {
          await prepare(page, base, v, width);
          const ours = path.join(OUT, String(width), `${v.name}.png`);
          await page.screenshot({ path: ours });
          if (width === 1440 && REF && v.ref) {
            const refPath = path.join(REF, `${v.ref}.png`);
            if (fs.existsSync(refPath)) {
              const a = fit(readPng(refPath), 1440, 900);
              const b = fit(readPng(ours), 1440, 900);
              const d = new PNG({ width: 1440, height: 900 });
              const n = pixelmatch(a.data, b.data, d.data, 1440, 900, { threshold: 0.15, includeAA: false, alpha: 0.3 });
              fs.writeFileSync(path.join(OUT, '1440', `${v.name}.diff.png`), PNG.sync.write(sideBySide(a, b, d)));
              report[v.name] = { mismatch: Math.round((n / (1440 * 900)) * 10000) / 100, ref: v.ref };
              console.log(`${v.name.padEnd(28)} ${String(report[v.name]!.mismatch).padStart(6)}%  (ref ${v.ref})`);
            }
          } else if (width === 1440) console.log(`${v.name.padEnd(28)}   —      (no reference)`);
        } catch (e) {
          console.error(`${v.name}: ${(e as Error).message}`);
        } finally {
          await page.close();
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    proc?.kill();
  }
  if (Object.keys(report).length) {
    const file = path.join(OUT, 'report.json');
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(file, JSON.stringify({ ...prev, ...report }, null, 2));
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
