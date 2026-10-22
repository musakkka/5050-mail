import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Accordion } from '@base-ui/react/accordion';
import { ChevronRight, CircleCheck, ThumbsDown, ThumbsUp, TriangleAlert, ArrowUpRight } from 'lucide-react';
import { Tabs as T } from '@base-ui/react/tabs';
import { TAB_CLASS } from '@/components/ui/Tabs';
import { CopyButton } from '@/components/ui/CopyButton';
import { Code } from '@/components/ui/Code';
import { IconButton, LinkButton } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { docsUrl } from '@/components/layout/docs';
import { shortDateTime } from '@/lib/format';
import type { Insight } from './insights';

export type MessageTab = 'preview' | 'text' | 'raw' | 'insights';

/**
 * Wrap untrusted email HTML for a sandboxed srcdoc iframe: no scripts (sandbox
 * without allow-scripts), links open in a new tab, light background like a mail client.
 */
export function previewDoc(html: string): string {
  const head = '<meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer"><style>html{background:#fff;color-scheme:light}body{margin:0;padding:16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export function EmailPreview({ html, text, title }: { html: string | null | undefined; text: string | null | undefined; title: string }) {
  const doc = useMemo(() => (html ? previewDoc(html) : null), [html]);
  if (!doc) {
    return (
      <div className="overflow-auto whitespace-pre-line break-words p-3 pt-2" style={{ height: 600 }}>
        <span className="text-sm text-default font-normal">{text || 'This email has no content.'}</span>
      </div>
    );
  }
  return (
    <iframe
      title={`Preview: ${title}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="block w-full rounded-2xl border border-gray-3 bg-white"
      style={{ height: 600 }}
    />
  );
}

function InsightRow({ i, idx }: { i: Insight; idx: number }) {
  return (
    <Accordion.Item value={i.id} className="py-4">
      <Accordion.Header className="flex">
        <Accordion.Trigger className="flex flex-row items-center gap-1 group w-full h-full focus-visible:ring-2 focus-visible:ring-gray-a2 focus-visible:outline-hidden rounded-sm cursor-pointer text-left">
          <ChevronRight size={14} aria-hidden className="shrink-0 transition duration-300 ease-[cubic-bezier(0.87,0,0.13,1)] group-data-[panel-open]:rotate-90 text-gray-6 group-hover:text-emphasis" />
          <span className="text-sm text-emphasis font-normal flex flex-row items-center gap-3">
            {i.ok ? <CircleCheck size={20} className="shrink-0 text-green-9" /> : <TriangleAlert size={20} className="shrink-0 text-default opacity-70" />}
            {i.title}
          </span>
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel
        hiddenUntilFound
        className="text-pretty pl-[50px] h-(--accordion-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-in-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0"
      >
        <div className="text-sm text-default font-normal py-2">
          <p>{i.description}</p>
          {i.detail ? <p className="mt-2 font-mono text-[13px] text-emphasis break-all">{i.detail}</p> : null}
          {i.code ? <Code code={i.code} lang="json" className="mt-2 rounded-xl border border-default bg-subtle [&_*]:text-[13px]" /> : null}
          <div className="mt-4 flex gap-2">
            <Tooltip content="Helpful">
              <IconButton label="Helpful" onClick={() => toast('Thanks for the feedback!')} data-idx={idx}>
                <ThumbsUp size={16} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Not helpful">
              <IconButton label="Not helpful" onClick={() => toast('Thanks for the feedback!')}>
                <ThumbsDown size={16} />
              </IconButton>
            </Tooltip>
            {i.docs ? (
              <LinkButton href={docsUrl(i.docs)} variant="ghost" aria-label={`Learn more about ${i.title}`}>
                Learn more <ArrowUpRight size={16} />
              </LinkButton>
            ) : null}
          </div>
        </div>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

export function InsightsPanel({ insights, generatedAt }: { insights: Insight[] | null; generatedAt: string }) {
  if (!insights) return <p className="py-6 text-sm text-default">Loading insights…</p>;
  const bad = insights.filter((i) => !i.ok);
  const good = insights.filter((i) => i.ok);
  let idx = 0;
  const group = (title: string, items: Insight[]) =>
    items.length ? (
      <div>
        <span className="text-sm text-default font-normal uppercase tracking-wide">{title}</span>
        <Accordion.Root multiple hiddenUntilFound className="divide-y divide-gray-2">
          {items.map((i) => (
            <InsightRow key={i.id} i={i} idx={idx++} />
          ))}
        </Accordion.Root>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-4 mt-4">
      {group('Possible improvements', bad)}
      {group('Doing great', good)}
      <p className="text-xs text-muted">Report generated on {shortDateTime(generatedAt)}</p>
    </div>
  );
}

/** Card with Preview / Plain Text / Raw (/ Insights) and a copy button for the active tab. */
export function MessageTabs({
  html,
  text,
  raw,
  title,
  insights,
  generatedAt,
}: {
  html: string | null | undefined;
  text: string | null | undefined;
  raw: string;
  title: string;
  insights?: Insight[] | null;
  generatedAt?: string;
}) {
  const [params, setParams] = useSearchParams();
  const tabs: { value: MessageTab; label: string }[] = [
    { value: 'preview', label: 'Preview' },
    { value: 'text', label: 'Plain Text' },
    { value: 'raw', label: 'Raw' },
    ...(insights !== undefined ? [{ value: 'insights' as const, label: 'Insights' }] : []),
  ];
  const fromUrl = params.get('tab') as MessageTab | null;
  const tab: MessageTab = tabs.some((t) => t.value === fromUrl) ? fromUrl! : 'preview';
  const copyValue = tab === 'preview' ? (html ?? text ?? '') : tab === 'text' ? (text ?? '') : tab === 'raw' ? raw : '';
  const panel = (v: MessageTab, children: ReactNode, cls = 'p-4 pt-2') => (
    <T.Panel value={v} className={`outline-hidden border-none ${cls}`}>
      {children}
    </T.Panel>
  );
  return (
    <T.Root
      value={tab}
      onValueChange={(v) => {
        const n = new URLSearchParams(params);
        if (v === 'preview') n.delete('tab');
        else n.set('tab', String(v));
        setParams(n, { replace: true });
      }}
      className="overflow-hidden rounded-3xl border border-gray-3"
    >
      <T.List className="flex flex-nowrap items-center gap-2 relative w-full justify-between overflow-x-auto overflow-y-hidden px-4 pb-3 pt-4">
        <div className="flex w-max items-center gap-2">
          {tabs.map((t) => (
            <T.Tab key={t.value} value={t.value} className={TAB_CLASS}>
              {t.label}
            </T.Tab>
          ))}
        </div>
        {tab !== 'insights' ? <CopyButton value={copyValue} /> : null}
      </T.List>
      {panel('preview', <EmailPreview html={html} text={text} title={title} />)}
      {panel(
        'text',
        <div className="overflow-auto whitespace-pre-line break-words p-3 pt-2" style={{ height: 600 }}>
          <span className="text-sm text-default font-normal">{text?.trim() ? text : 'This email has no plain text version.'}</span>
        </div>,
      )}
      {panel('raw', <Code code={raw} lang="json" height={600} wrap className="[&>div]:p-3 [&>pre]:p-3" />)}
      {insights !== undefined ? panel('insights', <InsightsPanel insights={insights} generatedAt={generatedAt ?? new Date().toISOString()} />, 'p-4 pt-0 pl-6') : null}
    </T.Root>
  );
}
