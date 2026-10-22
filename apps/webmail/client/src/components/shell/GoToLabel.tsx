import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Popover } from '../ui/Menu';
import { Icon } from '../icons/Icon';
import { useMailboxes } from '../../state/mail';
import { viewUrl } from '../../mail/views';

/** `g` then `l`: jump to a label (04-keyboard "Go to label"). */
export function GoToLabel() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const { data: model } = useMailboxes();
  const nav = useNavigate();
  useEffect(() => {
    const f = () => {
      setQ('');
      setHi(0);
      setOpen(true);
    };
    window.addEventListener('ff:goto-label', f);
    return () => window.removeEventListener('ff:goto-label', f);
  }, []);
  if (!open || !model) return null;
  const system = [
    { label: 'Inbox', url: '/mail/inbox' },
    { label: 'Starred', url: '/mail/starred' },
    { label: 'Snoozed', url: '/mail/snoozed' },
    { label: 'Sent', url: '/mail/sent' },
    { label: 'Drafts', url: '/mail/drafts' },
    { label: 'All Mail', url: '/mail/all' },
    { label: 'Spam', url: '/mail/spam' },
    { label: 'Trash', url: '/mail/trash' },
  ];
  const items = [...system, ...model.labels.map((l) => ({ label: l.path, url: viewUrl({ kind: 'label', key: l.path }) }))].filter(
    (i) => !q || i.label.toLowerCase().includes(q.toLowerCase()),
  );
  const go = (url: string) => {
    setOpen(false);
    nav(url);
  };
  return (
    <Popover anchor={{ x: window.innerWidth / 2 - 160, y: 72 }} onClose={() => setOpen(false)} className="menu picker goto-label" label="Go to label">
      <div className="picker__title">Go to label:</div>
      <div className="picker__search">
        <input
          value={q}
          autoFocus
          aria-label="Label name"
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(items.length - 1, h + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
            if (e.key === 'Enter' && items[hi]) go(items[hi]!.url);
          }}
        />
        <Icon name="search" size={18} />
      </div>
      <div className="picker__list" role="listbox">
        {items.map((i, n) => (
          <div
            key={i.url}
            role="option"
            aria-selected={n === hi}
            className={`menu-item${n === hi ? ' menu-item--hi' : ''}`}
            onMouseEnter={() => setHi(n)}
            onClick={() => go(i.url)}
          >
            <span className="menu-item__label">{i.label}</span>
          </div>
        ))}
      </div>
    </Popover>
  );
}
