import type { ReactNode } from 'react';
import { Tabs as T } from '@base-ui/react/tabs';
import { Code, type CodeLang } from '@/components/ui/Code';
import { CopyButton } from '@/components/ui/CopyButton';
import { TAB_CLASS } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';

export interface CodeTab {
  id: string;
  label: ReactNode;
  code: string;
  lang: CodeLang;
  /** Text above the code (e.g. "Go to Settings → Connectors…"). */
  intro?: ReactNode;
}

/** Code card with a language/tool tab row, copy button and an optional footer (onboarding, MCP). */
export function TabbedCode({
  tabs,
  value,
  onChange,
  footer,
  height = 240,
  className,
}: {
  tabs: CodeTab[];
  value: string;
  onChange: (v: string) => void;
  footer?: ReactNode;
  height?: number;
  className?: string;
}) {
  const cur = tabs.find((t) => t.id === value) ?? tabs[0]!;
  return (
    <div className={cn('min-w-0', className)}>
      <T.Root value={cur.id} onValueChange={(v) => onChange(String(v))} className={cn('border border-gray-3 rounded-t-3xl', !footer && 'rounded-b-3xl overflow-hidden')}>
        <div className="flex items-center justify-between gap-2 rounded-t-3xl bg-gray-a1/20 p-4">
          <T.List className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] -m-1 p-1">
            {tabs.map((t) => (
              <T.Tab key={t.id} value={t.id} className={cn(TAB_CLASS, 'gap-1.5')}>
                {t.label}
              </T.Tab>
            ))}
          </T.List>
          <div className="flex shrink-0 items-center gap-2">
            <CopyButton value={cur.code} />
          </div>
        </div>
        {tabs.map((t) => (
          <T.Panel key={t.id} value={t.id} className="outline-hidden">
            {t.intro ? <div className="bg-gray-a1/20 px-4 pt-1 text-sm text-default">{t.intro}</div> : null}
            <Code code={t.code} lang={t.lang} height={height} className="bg-gray-a1/20" />
          </T.Panel>
        ))}
      </T.Root>
      {footer ? <footer className="rounded-b-3xl border-x border-b border-gray-3 bg-gray-a1/20 p-4">{footer}</footer> : null}
    </div>
  );
}
