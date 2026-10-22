import { memo, type MouseEvent, type DragEvent } from 'react';
import { Icon } from '../icons/Icon';
import { IconButton } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import type { ThreadSummary } from '../../mail/threads';
import type { MailboxModel } from '../../mail/mailboxes';
import { displayName, formatFullDate, formatListDate } from '../../lib/format';
import { KW } from '../../mail/mapping';
import { attachmentIcon } from '../thread/attachmentIcon';
import { avatarColor, initialOf } from '../ui/Avatar';

export interface RowProps {
  item: ThreadSummary;
  selected: boolean;
  cursor: boolean;
  open: boolean;
  myEmails: Set<string>;
  model: MailboxModel;
  viewMailboxId?: string;
  showInboxChip: boolean;
  isSent: boolean;
  isDrafts: boolean;
  isTrashOrSpam: boolean;
  isSnoozed: boolean;
  density: 'default' | 'comfortable' | 'compact';
  multiline: boolean;
  labelColors: Record<string, { bg: string; fg: string }>;
  showSnippets: boolean;
  showMarkers: boolean;
  hoverActions: boolean;
  onToggleSelect: (e: MouseEvent) => void;
  onOpen: (e: MouseEvent) => void;
  onStar: () => void;
  onImportant: () => void;
  onAction: (kind: 'archive' | 'trash' | 'read' | 'unread' | 'deleteForever' | 'notSpam' | 'unsnooze' | 'moveToInbox', e: MouseEvent) => void;
  onSnooze: (anchor: Element) => void;
  onContextMenu: (e: MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpenAttachment: (a: ThreadSummary['attachments'][number]) => void;
}

/** Sender column text: "Alice, me (3)", Sent view "To: Bob", drafts in red. */
function Senders({ item, myEmails, isSent, isDrafts }: { item: ThreadSummary; myEmails: Set<string>; isSent: boolean; isDrafts: boolean }) {
  const count = item.emails.length;
  if (isDrafts) {
    return (
      <>
        <span className="row__draft">Draft</span>
      </>
    );
  }
  if (isSent) {
    const last = item.emails.filter((e) => e.from?.some((f) => myEmails.has(f.email.toLowerCase()))).at(-1) ?? item.emails.at(-1)!;
    const names = (last.to ?? []).map((a) => displayName(a, myEmails, { short: (last.to?.length ?? 0) > 1 }));
    return (
      <>
        <span>To: {names.join(', ') || '(no recipients)'}</span>
        {count > 1 ? <span className="row__count">{count}</span> : null}
      </>
    );
  }
  // Unique senders in chronological order; unread senders bold.
  const seen = new Map<string, { name: string; unread: boolean }>();
  const nonDraft = item.emails.filter((e) => !e.keywords[KW.draft]);
  for (const e of nonDraft) {
    const f = e.from?.[0];
    if (!f) continue;
    const k = f.email.toLowerCase();
    const prev = seen.get(k);
    const unread = !e.keywords[KW.seen];
    seen.delete(k);
    seen.set(k, { name: displayName(f, myEmails, { short: true }), unread: unread || !!prev?.unread });
  }
  let list = [...seen.values()];
  if (list.length === 1 && nonDraft[0]?.from?.[0]) list = [{ ...list[0]!, name: displayName(nonDraft.at(-1)!.from![0], myEmails) }];
  const shown = list.length > 3 ? [list[0]!, null, ...list.slice(-2)] : list;
  return (
    <>
      {shown.map((p, i) => (
        <span key={i}>
          {i > 0 ? (p === null || shown[i - 1] === null ? ' ' : ', ') : ''}
          {p === null ? '..' : <span className={p.unread ? 'row__unread-name' : undefined} dir="auto">{p.name}</span>}
        </span>
      ))}
      {item.hasDraft ? (
        <>
          {list.length ? ', ' : ''}
          <span className="row__draft">Draft</span>
        </>
      ) : null}
      {count > 1 ? <span className="row__count">{count}</span> : null}
    </>
  );
}

/** Mobile rows: the sender's letter avatar doubles as the selection toggle (as in Gmail's mobile web). */
function RowAvatar({ item, myEmails, selected, onToggle }: { item: ThreadSummary; myEmails: Set<string>; selected: boolean; onToggle: (e: MouseEvent) => void }) {
  const from =
    [...item.emails]
      .reverse()
      .map((e) => e.from?.[0])
      .find((f) => f && !myEmails.has(f.email.toLowerCase())) ?? item.emails.at(-1)?.from?.[0];
  const email = from?.email ?? '';
  return (
    <button
      type="button"
      className={`row__avatar${selected ? ' row__avatar--on' : ''}`}
      role="checkbox"
      aria-checked={selected}
      aria-label="Select conversation"
      style={selected ? undefined : { background: avatarColor(email || '?') }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
    >
      {selected ? <Icon name="check" size={20} /> : initialOf(from?.name, email || '?')}
    </button>
  );
}

function highlight(html: string | null | undefined) {
  if (!html) return null;
  // SearchSnippet returns text with <mark> only — escape everything else.
  const parts = html.split(/(<mark>.*?<\/mark>)/g);
  return parts.map((p, i) => (p.startsWith('<mark>') ? <b key={i}>{decode(p.slice(6, -7))}</b> : <span key={i}>{decode(p)}</span>));
}
function decode(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export const ThreadRow = memo(function ThreadRow(p: RowProps) {
  const { item, model } = p;
  const labels = [...item.mailboxIds]
    .map((id) => model.byId.get(id))
    .filter((m) => m && (!m.role || (p.showInboxChip && m.role === 'inbox')) && m.id !== p.viewMailboxId)
    .slice(0, 4);
  const subject = item.subject || '(no subject)';
  const dateIso = p.isSnoozed && item.wakeAt ? item.wakeAt : item.receivedAt;
  const dateText = p.isSnoozed && item.wakeAt ? formatListDate(item.wakeAt) : formatListDate(item.receivedAt);
  const chips = p.density === 'default' && !p.multiline ? item.attachments.slice(0, 3) : [];
  const cls = [
    'row',
    item.unread ? 'row--unread' : 'row--read',
    p.selected ? 'row--selected' : '',
    p.cursor ? 'row--cursor' : '',
    p.open ? 'row--open' : '',
    chips.length ? 'row--chips' : '',
    p.multiline ? 'row--multi' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const actions = (
    <div className="row__actions" onClick={(e) => e.stopPropagation()}>
      {p.isTrashOrSpam ? (
        <>
          <IconButton icon="delete" label="Delete forever" onClick={(e) => p.onAction('deleteForever', e)} />
          {p.viewMailboxId && model.byId.get(p.viewMailboxId)?.role === 'junk' ? (
            <IconButton icon="report_off" label="Not spam" onClick={(e) => p.onAction('notSpam', e)} />
          ) : (
            <IconButton icon="restore_from_trash" label="Move to Inbox" onClick={(e) => p.onAction('moveToInbox', e)} />
          )}
        </>
      ) : (
        <>
          {p.isSnoozed ? (
            <IconButton icon="move_to_inbox" label="Unsnooze" onClick={(e) => p.onAction('unsnooze', e)} />
          ) : (
            <IconButton icon="archive" label="Archive" onClick={(e) => p.onAction('archive', e)} />
          )}
          <IconButton icon="delete" label="Delete" onClick={(e) => p.onAction('trash', e)} />
          {item.unread ? (
            <IconButton icon="drafts" label="Mark as read" onClick={(e) => p.onAction('read', e)} />
          ) : (
            <IconButton icon="mark_email_unread" label="Mark as unread" onClick={(e) => p.onAction('unread', e)} />
          )}
          <IconButton icon="schedule" label="Snooze" onClick={(e) => p.onSnooze(e.currentTarget)} />
        </>
      )}
    </div>
  );

  return (
    <div
      className={cls}
      role="row"
      aria-selected={p.selected}
      data-thread={item.threadId}
      draggable
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onClick={p.onOpen}
      onContextMenu={p.onContextMenu}
      tabIndex={-1}
    >
      <div className="row__main">
        <span className="row__drag" aria-hidden="true">
          <Icon name="drag_indicator" size={20} />
        </span>
        <Checkbox checked={p.selected} onToggle={p.onToggleSelect} label="Select conversation" className="row__check" />
        <button
          type="button"
          className={`row__star${item.starred ? ' row__star--on' : ''}`}
          aria-label={item.starred ? 'Starred' : 'Not starred'}
          aria-pressed={item.starred}
          data-tooltip={item.starred ? 'Starred' : 'Not starred'}
          onClick={(e) => {
            e.stopPropagation();
            p.onStar();
          }}
        >
          <Icon name="star" size={20} fill={item.starred} />
        </button>
        {p.showMarkers ? (
          <button
            type="button"
            className={`row__imp${item.important ? ' row__imp--on' : ''}`}
            aria-label={item.important ? 'Important' : 'Not important'}
            data-tooltip={item.important ? 'Important because you marked it as important.' : 'Click to teach 5050 Mail this conversation is important.'}
            onClick={(e) => {
              e.stopPropagation();
              p.onImportant();
            }}
          >
            <Icon name="label_important" size={20} fill={item.important} />
          </button>
        ) : null}
        {p.multiline ? (
          <RowAvatar item={item} myEmails={p.myEmails} selected={p.selected} onToggle={p.onToggleSelect} />
        ) : null}
        {p.multiline ? (
          <div className="row__multi">
            <div className="row__line1">
              <span className="row__sender">
                <Senders item={item} myEmails={p.myEmails} isSent={p.isSent} isDrafts={p.isDrafts} />
              </span>
              <span className="row__date" data-tooltip={formatFullDate(dateIso)}>
                {item.hasAttachment ? <Icon name="attach_file" size={16} /> : null}
                {dateText}
              </span>
            </div>
            <div className="row__subject-line">
              <span className="row__subject" dir="auto">{item.snippet?.subject ? highlight(item.snippet.subject) : subject}</span>
            </div>
            {p.showSnippets ? (
              <div className="row__snippet row__snippet--line" dir="auto">{item.snippet?.preview ? highlight(item.snippet.preview) : item.preview}</div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="row__sender">
              <Senders item={item} myEmails={p.myEmails} isSent={p.isSent} isDrafts={p.isDrafts} />
            </div>
            <div className="row__body">
              <div className="row__subject-line">
                {labels.map((m) => {
                  const c = p.labelColors[m!.id];
                  return (
                    <span key={m!.id} className="label-chip" style={c ? { background: c.bg, color: c.fg } : undefined}>
                      {m!.role === 'inbox' ? 'Inbox' : model.pathOf(m!.id)}
                    </span>
                  );
                })}
                <span className="row__subject" dir="auto">{item.snippet?.subject ? highlight(item.snippet.subject) : subject}</span>
                {p.showSnippets && (item.snippet?.preview || item.preview) ? (
                  <span className="row__snippet">
                    {'\u00a0- '}
                    <span dir="auto">{item.snippet?.preview ? highlight(item.snippet.preview) : item.preview}</span>
                  </span>
                ) : null}
              </div>
              {chips.length ? (
                <div className="row__chips">
                  {chips.map((a, i) => (
                    <button
                      key={`${a.blobId}-${i}`}
                      type="button"
                      className="att-chip"
                      data-tooltip={a.name ?? 'Attachment'}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onOpenAttachment(a);
                      }}
                    >
                      <Icon name={attachmentIcon(a.type, a.name)} size={20} />
                      <span className="att-chip__name">{a.name ?? 'Attachment'}</span>
                    </button>
                  ))}
                  {item.attachments.length > 3 ? <span className="att-chip att-chip--more">+{item.attachments.length - 3}</span> : null}
                </div>
              ) : null}
            </div>
            <div className="row__end">
              {p.density !== 'default' && item.hasAttachment ? <Icon name="attach_file" size={16} className="row__clip" /> : null}
              <span className="row__date" data-tooltip={formatFullDate(dateIso)}>
                {dateText}
              </span>
            </div>
          </>
        )}
        {p.hoverActions ? actions : null}
      </div>
    </div>
  );
});
