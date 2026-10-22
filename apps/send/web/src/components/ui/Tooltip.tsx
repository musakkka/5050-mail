import { Tooltip as T } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delay={300}>{children}</T.Provider>;
}

/**
 * Tooltip around a single element. Collision-aware (flips/shifts at viewport edges),
 * portalled so it is never clipped by table overflow.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
  disabled,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  disabled?: boolean;
}) {
  if (disabled || content === null || content === undefined || content === '') return children;
  return (
    <T.Root>
      <T.Trigger render={children} />
      <T.Portal>
        <T.Positioner side={side} sideOffset={6} collisionPadding={8} className="z-[1100]">
          <T.Popup
            className={cn(
              'max-w-xs rounded-lg border border-interactive bg-background px-2 py-1 text-xs text-emphasis shadow-lg break-words',
              'origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 data-starting-style:opacity-0 data-starting-style:scale-95 data-ending-style:opacity-0',
              className,
            )}
          >
            {content}
          </T.Popup>
        </T.Positioner>
      </T.Portal>
    </T.Root>
  );
}
