import { useEffect, useRef, type RefObject } from 'react';

/** Open modals, innermost last: only the topmost reacts to Esc / Tab, and the page is scroll-locked while any is open. */
const stack: HTMLElement[] = [];

/**
 * Modal behaviour shared by dialogs, the shortcut overlay and the attachment viewer: initial focus,
 * Tab / Shift+Tab trapped inside, Esc closes (unless a menu is open), page scroll locked, focus
 * returned to where it was on close.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, opts: { initialFocus?: () => HTMLElement | null | undefined } = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusRef = useRef(opts.initialFocus);
  focusRef.current = opts.initialFocus;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (!el) return;
    const first =
      focusRef.current?.() ??
      el.querySelector<HTMLElement>('input, textarea, select, [data-autofocus]') ??
      el.querySelector<HTMLElement>('button, a[href]') ??
      el;
    if (first === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    first.focus({ preventScroll: true });
    stack.push(el);
    const html = document.documentElement;
    html.classList.add('scroll-locked');
    const key = (e: KeyboardEvent) => {
      if (stack.at(-1) !== el) return;
      if (e.key === 'Escape' && !document.querySelector('.popover')) {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], iframe, [tabindex]:not([tabindex="-1"]), [contenteditable=true]')].filter(
        (x) => !x.hasAttribute('disabled') && (x.offsetParent !== null || getComputedStyle(x).position === 'fixed'),
      );
      if (!f.length) {
        e.preventDefault();
        return;
      }
      if (!el.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? f.at(-1)! : f[0]!).focus();
      } else if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f.at(-1)!.focus();
      } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
        e.preventDefault();
        f[0]!.focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) html.classList.remove('scroll-locked');
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [ref]);
}

/** True while a modal is open (global keyboard shortcuts stay quiet). */
export function modalOpen(): boolean {
  return stack.length > 0;
}
