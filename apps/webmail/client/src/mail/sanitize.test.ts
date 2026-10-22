// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToText, renderEmailHtml, sanitizeForCompose, textToHtml } from './sanitize';

const body = (doc: string) => /<body>([\s\S]*)<\/body>/.exec(doc)![1]!;

describe('renderEmailHtml', () => {
  it('strips scripts, handlers, javascript: URLs, forms and frames', () => {
    const r = renderEmailHtml(
      `<p onclick="alert(1)">hi</p><script>alert(2)</script><a href="javascript:alert(3)">x</a><form action="https://evil"><input name=p></form><iframe src="https://evil"></iframe><img src=x onerror=alert(4)><svg><script>alert(5)</script></svg><base href="https://evil/">`,
      { allowRemote: false },
    );
    const b = body(r.full);
    expect(b).not.toMatch(/script|onclick|onerror|javascript:|<form|<input|<iframe|<base/i);
    expect(b).toContain('hi');
  });

  it('blocks remote images until allowed and reports it', () => {
    const html = '<img src="https://tracker.example/p.gif"><div style="background:url(https://x.example/bg.png)">t</div>';
    const blocked = renderEmailHtml(html, { allowRemote: false });
    expect(blocked.blockedRemote).toBe(true);
    expect(body(blocked.full)).not.toMatch(/\ssrc="https:\/\/tracker/);
    expect(body(blocked.full)).toContain('data-ff-src="https://tracker.example/p.gif"');
    expect(body(blocked.full)).not.toContain('url(https://x.example');
    expect(blocked.full).toMatch(/img-src \S+\/jmap\/download\/ data: blob:;/); // CSP meta blocks remote too
    const allowed = renderEmailHtml(html, { allowRemote: true });
    expect(body(allowed.full)).toContain('src="https://tracker.example/p.gif"');
    expect(allowed.full).toMatch(/img-src \S+\/jmap\/download\/ data: blob: https: http:/);
  });

  it('rewrites cid: images to same-origin URLs', () => {
    const r = renderEmailHtml('<img src="cid:logo@acme">', { allowRemote: false, cidMap: { 'logo@acme': '/jmap/download/a/b/logo.png?accept=image%2Fpng' } });
    expect(body(r.full)).toContain('src="/jmap/download/a/b/logo.png?accept=image%2Fpng"');
    expect(r.blockedRemote).toBe(false);
  });

  it('opens links in a new tab without referrer', () => {
    const r = renderEmailHtml('<a href="https://example.com">go</a>', { allowRemote: false });
    expect(body(r.full)).toMatch(/target="_blank"/);
    expect(body(r.full)).toMatch(/rel="noopener noreferrer nofollow"/);
  });

  it('keeps <style> in the head with remote url()s removed', () => {
    const r = renderEmailHtml('<style>.a{color:red;background:url(https://x/y.png)} @import url(https://evil/x.css);</style><p class="a">x</p>', {
      allowRemote: false,
    });
    expect(r.full).toContain('.a{color:red;background:none}');
    expect(r.full).not.toContain('@import');
  });

  it('cannot break out of <style> with nested closing tags', () => {
    const r = renderEmailHtml('<style>a{color:red}</sty</stylele><meta http-equiv="refresh" content="0;url=https://evil.example"></style><p>x</p>', {
      allowRemote: false,
    });
    const head = /<head>([\s\S]*)<\/head>/.exec(r.full)![1]!;
    expect(head.match(/<\/style>/g)!.length).toBe(head.match(/<style>/g)!.length);
    expect(r.full).not.toMatch(/<meta http-equiv="refresh"/i);
  });

  it('never lets email HTML/CSS request same-origin or relative URLs', () => {
    const r = renderEmailHtml(
      `<img src="/jmap/eventsource/?types=*"><img src="${location.origin}/api/me"><a href="/api/logout">x</a><div style="background:url(/jmap/download/a/b/c)">y</div><style>.q{background:url('/jmap/x')}</style>`,
      { allowRemote: true },
    );
    expect(r.full).not.toContain('/jmap/eventsource');
    expect(r.full).not.toContain('/api/me');
    expect(r.full).not.toContain('href="/api/logout"');
    expect(r.full).not.toContain('/jmap/download/a/b/c');
    expect(r.full).not.toContain("url('/jmap/x')");
  });

  it('flags image-set / escaped url() / svg images as blocked remote content', () => {
    expect(renderEmailHtml('<div style="background-image:image-set(\'https://x.example/a.png\' 1x)">a</div>', { allowRemote: false }).blockedRemote).toBe(true);
    expect(renderEmailHtml('<div style="background:url(\\68ttps://x.example/a.png)">a</div>', { allowRemote: false }).full).not.toContain('68ttps');
    const svg = renderEmailHtml('<svg><image href="https://x.example/t.png"/></svg><p>t</p>', { allowRemote: false });
    expect(svg.full).not.toContain('x.example');
  });

  it('trims trailing quoted text behind the toggle', () => {
    const r = renderEmailHtml('<div>New reply</div><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>old stuff</blockquote></div>', {
      allowRemote: false,
    });
    expect(r.hasQuote).toBe(true);
    expect(body(r.trimmed)).toContain('New reply');
    expect(body(r.trimmed)).not.toContain('old stuff');
    expect(body(r.full)).toContain('old stuff');
  });

  it('does not trim when the whole message is a quote', () => {
    const r = renderEmailHtml('<blockquote type="cite">only quote</blockquote>', { allowRemote: false });
    expect(r.hasQuote).toBe(false);
  });
});

describe('text helpers', () => {
  it('textToHtml escapes, linkifies and nests quotes', () => {
    const h = textToHtml('Hi <b>\nsee https://example.com/x.\n> quoted\n>> deeper');
    expect(h).toContain('&lt;b&gt;');
    expect(h).toContain('<a href="https://example.com/x"');
    expect(h).toMatch(/<blockquote type="cite"><div dir="auto">quoted<\/div><blockquote type="cite"><div dir="auto">deeper/);
  });

  it('textToHtml gives every line its own direction (RTL lines in an LTR mail)', () => {
    const h = textToHtml('Hi Alice,\nשלום עליכם\n\nمرحبا');
    expect(h.match(/<div dir="auto">/g)).toHaveLength(4);
    expect(h).toContain('<div dir="auto"><br></div>');
  });

  it('trims a plain-text "On … wrote:" quote including its attribution line', () => {
    const r = renderEmailHtml(textToHtml('Thanks!\nOn Tue, Oct 21, 2026 at 3:41 PM Bob <b@x.test> wrote:\n> earlier\n> text'), { allowRemote: false });
    expect(r.hasQuote).toBe(true);
    expect(body(r.trimmed)).toContain('Thanks!');
    expect(body(r.trimmed)).not.toMatch(/wrote:|earlier/);
  });

  it('sanitizeForCompose drops styles, remote images and positioning', () => {
    const s = sanitizeForCompose('<style>body{display:none}</style><img src="https://t/x.gif"><div style="position:fixed;color:red" class="x" id="y">a</div>');
    expect(s).not.toContain('<style');
    expect(s).not.toContain('https://t/x.gif');
    expect(s).toContain('position:static');
    expect(s).not.toMatch(/class=|id=/);
  });

  it('sees through CSS escapes, quoted ")" and image-set when blocking remote and same-origin loads', () => {
    const cases = [
      '<p style="background:u\\72l(https://t.test/a)">x</p>',
      '<p style="background:\\75\\72\\6c (https://t.test/b)">x</p>',
      `<p style="background:url('https://t.test/c)d')">x</p>`,
      '<p style="background:image-set(&quot;https://t.test/e&quot; 1x)">x</p>',
      '<p style="background:u\\72l(/jmap/eventsource/?x)">x</p>',
      `<p style="background:url('/jmap/eventsource/?x=)')">x</p>`,
      '<style>p{background:u\\72l(https://t.test/f)}</style><p>x</p>',
    ];
    for (const html of cases) {
      const r = renderEmailHtml(html, { allowRemote: false });
      expect(r.full, html).not.toMatch(/t\.test|eventsource/);
    }
    // Remote allowed: real remote URLs survive, same-origin ones still don't.
    const ok = renderEmailHtml('<p style="background:u\\72l(https://t.test/a)">x</p><p style="background:url(/jmap/eventsource)">y</p>', { allowRemote: true });
    expect(ok.full).toContain('url(https://t.test/a)');
    expect(ok.full).not.toContain('eventsource');
    // srcdoc CSP: same-origin loads only from attachment downloads.
    expect(ok.full).not.toMatch(/img-src 'self'/);
  });

  it('sanitizeForCompose resists CSS-escape tricks and drops every kind of positioning', () => {
    const s = sanitizeForCompose(
      '<p style="background:u\\72l(https://t.test/x)">a</p><p style="posit\\69on:fixed;inset:0;z-index:9999">b</p><p style="position : absolute">c</p><p style="background:image-set(\'https://t.test/y\' 1x)">d</p>',
    );
    expect(s).not.toContain('t.test');
    expect(s).not.toMatch(/position\s*:\s*(fixed|absolute|sticky)/i);
    expect(s).not.toMatch(/\\/);
  });

  it('htmlToText produces a readable plain-text alternative', () => {
    expect(htmlToText('<p>Hello <b>Bob</b></p><blockquote>old<br>line</blockquote><a href="https://x.test">link</a>')).toBe(
      'Hello Bob\n\n> old\n> line\nlink <https://x.test>',
    );
  });
});
