import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'violet' | 'outline';

const TONE: Record<BadgeTone, string> = {
  success: 'bg-success text-success border border-transparent',
  error: 'bg-error text-error border border-transparent',
  warning: 'bg-warning text-warning border border-transparent',
  info: 'bg-info text-info border border-transparent',
  neutral: 'bg-elevated text-default border border-transparent',
  violet: 'bg-violet-3 text-violet-11 border border-transparent',
  outline: 'bg-transparent text-default border border-interactive',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  size = '1',
  capitalize = true,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  size?: '1' | '0';
  capitalize?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center font-medium truncate',
        TONE[tone],
        size === '1' ? 'text-xs h-6 px-2 rounded-lg' : 'text-2xs h-5 px-1.5 rounded-md',
        capitalize && 'capitalize',
        className,
      )}
    >
      {children}
    </span>
  );
}
