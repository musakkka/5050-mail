import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { useModal } from '../ui/useModal';
import { IconButton } from '../ui/Button';
import { useSettings } from '../../state/settings';
import { SHORTCUT_GROUPS } from './shortcutTable';

/** `?` overlay (04-keyboard.md). */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const on = useSettings((s) => s.keyboardShortcuts);
  const set = useSettings((s) => s.set);
  const ref = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // The Enable/Disable link is the first Tab stop (04-keyboard).
  useModal(box, onClose, { initialFocus: () => ref.current });
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="kbd-help" role="dialog" aria-modal="true" aria-labelledby="kbd-title">
        <div className="kbd-help__head">
          <h2 id="kbd-title">Keyboard shortcuts</h2>
          <span className="kbd-help__toggle">
            Keyboard shortcuts are {on ? 'on' : 'off'} –{' '}
            <button ref={ref} type="button" className="link-btn" onClick={() => set({ keyboardShortcuts: !on })}>
              {on ? 'Disable' : 'Enable'}
            </button>
          </span>
          <IconButton icon="close" label="Close" onClick={onClose} className="kbd-help__close" />
        </div>
        <div className="kbd-help__cols">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className={`kbd-help__group${g.gated && !on ? ' kbd-help__group--off' : ''}`}>
              <h3>{g.title}</h3>
              <table>
                <tbody>
                  {g.rows.map(([k, d]) => (
                    <tr key={k + d}>
                      <td className="kbd-help__keys">
                        {k.split(/( then | \+ | or | \/ )/).map((part, i) =>
                          /^( then | \+ | or | \/ )$/.test(part) ? (
                            <span key={i} className="kbd-help__sep">
                              {part}
                            </span>
                          ) : (
                            <kbd key={i}>{part}</kbd>
                          ),
                        )}
                      </td>
                      <td className="kbd-help__colon">:</td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
