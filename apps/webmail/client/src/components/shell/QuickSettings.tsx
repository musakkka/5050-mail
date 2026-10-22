import { useNavigate } from 'react-router-dom';
import { IconButton, Button } from '../ui/Button';
import { useSettings, type Density, type InboxType, type ReadingPane, type Theme } from '../../state/settings';
import { useUi } from '../../state/ui';

function Radio<T extends string>({
  name,
  value,
  current,
  label,
  onChange,
  thumb,
}: {
  name: string;
  value: T;
  current: T;
  label: string;
  onChange: (v: T) => void;
  thumb?: React.ReactNode;
}) {
  return (
    <label className="qs-radio">
      <input type="radio" name={name} checked={current === value} onChange={() => onChange(value)} />
      <span className="qs-radio__dot" aria-hidden="true" />
      <span className="qs-radio__label">{label}</span>
      {thumb ? <span className="qs-thumb">{thumb}</span> : null}
    </label>
  );
}

/** Small schematic thumbnails (56×40). */
const Thumb = {
  density: (rows: number, chips: boolean) => (
    <svg width="56" height="40" viewBox="0 0 56 40" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <g key={i} transform={`translate(4 ${4 + i * (32 / rows)})`}>
          <rect width="6" height="3" rx="1" fill="currentColor" opacity=".5" />
          <rect x="9" width="35" height="3" rx="1" fill="currentColor" opacity=".3" />
          {chips && i === 0 ? <rect x="9" y="5" width="12" height="4" rx="2" fill="none" stroke="currentColor" opacity=".5" /> : null}
        </g>
      ))}
    </svg>
  ),
  pane: (mode: ReadingPane) => (
    <svg width="56" height="40" viewBox="0 0 56 40" aria-hidden="true">
      <rect x="1" y="1" width="54" height="38" rx="3" fill="none" stroke="currentColor" opacity=".4" />
      {mode === 'right' ? <line x1="28" y1="1" x2="28" y2="39" stroke="currentColor" opacity=".5" /> : null}
      {mode === 'below' ? <line x1="1" y1="20" x2="55" y2="20" stroke="currentColor" opacity=".5" /> : null}
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x="5" y={5 + i * (mode === 'below' ? 3.5 : 8)} width={mode === 'right' ? 19 : 46} height="2" rx="1" fill="currentColor" opacity=".35" />
      ))}
    </svg>
  ),
  theme: (t: Theme) => (
    <svg width="56" height="40" viewBox="0 0 56 40" aria-hidden="true">
      <defs>
        <clipPath id={`clip-${t}`}>
          <rect x="1" y="1" width="54" height="38" rx="6" />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${t})`}>
        <rect x="0" y="0" width="56" height="40" fill={t === 'dark' ? '#1b1b1b' : '#f6f8fc'} />
        {t === 'system' ? <polygon points="56,0 56,40 0,40" fill="#1b1b1b" /> : null}
        <rect x="14" y="8" width="38" height="28" rx="4" fill={t === 'dark' ? '#131314' : '#ffffff'} />
      </g>
      <rect x="1" y="1" width="54" height="38" rx="6" fill="none" stroke="currentColor" opacity=".3" />
    </svg>
  ),
};

/** Quick settings side pane (02-components §11). Changes apply immediately. */
export function QuickSettings() {
  const s = useSettings();
  const set = s.set;
  const close = useUi((x) => x.setQuickSettings);
  const nav = useNavigate();
  return (
    <aside className="qs" aria-label="Quick settings">
      <div className="qs__head">
        <h2>Quick settings</h2>
        <IconButton icon="close" label="Close" onClick={() => close(false)} />
      </div>
      <div className="qs__body">
        <Button variant="outlined" className="qs__all" onClick={() => (close(false), nav('/mail/settings/general'))}>
          See all settings
        </Button>
        <section className="qs__section">
          <h3>Density</h3>
          <Radio<Density>
            name="density"
            value="default"
            current={s.density}
            label="Default"
            onChange={(v) => set({ density: v })}
            thumb={Thumb.density(3, true)}
          />
          <Radio<Density>
            name="density"
            value="comfortable"
            current={s.density}
            label="Comfortable"
            onChange={(v) => set({ density: v })}
            thumb={Thumb.density(4, false)}
          />
          <Radio<Density>
            name="density"
            value="compact"
            current={s.density}
            label="Compact"
            onChange={(v) => set({ density: v })}
            thumb={Thumb.density(6, false)}
          />
        </section>
        <section className="qs__section">
          <h3>Theme</h3>
          <Radio<Theme> name="theme" value="light" current={s.theme} label="Light" onChange={(v) => set({ theme: v })} thumb={Thumb.theme('light')} />
          <Radio<Theme> name="theme" value="dark" current={s.theme} label="Dark" onChange={(v) => set({ theme: v })} thumb={Thumb.theme('dark')} />
          <Radio<Theme>
            name="theme"
            value="system"
            current={s.theme}
            label="Device default"
            onChange={(v) => set({ theme: v })}
            thumb={Thumb.theme('system')}
          />
        </section>
        <section className="qs__section">
          <h3>Inbox type</h3>
          <Radio<InboxType> name="inboxType" value="default" current={s.inboxType} label="Default" onChange={(v) => set({ inboxType: v })} />
          <Radio<InboxType> name="inboxType" value="important" current={s.inboxType} label="Important first" onChange={(v) => set({ inboxType: v })} />
          <Radio<InboxType> name="inboxType" value="unread" current={s.inboxType} label="Unread first" onChange={(v) => set({ inboxType: v })} />
          <Radio<InboxType> name="inboxType" value="starred" current={s.inboxType} label="Starred first" onChange={(v) => set({ inboxType: v })} />
        </section>
        <section className="qs__section">
          <h3>Reading pane</h3>
          <Radio<ReadingPane>
            name="pane"
            value="none"
            current={s.readingPane}
            label="No split"
            onChange={(v) => set({ readingPane: v })}
            thumb={Thumb.pane('none')}
          />
          <Radio<ReadingPane>
            name="pane"
            value="right"
            current={s.readingPane}
            label="Right of inbox"
            onChange={(v) => set({ readingPane: v })}
            thumb={Thumb.pane('right')}
          />
          <Radio<ReadingPane>
            name="pane"
            value="below"
            current={s.readingPane}
            label="Below inbox"
            onChange={(v) => set({ readingPane: v })}
            thumb={Thumb.pane('below')}
          />
        </section>
        <section className="qs__section">
          <h3>Email threading</h3>
          <label className="qs-check">
            <input type="checkbox" checked={s.conversationView} onChange={(e) => set({ conversationView: e.target.checked })} />
            <span>Conversation view</span>
          </label>
        </section>
      </div>
    </aside>
  );
}
