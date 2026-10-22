import { IconButton } from '../ui/Button';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import { useContacts } from '../../state/mail';
import { Avatar } from '../ui/Avatar';

/**
 * Spec 02 §10: show only add-ons that exist. v1 has Contacts (harvested from
 * correspondence); Calendar / Notes / Tasks get added here when implemented.
 */
const PANELS = [{ key: 'contacts', icon: 'person' as const, label: 'Contacts' }];

/** Right side-panel strip (02-components §10) with monochrome add-on icons. */
export function SidePanel() {
  const hidden = useSettings((s) => s.sidePanelHidden);
  const set = useSettings((s) => s.set);
  const active = useUi((s) => s.sidePanel);
  const setActive = useUi((s) => s.setSidePanel);
  if (hidden)
    return (
      <button type="button" className="side-show" aria-label="Show side panel" data-tooltip="Show side panel" onClick={() => set({ sidePanelHidden: false })}>
        ‹
      </button>
    );
  return (
    <>
      {active ? <AddonPanel kind={active} onClose={() => setActive(null)} /> : null}
      <aside className="side" aria-label="Side panel">
        <div className="side__icons">
          {PANELS.map((p) => (
            <IconButton
              key={p.key}
              icon={p.icon}
              label={p.label}
              active={active === p.key}
              fill={active === p.key}
              onClick={() => setActive(active === p.key ? null : p.key)}
            />
          ))}
          <div className="side__divider" />
        </div>
        <IconButton icon="chevron_right" label="Hide side panel" className="side__hide" onClick={() => (setActive(null), set({ sidePanelHidden: true }))} />
      </aside>
    </>
  );
}

function AddonPanel({ kind, onClose }: { kind: string; onClose: () => void }) {
  const p = PANELS.find((x) => x.key === kind)!;
  const { data: contacts } = useContacts(kind === 'contacts');
  return (
    <section className="addon" aria-label={p.label}>
      <div className="addon__head">
        <h2>{p.label.toUpperCase()}</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="addon__body">
        {kind === 'contacts' ? (
          <ul className="addon__contacts">
            {(contacts ?? []).slice(0, 30).map((c) => (
              <li key={c.email}>
                <Avatar name={c.name} email={c.email} size={32} />
                <span>
                  <span className="addon__name">{c.name || c.email}</span>
                  {c.name ? <span className="addon__email">{c.email}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
