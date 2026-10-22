import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, MenuDivider, MenuHeader, MenuItem, Popover, type Anchor, type Placement } from '../ui/Menu';
import { Icon } from '../icons/Icon';
import { Button } from '../ui/Button';
import { useMailboxes } from '../../state/mail';
import { useUi } from '../../state/ui';
import { snoozeOptions, type Target } from './commands';

export function SnoozeMenu({ anchor, onClose, onPick, placement }: { anchor: Anchor; onClose: () => void; onPick: (d: Date) => void; placement?: Placement }) {
  const openDialog = useUi((s) => s.openDialog);
  const opts = snoozeOptions();
  const fmt = (d: Date) => {
    const sameDay = d.toDateString() === new Date().toDateString();
    const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return sameDay ? t : `${d.toLocaleDateString(undefined, { weekday: 'short' })}, ${t}`;
  };
  return (
    <Menu anchor={anchor} onClose={onClose} placement={placement} className="snooze-menu" label="Snooze until">
      <MenuHeader>Snooze until…</MenuHeader>
      {opts.map((o) => (
        <MenuItem
          key={o.label}
          label={o.label}
          trailing={<span className="menu-item__hint">{fmt(o.when)}</span>}
          onSelect={() => (onClose(), onPick(o.when))}
        />
      ))}
      <MenuDivider />
      <MenuItem
        icon="date_range"
        label="Pick date & time"
        onSelect={() => {
          onClose();
          const d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(8, 0, 0, 0);
          openDialog({ kind: 'datetime', title: 'Pick date & time', initial: d, onPick });
        }}
      />
    </Menu>
  );
}

/** "Label as" picker: search + tri-state checkboxes + Apply (02-components §14). */
export function LabelAsMenu({
  anchor,
  targets,
  onClose,
  onApply,
  placement,
}: {
  anchor: Anchor;
  targets: Target[];
  onClose: () => void;
  onApply: (changes: Record<string, boolean>) => void;
  placement?: Placement;
}) {
  const { data: model } = useMailboxes();
  const openDialog = useUi((s) => s.openDialog);
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const initial = useMemo(() => {
    const m: Record<string, 'all' | 'some' | 'none'> = {};
    for (const l of model?.labels ?? []) {
      const has = targets.map((t) => t.emails.some((e) => e.mailboxIds[l.mailbox.id]));
      m[l.mailbox.id] = has.every(Boolean) ? 'all' : has.some(Boolean) ? 'some' : 'none';
    }
    return m;
  }, [model, targets]);
  const [state, setState] = useState(initial);
  const changes = Object.fromEntries(
    Object.entries(state)
      .filter(([id, v]) => v !== initial[id] && v !== 'some')
      .map(([id, v]) => [id, v === 'all']),
  );
  const dirty = Object.keys(changes).length > 0;
  const list = (model?.labels ?? []).filter((l) => !q || l.path.toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} className="menu picker" role="menu" label="Label as">
      <div className="picker__title">Label as:</div>
      <div className="picker__search">
        <input
          value={q}
          placeholder="Search labels"
          aria-label="Search labels"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) {
              onClose();
              onApply(changes);
            }
          }}
        />
        <Icon name="search" size={18} />
      </div>
      <div className="picker__list">
        {list.map((l) => {
          const v = state[l.mailbox.id] ?? 'none';
          return (
            <div
              key={l.mailbox.id}
              role="menuitemcheckbox"
              aria-checked={v === 'all' ? true : v === 'some' ? 'mixed' : false}
              tabIndex={-1}
              className="menu-item picker__item"
              onClick={() => setState({ ...state, [l.mailbox.id]: v === 'all' ? 'none' : 'all' })}
              onKeyDown={(e) => e.key === 'Enter' && setState({ ...state, [l.mailbox.id]: v === 'all' ? 'none' : 'all' })}
            >
              <Icon name={v === 'all' ? 'check_box' : v === 'some' ? 'indeterminate_check_box' : 'check_box_outline_blank'} fill={v !== 'none'} />
              <span className="menu-item__label">{l.path}</span>
            </div>
          );
        })}
        {!list.length ? <div className="picker__empty">No labels found</div> : null}
      </div>
      <MenuDivider />
      {dirty ? (
        <MenuItem label={<strong>Apply</strong>} onSelect={() => (onClose(), onApply(changes))} />
      ) : (
        <>
          <MenuItem label="Create new" onSelect={() => (onClose(), openDialog({ kind: 'createLabel', applyToSelection: true }))} />
          <MenuItem label="Manage labels" onSelect={() => (onClose(), nav('/mail/settings/labels'))} />
        </>
      )}
    </Popover>
  );
}

export function MoveToMenu({
  anchor,
  onClose,
  onMove,
  placement,
  excludeId,
}: {
  anchor: Anchor;
  onClose: () => void;
  onMove: (mailboxId: string) => void;
  placement?: Placement;
  excludeId?: string;
}) {
  const { data: model } = useMailboxes();
  const openDialog = useUi((s) => s.openDialog);
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    if (!model) return [];
    const sys = [
      { id: model.roleId('inbox'), label: 'Inbox' },
      ...model.labels.map((l) => ({ id: l.mailbox.id, label: l.path })),
      { id: model.roleId('junk'), label: 'Spam' },
      { id: model.roleId('trash'), label: 'Trash' },
    ];
    return sys.filter((x): x is { id: string; label: string } => !!x.id && x.id !== excludeId);
  }, [model, excludeId]);
  const list = items.filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement} className="menu picker" role="menu" label="Move to">
      <div className="picker__title">Move to:</div>
      <div className="picker__search">
        <input
          value={q}
          placeholder="Search"
          aria-label="Search labels"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) {
              onClose();
              onMove(list[0].id);
            }
          }}
        />
        <Icon name="search" size={18} />
      </div>
      <div className="picker__list">
        {list.map((i) => (
          <MenuItem key={i.id} label={i.label} onSelect={() => (onClose(), onMove(i.id))} />
        ))}
      </div>
      <MenuDivider />
      <MenuItem label="Create new" onSelect={() => (onClose(), openDialog({ kind: 'createLabel', applyToSelection: true }))} />
    </Popover>
  );
}

export function ConfirmFooter({ onCancel, onOk, okLabel }: { onCancel: () => void; onOk: () => void; okLabel: string }) {
  return (
    <>
      <Button variant="text" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="text" onClick={onOk}>
        {okLabel}
      </Button>
    </>
  );
}
