import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons/Icon';
import { IconButton, Button } from '../ui/Button';
import { LinearProgress } from '../ui/Progress';
import { Menu, MenuDivider, MenuItem } from '../ui/Menu';
import { MessageItem } from './MessageItem';
import { Composer } from '../compose/Composer';
import { LabelAsMenu, MoveToMenu, SnoozeMenu } from '../list/ActionMenus';
import { useCommands, type Target } from '../list/commands';
import { useActions, useConversation, useMail, useMailboxes, useMarkRead } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import { useKeys } from '../../state/keys';
import { viewTitle, viewUrl, type View } from '../../mail/views';
import { KW } from '../../mail/mapping';
import type { LiteEmail, ThreadSummary } from '../../mail/threads';
import type { ActionKind } from '../../mail/actions';
import type { Email } from '../../jmap/types';
import { formatCount, formatShortDateTime } from '../../lib/format';
import { useComposeOpeners } from '../compose/openers';
import { hasMultipleRecipients } from '../../mail/compose';

export function ThreadView({
  view,
  page,
  threadId,
  siblings,
  total,
  split,
}: {
  view: View;
  page: number;
  threadId: string;
  siblings: ThreadSummary[];
  total?: number;
  split?: boolean;
}) {
  const nav = useNavigate();
  const { client, myEmails } = useMail();
  const { data: conv, isLoading, error } = useConversation(threadId);
  const { data: model } = useMailboxes();
  const settings = useSettings();
  const composers = useUi((s) => s.composers);
  const kbdNav = useUi((s) => s.kbdNav);
  const openDialog = useUi((s) => s.openDialog);
  const showSnack = useUi((s) => s.showSnack);
  const setThreadKeys = useKeys((s) => s.setThread);
  const { act, viewMailboxId, isTrash, isSpam, isSnoozed } = useCommands(view);
  const { reply } = useComposeOpeners();
  const markRead = useMarkRead();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllCollapsed, setShowAllCollapsed] = useState(false);
  const [msgCursor, setMsgCursor] = useState(-1);
  const [menu, setMenu] = useState<null | { kind: 'snooze' | 'label' | 'move' | 'more'; anchor: Element }>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScheduled = view.kind === 'folder' && view.key === 'scheduled';

  const trash = model?.roleId('trash');
  const junk = model?.roleId('junk');
  // Hide trashed / spam messages inside a conversation unless we're viewing Trash/Spam.
  const emails = useMemo(() => {
    const all = conv?.emails ?? [];
    if (isTrash) return all.filter((e) => trash && e.mailboxIds[trash]);
    if (isSpam) return all.filter((e) => junk && e.mailboxIds[junk]);
    const visible = all.filter((e) => !Object.keys(e.mailboxIds).every((m) => m === trash || m === junk));
    return visible.length ? visible : all;
  }, [conv, isTrash, isSpam, trash, junk]);

  const target: Target[] = useMemo(() => (emails.length ? [{ threadId, emails: emails as unknown as LiteEmail[] }] : []), [threadId, emails]);

  // Default expansion: unread + last (03-behaviours / 02 §8.4).
  const initFor = useRef<string | null>(null);
  useEffect(() => {
    if (!emails.length || initFor.current === threadId) return;
    initFor.current = threadId;
    const s = new Set<string>();
    emails.forEach((e, i) => {
      if (!e.keywords[KW.seen] || i === emails.length - 1) s.add(e.id);
    });
    setExpanded(s);
    setShowAllCollapsed(false);
    setMsgCursor(emails.length - 1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [emails, threadId]);

  // Mark read on open (respect delay in split mode).
  useEffect(() => {
    if (!emails.length) return;
    const delay = split ? settings.markReadDelay : 0;
    if (delay < 0) return;
    const t = setTimeout(() => markRead(threadId, emails as unknown as LiteEmail[]), delay * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, emails.length]);

  const idx = siblings.findIndex((s) => s.threadId === threadId);
  const back = useCallback(() => nav(viewUrl(view, { page })), [nav, view, page]);
  const goSibling = useCallback(
    (delta: number) => {
      const s = siblings[idx + delta];
      if (s) nav(viewUrl(view, { threadId: s.threadId, page }));
    },
    [siblings, idx, nav, view, page],
  );

  const doAct = useCallback(
    async (kind: ActionKind, extra: Parameters<typeof act>[2] = {}) => {
      if (!target.length) return;
      const leaves =
        ['archive', 'trash', 'spam', 'notSpam', 'mute', 'snooze', 'moveTo', 'deleteForever', 'unsnooze', 'moveToInbox', 'removeLabel'].includes(kind) ||
        (kind === 'unread' && !split);
      const plan = act(kind, target, extra);
      if (leaves && !split) back();
      await plan;
    },
    [act, target, back, split],
  );

  const inlineComposers = composers.filter((c) => c.inline && c.draft.threadId === threadId);
  const last = [...emails].reverse().find((e) => !e.keywords[KW.draft]);
  const multiple = last ? hasMultipleRecipients(last, myEmails) : false;

  useEffect(() => {
    setThreadKeys({
      act: (kind) => {
        if (kind === 'star') {
          const starred = emails.some((e) => e.keywords[KW.flagged]);
          return void act(starred ? 'unstar' : 'star', target, {}, { silent: true });
        }
        if (kind === 'trash' && (isTrash || isSpam)) return void doAct('deleteForever');
        void doAct(kind);
      },
      reply: (mode) => last && void reply(threadId, mode, { email: last, inline: true }),
      back,
      sibling: (d, archiveFirst) => {
        if (archiveFirst) void act('archive', target);
        goSibling(d);
      },
      expandAll: () => {
        setShowAllCollapsed(true);
        setExpanded(new Set(emails.map((e) => e.id)));
      },
      collapseAll: () => setExpanded(new Set()),
      moveMessageCursor: (d) => setMsgCursor((c) => Math.max(0, Math.min(emails.length - 1, c + d))),
      toggleCursorMessage: () => {
        const e = emails[msgCursor];
        if (!e) return;
        const s = new Set(expanded);
        if (s.has(e.id)) s.delete(e.id);
        else s.add(e.id);
        setExpanded(s);
      },
      openMenu: (kind) => {
        const el = document.querySelector(`.conv__toolbar [data-menu=${kind}]`);
        if (el) setMenu({ kind, anchor: el });
      },
      markUnreadFromCursor: () => {
        const from = emails.slice(Math.max(0, msgCursor));
        void act('unread', [{ threadId, emails: from as unknown as LiteEmail[] }]);
        back();
      },
    });
    return () => setThreadKeys(null);
  });

  if (error)
    return (
      <div className="conv conv--error">
        <p>Couldn't load this conversation.</p>
        <Button variant="text" onClick={back}>
          Back to {viewTitle(view)}
        </Button>
      </div>
    );

  const subject = emails.find((e) => e.subject)?.subject ?? '(no subject)';
  const labelIds = new Set<string>();
  for (const e of emails) for (const m of Object.keys(e.mailboxIds)) labelIds.add(m);
  const chips = [...labelIds].map((id) => model?.byId.get(id)).filter((m) => m && (!m.role || m.role === 'inbox' || m.role === 'junk' || m.role === 'trash'));
  const important = emails.some((e) => e.keywords[KW.important]);
  const anyUnreadHidden = emails.length >= 4 && !showAllCollapsed;

  // Collapsed middle ("count bar") when ≥ 4 messages.
  const items: (Email | { bar: number })[] = [];
  if (anyUnreadHidden) {
    const firstIdx = 0;
    const lastIdx = emails.length - 1;
    let hidden = 0;
    emails.forEach((e, i) => {
      const keep = i === firstIdx || i === lastIdx || i === lastIdx - 1 || expanded.has(e.id);
      if (keep) {
        if (hidden) items.push({ bar: hidden });
        hidden = 0;
        items.push(e);
      } else hidden++;
    });
    if (hidden) items.push({ bar: hidden });
  } else items.push(...emails);

  return (
    <div className={`conv${split ? ' conv--split' : ''}`}>
      <div className="conv__toolbar list__toolbar" role="toolbar" aria-label="Conversation actions">
        <div className="list__toolbar-start">
          {!split ? <IconButton icon="arrow_back" label={`Back to ${viewTitle(view)}`} onClick={back} /> : null}
          {isTrash || isSpam ? (
            <>
              <button
                type="button"
                className="text-action"
                onClick={() =>
                  openDialog({
                    kind: 'confirm',
                    title: 'Delete forever',
                    body: 'This conversation will be permanently deleted.',
                    confirmLabel: 'OK',
                    onConfirm: () => void doAct('deleteForever'),
                  })
                }
              >
                Delete forever
              </button>
              {isSpam ? (
                <button type="button" className="text-action" onClick={() => void doAct('notSpam')}>
                  Not spam
                </button>
              ) : (
                <IconButton icon="move_to_inbox" label="Move to Inbox" onClick={() => void doAct('moveToInbox')} />
              )}
            </>
          ) : (
            <>
              {isSnoozed ? (
                <IconButton icon="move_to_inbox" label="Unsnooze" onClick={() => void doAct('unsnooze')} />
              ) : (
                <IconButton icon="archive" label="Archive" onClick={() => void doAct('archive')} />
              )}
              <IconButton icon="report" label="Report spam" onClick={() => void doAct('spam')} />
              <IconButton icon="delete" label="Delete" onClick={() => void doAct('trash')} />
            </>
          )}
          <span className="toolbar-divider" />
          <IconButton icon="mark_email_unread" label="Mark as unread" onClick={() => void doAct('unread')} />
          {!isTrash && !isSpam ? (
            <IconButton icon="schedule" label="Snooze" data-menu="snooze" onClick={(e) => setMenu({ kind: 'snooze', anchor: e.currentTarget })} />
          ) : null}
          <span className="toolbar-divider" />
          <IconButton icon="drive_file_move" label="Move to" data-menu="move" onClick={(e) => setMenu({ kind: 'move', anchor: e.currentTarget })} />
          <IconButton icon="label" label="Labels" data-menu="label" onClick={(e) => setMenu({ kind: 'label', anchor: e.currentTarget })} />
          <IconButton icon="more_vert" label="More" data-menu="more" onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget })} />
        </div>
        {!split && idx >= 0 ? (
          <div className="list__toolbar-end">
            <span className="pager__text">
              {formatCount((page - 1) * settings.pageSize + idx + 1)} of {total !== undefined ? formatCount(total) : 'many'}
            </span>
            <IconButton icon="chevron_left" label="Newer" disabled={idx <= 0} onClick={() => goSibling(-1)} />
            <IconButton icon="chevron_right" label="Older" disabled={idx >= siblings.length - 1} onClick={() => goSibling(1)} />
          </div>
        ) : null}
      </div>
      <LinearProgress active={isLoading} className="list__progress" />
      <div className="conv__scroll" ref={scrollRef}>
        {conv ? (
          <>
            <div className="conv__header">
              <h1 className="conv__subject">
                <span className="conv__subject-text" dir="auto">{subject}</span>
                {important ? <Icon name="label_important" size={20} fill className="conv__imp" /> : null}
                {chips.map((m) => {
                  const c = settings.labelColors[m!.id];
                  const name = m!.role === 'inbox' ? 'Inbox' : m!.role === 'junk' ? 'Spam' : m!.role === 'trash' ? 'Trash' : model!.pathOf(m!.id);
                  return (
                    <span key={m!.id} className="label-chip label-chip--conv" style={c ? { background: c.bg, color: c.fg } : undefined}>
                      {name}
                      {!m!.role || m!.role === 'inbox' ? (
                        <button
                          type="button"
                          className="label-chip__x"
                          aria-label="Remove this label"
                          data-tooltip="Remove this label"
                          onClick={() => void act('labels', target, { labelChanges: { [m!.id]: false } })}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      ) : null}
                    </span>
                  );
                })}
              </h1>
              <div className="conv__header-actions">
                <IconButton icon="print" label="Print all" onClick={() => window.print()} />
                <IconButton
                  icon="open_in_new"
                  label="In new window"
                  onClick={() => window.open(viewUrl(view, { threadId }), '_blank', 'noopener,width=900,height=800')}
                />
              </div>
            </div>
            {isSpam ? (
              <div className="banner banner--danger">
                <Icon name="report" size={20} fill />
                <span>Why is this message in spam? It is similar to messages that were identified as spam in the past.</span>
                <Button variant="outlined" dense onClick={() => void doAct('notSpam')}>
                  Report not spam
                </Button>
              </div>
            ) : null}
            {isScheduled ? <ScheduledBanner emails={emails} onCanceled={back} /> : null}
            <div className="conv__messages">
              {items.map((it, i) =>
                'bar' in it ? (
                  <button
                    key={`bar${i}`}
                    type="button"
                    className="count-bar"
                    data-tooltip={`Show ${it.bar} older messages`}
                    onClick={() => setShowAllCollapsed(true)}
                  >
                    <span className="count-bar__circle">{it.bar}</span>
                  </button>
                ) : (
                  <MessageItem
                    key={it.id}
                    email={it}
                    expanded={expanded.has(it.id)}
                    cursor={emails.indexOf(it) === msgCursor && kbdNav}
                    isLast={it === emails.at(-1)}
                    forceBlockImages={isSpam}
                    onToggle={() => {
                      const s = new Set(expanded);
                      if (s.has(it.id)) s.delete(it.id);
                      else s.add(it.id);
                      setExpanded(s);
                    }}
                    onReply={(mode) => void reply(threadId, mode, { email: it, inline: true })}
                    onStar={(on) => void act(on ? 'star' : 'unstar', [{ threadId, emails: [it as unknown as LiteEmail] }], {}, { silent: true })}
                    onAction={(kind) => void act(kind, [{ threadId, emails: [it as unknown as LiteEmail] }])}
                    onUnreadFromHere={() => {
                      const from = emails.slice(emails.indexOf(it));
                      void act('unread', [{ threadId, emails: from as unknown as LiteEmail[] }]);
                      if (!split) back();
                    }}
                  />
                ),
              )}
            </div>
            {inlineComposers.length ? (
              inlineComposers.map((c) => <Composer key={c.id} composer={c} />)
            ) : last && !isScheduled ? (
              <div className="conv__reply-buttons">
                <Button variant="outlined" icon="reply" onClick={() => void reply(threadId, 'reply', { email: last, inline: true })}>
                  Reply
                </Button>
                {multiple ? (
                  <Button variant="outlined" icon="reply_all" onClick={() => void reply(threadId, 'replyAll', { email: last, inline: true })}>
                    Reply all
                  </Button>
                ) : null}
                <Button variant="outlined" icon="forward" onClick={() => void reply(threadId, 'forward', { email: last, inline: true })}>
                  Forward
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {menu?.kind === 'snooze' ? (
        <SnoozeMenu anchor={menu.anchor} onClose={() => setMenu(null)} onPick={(d) => void doAct('snooze', { snoozeUntil: d })} />
      ) : null}
      {menu?.kind === 'label' ? (
        <LabelAsMenu
          anchor={menu.anchor}
          targets={target}
          onClose={() => setMenu(null)}
          onApply={(changes) => void act('labels', target, { labelChanges: changes })}
        />
      ) : null}
      {menu?.kind === 'move' ? (
        <MoveToMenu
          anchor={menu.anchor}
          excludeId={viewMailboxId}
          onClose={() => setMenu(null)}
          onMove={(id) => {
            void doAct('moveTo', { targetMailboxId: id });
          }}
        />
      ) : null}
      {menu?.kind === 'more' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          {important ? (
            <MenuItem icon="label_off" label="Mark as not important" onSelect={() => (setMenu(null), void act('notImportant', target))} />
          ) : (
            <MenuItem icon="label_important" label="Mark as important" onSelect={() => (setMenu(null), void act('important', target))} />
          )}
          <MenuItem
            icon="filter_alt"
            label="Filter messages like these"
            onSelect={() => {
              setMenu(null);
              const from = last?.from?.[0]?.email;
              if (from) nav(`/mail/search/${encodeURIComponent(`from:${from}`)}`);
            }}
          />
          <MenuItem icon="volume_off" label="Mute" onSelect={() => (setMenu(null), void doAct('mute'))} />
          <MenuDivider />
          <MenuItem icon="print" label="Print all" onSelect={() => (setMenu(null), window.print())} />
          {view.kind === 'label' && viewMailboxId ? (
            <MenuItem icon="label_off" label={`Remove label "${view.key}"`} onSelect={() => (setMenu(null), void doAct('removeLabel'))} />
          ) : null}
          <MenuItem
            icon="download"
            label="Download conversation"
            onSelect={async () => {
              setMenu(null);
              for (const e of emails) {
                const a = document.createElement('a');
                a.href = client.downloadUrl(e.blobId, `${(e.subject || 'message').replace(/[^\w.-]+/g, '_')}.eml`, 'message/rfc822');
                a.download = '';
                a.click();
              }
              showSnack({ text: `Downloading ${emails.length} message${emails.length === 1 ? '' : 's'}.` });
            }}
          />
        </Menu>
      ) : null}
    </div>
  );
}

function ScheduledBanner({ emails, onCanceled }: { emails: Email[]; onCanceled: () => void }) {
  const { client } = useMail();
  const { data: model } = useMailboxes();
  const { invalidate } = useActions();
  const showSnack = useUi((s) => s.showSnack);
  const [sendAt, setSendAt] = useState<string | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  // The scheduled message itself — in a conversation it isn't necessarily the newest one.
  const scheduledId = model?.roleId('scheduled');
  const email = (scheduledId ? emails.filter((e) => e.mailboxIds[scheduledId]) : emails).at(-1);
  useEffect(() => {
    if (!email) return;
    let alive = true;
    (async () => {
      try {
        const b = client.batch();
        const q = b.call('EmailSubmission/query', { filter: { emailIds: [email.id], undoStatus: 'pending' } });
        const g = b.call('EmailSubmission/get', { '#ids': q.ref('/ids'), properties: ['sendAt', 'undoStatus'] });
        const r = await b.send();
        const s = r.get(g).list[0];
        if (alive && s) {
          setSendAt(s.sendAt);
          setSubId(s.id);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, email]);
  if (!email) return null;
  return (
    <div className="banner">
      <Icon name="schedule_send" size={20} />
      <span>{sendAt ? `Send scheduled for ${formatShortDateTime(new Date(sendAt))}` : 'Scheduled'}</span>
      <Button
        variant="outlined"
        dense
        disabled={!subId}
        onClick={async () => {
          if (!subId || !model) return;
          const scheduled = model.roleId('scheduled');
          const drafts = model.roleId('drafts');
          try {
            await client.call('EmailSubmission/set', { update: { [subId]: { undoStatus: 'canceled' } } });
            await client.emailSet({
              update: { [email.id]: { [`mailboxIds/${scheduled}`]: null, [`mailboxIds/${drafts}`]: true, [`keywords/${KW.draft}`]: true } },
            });
            showSnack({ text: 'Scheduled send canceled. The message is now a draft.' });
            invalidate([email.threadId]);
            onCanceled();
          } catch (e) {
            showSnack({ text: `Couldn't cancel: ${(e as Error).message}` });
          }
        }}
      >
        Cancel send
      </Button>
    </div>
  );
}
