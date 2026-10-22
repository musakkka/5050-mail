import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { SCROLL_FADE, useScrollFade } from '@/lib/useScrollFade';

/** Scroll container + table with the reference's pill-shaped header row. */
export function Table({ children, className, minWidth }: { children: ReactNode; className?: string; minWidth?: number }) {
  const scroller = useScrollFade();
  return (
    <div className="@container min-h-0">
      <div ref={scroller} className={cn(SCROLL_FADE, 'relative w-full overflow-x-auto transform-gpu overflow-y-hidden min-h-0 max-md:-mx-6 max-md:w-auto max-md:px-6')}>
        <table
          className={cn('m-0 w-max min-w-full border-separate border-spacing-0 border-none p-0 text-left md:w-full', className)}
          style={minWidth ? { minWidth } : undefined}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="h-8">
      <tr>{children}</tr>
    </thead>
  );
}

export function Th({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-8 border-b border-t border-interactive px-3 text-xs font-semibold text-default bg-interactive first:rounded-l-xl first:border-l last:rounded-r-xl last:border-r whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TBody({ children, className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn('transition-all duration-300 ease-in-out delay-0', className)} {...rest}>
      {children}
    </tbody>
  );
}

export function Td({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('border-subtle h-10 border-b pr-3 pl-2 text-sm text-ellipsis whitespace-nowrap md:px-3', className)} {...rest}>
      {children}
    </td>
  );
}

/** A row of shimmering placeholders while a table loads. */
export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <Td key={c} className="py-3 h-[57px]">
              <div className={cn('h-4 rounded-md bg-interactive animate-pulse', c === 0 ? 'w-48' : c === cols - 1 ? 'w-6 ml-auto' : 'w-24')} />
            </Td>
          ))}
        </tr>
      ))}
    </>
  );
}
