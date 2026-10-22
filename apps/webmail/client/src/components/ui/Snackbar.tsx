import { useEffect } from 'react';
import { useUi } from '../../state/ui';
import { IconButton } from './Button';

/** Bottom-left snackbar (02-components §12): one at a time, ~10s or the given duration. */
export function Snackbar() {
  const snack = useUi((s) => s.snack);
  const hide = useUi((s) => s.hideSnack);
  useEffect(() => {
    if (!snack) return;
    const d = snack.duration ?? 10_000;
    if (!d) return;
    const t = setTimeout(() => hide(snack.id), d);
    return () => clearTimeout(t);
  }, [snack, hide]);
  if (!snack) return null;
  return (
    <div className="snackbar" role="status" aria-live="polite" key={snack.id}>
      <span className="snackbar__text">{snack.text}</span>
      {snack.actions?.map((a) => (
        <button
          key={a.label}
          type="button"
          className="snackbar__action"
          onClick={() => {
            hide(snack.id);
            void a.run();
          }}
        >
          {a.label}
        </button>
      ))}
      <IconButton icon="close" label="Close" size={36} className="snackbar__close" onClick={() => hide(snack.id)} />
    </div>
  );
}
