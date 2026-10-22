import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Tooltip } from './Tooltip';
import { iconButtonClass } from './Button';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ value, className, size = 16, label = 'Copy to clipboard' }: { value: string; className?: string; size?: number; label?: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <Tooltip content={copied ? 'Copied!' : 'Copy'}>
      <button
        type="button"
        aria-label={label}
        data-copy-value={value}
        className={iconButtonClass('ghost', '1', cn('cursor-pointer', className))}
        onClick={async (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (await copyText(value)) {
            setCopied(true);
            window.clearTimeout(t.current);
            t.current = window.setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        <span className="inline-flex items-center justify-center opacity-100">
          <span className="w-[22px] h-[22px] flex">
            {copied ? <Check className="text-current m-auto" size={size} /> : <Copy className="text-current m-auto" size={size} />}
          </span>
          <span aria-live="polite" aria-atomic="true" className="sr-only">
            {copied ? 'Copied' : ''}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

/** Monospace ID pill with a copy button (email/domain/key IDs). */
export function IdPill({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium truncate bg-interactive dark:bg-elevated text-default border border-transparent h-6 px-2 rounded-lg font-mono text-[13px] gap-2 pr-1 select-auto w-fit max-w-full',
        className,
      )}
      translate="no"
      title={value}
    >
      <span className="truncate block flex-1">{value}</span>
      <span className="flex items-center">
        <CopyButton value={value} />
      </span>
    </span>
  );
}
