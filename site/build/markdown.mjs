// A small Markdown renderer for the docs. No dependencies on purpose: the site
// builds with plain Node, so `npm run build` works offline and stays fast.
// Supports: front matter, headings (with ids), paragraphs, ul/ol (one nested
// level), fenced code (with an optional title="..."), tables, callouts
// (> [!NOTE] / [!TIP] / [!WARNING]), blockquotes and raw HTML blocks.

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function parseFrontMatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { data, body: src.slice(m[0].length) };
}

/** Inline formatting: code spans first (protected), then links, bold, italics. */
export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Raw inline HTML we allow: <kbd>, <br>.
  const keep = [];
  s = s.replace(/<(\/?)(kbd|br)\s*\/?>/g, (m) => {
    keep.push(m);
    return `\u0001${keep.length - 1}\u0001`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const ext = /^https?:\/\//.test(href);
    return `<a href="${href}"${ext ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[Number(i)]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

// --- code highlighting: comments and strings only, honest and cheap ---------
const COMMENT = {
  sh: /#.*$/, bash: /#.*$/, shell: /#.*$/, env: /#.*$/, dotenv: /#.*$/, yaml: /#.*$/, toml: /#.*$/,
  py: /#.*$/, python: /#.*$/, ruby: /#.*$/, rb: /#.*$/,
  js: /\/\/.*$/, ts: /\/\/.*$/, javascript: /\/\/.*$/, typescript: /\/\/.*$/, go: /\/\/.*$/, php: /\/\/.*$/,
};

export function highlight(code, lang) {
  const cRe = COMMENT[lang];
  return code
    .split('\n')
    .map((line) => {
      let out = '';
      let i = 0;
      while (i < line.length) {
        const rest = line.slice(i);
        // comment (only when it starts a token, not inside a URL like https://)
        if (cRe) {
          const m = cRe.exec(rest);
          if (m && m.index === 0 && (i === 0 || /\s/.test(line[i - 1]))) {
            out += `<span class="t-c">${escapeHtml(rest)}</span>`;
            break;
          }
        }
        const ch = line[i];
        if ((ch === '"' || ch === "'") && lang !== 'text' && lang !== 'dns' && lang !== 'zone') {
          let j = i + 1;
          while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
          const str = line.slice(i, Math.min(j + 1, line.length));
          out += `<span class="t-s">${escapeHtml(str)}</span>`;
          i += str.length;
          continue;
        }
        if (lang === 'env' || lang === 'dotenv') {
          const m = /^([A-Z0-9_]+)=/.exec(rest);
          if (m && i === 0) {
            out += `<span class="t-k">${m[1]}</span>=`;
            i += m[0].length;
            continue;
          }
        }
        out += escapeHtml(ch);
        i += 1;
      }
      return out;
    })
    .join('\n');
}

const LANG_LABEL = {
  sh: 'Shell', bash: 'Shell', shell: 'Shell', js: 'JavaScript', ts: 'TypeScript', javascript: 'JavaScript', typescript: 'TypeScript',
  py: 'Python', python: 'Python', go: 'Go', php: 'PHP', ruby: 'Ruby', rb: 'Ruby', json: 'JSON', env: '.env', dotenv: '.env',
  yaml: 'YAML', text: 'Text', zone: 'DNS zone', http: 'HTTP',
};

function codeBlock(lang, title, body) {
  const label = title || LANG_LABEL[lang] || lang || 'Code';
  return (
    `<div class="code" data-lang="${escapeHtml(lang || 'text')}">` +
    `<div class="code__head"><span class="code__label">${escapeHtml(label)}</span>` +
    `<button type="button" class="copy" data-copy hidden>Copy</button></div>` +
    `<pre><code>${highlight(body, lang)}</code></pre></div>`
  );
}

function table(lines) {
  const rows = lines.map((l) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|')),
  );
  const head = rows[0];
  const body = rows.slice(2);
  return (
    '<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead><tr>' +
    head.map((h) => `<th scope="col">${inline(h)}</th>`).join('') +
    '</tr></thead><tbody>' +
    body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>'
  );
}

function list(lines) {
  // lines: raw lines of a list block (items + continuation + nested items)
  const ordered = /^\s*\d+\.\s/.test(lines[0]);
  const items = [];
  for (const line of lines) {
    const top = /^(\d+\.|[-*])\s+(.*)$/.exec(line);
    const nested = /^\s{2,}(\d+\.|[-*])\s+(.*)$/.exec(line);
    if (top) items.push({ text: top[2], children: [] });
    else if (nested && items.length) items[items.length - 1].children.push(nested[2]);
    else if (items.length) {
      const last = items[items.length - 1];
      if (last.children.length) last.children[last.children.length - 1] += ' ' + line.trim();
      else last.text += ' ' + line.trim();
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  return (
    `<${tag}>` +
    items
      .map(
        (it) =>
          `<li>${inline(it.text)}${it.children.length ? '<ul>' + it.children.map((c) => `<li>${inline(c)}</li>`).join('') + '</ul>' : ''}</li>`,
      )
      .join('') +
    `</${tag}>`
  );
}

/** Render Markdown. Returns { html, headings: [{depth, id, text}] }. */
export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const used = new Set();
  let i = 0;

  const isBlockStart = (l) =>
    /^(#{1,4})\s/.test(l) || /^```/.test(l) || /^\s*([-*]|\d+\.)\s+/.test(l) || /^>/.test(l) || /^\|/.test(l) || /^<(div|aside|figure|details|table|p |section)/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    const fence = /^```(\w+)?(?:\s+title="([^"]*)")?\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(codeBlock(fence[1] || 'text', fence[2], body.join('\n')));
      continue;
    }
    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const text = h[2].trim();
      let id = slugify(text) || 'section';
      let n = 2;
      while (used.has(id)) id = `${slugify(text)}-${n++}`;
      used.add(id);
      if (depth >= 2) headings.push({ depth, id, text: text.replace(/`/g, '') });
      out.push(
        depth === 1
          ? `<h1 id="${id}">${inline(text)}</h1>`
          : `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section"></a>${inline(text)}</h${depth}>`,
      );
      i++;
      continue;
    }
    // raw HTML block (until a blank line)
    if (/^<(div|aside|figure|details|table|p |section|ol|ul)/.test(line)) {
      const block = [];
      while (i < lines.length && lines[i].trim()) block.push(lines[i++]);
      out.push(block.join('\n'));
      continue;
    }
    // table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const block = [];
      while (i < lines.length && /^\|/.test(lines[i])) block.push(lines[i++]);
      out.push(table(block));
      continue;
    }
    // blockquote / callout
    if (/^>/.test(line)) {
      const block = [];
      while (i < lines.length && /^>/.test(lines[i])) block.push(lines[i++].replace(/^>\s?/, ''));
      const kind = /^\[!(NOTE|TIP|WARNING|IMPORTANT)\]\s*$/.exec(block[0]);
      if (kind) {
        const k = kind[1].toLowerCase();
        const title = { note: 'Note', tip: 'Tip', warning: 'Warning', important: 'Important' }[k];
        const inner = renderMarkdown(block.slice(1).join('\n')).html;
        out.push(`<aside class="callout callout--${k}" role="note"><p class="callout__title">${title}</p>${inner}</aside>`);
      } else {
        out.push(`<blockquote>${renderMarkdown(block.join('\n')).html}</blockquote>`);
      }
      continue;
    }
    // list
    if (/^([-*]|\d+\.)\s+/.test(line)) {
      const block = [];
      while (i < lines.length && lines[i].trim() && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || /^\s+\S/.test(lines[i]))) block.push(lines[i++]);
      out.push(list(block));
      continue;
    }
    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), headings };
}

/** Plain text (for the search index). */
export function toPlain(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*#>|]/g, ' ')
    .replace(/\[!(NOTE|TIP|WARNING|IMPORTANT)\]/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
