import { useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconKey } from '../icons/Icon';
import { useActions, useCategoryCounts } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { viewUrl } from '../../mail/views';
import type { Category } from '../../mail/mapping';
import { draggedThreads, endThreadDrag, isThreadDrag } from '../../lib/dnd';

const TABS: { key: Category; label: string; icon: IconKey; badge: string }[] = [
  { key: 'primary', label: 'Primary', icon: 'inbox', badge: '#0B57D0' },
  { key: 'promotions', label: 'Promotions', icon: 'sell', badge: '#146C2E' },
  { key: 'social', label: 'Social', icon: 'group', badge: '#0B57D0' },
  { key: 'updates', label: 'Updates', icon: 'info', badge: '#B06000' },
  { key: 'forums', label: 'Forums', icon: 'forum', badge: '#8430CE' },
];

export function CategoryTabs({ active }: { active: Category }) {
  const nav = useNavigate();
  const enabled = useSettings((s) => s.categories);
  const { data: counts } = useCategoryCounts();
  const { run } = useActions();
  const [over, setOver] = useState<Category | null>(null);
  const tabs = TABS.filter((t) => t.key === 'primary' || enabled.includes(t.key));

  const onDrop = (e: DragEvent, cat: Category) => {
    setOver(null);
    const threads = draggedThreads(e);
    endThreadDrag();
    if (!threads?.length) return;
    e.preventDefault();
    void run(
      { kind: 'category', category: cat, threads: threads.map((t) => ({ threadId: t.threadId, emails: t.emails })) },
      { currentView: active === 'primary' ? { kind: 'folder', key: 'inbox' } : { kind: 'category', key: active as Exclude<Category, 'primary'> } },
    );
  };

  return (
    <div className="tabs" role="tablist" aria-label="Inbox categories">
      {tabs.map((t) => {
        const isActive = t.key === active;
        const c = counts?.[t.key];
        const showNew = !isActive && t.key !== 'primary' && c && c.unread > 0;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? ' tab--active' : ''}${over === t.key ? ' tab--drop' : ''}`}
            onClick={() =>
              nav(t.key === 'primary' ? viewUrl({ kind: 'folder', key: 'inbox' }) : viewUrl({ kind: 'category', key: t.key as Exclude<Category, 'primary'> }))
            }
            onDragOver={(e) => {
              if (!isThreadDrag(e)) return;
              e.preventDefault();
              setOver(t.key);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => onDrop(e, t.key)}
          >
            <Icon name={t.icon} size={20} fill={isActive} className="tab__icon" />
            <span className="tab__text">
              <span className="tab__label">
                {t.label}
                {showNew ? (
                  <span className="tab__badge" style={{ background: t.badge }}>
                    {c!.unread} new
                  </span>
                ) : null}
              </span>
              {showNew && c!.senders.length ? <span className="tab__senders">{c!.senders.join(', ')}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
