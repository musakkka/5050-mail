import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One global tooltip for every element with `data-tooltip` (02-components §15):
 * shows after ~500 ms hover (or on keyboard focus), 8px below the anchor, hides on leave/scroll/press.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const show = (el: Element, immediate: boolean) => {
      clearTimeout(timer.current);
      current.current = el;
      const run = () => {
        if (current.current !== el || !el.isConnected) return;
        const text = el.getAttribute('data-tooltip');
        if (!text) return;
        const r = el.getBoundingClientRect();
        const above = r.bottom + 40 > window.innerHeight;
        setTip({ text, x: r.left + r.width / 2, y: above ? r.top - 8 : r.bottom + 8, above });
      };
      if (immediate) run();
      else timer.current = setTimeout(run, 500);
    };
    const hide = () => {
      clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.('[data-tooltip]');
      if (el && el !== current.current) show(el, false);
      else if (!el && current.current) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as Element;
      if (el?.matches?.(':focus-visible') && el.hasAttribute('data-tooltip')) show(el, false);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div className={`tooltip${tip.above ? ' tooltip--above' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}
