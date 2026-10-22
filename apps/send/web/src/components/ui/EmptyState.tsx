import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The bordered empty-state card: a soft blurred glow behind an illustration tile,
 * a bold title, a balanced description and actions.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-8 overflow-hidden rounded-2xl border border-default px-6',
        compact ? 'min-h-60 py-12' : 'min-h-80 py-20',
        className,
      )}
    >
      <div className="flex max-w-md flex-col gap-2 text-center">
        {icon ? (
          <div className="relative flex shrink-0 justify-center pb-3">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 select-none opacity-[0.15]"
              style={{
                width: 420,
                maxWidth: '90vw',
                height: 140,
                borderRadius: 100,
                background: 'linear-gradient(180deg, #D9D9D9 0%, #737373 100%)',
                filter: 'blur(62px)',
                transform: 'translate(-50%, -50%) rotate(-15deg)',
              }}
            />
            <div className="relative flex items-center justify-center">{icon}</div>
          </div>
        ) : null}
        <h2 className="text-xl tracking-[-0.16px] text-emphasis font-bold">{title}</h2>
        {description ? <span className="text-sm text-default font-normal text-balance break-words hyphens-auto">{description}</span> : null}
        {actions ? <div className="flex flex-wrap items-center justify-center gap-2 mt-4">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Error card with retry, same frame as EmptyState. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong';
  return (
    <div role="alert" className={cn('flex min-h-60 flex-col items-center justify-center gap-3 rounded-2xl border border-error-subtle bg-error/40 px-6 py-12 text-center', className)}>
      <h2 className="text-base font-semibold text-emphasis">Couldn't load this page</h2>
      <p className="max-w-md text-sm text-default break-words">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex h-8 items-center rounded-xl border border-interactive bg-interactive px-3 text-sm font-medium text-default hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-focus outline-hidden"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
