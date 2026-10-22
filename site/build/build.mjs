// Builds the static site into dist/. Plain Node, no dependencies.
//   node build/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, parseFrontMatter, toPlain, escapeHtml } from './markdown.mjs';
import { SITE, head, siteHeader, mark, ICONS, themeButton } from './layout.mjs';
import { renderLanding } from '../src/landing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const DOCS = join(ROOT, 'src/docs');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'assets'), { recursive: true });
cpSync(join(ROOT, 'public'), DIST, { recursive: true });
for (const f of readdirSync(join(ROOT, 'src/styles'))) cpSync(join(ROOT, 'src/styles', f), join(DIST, 'assets', f));
for (const f of readdirSync(join(ROOT, 'src/scripts'))) cpSync(join(ROOT, 'src/scripts', f), join(DIST, 'assets', f));

const write = (rel, html) => {
  const p = join(DIST, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, html);
};

// ------------------------------------------------------------------ docs
const nav = JSON.parse(readFileSync(join(DOCS, 'nav.json'), 'utf8'));
const order = nav.flatMap((g) => g.pages.map((slug) => ({ slug, group: g.group })));
const docUrl = (slug) => (slug === 'index' ? '/docs/' : `/docs/${slug}/`);

const pages = order.map(({ slug, group }) => {
  const file = join(DOCS, `${slug}.md`);
  const { data, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const { html, headings } = renderMarkdown(body);
  return { slug, group, url: docUrl(slug), title: data.title, description: data.description, html, headings, body };
});

function sidebar(current) {
  return nav
    .map(
      (g) =>
        `<div class="sidenav__group"><p class="sidenav__title">${escapeHtml(g.group)}</p><ul>` +
        g.pages
          .map((slug) => {
            const p = pages.find((x) => x.slug === slug);
            const cur = slug === current ? ' aria-current="page"' : '';
            return `<li><a href="${p.url}"${cur}>${escapeHtml(p.title)}</a></li>`;
          })
          .join('') +
        '</ul></div>',
    )
    .join('');
}

function toc(headings) {
  const items = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (items.length < 2) return '';
  return (
    '<nav class="toc" aria-label="On this page"><p class="toc__title">On this page</p><ul>' +
    items.map((h) => `<li class="toc__d${h.depth}"><a href="#${h.id}">${escapeHtml(h.text.replace(/<[^>]+>/g, ''))}</a></li>`).join('') +
    '</ul></nav>'
  );
}

function docsHeader() {
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header docs-header">
  <div class="site-header__inner">
    <button type="button" class="icon-btn docs-menu" data-docs-menu aria-controls="sidenav" aria-expanded="false" aria-label="Open documentation menu">${ICONS.menu}</button>
    <a class="brand" href="/" aria-label="5050 Mail home">${mark()}</a>
    <a class="docs-home" href="/docs/">Docs</a>
    <div class="search" role="search">
      <label for="q" class="visually-hidden">Search the docs</label>
      <span class="search__icon">${ICONS.search}</span>
      <input id="q" type="search" placeholder="Search docs" autocomplete="off" spellcheck="false"
        role="combobox" aria-controls="search-results" aria-expanded="false" aria-autocomplete="list">
      <kbd class="search__key" aria-hidden="true">/</kbd>
      <div id="search-results" class="search__results" role="listbox" aria-label="Search results" hidden></div>
    </div>
    <nav class="site-nav docs-nav" aria-label="Main">
      <a href="${SITE.repo}" class="site-nav__gh" rel="noopener">${ICONS.github}<span>GitHub</span></a>
      ${themeButton()}
    </nav>
  </div>
</header>`;
}

pages.forEach((p, i) => {
  const prev = pages[i - 1];
  const next = pages[i + 1];
  const pager =
    '<nav class="pager" aria-label="Previous and next page">' +
    (prev ? `<a class="pager__prev" href="${prev.url}" rel="prev"><span>Previous</span>${escapeHtml(prev.title)}</a>` : '<span></span>') +
    (next ? `<a class="pager__next" href="${next.url}" rel="next"><span>Next</span>${escapeHtml(next.title)}</a>` : '<span></span>') +
    '</nav>';
  const edit = `${SITE.repo}/edit/main/site/src/docs/${p.slug}.md`;
  const html = `${head({ title: p.slug === 'index' ? 'Docs' : p.title, description: p.description, path: p.url, extraCss: ['docs.css'] })}
<body class="docs">
${docsHeader()}
<div class="docs-shell">
  <aside class="sidenav" id="sidenav" aria-label="Documentation">
    <nav aria-label="Documentation pages">${sidebar(p.slug)}</nav>
  </aside>
  <main id="main" class="docs-main">
    <article class="prose" data-search-body>
      <p class="crumb">${escapeHtml(p.group)}</p>
      ${p.html}
    </article>
    ${pager}
    <p class="edit"><a href="${edit}" rel="noopener">Edit this page on GitHub</a></p>
  </main>
  ${toc(p.headings)}
</div>
<script src="/assets/site.js" defer></script>
<script src="/assets/docs.js" defer></script>
</body>
</html>`;
  write(p.slug === 'index' ? 'docs/index.html' : `docs/${p.slug}/index.html`, html);
});

// Search index: one entry per page and per h2 section.
const index = [];
for (const p of pages) {
  const sections = p.body.split(/\n(?=## )/);
  sections.forEach((s, k) => {
    const h = /^## (.*)$/m.exec(s);
    const heading = k === 0 ? '' : h ? h[1].replace(/`/g, '') : '';
    const id = k === 0 ? '' : p.headings.find((x) => x.depth === 2 && x.text === heading)?.id || '';
    index.push({ u: p.url + (id ? `#${id}` : ''), t: p.title, h: heading, x: toPlain(s.replace(/^---[\s\S]*?---/, '')).slice(0, 1200) });
  });
}
write('assets/search.json', JSON.stringify(index));

// ------------------------------------------------------------------ landing, 404, meta files
const hasMp4 = existsSync(join(ROOT, 'public/demo/demo.mp4'));
const hasWebm = existsSync(join(ROOT, 'public/demo/demo.webm'));
const hasDemo = hasMp4 || hasWebm;
const hasPoster = existsSync(join(ROOT, 'public/demo/poster.jpg'));
write('index.html', renderLanding({ hasDemo, hasPoster, hasMp4, hasWebm }));

write(
  '404.html',
  `${head({ title: 'Page not found', description: 'This page does not exist.', path: '/404.html', extraCss: ['landing.css'] })}
<body>
${siteHeader()}
<main id="main" class="notfound">
  <h1>That page isn't here</h1>
  <p>The link may be old, or the page moved. The docs have everything.</p>
  <p class="notfound__links"><a class="btn" href="/docs/">Open the docs</a> <a href="/">Back to the home page</a></p>
</main>
<script src="/assets/site.js" defer></script>
</body></html>`,
);

write(
  'site.webmanifest',
  JSON.stringify({
    name: '5050 Mail',
    short_name: '5050 Mail',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: '#F4EFE3',
    background_color: '#F4EFE3',
    display: 'browser',
  }),
);
const urls = ['/', ...pages.map((p) => p.url)];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE.url}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);

// ------------------------------------------------------------------ link check
const known = new Map(); // url -> Set(ids)
const collectIds = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.html') ? [join(dir, d.name)] : []));
const htmlFiles = walk(DIST);
for (const f of htmlFiles) {
  let u = '/' + f.slice(DIST.length + 1).replace(/index\.html$/, '');
  known.set(u, collectIds(readFileSync(f, 'utf8')));
}
const broken = [];
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
    const [path, hash] = m[1].split('#');
    if (/\.(png|svg|css|js|json|xml|txt|webmanifest|mp4|jpg|woff2)$/.test(path)) {
      if (!existsSync(join(DIST, path))) broken.push(`${f.slice(DIST.length)} -> ${m[1]}`);
      continue;
    }
    const ids = known.get(path) ?? known.get(path.endsWith('/') ? path : path + '/');
    if (!ids) broken.push(`${f.slice(DIST.length)} -> ${m[1]}`);
    else if (hash && !ids.has(hash)) broken.push(`${f.slice(DIST.length)} -> ${m[1]} (missing #${hash})`);
  }
}
if (broken.length) {
  console.error('Broken internal links:\n  ' + broken.join('\n  '));
  process.exit(1);
}
console.log(`built ${htmlFiles.length} pages into dist/ (demo video: ${hasDemo ? 'yes' : 'not yet'})`);
