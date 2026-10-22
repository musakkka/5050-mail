import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon, type IconKey } from '../icons/Icon';
import { IconButton } from '../ui/Button';
import { Menu, MenuDivider, MenuItem } from '../ui/Menu';
import { useActions, useCategoryCounts, useMail, useMailboxes } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi, emptyDraft } from '../../state/ui';
import { SYSTEM_FOLDERS, type LabelNode } from '../../mail/mailboxes';
import { sameView, viewUrl, type View } from '../../mail/views';
import { draggedThreads, endThreadDrag, isThreadDrag } from '../../lib/dnd';
import { formatCount } from '../../lib/format';
import { LABEL_PALETTE } from '../../theme/labelColors';
import type { Category } from '../../mail/mapping';

const CATEGORY_NAV: { key: Exclude<Category, 'primary'>; label: string; icon: IconKey }[] = [
  { key: 'social', label: 'Social', icon: 'group' },
  { key: 'updates', label: 'Updates', icon: 'info' },
  { key: 'forums', label: 'Forums', icon: 'forum' },
  { key: 'promotions', label: 'Promotions', icon: 'sell' },
];

export function Nav({ view, collapsed }: { view: View; collapsed: boolean }) {
  const { me, identities } = useMail();
  const nav = useNavigate();
  const { data: model } = useMailboxes();
  const { data: counts } = useCategoryCounts();
  const categories = useSettings((s) => s.categories);
  const inboxType = useSettings((s) => s.inboxType);
  const labelColors = useSettings((s) => s.labelColors);
  const labelVisibility = useSettings((s) => s.labelVisibility);
  const openComposer = useUi((s) => s.openComposer);
  const openDialog = useUi((s) => s.openDialog);
  const hoverOpen = useUi((s) => s.navHoverOpen);
  const setHoverOpen = useUi((s) => s.setNavHoverOpen);
  const mobileOpen = useUi((s) => s.mobileNavOpen);
  const setMobileOpen = useUi((s) => s.setMobileNavOpen);
  const [more, setMore] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const [collapsedLabels, setCollapsedLabels] = useState<Set<string>>(new Set());
  const [labelMenu, setLabelMenu] = useState<{ anchor: Element; node: LabelNode } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const { run } = useActions();

  const expanded = !collapsed || hoverOpen || mobileOpen;
  const categoriesOn = inboxType === 'default' && categories.length > 1;

  const go = (v: View) => {
    setMobileOpen(false);
    nav(viewUrl(v));
  };

  const drop = (e: DragEvent, target: { kind: 'inbox' | 'starred' | 'spam' | 'trash' | 'label' | 'important'; mailboxId?: string }) => {
    const threads = draggedThreads(e);
    endThreadDrag();
    if (!threads?.length || !model) return;
    e.preventDefault();
    const t = threads.map((x) => ({ threadId: x.threadId, emails: x.emails }));
    const viewMailboxId =
      view.kind === 'folder' && view.key === 'inbox'
        ? model.roleId('inbox')
        : view.kind === 'label'
          ? model.idByPath(view.key)
          : view.kind === 'category'
            ? model.roleId('inbox')
            : undefined;
    switch (target.kind) {
      case 'inbox':
        void run({ kind: 'moveToInbox', threads: t, viewMailboxId }, { currentView: view });
        break;
      case 'starred':
        void run({ kind: 'star', threads: t }, { currentView: view });
        break;
      case 'important':
        void run({ kind: 'important', threads: t }, { currentView: view });
        break;
      case 'spam':
        void run({ kind: 'spam', threads: t, viewMailboxId }, { currentView: view });
        break;
      case 'trash':
        void run({ kind: 'trash', threads: t, viewMailboxId }, { currentView: view });
        break;
      case 'label':
        void run({ kind: 'moveTo', threads: t, viewMailboxId, targetMailboxId: target.mailboxId }, { currentView: view });
        break;
    }
  };

  const countFor = (key: string): { n: number; bold: boolean } | null => {
    const f = SYSTEM_FOLDERS.find((x) => x.key === key);
    if (!f?.count || !model) return null;
    if (key === 'inbox' && categoriesOn && counts?.primary) return { n: counts.primary.unread, bold: true };
    const mb = f.role ? model.byRole.get(f.role) : undefined;
    if (!mb) return null;
    const n = mb[f.count];
    return { n, bold: f.count !== 'totalEmails' };
  };

  const folderItem = (f: (typeof SYSTEM_FOLDERS)[number]) => {
    if (f.key === 'scheduled' && !(model?.byRole.get('scheduled')?.totalEmails ?? 0)) return null;
    const v: View = { kind: 'folder', key: f.key as never };
    const active = sameView(view, v) || (f.key === 'inbox' && view.kind === 'category');
    const c = countFor(f.key);
    const dropKind =
      f.key === 'inbox'
        ? 'inbox'
        : f.key === 'starred'
          ? 'starred'
          : f.key === 'spam'
            ? 'spam'
            : f.key === 'trash'
              ? 'trash'
              : f.key === 'imp'
                ? 'important'
                : null;
    return (
      <NavItem
        key={f.key}
        icon={f.icon}
        label={f.label}
        active={active}
        count={c && c.n > 0 ? c.n : undefined}
        bold={!!c?.bold && (c?.n ?? 0) > 0}
        href={viewUrl(v)}
        onClick={() => go(v)}
        collapsed={!expanded}
        onDrop={dropKind ? (e) => drop(e, { kind: dropKind }) : undefined}
      />
    );
  };

  const renderLabels = (nodes: LabelNode[]): ReactNode =>
    nodes.map((n) => {
      const v: View = { kind: 'label', key: n.path };
      const vis = labelVisibility[n.mailbox.id] ?? 'show';
      if (!sameView(view, v) && (vis === 'hide' || (vis === 'unread' && !n.mailbox.unreadThreads))) return null;
      const color = labelColors[n.mailbox.id];
      const hasKids = n.children.length > 0;
      const isCollapsed = collapsedLabels.has(n.mailbox.id);
      return (
        <div key={n.mailbox.id}>
          <NavItem
            icon="label"
            iconFill={!!color}
            iconColor={color?.bg}
            label={n.mailbox.name}
            title={n.path}
            active={sameView(view, v)}
            count={n.mailbox.unreadThreads > 0 ? n.mailbox.unreadThreads : undefined}
            bold={n.mailbox.unreadThreads > 0}
            indent={n.depth}
            href={viewUrl(v)}
            onClick={() => go(v)}
            collapsed={!expanded}
            expander={
              hasKids ? (
                <button
                  type="button"
                  className="nav-item__expander"
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const s = new Set(collapsedLabels);
                    if (isCollapsed) s.delete(n.mailbox.id);
                    else s.add(n.mailbox.id);
                    setCollapsedLabels(s);
                  }}
                >
                  <Icon name={isCollapsed ? 'arrow_drop_down' : 'arrow_drop_down'} size={16} className={isCollapsed ? 'rot-270' : ''} />
                </button>
              ) : undefined
            }
            onMore={(el) => setLabelMenu({ anchor: el, node: n })}
            onDrop={(e) => drop(e, { kind: 'label', mailboxId: n.mailbox.id })}
          />
          {hasKids && !isCollapsed ? renderLabels(n.children) : null}
        </div>
      );
    });

  return (
    <>
      {mobileOpen ? <div className="nav-scrim" onClick={() => setMobileOpen(false)} /> : null}
      <div className="nav-slot">
        <nav
          className={`nav${collapsed ? ' nav--collapsed' : ''}${collapsed && hoverOpen ? ' nav--hover' : ''}${mobileOpen ? ' nav--mobile-open' : ''}`}
          aria-label="Mail folders"
          onMouseEnter={() => {
            if (!collapsed) return;
            clearTimeout(hoverTimer.current);
            hoverTimer.current = setTimeout(() => setHoverOpen(true), 250);
          }}
          onMouseLeave={() => {
            clearTimeout(hoverTimer.current);
            setHoverOpen(false);
          }}
        >
          <div className="nav__compose-wrap">
            <button
              type="button"
              className={`compose-btn${expanded ? '' : ' compose-btn--fab'}`}
              data-tooltip={expanded ? undefined : 'Compose'}
              aria-label="Compose"
              onClick={() => openComposer(emptyDraft(identities[0]?.id))}
            >
              <Icon name="edit" size={24} />
              {expanded ? <span>Compose</span> : null}
            </button>
          </div>
          <div className="nav__scroll">
            {SYSTEM_FOLDERS.filter((f) => !f.more).map(folderItem)}
            <NavItem icon={more ? 'expand_less' : 'expand_more'} label={more ? 'Less' : 'More'} onClick={() => setMore(!more)} collapsed={!expanded} />
            {more ? (
              <>
                {SYSTEM_FOLDERS.filter((f) => f.more).map(folderItem)}
                {categoriesOn ? (
                  <>
                    <NavItem
                      icon="label"
                      label="Categories"
                      onClick={() => setCatsOpen(!catsOpen)}
                      collapsed={!expanded}
                      trailing={<Icon name={catsOpen ? 'expand_less' : 'expand_more'} size={18} />}
                    />
                    {catsOpen
                      ? CATEGORY_NAV.filter((c) => categories.includes(c.key)).map((c) => {
                          const v: View = { kind: 'category', key: c.key };
                          return (
                            <NavItem
                              key={c.key}
                              icon={c.icon}
                              label={c.label}
                              indent={1}
                              active={sameView(view, v)}
                              href={viewUrl(v)}
                              onClick={() => go(v)}
                              collapsed={!expanded}
                              count={counts?.[c.key]?.unread || undefined}
                              bold={!!counts?.[c.key]?.unread}
                            />
                          );
                        })
                      : null}
                  </>
                ) : null}
                <NavItem icon="settings" label="Manage labels" onClick={() => nav('/mail/settings/labels')} collapsed={!expanded} />
                <NavItem icon="add" label="Create new label" onClick={() => openDialog({ kind: 'createLabel' })} collapsed={!expanded} />
              </>
            ) : null}
            {me.isAdmin ? (
              <NavItem icon="admin_panel_settings" label="Admin console" href="/admin" onClick={() => nav('/admin')} collapsed={!expanded} />
            ) : null}
            {expanded ? (
              <div className="nav__labels-header">
                <span>Labels</span>
                <IconButton icon="add" label="Create new label" size={32} onClick={() => openDialog({ kind: 'createLabel' })} />
              </div>
            ) : (
              <div className="nav__divider" />
            )}
            {model ? renderLabels(model.labelTree) : null}
          </div>
        </nav>
      </div>
      {labelMenu ? <LabelOptionsMenu anchor={labelMenu.anchor} node={labelMenu.node} onClose={() => setLabelMenu(null)} /> : null}
    </>
  );
}

function NavItem({
  icon,
  iconFill,
  iconColor,
  label,
  title,
  active,
  count,
  bold,
  indent = 0,
  href,
  onClick,
  collapsed,
  expander,
  trailing,
  onMore,
  onDrop,
}: {
  icon: IconKey;
  iconFill?: boolean;
  iconColor?: string;
  label: string;
  title?: string;
  active?: boolean;
  count?: number;
  bold?: boolean;
  indent?: number;
  href?: string;
  onClick: () => void;
  collapsed: boolean;
  expander?: ReactNode;
  trailing?: ReactNode;
  onMore?: (el: Element) => void;
  onDrop?: (e: DragEvent) => void;
}) {
  const [over, setOver] = useState(false);
  const cls = `nav-item${active ? ' nav-item--active' : ''}${bold ? ' nav-item--bold' : ''}${over ? ' nav-item--drop' : ''}`;
  const content = (
    <>
      <span className="nav-item__lead" style={collapsed ? undefined : { paddingLeft: indent * 12 }}>
        {expander ?? (indent > 0 && !collapsed ? <span className="nav-item__expander-space" /> : null)}
        <span className="nav-item__icon" style={iconColor ? { color: iconColor } : undefined}>
          <Icon name={icon} size={20} fill={active || iconFill} />
          {collapsed && count ? <span className="nav-item__dot" /> : null}
        </span>
      </span>
      {!collapsed ? <span className="nav-item__label">{label}</span> : null}
      {!collapsed && count ? <span className="nav-item__count">{formatCount(count)}</span> : null}
      {!collapsed && trailing ? <span className="nav-item__trailing">{trailing}</span> : null}
      {!collapsed && onMore ? (
        <button
          type="button"
          className="nav-item__more"
          aria-label="Label options"
          data-tooltip="Label options"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMore(e.currentTarget);
          }}
        >
          <Icon name="more_vert" size={20} />
        </button>
      ) : null}
    </>
  );
  const dnd = onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          if (!isThreadDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          setOver(false);
          onDrop(e);
        },
      }
    : {};
  if (href)
    return (
      <Link
        to={href}
        className={cls}
        title={collapsed ? label : title}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          onClick();
        }}
        {...dnd}
      >
        {content}
      </Link>
    );
  return (
    <button type="button" className={cls} title={collapsed ? label : undefined} onClick={onClick} {...dnd}>
      {content}
    </button>
  );
}

function LabelOptionsMenu({ anchor, node, onClose }: { anchor: Element; node: LabelNode; onClose: () => void }) {
  const { client } = useMail();
  const openDialog = useUi((s) => s.openDialog);
  const showSnack = useUi((s) => s.showSnack);
  const labelColors = useSettings((s) => s.labelColors);
  const labelVisibility = useSettings((s) => s.labelVisibility);
  const setSettings = useSettings((s) => s.set);
  const { invalidate } = useActions();
  const vis = labelVisibility[node.mailbox.id] ?? 'show';
  const setVis = (v: 'show' | 'unread' | 'hide') => {
    setSettings({ labelVisibility: { ...labelVisibility, [node.mailbox.id]: v } });
    onClose();
  };
  const nav = useNavigate();
  const { data: model } = useMailboxes();
  return (
    <Menu anchor={anchor} onClose={onClose} label="Label options">
      <MenuItem
        icon="palette"
        label="Label colour"
        submenu={(a, close) => (
          <Menu anchor={a} onClose={close} placement="right-start" className="color-menu">
            <div className="color-grid">
              {LABEL_PALETTE.map((c) => (
                <button
                  key={c.bg}
                  type="button"
                  role="menuitem"
                  className="color-swatch"
                  style={{ background: c.bg, color: c.fg }}
                  aria-label={`Colour ${c.bg}`}
                  onClick={() => {
                    setSettings({ labelColors: { ...labelColors, [node.mailbox.id]: c } });
                    onClose();
                  }}
                >
                  a
                </button>
              ))}
            </div>
            <MenuDivider />
            <MenuItem
              label="Remove colour"
              onSelect={() => {
                const next = { ...labelColors };
                delete next[node.mailbox.id];
                setSettings({ labelColors: next });
                onClose();
              }}
            />
          </Menu>
        )}
      />
      <MenuItem
        icon="visibility"
        label="In label list"
        submenu={(a, close) => (
          <Menu anchor={a} onClose={close} placement="right-start">
            <MenuItem checked={vis === 'show'} label="Show" onSelect={() => setVis('show')} />
            <MenuItem checked={vis === 'unread'} label="Show if unread" onSelect={() => setVis('unread')} />
            <MenuItem checked={vis === 'hide'} label="Hide" onSelect={() => setVis('hide')} />
          </Menu>
        )}
      />
      <MenuDivider />
      <MenuItem icon="edit" label="Edit" onSelect={() => (onClose(), openDialog({ kind: 'editLabel', mailboxId: node.mailbox.id }))} />
      <MenuItem
        icon="delete"
        label="Remove label"
        onSelect={() => {
          onClose();
          openDialog({
            kind: 'confirm',
            title: 'Remove label',
            body: `Delete the label "${node.path}"? Conversations with this label keep their other labels; ones that only had this label move to Archive.`,
            confirmLabel: 'Delete',
            onConfirm: async () => {
              try {
                // Emails only in this label must keep a mailbox: move them to Archive first (05 §1).
                const archive = model?.roleId('archive');
                const ids = [node.mailbox.id, ...collectChildren(node)];
                const b = client.batch();
                const q = b.call('Email/query', { filter: { inMailbox: node.mailbox.id }, limit: 5000 });
                const g = b.call('Email/get', { '#ids': q.ref('/ids'), properties: ['mailboxIds'] });
                const r = await b.send();
                const update: Record<string, Record<string, unknown>> = {};
                for (const e of r.get(g).list)
                  if (Object.keys(e.mailboxIds).every((m) => ids.includes(m)) && archive) update[e.id] = { [`mailboxIds/${archive}`]: true };
                if (Object.keys(update).length) await client.emailSet({ update });
                const res = await client.mailboxSet({ destroy: ids.reverse(), onDestroyRemoveEmails: false });
                if (res.notDestroyed && Object.keys(res.notDestroyed).length) throw new Error(Object.values(res.notDestroyed)[0]!.description ?? 'failed');
                showSnack({ text: `Label "${node.mailbox.name}" removed.` });
                invalidate([]);
                nav('/mail/inbox');
              } catch (e) {
                showSnack({ text: `Couldn't remove label: ${(e as Error).message}` });
              }
            },
          });
        }}
      />
      <MenuItem icon="new_label" label="Add sublabel" onSelect={() => (onClose(), openDialog({ kind: 'createLabel', parentId: node.mailbox.id }))} />
    </Menu>
  );
}

function collectChildren(n: LabelNode): string[] {
  return n.children.flatMap((c) => [c.mailbox.id, ...collectChildren(c)]);
}
