import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons/Icon';
import { IconButton } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { Menu, MenuDivider, MenuItem, Popover } from '../ui/Menu';
import { MessageBody } from './MessageBody';
import { SenderHover } from './SenderCard';
import { Attachments } from './Attachments';
import { useMail } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import type { Email, EmailAddress } from '../../jmap/types';
import { displayName, formatFullDate, formatListDate, formatMessageDate } from '../../lib/format';
import { KW } from '../../mail/mapping';
import { isDarkTheme } from '../../theme/theme';
import { useComposeOpeners } from '../compose/openers';
import type { ActionKind } from '../../mail/actions';

export function MessageItem({
  email,
  expanded,
  cursor,
  isLast,
  forceBlockImages,
  onToggle,
  onReply,
  onStar,
  onAction,
  onUnreadFromHere,
}: {
  email: Email;
  expanded: boolean;
  cursor: boolean;
  isLast: boolean;
  forceBlockImages?: boolean;
  onToggle: () => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward') => void;
  onStar: (on: boolean) => void;
  onAction: (kind: ActionKind) => void;
  onUnreadFromHere: () => void;
}) {
  const { myEmails, client } = useMail();
  const nav = useNavigate();
  const trusted = useSettings((s) => s.trustedImageSenders);
  const externalImages = useSettings((s) => s.externalImages);
  const setSettings = useSettings((s) => s.set);
  const openDialog = useUi((s) => s.openDialog);
  const { openDraft } = useComposeOpeners();
  const [allowOnce, setAllowOnce] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [menu, setMenu] = useState<Element | null>(null);
  const [details, setDetails] = useState<Element | null>(null);
  const from = email.from?.[0] ?? email.sender?.[0] ?? { name: null, email: 'unknown' };
  const senderKey = from.email.toLowerCase();
  const allowRemote = !forceBlockImages && (allowOnce || externalImages === 'always' || trusted.includes(senderKey) || myEmails.has(senderKey));
  const starred = !!email.keywords[KW.flagged];
  const isDraft = !!email.keywords[KW.draft];
  const unread = !email.keywords[KW.seen];
  const onBlocked = useCallback((b: boolean) => setBlocked(b), []);
  const listId = email['header:List-Id:asText'] as string | null | undefined;
  const unsubscribe = (email['header:List-Unsubscribe:asURLs'] as string[] | null | undefined)?.find((u) => /^https:/i.test(u) || /^mailto:/i.test(u));

  if (!expanded) {
    return (
      <div
        className={`msg msg--collapsed${unread ? ' msg--unread' : ''}${cursor ? ' msg--cursor' : ''}`}
        onClick={isDraft ? () => void openDraft(email.threadId, email.id, { inline: true }) : onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onToggle()}
      >
        <Avatar name={from.name} email={from.email} size={40} />
        <span className="msg__name" dir="auto">{isDraft ? <span className="row__draft">Draft</span> : from.name || from.email}</span>
        <span className="msg__snippet" dir="auto">{email.preview}</span>
        <span className="msg__meta">
          {email.hasAttachment ? <Icon name="attach_file" size={16} /> : null}
          <span className="msg__date" data-tooltip={formatFullDate(email.receivedAt)}>
            {formatListDate(email.receivedAt)}
          </span>
          <button
            type="button"
            className={`row__star${starred ? ' row__star--on' : ''}`}
            aria-label={starred ? 'Starred' : 'Not starred'}
            data-tooltip={starred ? 'Starred' : 'Not starred'}
            onClick={(e) => {
              e.stopPropagation();
              onStar(!starred);
            }}
          >
            <Icon name="star" size={20} fill={starred} />
          </button>
        </span>
      </div>
    );
  }

  const recipients = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
  const toLine = recipients.length
    ? `to ${recipients
        .slice(0, 3)
        .map((r) => displayName(r, myEmails, { short: recipients.length > 1 }))
        .join(', ')}${recipients.length > 3 ? `, ${recipients.length - 3} other${recipients.length - 3 === 1 ? '' : 's'}` : ''}`
    : 'to undisclosed recipients';

  return (
    <div className={`msg msg--expanded${cursor ? ' msg--cursor' : ''}${isLast ? ' msg--last' : ''}`}>
      <div className="msg__head">
        <SenderHover name={from.name} email={from.email}>
          <Avatar name={from.name} email={from.email} size={40} className="msg__avatar" />
        </SenderHover>
        <div className="msg__who" onClick={onToggle}>
          <div className="msg__line1">
            <SenderHover name={from.name} email={from.email}>
              <span className="msg__sender" dir="auto">{from.name || from.email}</span>
            </SenderHover>
            {from.name ? <span className="msg__email">&lt;{from.email}&gt;</span> : null}
            {listId ? <span className="msg__via">via {listId.replace(/^.*<|>.*$/g, '').trim()}</span> : null}
            {unsubscribe ? (
              <a
                className="msg__unsub"
                href={unsubscribe}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                Unsubscribe
              </a>
            ) : null}
          </div>
          <div className="msg__line2">
            <span>{toLine}</span>
            <button
              type="button"
              className="msg__details-btn"
              aria-label="Show details"
              data-tooltip="Show details"
              onClick={(e) => {
                e.stopPropagation();
                setDetails(e.currentTarget);
              }}
            >
              <Icon name="arrow_drop_down" size={20} />
            </button>
          </div>
        </div>
        <div className="msg__actions">
          <span className="msg__date" data-tooltip={formatFullDate(email.receivedAt)}>
            {formatMessageDate(email.receivedAt)}
          </span>
          <IconButton
            icon="star"
            fill={starred}
            label={starred ? 'Starred' : 'Not starred'}
            className={starred ? 'star-on' : ''}
            onClick={() => onStar(!starred)}
          />
          <IconButton icon="reply" label="Reply" onClick={() => onReply('reply')} />
          <IconButton icon="more_vert" label="More" onClick={(e) => setMenu(e.currentTarget)} />
        </div>
      </div>
      {blocked && !allowRemote ? (
        <div className="banner banner--images">
          <span>Images are not displayed.</span>
          {!forceBlockImages ? (
            <>
              <button type="button" className="link-btn" onClick={() => setAllowOnce(true)}>
                Display images below
              </button>
              <span>–</span>
              <button type="button" className="link-btn" onClick={() => setSettings({ trustedImageSenders: [...trusted, senderKey] })}>
                Always display images from {from.email}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="msg__content">
        <MessageBody email={email} allowRemote={allowRemote} dark={isDarkTheme()} onBlockedChange={onBlocked} />
        <Attachments email={email} />
      </div>
      {menu ? (
        <Menu anchor={menu} onClose={() => setMenu(null)} placement="bottom-end">
          <MenuItem icon="reply" label="Reply" onSelect={() => (setMenu(null), onReply('reply'))} />
          <MenuItem icon="reply_all" label="Reply all" onSelect={() => (setMenu(null), onReply('replyAll'))} />
          <MenuItem icon="forward" label="Forward" onSelect={() => (setMenu(null), onReply('forward'))} />
          <MenuDivider />
          <MenuItem
            icon="filter_alt"
            label="Filter messages like this"
            onSelect={() => (setMenu(null), nav(`/mail/search/${encodeURIComponent(`from:${from.email}`)}`))}
          />
          <MenuItem icon="print" label="Print" onSelect={() => (setMenu(null), window.print())} />
          <MenuItem icon="delete" label="Delete this message" onSelect={() => (setMenu(null), onAction('trash'))} />
          <MenuItem
            icon="block"
            label={`Block "${from.name || from.email}"`}
            onSelect={() => {
              setMenu(null);
              openDialog({
                kind: 'confirm',
                title: `Block ${from.email}`,
                body: 'Future messages from this sender will be marked as spam. (5050 Mail stores this as a Sieve rule on the server — coming soon; for now this conversation is reported as spam.)',
                confirmLabel: 'Block',
                onConfirm: () => onAction('spam'),
              });
            }}
          />
          <MenuItem icon="report" label="Report spam" onSelect={() => (setMenu(null), onAction('spam'))} />
          <MenuDivider />
          <MenuItem
            icon="code"
            label="Show original"
            onSelect={() => (
              setMenu(null),
              window.open(client.downloadUrl(email.blobId, 'original.txt', 'text/plain', { inline: true }), '_blank', 'noopener')
            )}
          />
          <MenuItem
            icon="download"
            label="Download message"
            onSelect={() => {
              setMenu(null);
              const a = document.createElement('a');
              a.href = client.downloadUrl(email.blobId, `${(email.subject || 'message').replace(/[^\w.-]+/g, '_')}.eml`, 'message/rfc822');
              a.download = '';
              a.click();
            }}
          />
          <MenuItem icon="mark_email_unread" label="Mark as unread from here" onSelect={() => (setMenu(null), onUnreadFromHere())} />
        </Menu>
      ) : null}
      {details ? <DetailsPopover anchor={details} email={email} onClose={() => setDetails(null)} /> : null}
    </div>
  );
}

function DetailsPopover({ anchor, email, onClose }: { anchor: Element; email: Email; onClose: () => void }) {
  const fmt = (a: EmailAddress[] | null | undefined) => (a ?? []).map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ');
  const auth = (email['header:Authentication-Results:asText'] as string | null | undefined) ?? '';
  const mailedBy = /smtp\.mailfrom=(?:[^@\s;]*@)?([^\s;]+)/i.exec(auth)?.[1];
  const signedBy = /dkim=pass[^;]*header\.d=([^\s;]+)/i.exec(auth)?.[1];
  const rows: [string, string | undefined][] = [
    ['from', fmt(email.from)],
    ['reply-to', email.replyTo?.length ? fmt(email.replyTo) : undefined],
    ['to', fmt(email.to)],
    ['cc', email.cc?.length ? fmt(email.cc) : undefined],
    ['bcc', email.bcc?.length ? fmt(email.bcc) : undefined],
    ['date', formatFullDate(email.sentAt ?? email.receivedAt)],
    ['subject', email.subject ?? ''],
    ['mailed-by', mailedBy],
    ['signed-by', signedBy],
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} className="details-pop" label="Message details">
      <table>
        <tbody>
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <tr key={k}>
                <th>{k}:</th>
                <td>{v}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Popover>
  );
}
