import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../icons/Icon';
import { IconButton } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { LinearProgress } from '../ui/Progress';
import { Menu, MenuDivider, MenuItem } from '../ui/Menu';
import { ThreadRow } from './ThreadRow';
import { LabelAsMenu, MoveToMenu, SnoozeMenu } from './ActionMenus';
import { useCommands, type Target } from './commands';
import { CategoryTabs } from './CategoryTabs';
import { useContacts, useMail, useMailboxes, useQuota, useThreadPage, useViewContext } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import { useKeys } from '../../state/keys';
import { viewQuery, viewTitle, viewUrl, type View } from '../../mail/views';
import { queryAllEmailIds, type ThreadSummary } from '../../mail/threads';
import { getEmailsChunked } from '../../mail/threads';
import { resolveFilenameFilters } from '../../mail/filenameFilter';
import type { ActionKind } from '../../mail/actions';
import { formatCount, formatSize } from '../../lib/format';
import { startThreadDrag, endThreadDrag } from '../../lib/dnd';
import { useComposeOpeners } from '../compose/openers';
import { useAttachmentPreview } from '../thread/AttachmentPreview';
import { KW } from '../../mail/mapping';

export function ThreadList({ view, page, openThreadId, compactRows }: { view: View; page: number; openThreadId?: string; compactRows?: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { client, myEmails } = useMail();
  const { data: model } = useMailboxes();
  const vctx = useViewContext(model);
  const { data, isFetching, isLoading, refetch, error } = useThreadPage(view, page);
  const settings = useSettings();
  const selection = useUi((s) => s.selection);
  const setSelection = useUi((s) => s.setSelection);
  const clearSelection = useUi((s) => s.clearSelection);
  const anchor = useUi((s) => s.selectionAnchor);
  const selectAllMatching = useUi((s) => s.selectAllMatching);
  const setSelectAllMatching = useUi((s) => s.setSelectAllMatching);
  const cursor = useUi((s) => s.cursor);
  const kbdNav = useUi((s) => s.kbdNav);
  const setCursor = useUi((s) => s.setCursor);
  const showSnack = useUi((s) => s.showSnack);
  const openDialog = useUi((s) => s.openDialog);
  const menuRequest = useUi((s) => s.menuRequest);
  const setListKeys = useKeys((s) => s.setList);
  const { act, viewMailboxId, isTrash, isSpam, isSnoozed, isInbox } = useCommands(view);
  const { reply, openDraft } = useComposeOpeners();
  const preview = useAttachmentPreview();
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<null | {
    kind: 'select' | 'more' | 'snooze' | 'label' | 'move' | 'context';
    anchor: Element | { x: number; y: number };
    targets: Target[];
    /** Opened from the toolbar for the current selection (which may be "all N in view"). */
    selection?: boolean;
  }>(null);
  const [scrolled, setScrolled] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total;
  const pageSize = settings.pageSize;
  const isDrafts = view.kind === 'folder' && view.key === 'drafts';
  const isSent = view.kind === 'folder' && (view.key === 'sent' || view.key === 'scheduled');
  const isScheduled = view.kind === 'folder' && view.key === 'scheduled';
  const isSearch = view.kind === 'search';
  const multiline = !!compactRows;
  const showTabs = isInbox && !!vctx?.categoriesEnabled && settings.inboxType === 'default';

  // Clear selection when the view/page changes.
  const viewKey = `${view.kind}:${view.key}:${page}`;
  useEffect(() => {
    clearSelection();
    setCursor(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [viewKey, clearSelection, setCursor]);

  // Drop selected ids that disappeared (e.g. after archiving).
  useEffect(() => {
    if (!selection.size) return;
    const ids = new Set(items.map((i) => i.threadId));
    const kept = new Set([...selection].filter((s) => ids.has(s)));
    if (kept.size !== selection.size) setSelection(kept);
  }, [items, selection, setSelection]);

  const selectedItems = useMemo(() => items.filter((i) => selection.has(i.threadId)), [items, selection]);
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const someSelected = selectedItems.length > 0 && !allSelected;

  const rowHeight = settings.density === 'compact' ? 32 : 40;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (multiline ? 92 : settings.density === 'default' && items[i]?.attachments.length ? rowHeight + 36 : rowHeight),
    overscan: 10,
    getItemKey: (i) => items[i]?.threadId ?? i,
  });

  // Keep cursor row visible.
  useEffect(() => {
    if (items.length) virtualizer.scrollToIndex(Math.min(cursor, items.length - 1), { align: 'auto' });
  }, [cursor, items.length, virtualizer]);

  const targetsFor = useCallback((list: ThreadSummary[]): Target[] => list.map((t) => ({ threadId: t.threadId, emails: t.emails })), []);

  /** Run an action on the selection (or "all matching" set). */
  const actOnSelection = useCallback(
    async (kind: ActionKind, extra: Parameters<typeof act>[2] = {}) => {
      if (selectAllMatching && vctx) {
        const q = viewQuery(view, vctx);
        useUi.getState().addBusy(1);
        try {
          const refs = await queryAllEmailIds(client, (await resolveFilenameFilters(client, q.filter)) ?? q.filter);
          const emails = await getEmailsChunked(
            client,
            refs.map((r) => r.id),
            ['id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt'],
          );
          const byThread = new Map<string, Target>();
          for (const e of emails) {
            const t = byThread.get(e.threadId) ?? { threadId: e.threadId, emails: [] };
            t.emails.push(e);
            byThread.set(e.threadId, t);
          }
          await act(kind, [...byThread.values()], extra);
        } finally {
          useUi.getState().addBusy(-1);
        }
        clearSelection();
        return;
      }
      if (!selectedItems.length) return;
      await act(kind, targetsFor(selectedItems), extra);
    },
    [selectAllMatching, vctx, view, client, act, selectedItems, targetsFor, clearSelection],
  );

  const confirmDeleteForever = (targets: Target[]) => {
    openDialog({
      kind: 'confirm',
      title: 'Delete forever',
      body: `This action will affect ${targets.length === 1 ? '1 conversation' : `all ${targets.length} selected conversations`}. Are you sure you want to continue?`,
      confirmLabel: 'OK',
      onConfirm: () => void act('deleteForever', targets),
    });
  };

  const open = useCallback(
    (item: ThreadSummary, e?: MouseEvent) => {
      if (isDrafts || (item.emails.length === 1 && item.emails[0]!.keywords[KW.draft] && !isScheduled)) {
        void openDraft(item.threadId, item.emailId);
        return;
      }
      const url = viewUrl(view, { threadId: item.threadId, page });
      if (e && (e.metaKey || e.ctrlKey)) {
        window.open(url, '_blank', 'noopener');
        return;
      }
      nav(url);
    },
    [isDrafts, isScheduled, openDraft, view, page, nav],
  );

  const toggleSelect = useCallback(
    (item: ThreadSummary, index: number, e: MouseEvent) => {
      const next = new Set(useUi.getState().selection);
      const turnOn = !next.has(item.threadId);
      const anchorIdx = anchor ? items.findIndex((i) => i.threadId === anchor) : -1;
      if (e.shiftKey && anchorIdx >= 0) {
        const anchorOn = next.has(anchor!);
        const [a, b] = [Math.min(anchorIdx, index), Math.max(anchorIdx, index)];
        for (let i = a; i <= b; i++) {
          if (anchorOn) next.add(items[i]!.threadId);
          else next.delete(items[i]!.threadId);
        }
      } else if (turnOn) next.add(item.threadId);
      else next.delete(item.threadId);
      setSelection(next, item.threadId);
    },
    [anchor, items, setSelection],
  );

  const selectBy = useCallback(
    (pred: 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred') => {
      const f: Record<typeof pred, (t: ThreadSummary) => boolean> = {
        all: () => true,
        none: () => false,
        read: (t) => !t.unread,
        unread: (t) => t.unread,
        starred: (t) => t.starred,
        unstarred: (t) => !t.starred,
      };
      setSelection(new Set(items.filter(f[pred]).map((t) => t.threadId)), null);
    },
    [items, setSelection],
  );

  const pageCount = total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : page + (items.length === pageSize ? 1 : 0);
  const goPage = useCallback((p: number) => nav(viewUrl(view, { page: p })), [nav, view]);

  // Keyboard API.
  const cursorItem = items[Math.min(cursor, items.length - 1)];
  const keyTargets = useCallback(
    (): Target[] => (selectedItems.length ? targetsFor(selectedItems) : cursorItem ? targetsFor([cursorItem]) : []),
    [selectedItems, cursorItem, targetsFor],
  );
  useEffect(() => {
    setListKeys({
      moveCursor: (d) => {
        const n = cursor + d;
        if (n >= items.length && page < pageCount) return goPage(page + 1);
        if (n < 0 && page > 1) return goPage(page - 1);
        setCursor(Math.max(0, Math.min(items.length - 1, n)));
      },
      openCursor: () => cursorItem && open(cursorItem),
      toggleSelectCursor: () => {
        if (!cursorItem) return;
        const next = new Set(selection);
        if (next.has(cursorItem.threadId)) next.delete(cursorItem.threadId);
        else next.add(cursorItem.threadId);
        setSelection(next, cursorItem.threadId);
      },
      selectBy,
      act: (kind) => {
        if (selectAllMatching) return void actOnSelection(kind === 'trash' && (isTrash || isSpam) ? 'deleteForever' : kind);
        const t = keyTargets();
        if (!t.length) return;
        if (kind === 'star' && t.every((x) => items.find((i) => i.threadId === x.threadId)?.starred)) return void act('unstar', t);
        if (kind === 'trash' && (isTrash || isSpam)) return confirmDeleteForever(t);
        void act(kind, t);
      },
      nextPage: () => page < pageCount && goPage(page + 1),
      prevPage: () => page > 1 && goPage(page - 1),
      openMenu: (kind) => {
        const t = keyTargets();
        const el = toolbarRef.current;
        if (!el || (!t.length && kind !== 'more')) return;
        setMenu({ kind: kind === 'more' ? 'more' : kind, anchor: el.querySelector(`[data-menu=${kind}]`) ?? el, targets: t, selection: selectedItems.length > 0 });
      },
      reply: (mode) => cursorItem && void reply(cursorItem.threadId, mode),
      focusToolbar: () => toolbarRef.current?.querySelector<HTMLElement>('button')?.focus(),
      cycleTab: (d) => {
        if (!showTabs && view.kind !== 'category') return;
        const tabs = ['primary', ...settings.categories.filter((c) => c !== 'primary')];
        const cur = tabs.indexOf(view.kind === 'category' ? view.key : 'primary');
        const next = tabs[(cur + d + tabs.length) % tabs.length]!;
        nav(next === 'primary' ? '/mail/inbox' : `/mail/category/${next}`);
      },
      refresh: () => void refetch(),
    });
    return () => setListKeys(null);
  });

  // Menu requests from keyboard (v / l / b / .) when nothing else handled them.
  useEffect(() => {
    if (!menuRequest) return;
    useKeys.getState().list?.openMenu(menuRequest.kind);
  }, [menuRequest]);

  const onRowAction = useCallback(
    (item: ThreadSummary, kind: 'archive' | 'trash' | 'read' | 'unread' | 'deleteForever' | 'notSpam' | 'unsnooze' | 'moveToInbox') => {
      const t = targetsFor([item]);
      if (kind === 'deleteForever') return confirmDeleteForever(t);
      void act(kind, t);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [act, targetsFor],
  );

  const title = viewTitle(view);
  const from = items.length ? (page - 1) * pageSize + 1 : 0;
  const to = (page - 1) * pageSize + items.length;
  const hasSel = selectedItems.length > 0 || selectAllMatching;

  const empty = !isLoading && !items.length;

  return (
    <div className="list">
      <div className={`list__toolbar${scrolled ? ' list__toolbar--scrolled' : ''}${hasSel ? ' list__toolbar--sel' : ''}`} ref={toolbarRef} role="toolbar" aria-label="List actions">
        <div className="list__toolbar-start">
          <div className="select-ctl">
            <Checkbox
              checked={allSelected || selectAllMatching}
              indeterminate={someSelected}
              label="Select"
              onToggle={() => (allSelected || someSelected ? clearSelection() : selectBy('all'))}
            />
            <button
              type="button"
              className="select-ctl__drop"
              aria-label="Select options"
              data-tooltip="Select"
              onClick={(e) => setMenu({ kind: 'select', anchor: e.currentTarget.parentElement!, targets: [] })}
            >
              <Icon name="arrow_drop_down" size={20} />
            </button>
          </div>
          {!hasSel ? (
            <>
              <IconButton icon="refresh" label="Refresh" onClick={() => void refetch()} />
              <IconButton icon="more_vert" label="More" data-menu="more" onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget, targets: [] })} />
            </>
          ) : (
            <>
              {isTrash || isSpam ? (
                <>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => (selectAllMatching ? void actOnSelection('deleteForever') : confirmDeleteForever(targetsFor(selectedItems)))}
                  >
                    Delete forever
                  </button>
                  {isSpam ? (
                    <button type="button" className="text-action" onClick={() => void actOnSelection('notSpam')}>
                      Not spam
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {isSnoozed ? (
                    <IconButton icon="move_to_inbox" label="Unsnooze" onClick={() => void actOnSelection('unsnooze')} />
                  ) : (
                    <IconButton icon="archive" label="Archive" onClick={() => void actOnSelection('archive')} />
                  )}
                  <IconButton icon="report" label="Report spam" onClick={() => void actOnSelection('spam')} />
                  <IconButton icon="delete" label="Delete" onClick={() => void actOnSelection('trash')} />
                </>
              )}
              <span className="toolbar-divider" />
              {selectedItems.some((i) => i.unread) ? (
                <IconButton icon="drafts" label="Mark as read" onClick={() => void actOnSelection('read')} />
              ) : (
                <IconButton icon="mark_email_unread" label="Mark as unread" onClick={() => void actOnSelection('unread')} />
              )}
              {!isTrash && !isSpam ? (
                <IconButton
                  icon="schedule"
                  label="Snooze"
                  data-menu="snooze"
                  onClick={(e) => setMenu({ kind: 'snooze', anchor: e.currentTarget, targets: targetsFor(selectedItems), selection: true })}
                />
              ) : null}
              <span className="toolbar-divider" />
              <IconButton
                icon="drive_file_move"
                label="Move to"
                data-menu="move"
                onClick={(e) => setMenu({ kind: 'move', anchor: e.currentTarget, targets: targetsFor(selectedItems), selection: true })}
              />
              <IconButton
                icon="label"
                label="Labels"
                data-menu="label"
                onClick={(e) => setMenu({ kind: 'label', anchor: e.currentTarget, targets: targetsFor(selectedItems), selection: true })}
              />
              <IconButton
                icon="more_vert"
                label="More"
                data-menu="more"
                onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget, targets: targetsFor(selectedItems) })}
              />
            </>
          )}
        </div>
        <div className="list__toolbar-end">
          {items.length ? (
            <span className="pager__text" aria-live="polite">
              {formatCount(from)}–{formatCount(to)} of {total !== undefined ? formatCount(total) : 'many'}
            </span>
          ) : null}
          <IconButton icon="chevron_left" label="Newer" disabled={page <= 1} onClick={() => goPage(page - 1)} />
          <IconButton icon="chevron_right" label="Older" disabled={page >= pageCount} onClick={() => goPage(page + 1)} />
        </div>
      </div>
      <LinearProgress active={isFetching && !isLoading ? false : isLoading} className="list__progress" />
      {isFetching && !isLoading ? <LinearProgress active className="list__progress list__progress--refetch" /> : null}

      {allSelected && total !== undefined && total > items.length ? (
        <div className="select-banner">
          {selectAllMatching ? (
            <>
              All <b>{formatCount(total)}</b> conversations in {title} are selected.{' '}
              <button type="button" className="link-btn" onClick={() => clearSelection()}>
                Clear selection
              </button>
            </>
          ) : (
            <>
              All <b>{items.length}</b> conversations on this page are selected.{' '}
              <button type="button" className="link-btn" onClick={() => setSelectAllMatching(true)}>
                Select all {formatCount(total)} conversations in {title}
              </button>
            </>
          )}
        </div>
      ) : null}

      <div className="list__scroll" ref={scrollRef} onScroll={(e) => setScrolled((e.currentTarget as HTMLDivElement).scrollTop > 0)}>
        {showTabs ? <CategoryTabs active={view.kind === 'category' ? view.key : 'primary'} /> : null}
        {isSearch ? <SearchChips query={view.key} /> : null}
        {isTrash || isSpam ? (
          <div className="info-banner">
            Messages that have been in {isTrash ? 'Trash' : 'Spam'} more than 30 days will be deleted automatically.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                openDialog({
                  kind: 'confirm',
                  title: isTrash ? 'Empty Trash' : 'Delete all spam messages',
                  body: `All messages in ${isTrash ? 'Trash' : 'Spam'} will be permanently deleted. This can't be undone.`,
                  confirmLabel: 'OK',
                  onConfirm: async () => {
                    const id = viewMailboxId;
                    if (!id) return;
                    const refs = await queryAllEmailIds(client, { inMailbox: id });
                    const max = client.limits?.maxObjectsInSet ?? 500;
                    for (let i = 0; i < refs.length; i += max) await client.emailSet({ destroy: refs.slice(i, i + max).map((r) => r.id) });
                    showSnack({ text: isTrash ? 'Trash emptied.' : 'Spam deleted.' });
                    qc.invalidateQueries({ queryKey: ['threads'] });
                    qc.invalidateQueries({ queryKey: ['mailboxes'] });
                  },
                })
              }
            >
              {isTrash ? 'Empty Trash now' : 'Delete all spam messages now'}
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="empty">
            Couldn't load conversations.{' '}
            <button type="button" className="link-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        ) : null}
        {empty && !error ? <EmptyState view={view} /> : null}
        <div className="list__rows" role="grid" aria-label={title} aria-rowcount={items.length} style={{ height: virtualizer.getTotalSize() }}>
          {model &&
            virtualizer.getVirtualItems().map((vi) => {
              const item = items[vi.index]!;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="list__vrow"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <ThreadRow
                    item={item}
                    selected={selection.has(item.threadId) || selectAllMatching}
                    cursor={vi.index === cursor && settings.keyboardShortcuts && kbdNav}
                    open={item.threadId === openThreadId}
                    myEmails={myEmails}
                    model={model}
                    viewMailboxId={viewMailboxId}
                    showInboxChip={isSearch}
                    isSent={isSent}
                    isDrafts={isDrafts}
                    isTrashOrSpam={isTrash || isSpam}
                    isSnoozed={isSnoozed}
                    density={settings.density}
                    multiline={multiline}
                    labelColors={settings.labelColors}
                    showSnippets={settings.snippets}
                    showMarkers={settings.importanceMarkers}
                    hoverActions={settings.hoverActions}
                    onToggleSelect={(e) => toggleSelect(item, vi.index, e)}
                    onOpen={(e) => {
                      setCursor(vi.index);
                      open(item, e);
                    }}
                    onStar={() => void act(item.starred ? 'unstar' : 'star', targetsFor([item]), {}, { silent: true })}
                    onImportant={() => void act(item.important ? 'notImportant' : 'important', targetsFor([item]))}
                    onAction={(kind) => onRowAction(item, kind)}
                    onSnooze={(el) => setMenu({ kind: 'snooze', anchor: el, targets: targetsFor([item]) })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCursor(vi.index);
                      const t = selection.has(item.threadId) ? targetsFor(selectedItems) : targetsFor([item]);
                      setMenu({ kind: 'context', anchor: { x: e.clientX, y: e.clientY }, targets: t });
                    }}
                    onDragStart={(e) => startThreadDrag(e, selection.has(item.threadId) ? selectedItems : [item])}
                    onDragEnd={endThreadDrag}
                    onOpenAttachment={(a) => preview.open(a, item.attachments)}
                  />
                </div>
              );
            })}
        </div>
        {items.length ? <ListFooter /> : null}
      </div>

      {menu?.kind === 'select' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label="Select">
          {(['all', 'none', 'read', 'unread', 'starred', 'unstarred'] as const).map((p) => (
            <MenuItem key={p} label={p[0]!.toUpperCase() + p.slice(1)} onSelect={() => (setMenu(null), selectBy(p))} />
          ))}
        </Menu>
      ) : null}
      {menu?.kind === 'more' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label="More">
          {menu.targets.length ? (
            <>
              <MenuItem icon="drafts" label="Mark as read" onSelect={() => (setMenu(null), void actOnSelection('read'))} />
              <MenuItem icon="mark_email_unread" label="Mark as unread" onSelect={() => (setMenu(null), void actOnSelection('unread'))} />
              <MenuItem icon="label_important" label="Mark as important" onSelect={() => (setMenu(null), void actOnSelection('important'))} />
              <MenuItem icon="label_off" label="Mark as not important" onSelect={() => (setMenu(null), void actOnSelection('notImportant'))} />
              <MenuItem icon="star" label="Add star" onSelect={() => (setMenu(null), void actOnSelection('star'))} />
              <MenuItem icon="star" label="Remove star" onSelect={() => (setMenu(null), void actOnSelection('unstar'))} />
              <MenuItem icon="volume_off" label="Mute" onSelect={() => (setMenu(null), void actOnSelection('mute'))} />
              {showTabs || view.kind === 'category' ? (
                <MenuItem
                  icon="inbox_customize"
                  label="Move to tab"
                  submenu={(a, close) => (
                    <Menu anchor={a} onClose={close} placement="right-start">
                      {(['primary', ...settings.categories.filter((c) => c !== 'primary')] as const).map((c) => (
                        <MenuItem
                          key={c}
                          label={c[0]!.toUpperCase() + c.slice(1)}
                          onSelect={() => (setMenu(null), void actOnSelection('category', { category: c }))}
                        />
                      ))}
                    </Menu>
                  )}
                />
              ) : null}
            </>
          ) : (
            <MenuItem
              icon="drafts"
              label="Mark all as read"
              onSelect={() => {
                setMenu(null);
                const unread = items.filter((i) => i.unread);
                if (unread.length) void act('read', targetsFor(unread));
              }}
            />
          )}
        </Menu>
      ) : null}
      {menu?.kind === 'snooze' ? (
        <SnoozeMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onPick={(d) => {
            const t = menu.targets;
            setMenu(null);
            if (menu.selection && selectAllMatching) void actOnSelection('snooze', { snoozeUntil: d });
            else void act('snooze', t, { snoozeUntil: d });
          }}
        />
      ) : null}
      {menu?.kind === 'label' ? (
        <LabelAsMenu
          anchor={menu.anchor}
          targets={menu.targets}
          onClose={() => setMenu(null)}
          onApply={(changes) =>
            void (menu.selection && selectAllMatching ? actOnSelection('labels', { labelChanges: changes }) : act('labels', menu.targets, { labelChanges: changes }))
          }
        />
      ) : null}
      {menu?.kind === 'move' ? (
        <MoveToMenu
          anchor={menu.anchor}
          excludeId={viewMailboxId}
          onClose={() => setMenu(null)}
          onMove={(id) =>
            void (menu.selection && selectAllMatching ? actOnSelection('moveTo', { targetMailboxId: id }) : act('moveTo', menu.targets, { targetMailboxId: id }))
          }
        />
      ) : null}
      {menu?.kind === 'context' ? (
        <ContextMenu
          anchor={menu.anchor as { x: number; y: number }}
          targets={menu.targets}
          items={items}
          onClose={() => setMenu(null)}
          onAct={(k, extra) => void act(k, menu.targets, extra)}
          onReply={(mode) => void reply(menu.targets[0]!.threadId, mode)}
          onOpenMenu={(kind, a) => setMenu({ kind, anchor: a, targets: menu.targets })}
          onFind={(q) => nav(`/mail/search/${encodeURIComponent(q)}`)}
          onOpenNew={() => window.open(viewUrl(view, { threadId: menu.targets[0]!.threadId }), '_blank', 'noopener')}
          isTrashOrSpam={isTrash || isSpam}
        />
      ) : null}
      {preview.element}
    </div>
  );
}

function ContextMenu({
  anchor,
  targets,
  items,
  onClose,
  onAct,
  onReply,
  onOpenMenu,
  onFind,
  onOpenNew,
  isTrashOrSpam,
}: {
  anchor: { x: number; y: number };
  targets: Target[];
  items: ThreadSummary[];
  onClose: () => void;
  onAct: (k: ActionKind, extra?: Record<string, unknown>) => void;
  onReply: (m: 'reply' | 'replyAll' | 'forward') => void;
  onOpenMenu: (k: 'snooze' | 'label' | 'move', anchor: Element | { x: number; y: number }) => void;
  onFind: (q: string) => void;
  onOpenNew: () => void;
  isTrashOrSpam: boolean;
}) {
  const one = targets.length === 1 ? items.find((i) => i.threadId === targets[0]!.threadId) : undefined;
  const anyUnread = targets.some((t) => items.find((i) => i.threadId === t.threadId)?.unread);
  const { myEmails } = useMail();
  const sender =
    [...(one?.emails ?? [])]
      .reverse()
      .map((e) => e.from?.[0])
      .find((f) => f && !myEmails.has(f.email.toLowerCase())) ?? one?.emails.at(-1)?.from?.[0];
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <Menu anchor={anchor} onClose={onClose} label="Conversation actions">
      {one ? (
        <>
          <MenuItem icon="reply" label="Reply" onSelect={run(() => onReply('reply'))} />
          <MenuItem icon="reply_all" label="Reply all" onSelect={run(() => onReply('replyAll'))} />
          <MenuItem icon="forward" label="Forward" onSelect={run(() => onReply('forward'))} />
          <MenuDivider />
        </>
      ) : null}
      {isTrashOrSpam ? (
        <MenuItem icon="move_to_inbox" label="Move to Inbox" onSelect={run(() => onAct('moveToInbox'))} />
      ) : (
        <>
          <MenuItem icon="archive" label="Archive" onSelect={run(() => onAct('archive'))} />
          <MenuItem icon="delete" label="Delete" onSelect={run(() => onAct('trash'))} />
        </>
      )}
      {anyUnread ? (
        <MenuItem icon="drafts" label="Mark as read" onSelect={run(() => onAct('read'))} />
      ) : (
        <MenuItem icon="mark_email_unread" label="Mark as unread" onSelect={run(() => onAct('unread'))} />
      )}
      <MenuItem icon="schedule" label="Snooze" onSelect={run(() => onOpenMenu('snooze', anchor))} />
      <MenuDivider />
      <MenuItem icon="drive_file_move" label="Move to" onSelect={run(() => onOpenMenu('move', anchor))} />
      <MenuItem icon="label" label="Label as" onSelect={run(() => onOpenMenu('label', anchor))} />
      <MenuItem icon="volume_off" label="Mute" onSelect={run(() => onAct('mute'))} />
      {one ? (
        <>
          <MenuDivider />
          {sender ? (
            <MenuItem icon="search" label={`Find emails from ${sender.name || sender.email}`} onSelect={run(() => onFind(`from:${sender.email}`))} />
          ) : null}
          <MenuItem icon="search" label="Find emails with this subject" onSelect={run(() => onFind(`subject:"${(one.subject || '').replace(/"/g, '')}"`))} />
          <MenuDivider />
          <MenuItem icon="open_in_new" label="Open in new window" onSelect={run(onOpenNew)} />
        </>
      ) : null}
    </Menu>
  );
}

function SearchChips({ query }: { query: string }) {
  const nav = useNavigate();
  const { data: contacts } = useContacts(true);
  const [menu, setMenu] = useState<null | { kind: 'from' | 'to' | 'time'; anchor: Element }>(null);
  const parts = query.split(/\s+/).filter(Boolean);
  const has = (s: string) => parts.includes(s);
  const opValue = (op: string) => parts.find((p) => p.startsWith(`${op}:`))?.slice(op.length + 1);
  const go = (next: string[]) => nav(`/mail/search/${encodeURIComponent(next.join(' ') || '*')}`);
  const toggle = (s: string) => go(has(s) ? parts.filter((p) => p !== s) : [...parts, s]);
  const setOp = (ops: string[], value: string | null) => go([...parts.filter((p) => !ops.some((o) => p.startsWith(`${o}:`))), ...(value ? [value] : [])]);
  const chip = (label: string, token: string) => (
    <button type="button" className={`filter-chip${has(token) ? ' filter-chip--on' : ''}`} onClick={() => toggle(token)} aria-pressed={has(token)}>
      {has(token) ? <Icon name="check" size={18} /> : null}
      {label}
    </button>
  );
  const drop = (kind: 'from' | 'to' | 'time', label: string, active: string | undefined) => (
    <button
      type="button"
      className={`filter-chip filter-chip--drop${active ? ' filter-chip--on' : ''}`}
      aria-haspopup="menu"
      onClick={(e) => setMenu({ kind, anchor: e.currentTarget })}
    >
      {active ? <Icon name="check" size={18} /> : null}
      {active ?? label}
      <Icon name="arrow_drop_down" size={18} />
    </button>
  );
  const time = opValue('older_than') ?? opValue('newer_than');
  const timeLabels: Record<string, string> = { '7d': 'Older than a week', '1m': 'Older than a month', '6m': 'Older than 6 months', '1y': 'Older than a year' };
  return (
    <div className="search-chips">
      {drop('from', 'From', opValue('from'))}
      {drop('time', 'Any time', time ? (timeLabels[time] ?? time) : undefined)}
      {chip('Has attachment', 'has:attachment')}
      {drop('to', 'To', opValue('to'))}
      {chip('Is unread', 'is:unread')}
      <button type="button" className="filter-chip filter-chip--link" onClick={() => window.dispatchEvent(new Event('ff:advanced-search'))}>
        Advanced search
      </button>
      {menu && menu.kind !== 'time' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label={menu.kind === 'from' ? 'From' : 'To'}>
          {opValue(menu.kind) ? (
            <MenuItem label={`Any ${menu.kind === 'from' ? 'sender' : 'recipient'}`} onSelect={() => (setMenu(null), setOp([menu.kind], null))} />
          ) : null}
          <MenuItem label="me" onSelect={() => (setMenu(null), setOp([menu.kind], `${menu.kind}:me`))} />
          {(contacts ?? []).slice(0, 8).map((c) => (
            <MenuItem
              key={c.email}
              label={c.name || c.email}
              hint={c.name ? c.email : undefined}
              onSelect={() => (setMenu(null), setOp([menu.kind], `${menu.kind}:${c.email}`))}
            />
          ))}
        </Menu>
      ) : null}
      {menu?.kind === 'time' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label="Any time">
          <MenuItem checked={!time} label="Any time" onSelect={() => (setMenu(null), setOp(['older_than', 'newer_than'], null))} />
          {Object.entries(timeLabels).map(([v, l]) => (
            <MenuItem key={v} checked={time === v} label={l} onSelect={() => (setMenu(null), setOp(['older_than', 'newer_than'], `older_than:${v}`))} />
          ))}
          <MenuDivider />
          <MenuItem label="Custom range…" onSelect={() => (setMenu(null), window.dispatchEvent(new Event('ff:advanced-search')))} />
        </Menu>
      ) : null}
    </div>
  );
}

function EmptyState({ view }: { view: View }) {
  let title = `No conversations in ${viewTitle(view)}.`;
  let body: string | null = null;
  if (view.kind === 'folder') {
    if (view.key === 'inbox') {
      title = 'Your Primary tab is empty.';
      body = "Personal messages and messages that don't appear in other tabs will be shown here.";
    }
    if (view.key === 'starred') {
      title = 'No starred messages.';
      body =
        'Stars let you give messages a special status to make them easier to find. To star a message, click on the star outline beside any message or conversation.';
    }
    if (view.key === 'snoozed') {
      title = 'Nothing snoozed.';
      body = 'Snooze conversations to make them come back at a better time.';
    }
    if (view.key === 'drafts') title = "You don't have any saved drafts.";
    if (view.key === 'sent') title = 'No sent messages! Send one now!';
    if (view.key === 'scheduled') title = 'No scheduled messages.';
    if (view.key === 'spam') title = 'Hooray, no spam here!';
  }
  if (view.kind === 'category') {
    const name = viewTitle(view);
    title = `Your ${name} tab is empty.`;
  }
  if (view.kind === 'search') {
    title = 'No messages matched your search.';
    body = 'Try using search options such as sender, date, size and more.';
  }
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {body ? <div className="empty__body">{body}</div> : null}
    </div>
  );
}

function ListFooter() {
  const { data: quota } = useQuota();
  return (
    <div className="list-footer">
      <div className="list-footer__quota">
        {quota ? (
          <>
            <div className="quota-bar">
              <div className="quota-bar__fill" style={{ width: `${quota.limit ? Math.min(100, (quota.used / quota.limit) * 100) : 2}%` }} />
            </div>
            <span>
              {formatSize(quota.used)} {quota.limit ? `of ${formatSize(quota.limit)} used` : 'used'}
            </span>
          </>
        ) : null}
      </div>
      <div className="list-footer__links">5050 Mail · On your own domains</div>
    </div>
  );
}
