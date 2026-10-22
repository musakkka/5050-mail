import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export type StepState = 'active' | 'done' | 'upcoming';

/** Vertical step rail (onboarding, MCP setup): a faded line with a ring per step. */
export function Steps({ children, className, lineClassName }: { children: ReactNode; className?: string; lineClassName?: string }) {
  return (
    <div className={cn('relative', className)}>
      <div aria-hidden="true" className={cn('steps-gradient absolute top-0 w-px', lineClassName ?? 'bottom-28')} />
      <ol className="flex flex-col gap-4">{children}</ol>
    </div>
  );
}

export function Step({ state, title, description, children, right, interactive }: { state: StepState; title: ReactNode; description?: ReactNode; children?: ReactNode; right?: ReactNode; interactive?: boolean }) {
  const upcoming = state === 'upcoming';
  return (
    <li className={cn('relative pl-6 transition duration-200 ease-in-out', upcoming && !interactive && 'pointer-events-none select-none')} aria-current={state === 'active' ? 'step' : undefined}>
      <div className="bg-background absolute -left-[10px] top-[21px] sm:top-7 z-10 flex h-[21px] w-[21px] rounded-full">
        {state === 'done' ? (
          <span className="m-auto flex h-[18px] w-[18px] items-center justify-center rounded-full bg-success text-success">
            <Check size={12} strokeWidth={3} />
          </span>
        ) : (
          <div className={cn('m-auto h-3 w-3 rounded-full border-2 transition duration-200 ease-in-out', upcoming ? 'border-gray-4' : 'border-black dark:border-white')} />
        )}
      </div>
      <div className={cn('rounded-4xl p-0.5 transition duration-200 ease-in-out', upcoming && 'opacity-50')}>
        <div className="bg-background rounded-[30px]">
          <div className="rounded-[30px] p-4 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold mb-1">{title}</h3>
                {description ? <p className="text-sm text-default font-normal text-balance">{description}</p> : null}
              </div>
              {right}
            </div>
            {children ? <div className="mt-6">{children}</div> : null}
          </div>
        </div>
      </div>
    </li>
  );
}
