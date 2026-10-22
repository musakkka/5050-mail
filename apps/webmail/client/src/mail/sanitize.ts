/**
 * Email HTML sanitisation (DOMPurify) for display in a sandboxed iframe, plus
 * helpers for quoting into the composer and HTML→text.
 *
 * Security model:
 *  - DOMPurify strips scripts, event handlers, javascript: URLs, forms, frames, <base>, <meta>, <link>.
 *  - The result is rendered via `srcdoc` in an <iframe sandbox="allow-same-origin allow-popups
 *    allow-popups-to-escape-sandbox"> — no allow-scripts, so nothing can execute even if
 *    something slipped through.
 *  - The srcdoc carries its own CSP <meta>: remote images/fonts are blocked unless the user
 *    clicked "Display images below".
 */
import DOMPurify from 'dompurify';
import { escapeHtml } from '../lib/format';

export interface RenderOptions {
  allowRemote: boolean;
  /** cid (without <>) → URL (same-origin download URL). */
  cidMap?: Record<string, string>;
  dark?: boolean;
}

export interface RenderedEmail {
  /** Complete srcdoc document with quoted text removed. */
  trimmed: string;
  /** Complete srcdoc document including quoted text. */
  full: string;
  hasQuote: boolean;
  /** The message references remote images that were blocked. */
  blockedRemote: boolean;
  /** Message has its own backgrounds/colours → render on a light canvas even in dark mode. */
  styled: boolean;
}

const FORBID_TAGS = [
  'svg',
  'math',
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'base',
  'link',
  'meta',
  'noscript',
  'template',
  'portal',
  'dialog',
];
const FORBID_ATTR = ['action', 'formaction', 'srcdoc', 'ping', 'autofocus', 'contenteditable'];
const QUOTE_SELECTORS = [
  '.ff_quote',
  '.gmail_quote',
  'blockquote[type="cite"]',
  '#divRplyFwdMsg',
  'div[id^="divRplyFwdMsg"]',
  '#appendonsend',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  '.protonmail_quote',
  'blockquote.gmail_quote',
];

const REMOTE_RE = /^\s*(https?:)?\/\//i;

function ownOrigin(): string {
  return typeof location !== 'undefined' ? location.origin : '';
}

/**
 * Classify a resource URL found in email HTML/CSS:
 *  - 'data'   — inline data: URL (always allowed)
 *  - 'remote' — absolute http(s) URL on another origin (allowed only when images are shown)
 *  - 'local'  — relative or same-origin URL: never allowed (email must not make
 *               cookie-authenticated requests to the BFF, e.g. /jmap/eventsource)
 */
export function classifyUrl(raw: string): 'data' | 'remote' | 'local' | 'other' {
  const v = raw.trim();
  if (/^data:/i.test(v)) return 'data';
  if (/^cid:/i.test(v)) return 'other';
  if (REMOTE_RE.test(v)) {
    try {
      const u = new URL(v, 'https://placeholder.invalid');
      return u.origin === ownOrigin() ? 'local' : 'remote';
    } catch {
      return 'local';
    }
  }
  return 'local';
}

function purifier() {
  // A fresh instance per call so hooks don't leak between renders.
  return DOMPurify(window);
}

/**
 * Resolve CSS escapes (`\72`, `\72 `, `\(`, escaped newlines) so that filters below see what the
 * browser will see: `u\72l(https://…)` is `url(https://…)`, `posit\69on` is `position`.
 * The decoded text is what we emit, so nothing escaped can slip past afterwards.
 */
export function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|(\r\n|[\n\r\f])|([\s\S]))/gi, (_m, hex: string | undefined, nl: string | undefined, ch: string | undefined) => {
    if (nl) return '';
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
    }
    return ch ?? '';
  });
}

/**
 * Call `fn` for every `url(...)` token (quoted or not, including `)` inside quotes) and replace it
 * with the result. An unterminated url( swallows the rest of the text, as CSS does.
 */
function replaceCssUrls(css: string, fn: (url: string, token: string) => string): string {
  let out = '';
  let i = 0;
  const re = /url\(/gi;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    out += css.slice(i, m.index);
    let j = m.index + 4;
    while (j < css.length && /\s/.test(css[j]!)) j++;
    let url = '';
    const q = css[j];
    if (q === '"' || q === "'") {
      const end = css.indexOf(q, j + 1);
      url = css.slice(j + 1, end < 0 ? css.length : end);
      j = end < 0 ? css.length : end + 1;
      const close = css.indexOf(')', j);
      j = close < 0 ? css.length : close + 1;
    } else {
      const close = css.indexOf(')', j);
      url = css.slice(j, close < 0 ? css.length : close).trim();
      j = close < 0 ? css.length : close + 1;
    }
    out += fn(url, css.slice(m.index, j));
    i = j;
    re.lastIndex = j;
  }
  return out + css.slice(i);
}

/** Replace whole function calls (`name(` … matching `)`, quote-aware) found by `start`. */
function replaceCssCalls(css: string, start: RegExp, fn: (call: string) => string): string {
  let out = '';
  let i = 0;
  for (let m = start.exec(css); m; m = start.exec(css)) {
    out += css.slice(i, m.index);
    let j = m.index + m[0].length;
    let depth = 1;
    let quote = '';
    for (; j < css.length && depth; j++) {
      const ch = css[j]!;
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out += fn(css.slice(m.index, j));
    i = j;
    start.lastIndex = j;
  }
  return out + css.slice(i);
}

/**
 * Make email CSS safe: no @import, no same-origin / relative URLs (they'd be cookie-authenticated
 * requests to the BFF), remote URLs only when images are allowed, no fixed/sticky overlays.
 * `compose` (the editor lives in our own document): only data: URLs and no positioning at all.
 */
function sanitizeCss(css: string, opts: { allowRemote: boolean; compose?: boolean }, onBlocked: () => void = () => {}): string {
  let out = decodeCssEscapes(css).replace(/@import[^;]*;?/gi, '');
  // image-set("https://…" 1x) and src("…") load images without url(): drop unless remote content is allowed.
  if (!opts.allowRemote || opts.compose) {
    out = replaceCssCalls(out, /(?:-webkit-)?image-set\s*\(|\bsrc\s*\(/gi, () => {
      onBlocked();
      return 'none';
    });
  }
  out = replaceCssUrls(out, (url, token) => {
    const kind = classifyUrl(url);
    if (kind === 'data') return token;
    if (kind === 'remote' && opts.allowRemote && !opts.compose) return token;
    if (kind === 'remote') onBlocked();
    return 'none';
  });
  return opts.compose
    ? out.replace(/(^|[;{\s])position\s*:[^;}]*/gi, '$1position:static')
    : out.replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static');
}

function stripRemoteCss(css: string, allowRemote: boolean, onBlocked: () => void): string {
  return sanitizeCss(css, { allowRemote }, onBlocked);
}

function sanitizeToFragment(html: string, opts: RenderOptions, state: { blocked: boolean; styles: string[] }) {
  const dp = purifier();
  dp.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      state.styles.push(stripRemoteCss(node.textContent, opts.allowRemote, () => (state.blocked = true)));
    }
  });
  dp.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    const tag = el.tagName?.toLowerCase();
    // Links: always new tab, no referrer/opener.
    if (tag === 'a' || tag === 'area') {
      const href = el.getAttribute('href') ?? '';
      // Only external web links, mail/tel links and in-message anchors.
      if (href && !href.startsWith('#') && !/^(mailto|tel):/i.test(href) && classifyUrl(href) !== 'remote') el.removeAttribute('href');
      else if (href && !href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    // Images and other remote resources.
    for (const attr of ['src', 'background', 'poster']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (v.toLowerCase().startsWith('cid:')) {
        const cid = v.slice(4).replace(/^<|>$/g, '');
        const url = opts.cidMap?.[cid] ?? opts.cidMap?.[decodeURIComponent(cid)];
        if (url) el.setAttribute(attr, url);
        else el.removeAttribute(attr);
      } else {
        const kind = classifyUrl(v);
        if (kind === 'remote') {
          if (!opts.allowRemote) {
            state.blocked = true;
            el.setAttribute(`data-ff-${attr}`, v);
            el.removeAttribute(attr);
          }
        } else if (kind !== 'data') el.removeAttribute(attr);
      }
    }
    if (el.hasAttribute('srcset')) {
      if (!opts.allowRemote && REMOTE_RE.test(el.getAttribute('srcset') ?? '')) state.blocked = true;
      el.removeAttribute('srcset');
    }
    const style = el.getAttribute('style');
    if (style)
      el.setAttribute(
        'style',
        stripRemoteCss(style, opts.allowRemote, () => (state.blocked = true)),
      );
  });
  const frag = dp.sanitize(html, {
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS: ['style', 'center', 'font'],
    ADD_ATTR: ['target', 'bgcolor', 'background', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'width', 'height', 'color', 'face', 'size'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORCE_BODY: true,
  }) as HTMLElement;
  // <style> elements were captured by the hook; drop them from the body (re-added in <head>).
  frag.querySelectorAll('style').forEach((s) => s.remove());
  return frag;
}

/** Remove trailing quoted content. Returns true if something was removed. */
export function trimQuote(body: HTMLElement): boolean {
  const cand = body.querySelector(QUOTE_SELECTORS.join(','));
  let start: Element | null = cand;
  if (!start) {
    // Outlook-style "-----Original Message-----" or "From: … Sent: …" after an <hr>.
    const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/^\s*-{3,}\s*(Original Message|Forwarded message)\s*-{3,}/i.test(n.textContent ?? '')) {
        start = n.parentElement;
        break;
      }
    }
  }
  if (!start || start === body) return false;
  // Pull in a preceding "On … wrote:" attribution.
  const prev = start.previousElementSibling;
  if (prev && /wrote:\s*$/i.test(prev.textContent ?? '') && (prev.textContent ?? '').length < 300) start = prev;
  // Remove start and everything after it, walking up to body.
  let node: Node | null = start;
  while (node && node !== body) {
    let sib = node.nextSibling;
    while (sib) {
      const nx: ChildNode | null = sib.nextSibling;
      sib.parentNode?.removeChild(sib);
      sib = nx;
    }
    const parent: Node | null = node.parentNode;
    if (node === start) parent?.removeChild(node);
    node = parent;
  }
  return true;
}

const BASE_CSS = (dark: boolean, styled: boolean) => `
:root{color-scheme:${dark && !styled ? 'dark' : 'light'}}
html,body{margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:small;line-height:1.5;color:${dark && !styled ? '#e3e3e3' : '#222222'};background:${dark && styled ? '#ffffff' : 'transparent'};word-wrap:break-word;overflow-wrap:anywhere;overflow-y:hidden}
${dark && styled ? 'body{padding:12px;border-radius:8px}' : ''}
a{color:${dark && !styled ? '#a8c7fa' : '#0b57d0'}}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 .8ex;border-left:1px solid ${dark && !styled ? '#5f6368' : '#ccc'};padding-left:1ex}
.ff-plain{white-space:normal;font-family:Arial,Helvetica,sans-serif}
img:not([src]){display:none}
`;

function documentFor(bodyHtml: string, styles: string[], opts: RenderOptions, styled: boolean): string {
  const remote = opts.allowRemote ? ' https: http:' : '';
  // Same-origin loads are limited to attachment downloads (inline cid: images), never other BFF routes.
  const dl = `${ownOrigin()}/jmap/download/`;
  const csp = `default-src 'none'; img-src ${dl} data: blob:${remote}; style-src 'unsafe-inline'; font-src data:${remote}; media-src ${dl}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${BASE_CSS(!!opts.dark, styled)}</style>${styles
    // Escape "<" so CSS text can never close the <style> element (single-pass stripping can be defeated).
    .map((s) => `<style>${s.replace(/</g, '\\3c ')}</style>`)
    .join('')}</head><body>${bodyHtml}</body></html>`;
}

function looksStyled(html: string): boolean {
  return /bgcolor\s*=|background(-color)?\s*:|background\s*=|<table[^>]+width/i.test(html);
}

export function renderEmailHtml(html: string, opts: RenderOptions): RenderedEmail {
  const state = { blocked: false, styles: [] as string[] };
  const frag = sanitizeToFragment(html, opts, state);
  const styled = looksStyled(html);
  const full = frag.innerHTML;
  const clone = frag.cloneNode(true) as HTMLElement;
  let hasQuote = trimQuote(clone);
  const trimmedHtml = clone.innerHTML;
  if (hasQuote && !(clone.textContent ?? '').trim() && !clone.querySelector('img')) hasQuote = false;
  return {
    trimmed: documentFor(hasQuote ? trimmedHtml : full, state.styles, opts, styled),
    full: documentFor(full, state.styles, opts, styled),
    hasQuote,
    blockedRemote: state.blocked,
    styled,
  };
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

/** Plain text → safe HTML with links and > quotes as blockquotes. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let depth = 0;
  for (const raw of lines) {
    const m = /^((?:>\s?)*)(.*)$/.exec(raw)!;
    const d = (m[1]!.match(/>/g) ?? []).length;
    while (depth < d) {
      out.push('<blockquote type="cite">');
      depth++;
    }
    while (depth > d) {
      out.push('</blockquote>');
      depth--;
    }
    const linked = escapeHtml(m[2]!).replace(
      URL_RE,
      (u) => `<a href="${u.startsWith('www.') ? 'https://' + u : u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`,
    );
    // One block per line with dir="auto", so Hebrew/Arabic lines read right-to-left in an LTR mail.
    out.push(`<div dir="auto">${linked || '<br>'}</div>`);
  }
  while (depth-- > 0) out.push('</blockquote>');
  // Mark an "On … wrote:" line right before a quote so trimming includes it.
  return `<div class="ff-plain">${out.join('')}</div>`;
}

/** Sanitise HTML for insertion into the compose editor (our own document!). */
export function sanitizeForCompose(html: string): string {
  const dp = purifier();
  dp.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    // The composer lives in our own document: only inline data: images survive.
    for (const attr of ['src', 'background', 'poster', 'srcset']) {
      const v = el.getAttribute(attr);
      if (v && (attr === 'srcset' || classifyUrl(v) !== 'data')) el.removeAttribute(attr);
    }
    const href = el.getAttribute('href');
    if (href && !href.startsWith('#') && !/^(mailto|tel):/i.test(href) && classifyUrl(href) !== 'remote') el.removeAttribute('href');
    const style = el.getAttribute('style');
    if (style) el.setAttribute('style', sanitizeCss(style, { allowRemote: false, compose: true }));
    el.removeAttribute('class');
    el.removeAttribute('id');
  });
  return dp.sanitize(html, {
    FORBID_TAGS: [...FORBID_TAGS, 'style', 'title', 'head', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR,
    ADD_ATTR: ['target'],
  }) as unknown as string;
}

/** Plain-text alternative of an HTML body. Quotes become "> " lines. */
export function htmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (n: Node, quote: number): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\s+/g, ' ');
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'head') return '';
    if (tag === 'br') return '\n';
    if (tag === 'img') return el.getAttribute('alt') ? `[${el.getAttribute('alt')}]` : '';
    let inner = [...el.childNodes].map((c) => walk(c, tag === 'blockquote' ? quote + 1 : quote)).join('');
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('mailto:') && href !== inner.trim()) inner = `${inner} <${href}>`;
    }
    if (tag === 'li') inner = `* ${inner}`;
    if (tag === 'blockquote') {
      return (
        '\n' +
        inner
          .trim()
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n') +
        '\n'
      );
    }
    if (/^(p|div|li|tr|h\d|ul|ol|table|pre)$/.test(tag)) return `${inner}\n`;
    return inner;
  };
  return walk(doc.body, 0)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
