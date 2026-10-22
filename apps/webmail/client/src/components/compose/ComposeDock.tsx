import { useUi } from '../../state/ui';
import { Composer } from './Composer';

/** Docked compose windows, laid out right → left with a 16px gap (02-components §9.4). */
export function ComposeDock() {
  const composers = useUi((s) => s.composers);
  const updateComposer = useUi((s) => s.updateComposer);
  const docked = composers.filter((c) => !c.inline);
  const maximized = docked.find((c) => c.window === 'maximized');
  const inDock = docked.filter((c) => c !== maximized);
  return (
    <>
      <div className="compose-dock" aria-label="Compose windows">
        {[...inDock].reverse().map((c) => (
          <Composer key={c.id} composer={c} />
        ))}
      </div>
      {maximized ? (
        <div className="compose-modal" onMouseDown={(e) => e.target === e.currentTarget && updateComposer(maximized.id, { window: 'normal' })}>
          <Composer key={maximized.id} composer={maximized} />
        </div>
      ) : null}
    </>
  );
}
