import { Toaster as Sonner, toast as sonnerToast } from 'sonner';

/** Toasts: bottom-right like the reference (sonner, MIT). */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      offset={{ bottom: 52, right: 16 }}
      mobileOffset={{ bottom: 52 }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-2 rounded-2xl border border-interactive bg-background px-4 py-3 text-sm text-emphasis shadow-lg',
          title: 'font-medium',
          description: 'text-default text-xs mt-0.5',
          error: 'border-error-subtle',
          success: '',
          icon: 'mt-0.5',
        },
      }}
    />
  );
}

export const toast = sonnerToast;

export function toastError(e: unknown, fallback = 'Something went wrong') {
  sonnerToast.error(e instanceof Error ? e.message : fallback);
}
