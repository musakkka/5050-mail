import { ArrowUpRight, BookText, Plus } from 'lucide-react';
import { docsUrl } from './docs';
import { openAsk } from './AskAnything';
import { Tooltip } from '@/components/ui/Tooltip';

/** 40px workspace bar under the panel: contextual docs link and "Ask anything". */
export function BottomBar({ docsPath }: { docsPath: string }) {
  const rest = docsPath.replace(/^\//, '');
  return (
    <div data-workspace-bar="true" className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 px-4 font-sans text-muted text-xs" style={{ height: 40 }}>
      <a
        href={docsUrl(docsPath)}
        rel="noopener noreferrer"
        target="_blank"
        aria-label={`Docs: /docs/${rest}`}
        className="pointer-events-none min-w-0 self-stretch -ml-4 group font-normal text-default hover:text-default transition-colors hidden shrink-0 md:flex"
      >
        <span className="pointer-events-auto flex min-w-0 items-center gap-2 pl-6 pr-4">
          <BookText size={14} className="shrink-0" />
          <span className="truncate font-mono">/docs</span>
        </span>
        <span className="pointer-events-none -ml-4 flex min-w-0 items-center font-mono text-muted transition opacity-0 -translate-x-2 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-x-0">
          <span className="truncate">/{rest.split('/')[0]}</span>
        </span>
        <span className="pointer-events-none flex shrink-0 items-center pl-2 pr-4 text-muted transition opacity-0 -translate-x-1 group-hover:pointer-events-auto group-hover:opacity-100 group-hover:translate-x-0">
          <ArrowUpRight size={14} />
        </span>
      </a>
      <div className="flex h-full min-w-0 flex-1 items-center gap-2">
        <div className="flex h-full min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden max-md:order-last max-md:justify-start" />
        <div className="group/chip relative inline-flex items-center shrink-0">
          <Tooltip content={<span>Ask anything <span className="text-muted">⌘K</span></span>}>
            <button
              type="button"
              onClick={openAsk}
              className="inline-flex items-center select-none relative cursor-pointer transition ease-in-out duration-200 bg-transparent border-transparent hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden text-xs h-6 px-1.5 rounded-lg gap-1 justify-start border-0 text-left font-sans font-normal shrink-0 text-emphasis [&_svg]:text-emphasis"
            >
              <span className="opacity-100">
                <Plus size={12} />
              </span>
              <span className="inline-flex items-center justify-center gap-1 truncate min-w-0 opacity-100">Ask anything</span>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
