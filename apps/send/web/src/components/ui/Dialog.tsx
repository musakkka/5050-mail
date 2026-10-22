import { Dialog as D } from '@base-ui/react/dialog';
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './Button';

const POPUP =
  "interpolate-size bg-background fixed left-1/2 top-1/2 z-50 h-auto max-h-[90vh] max-h-[90dvh] overflow-y-auto overscroll-contain border border-default p-6 rounded-4xl -translate-x-1/2 translate-y-[calc(-50%-1.5rem*var(--nested-dialogs,0))] scale-[calc(1-0.05*var(--nested-dialogs,0))] transition-[opacity,scale,translate,height,max-height] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-starting-style:translate-y-[calc(-50%+0.75rem)] data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-ending-style:translate-y-[calc(-50%+0.5rem)] after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-4xl after:bg-black/30 after:opacity-0 after:transition-opacity after:duration-300 after:content-[''] dark:after:bg-black/50 data-nested-dialog-open:overflow-hidden data-nested-dialog-open:after:opacity-100 focus-visible:outline-none w-[calc(100vw-2rem)]";

const SIZE = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/**
 * Modal dialog: focus trap, Esc to close, scroll lock (Base UI), and ⌘/Ctrl+Enter to
 * submit when `onSubmit` is given, like the reference dialogs.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'md',
  onSubmit,
  className,
  hideClose,
  initialFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  size?: keyof typeof SIZE;
  onSubmit?: () => void;
  className?: string;
  hideClose?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submitRef.current) {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
  return (
    <D.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <D.Portal>
        <D.Backdrop className="fixed inset-0 z-50 transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 bg-overlay" />
        <D.Popup className={cn(POPUP, SIZE[size], className)} initialFocus={initialFocus}>
          <D.Title className="text-base text-emphasis font-semibold pr-8">{title}</D.Title>
          {description ? <D.Description className="mt-2 text-sm text-default">{description}</D.Description> : null}
          {children}
          {hideClose ? null : (
            <D.Close
              render={
                <IconButton label="Close dialog" variant="ghost" size="1" className="absolute right-6 top-6">
                  <X size={18} />
                </IconButton>
              }
            />
          )}
        </D.Popup>
      </D.Portal>
    </D.Root>
  );
}

/** The action row at the bottom of dialogs. */
export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export const DialogClose = D.Close;
