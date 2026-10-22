import { useEffect } from 'react';
import { useSettings, type Theme } from '../state/settings';

/** Resolve "system" and apply theme + density to <html>. */
export function applyTheme(theme: Theme, density: string) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = density;
  // index.html ships light/dark theme-color metas keyed on prefers-color-scheme;
  // once the user's theme is known, both follow it so an explicit choice wins.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#1b1b1b' : '#f6f8fc'));
}

export function useThemeSync() {
  const theme = useSettings((s) => s.theme);
  const density = useSettings((s) => s.density);
  useEffect(() => {
    applyTheme(theme, density);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const f = () => applyTheme(theme, density);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [theme, density]);
}

export function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}
