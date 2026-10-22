/**
 * Renders every static/overlay layer the compositor needs with the browser, so type and edges are
 * pixel-perfect and on-brand: background, browser bar per URL, window mask/border, cursor, click ring,
 * terminal states (from the recording) and the title-card entrance animations (sampled at 60 fps
 * with the Web Animations API, so they are frame-exact).
 *
 *   CAPTURE=.work/capture OUT=.work/assets npx tsx render-assets.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = process.env.CAPTURE ?? path.join(HERE, '.work/capture');
const OUT = process.env.OUT ?? path.join(HERE, '.work/assets');
const FPS = 60;
const CARDS = ['intro', 'mail', 'admin', 'send', 'outro'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const cap = JSON.parse(fs.readFileSync(path.join(CAPTURE, 'capture.json'), 'utf8')) as {
  hosts: Record<string, string>;
  events: { type: string; url?: string; [k: string]: unknown }[];
};

// stage page with the brand mark inlined
const svg = fs.readFileSync(path.join(HERE, 'assets/5050-mark.svg'), 'utf8');
const group = (cls: string) => svg.match(new RegExp(`<g class="pl ${cls}"[^>]*>[\\s\\S]*?</g>`))![0].replace(/class="[^"]*"/, '');
const html = fs
  .readFileSync(path.join(HERE, 'assets/stage.html'), 'utf8')
  .replace('`__MARK__`', JSON.stringify({ lime: group('li'), aqua: group('aq') }));
const stagePath = path.join(HERE, 'assets/.stage.html');
fs.writeFileSync(stagePath, html);

const browser = await chromium.launch();
const mk = async (dsf: number) => {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dsf });
  await p.goto(`file://${stagePath}`);
  await p.evaluate(() => document.fonts.ready);
  return p;
};
const p1 = await mk(1);
const p2 = await mk(2);
const shot = async (p: Page, id: string, file: string, omit = true) =>
  p.locator(`#${id}`).screenshot({ path: path.join(OUT, file), omitBackground: omit, animations: 'allow' });

const manifest: Record<string, unknown> = {};

await p1.evaluate(() => (window as any).showId('bg'));
await shot(p1, 'bg', 'bg.png', false);

// browser bar per displayed URL
const display = (u: string) => {
  try {
    const url = new URL(u);
    const host = cap.hosts[url.host] ?? url.host;
    let pathn = url.pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '/…').replace(/\?.*$/, '');
    if (pathn === '/') pathn = '';
    return `${host}${pathn}`;
  } catch {
    return '';
  }
};
const urls = [...new Set(cap.events.filter((e) => e.type === 'url' && e.url?.startsWith('http')).map((e) => display(e.url!)))];
const bars: Record<string, string> = {};
for (const [i, u] of urls.entries()) {
  await p2.evaluate((x) => (window as any).setUrl(x), u);
  await shot(p2, 'bar', `bar_${i}.png`, false);
  bars[u] = `bar_${i}.png`;
}
manifest.bars = bars;
manifest.display = Object.fromEntries(cap.events.filter((e) => e.type === 'url' && e.url).map((e) => [e.url!, display(e.url!)]));

await p2.evaluate(() => (window as any).showId('frame'));
await shot(p2, 'frame', 'frame_mask.png');
await p2.evaluate(() => (window as any).showId('frameBorder'));
await shot(p2, 'frameBorder', 'frame_border.png');
await p2.evaluate(() => (window as any).showId('cursor'));
await shot(p2, 'cursor', 'cursor.png');
await p2.evaluate(() => (window as any).showId('ring'));
await shot(p2, 'ring', 'ring.png');

// terminal states
const terms: Record<string, string> = {};
let ti = 0;
for (const e of cap.events.filter((x) => x.type === 'term' && x.open)) {
  const key = JSON.stringify({ lines: e.lines, caret: e.caret, status: e.status });
  if (terms[key]) continue;
  await p2.evaluate((st) => (window as any).setTerm(st), e);
  const file = `term_${String(ti++).padStart(4, '0')}.png`;
  await shot(p2, 'term', file);
  terms[key] = file;
}
manifest.terms = terms;

// title cards: entrance animation frames, then the held last frame
const cards: Record<string, string[]> = {};
for (const name of CARDS) {
  const end = (await p1.evaluate((n) => (window as any).setCard(n), name)) as number;
  const n = Math.ceil((end / 1000) * FPS) + 1;
  cards[name] = [];
  for (let f = 0; f < n; f++) {
    await p1.evaluate((ms) => (window as any).seek(ms), Math.min(end, (f * 1000) / FPS));
    const file = `card_${name}_${String(f).padStart(3, '0')}.png`;
    await shot(p1, 'card', file, false);
    cards[name].push(file);
  }
}
manifest.cards = cards;

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.rmSync(stagePath);
await browser.close();
console.log(`assets: ${urls.length} bars, ${ti} terminal states, ${CARDS.length} cards → ${OUT}`);
