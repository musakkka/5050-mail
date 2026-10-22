import { useEffect, useRef } from 'react';

/** Fades the edge of a horizontal scroller that has more content behind it. */
export const SCROLL_FADE =
  'data-[fade~=l]:[mask-image:linear-gradient(to_right,transparent,black_24px)] data-[fade~=r]:[mask-image:linear-gradient(to_left,transparent,black_24px)] data-[fade~=l]:data-[fade~=r]:[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]';

/**
 * Horizontal scroller (tab strip, table): marks which edges have more content behind them
 * (data-fade, styled by SCROLL_FADE) and keeps the selected tab (aria-selected) in view.
 */
export function useScrollFade<T extends HTMLElement = HTMLDivElement>(activeKey?: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const f = [el.scrollLeft > 1 ? 'l' : '', el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'r' : ''].filter(Boolean).join(' ');
      if (f) el.dataset.fade = f;
      else delete el.dataset.fade;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !active || el.scrollWidth <= el.clientWidth) return;
    const l = active.offsetLeft - el.offsetLeft;
    if (l < el.scrollLeft || l + active.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, l - 24);
  }, [activeKey]);
  return ref;
}
