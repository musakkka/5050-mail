import { useEffect, useState, type ReactNode } from 'react';
import type { HighlighterCore, ThemeRegistration } from 'shiki/core';
import { cn } from '@/lib/cn';
import { CopyButton } from './CopyButton';

export type CodeLang =
  | 'javascript'
  | 'typescript'
  | 'php'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'elixir'
  | 'java'
  | 'csharp'
  | 'bash'
  | 'json'
  | 'html'
  | 'http'
  | 'text';

/** Monochrome theme matched to the reference code blocks (keywords dim, strings mid, names bright). */
function mono(name: string, c: { fg: string; kw: string; punct: string; str: string; fn: string; prop: string; comment: string; num: string }): ThemeRegistration {
  return {
    name,
    type: name.endsWith('dark') ? 'dark' : 'light',
    colors: { 'editor.foreground': c.fg, 'editor.background': '#00000000' },
    fg: c.fg,
    bg: '#00000000',
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment, fontStyle: 'italic' } },
      { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator', 'keyword.control', 'entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'variable.language', 'constant.language'], settings: { foreground: c.kw } },
      { scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator', 'meta.delimiter'], settings: { foreground: c.punct } },
      { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], settings: { foreground: c.str } },
      { scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'], settings: { foreground: c.fn } },
      { scope: ['meta.object-literal.key', 'variable.other.property', 'support.type.property-name', 'entity.name.tag', 'variable.object.property', 'meta.mapping.key', 'constant.other.symbol'], settings: { foreground: c.prop } },
      { scope: ['constant.numeric'], settings: { foreground: c.num } },
    ],
  };
}

const DARK = mono('send-mono-dark', { fg: '#f8f8f8', kw: '#6C6C6C', punct: '#A0A0A0', str: '#ABABAB', fn: '#EBECED', prop: '#EBECED', comment: '#5a5a5a', num: '#ABABAB' });
const LIGHT = mono('send-mono-light', { fg: '#191919', kw: '#8a8a8a', punct: '#6b6b6b', str: '#5c5c5c', fn: '#0d0d0d', prop: '#0d0d0d', comment: '#9a9a9a', num: '#5c5c5c' });

let hl: Promise<HighlighterCore> | null = null;
function highlighter(): Promise<HighlighterCore> {
  hl ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      themes: [DARK, LIGHT],
      langs: [
        import('@shikijs/langs/javascript'),
        import('@shikijs/langs/typescript'),
        import('@shikijs/langs/php'),
        import('@shikijs/langs/python'),
        import('@shikijs/langs/ruby'),
        import('@shikijs/langs/go'),
        import('@shikijs/langs/rust'),
        import('@shikijs/langs/elixir'),
        import('@shikijs/langs/java'),
        import('@shikijs/langs/csharp'),
        import('@shikijs/langs/bash'),
        import('@shikijs/langs/json'),
        import('@shikijs/langs/html'),
        import('@shikijs/langs/http'),
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return hl;
}

export function useHighlighted(code: string, lang: CodeLang): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (lang === 'text') {
      setHtml(null);
      return;
    }
    highlighter()
      .then((h) => {
        if (!alive) return;
        setHtml(h.codeToHtml(code, { lang, themes: { light: 'send-mono-light', dark: 'send-mono-dark' }, defaultColor: false }));
      })
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return html;
}

/** Highlighted, scrollable code. Falls back to plain text until the highlighter loads. */
export function Code({ code, lang, className, height, wrap }: { code: string; lang: CodeLang; className?: string; height?: number | string; wrap?: boolean }) {
  const html = useHighlighted(code, lang);
  return (
    <div className={cn('relative code-block selection:bg-black/10! selection:text-black! dark:selection:bg-white/20! dark:selection:text-white!', className)}>
      {html ? (
        <div
          translate="no"
          className={cn('overflow-auto p-4 text-sm font-mono [&_pre]:!bg-transparent [&_code]:font-mono', wrap && '[&_pre]:whitespace-pre-wrap [&_pre]:break-all')}
          style={{ height }}
          // Shiki output: escaped tokens only, no user HTML is executed.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre translate="no" className={cn('overflow-auto p-4 text-sm font-mono text-emphasis', wrap && 'whitespace-pre-wrap break-all')} style={{ height }}>
          {code}
        </pre>
      )}
    </div>
  );
}

/** Bordered code card with a header (tabs/title) and a copy button. */
export function CodeCard({ header, code, lang, height, className, footer, wrap }: { header?: ReactNode; code: string; lang: CodeLang; height?: number; className?: string; footer?: ReactNode; wrap?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-3xl border border-gray-3', className)}>
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
        <div className="min-w-0">{header}</div>
        <CopyButton value={code} />
      </div>
      <Code code={code} lang={lang} height={height} className="bg-gray-a1/20" wrap={wrap} />
      {footer}
    </div>
  );
}
