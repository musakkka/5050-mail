// Shared page shell: <head>, meta/OG tags, theme bootstrap, header, footer.
import { readFileSync } from 'node:fs';
import { escapeHtml } from './markdown.mjs';

export const SITE = {
  name: '5050 Mail',
  url: (process.env.SITE_URL || 'http://localhost:4321').replace(/\/+$/, ''),
  repo: 'https://github.com/musakkka/5050-mail',
  install: 'curl -fsSL https://raw.githubusercontent.com/musakkka/5050-mail/main/install.sh | sudo bash',
};

// The bare 5050 mark, inlined from the brand kit file so its two plates can
// follow the theme (multiplied on paper, screened on ink).
const logo = readFileSync(new URL('../public/brand/5050-logo.svg', import.meta.url), 'utf8');
const groups = [...logo.matchAll(/<g class="pl (li|aq)"[^>]*>([\s\S]*?)<\/g>/g)];
const plate = (k) => {
  const g = groups.find((m) => m[1] === k);
  return [...g[2].matchAll(/d="([^"]+)"/g)].map((m) => `<path d="${m[1]}" fill-rule="evenodd"/>`).join('');
};
export const MARK_PATHS = { lime: plate('li'), aqua: plate('aq') };

export function mark({ cls = 'mark', label = '' } = {}) {
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  return (
    `<svg class="${cls}" viewBox="96 44 844 352" ${a11y}>` +
    `<g class="plate plate--lime">${MARK_PATHS.lime}</g>` +
    `<g class="plate plate--aqua">${MARK_PATHS.aqua}</g></svg>`
  );
}

const ICONS = {
  github:
    '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  theme:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2v14a7 7 0 0 1 0-14Z"/></svg>',
  menu:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"/></svg>',
};
export { ICONS };

export function head({ title, description, path, extraCss = [] }) {
  const url = SITE.url + path;
  const fullTitle = title === SITE.name ? title : `${title} · ${SITE.name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F4EFE3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1C1A24" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE.name}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE.url}/brand/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The 5050 mark: a lime 50 and an aqua 50, overlapping.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(fullTitle)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${SITE.url}/brand/og.png">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preload" href="/fonts/archivo-wdth.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/opensauceone-regular.woff2" as="font" type="font/woff2" crossorigin>
<script>try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}document.documentElement.classList.add('js')</script>
<link rel="stylesheet" href="/assets/base.css">
${extraCss.map((c) => `<link rel="stylesheet" href="/assets/${c}">`).join('\n')}
</head>`;
}

export function themeButton() {
  return `<button type="button" class="icon-btn" data-theme-toggle aria-label="Switch colour theme" title="Switch colour theme">${ICONS.theme}</button>`;
}

export function siteHeader({ current = '' } = {}) {
  const link = (href, label, key) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="site-header__inner">
    <a class="brand" href="/" aria-label="5050 Mail home">${mark()}</a>
    <nav class="site-nav" aria-label="Main">
      ${link('/docs/', 'Docs', 'docs')}
      ${link('/docs/send-api/', 'Send API', 'send')}
      ${link('/#cost', 'Cost', 'cost')}
      <a href="${SITE.repo}" class="site-nav__gh" rel="noopener">${ICONS.github}<span>GitHub</span></a>
      ${themeButton()}
    </nav>
  </div>
</header>`;
}
