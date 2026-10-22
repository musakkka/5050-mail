import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons/Icon';
import { IconButton, Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { Dialog } from '../ui/Dialog';
import { Menu, MenuItem, Popover } from '../ui/Menu';
import { RecipientField } from './RecipientField';
import { Editor, FormattingToolbar, handleFormattingKeys, type EditorHandle } from './Editor';
import { useComposer } from './useComposer';
import { useMail } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi, type Composer as ComposerT } from '../../state/ui';
import { formatShortDateTime, formatSize, escapeHtml } from '../../lib/format';
import { attachmentIcon } from '../thread/attachmentIcon';
import { useComposeOpeners } from './openers';
import { sanitizeForCompose } from '../../mail/sanitize';

const EMOJI = '😀 😂 😊 😍 😘 😎 🤔 😅 😢 😭 😡 👍 👎 👏 🙏 💪 🎉 🎂 ❤️ 💔 ⭐ 🔥 ✅ ❌ ⚠️ 📎 📅 ☕ 🍕 🚀 🌟 💡 📌 ✉️ 🙂 😉 🤝 👋 🙌 🤷'.split(' ');

export function Composer({ composer }: { composer: ComposerT }) {
  const { identities } = useMail();
  const { draft } = composer;
  const c = useComposer(composer);
  const updateComposer = useUi((s) => s.updateComposer);
  const focusComposer = useUi((s) => s.focusComposer);
  const focused = useUi((s) => s.focusedComposer === composer.id);
  const openDialog = useUi((s) => s.openDialog);
  const lastScheduledAt = useSettings((s) => s.lastScheduledAt);
  const editor = useRef<EditorHandle>(null);
  const quoteEditor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const [showFmt, setShowFmt] = useState(false);
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(draft.bcc.length > 0);
  const [rcptOpen, setRcptOpen] = useState(composer.inline || draft.to.length === 0);
  const [showQuote, setShowQuote] = useState(draft.mode === 'forward');
  const [menu, setMenu] = useState<null | { kind: 'send' | 'emoji' | 'more' | 'replyType' | 'from' | 'signature'; anchor: Element }>(null);
  const [linkDlg, setLinkDlg] = useState<null | { text: string; url: string }>(null);
  const [scheduleDlg, setScheduleDlg] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editSubject, setEditSubject] = useState(!composer.inline);
  const { reply } = useComposeOpeners();

  const identity = c.identity;
  const isMax = composer.window === 'maximized';
  const isMin = composer.window === 'minimized';
  const title = draft.subject.trim() || (draft.mode === 'new' ? 'New Message' : draft.mode === 'forward' ? 'Forward' : 'Reply');

  // Signature for brand-new messages (03-behaviours §14).
  const sigDone = useRef(false);
  useEffect(() => {
    if (sigDone.current || draft.draftEmailId || draft.html) return;
    sigDone.current = true;
    const sig = identity?.htmlSignature || (identity?.textSignature ? escapeHtml(identity.textSignature).replace(/\n/g, '<br>') : '');
    if (!sig) return;
    const html = `<br><br><div class="ff_signature">-- <br>${sanitizeForCompose(sig)}</div>`;
    // Not an edit: an untouched composer with just the signature closes without leaving a draft.
    c.prefill({ html });
    // Editor content is uncontrolled; put it in the DOM too (silently).
    editor.current?.setHtml(html);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inline replies appear at the bottom of the conversation: bring them into view.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (composer.inline) rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [composer.inline, composer.focusNonce]);

  // Focus requests.
  useEffect(() => {
    if (isMin) return;
    const t = setTimeout(() => {
      if (draft.mode === 'new' && !draft.to.length && !composer.inline) toRef.current?.focus();
      else if (draft.mode === 'forward' && !draft.to.length) toRef.current?.focus();
      else editor.current?.focus(true);
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer.focusNonce]);

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void c.send();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setShowCc(true);
      setRcptOpen(true);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setShowBcc(true);
      setRcptOpen(true);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      void c.discard();
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void c.save();
      return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      editor.current?.saveSelection();
      setLinkDlg({ text: editor.current?.selectedText() ?? '', url: '' });
      return;
    }
    // Full-screen compose: Esc closes (the draft is saved) — 02-components §9.3.
    if (e.key === 'Escape' && composer.window === 'maximized' && !document.querySelector('.popover')) {
      e.preventDefault();
      void c.close();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    c.attach([...e.dataTransfer.files]);
  };

  const scheduleOptions = (() => {
    const now = new Date();
    const at = (d: Date, h: number) => {
      const x = new Date(d);
      x.setHours(h, 0, 0, 0);
      return x;
    };
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const monday = new Date(now);
    monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    const opts = [
      { label: 'Tomorrow morning', when: at(tomorrow, 8) },
      { label: 'Tomorrow afternoon', when: at(tomorrow, 13) },
      { label: 'Monday morning', when: at(monday, 8) },
    ];
    return opts.filter((o, i) => i < 2 || o.when.toDateString() !== tomorrow.toDateString());
  })();

  const header = !composer.inline ? (
    <div
      className="compose__header"
      onClick={(e) => {
        if ((e.target as Element).closest('button')) return;
        updateComposer(composer.id, { window: isMin ? 'normal' : 'minimized' });
      }}
    >
      <span className="compose__title">{title}</span>
      <div className="compose__header-actions">
        <IconButton
          icon={isMin ? 'expand_less' : 'minimize'}
          label={isMin ? 'Restore' : 'Minimize'}
          size={24}
          iconSize={20}
          onClick={() => updateComposer(composer.id, { window: isMin ? 'normal' : 'minimized' })}
        />
        <IconButton
          icon={isMax ? 'close_fullscreen' : 'open_in_full'}
          label={isMax ? 'Exit full screen' : 'Full screen'}
          tooltip={isMax ? 'Exit full screen' : 'Full screen (Shift for pop-out)'}
          size={24}
          iconSize={18}
          onClick={(e) => (e.shiftKey ? void c.popOut() : updateComposer(composer.id, { window: isMax ? 'normal' : 'maximized' }))}
        />
        <IconButton icon="close" label="Save & close" size={24} iconSize={20} onClick={() => void c.close()} />
      </div>
    </div>
  ) : null;

  const body = (
    <div
      className="compose__body"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {composer.inline ? (
        <div className="compose__inline-head">
          <button
            type="button"
            className="compose__reply-type"
            aria-label="Type of response"
            data-tooltip="Type of response"
            onClick={(e) => setMenu({ kind: 'replyType', anchor: e.currentTarget })}
          >
            <Icon name={draft.mode === 'forward' ? 'forward' : draft.mode === 'replyAll' ? 'reply_all' : 'reply'} size={20} />
            <Icon name="arrow_drop_down" size={18} />
          </button>
          <div className="compose__inline-rcpts">
            <RecipientField label="" value={draft.to} onChange={(to) => c.change({ to })} inputRef={toRef} />
            {!showCc || !showBcc ? (
              <div className="rcpt__links rcpt__links--inline">
                {!showCc ? (
                  <button type="button" onClick={() => setShowCc(true)}>
                    Cc
                  </button>
                ) : null}
                {!showBcc ? (
                  <button type="button" onClick={() => setShowBcc(true)}>
                    Bcc
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {!composer.inline && identities.length > 1 ? (
        <div className="compose__row compose__from">
          <span className="compose__row-label">From</span>
          <button type="button" className="compose__from-btn" onClick={(e) => setMenu({ kind: 'from', anchor: e.currentTarget })}>
            {identity ? `${identity.name} <${identity.email}>` : ''}
            <Icon name="arrow_drop_down" size={20} />
          </button>
        </div>
      ) : null}
      {!composer.inline ? (
        rcptOpen || draft.to.length || showCc || showBcc ? (
          <div className="compose__rcpts" onFocus={() => setRcptOpen(true)}>
            <RecipientField
              label="To"
              value={draft.to}
              onChange={(to) => c.change({ to })}
              inputRef={toRef}
              trailing={
                <div className="rcpt__links">
                  {!showCc ? (
                    <button type="button" onClick={() => setShowCc(true)} data-tooltip="Add Cc recipients (⌘⇧C)">
                      Cc
                    </button>
                  ) : null}
                  {!showBcc ? (
                    <button type="button" onClick={() => setShowBcc(true)} data-tooltip="Add Bcc recipients (⌘⇧B)">
                      Bcc
                    </button>
                  ) : null}
                </div>
              }
            />
          </div>
        ) : (
          <button
            type="button"
            className="compose__row compose__rcpt-collapsed"
            onClick={() => {
              setRcptOpen(true);
              setTimeout(() => toRef.current?.focus(), 0);
            }}
          >
            Recipients
          </button>
        )
      ) : null}
      {showCc ? <RecipientField label="Cc" value={draft.cc} onChange={(cc) => c.change({ cc })} autoFocus={draft.cc.length === 0} /> : null}
      {showBcc ? <RecipientField label="Bcc" value={draft.bcc} onChange={(bcc) => c.change({ bcc })} autoFocus={draft.bcc.length === 0} /> : null}
      {editSubject ? (
        <input
          className="compose__row compose__subject"
          dir="auto"
          placeholder="Subject"
          aria-label="Subject"
          value={draft.subject}
          onChange={(e) => c.change({ subject: e.target.value })}
        />
      ) : null}
      <div className="compose__scroll">
        <Editor
          ref={editor}
          initialHtml={draft.html}
          onChange={(html) => c.change({ html })}
          onKeyDown={(e) => handleFormattingKeys(e, editor.current)}
          className="compose__editor"
        />
        {draft.quotedHtml ? (
          showQuote ? (
            <Editor
              ref={quoteEditor}
              initialHtml={draft.quotedHtml}
              onChange={(quotedHtml) => c.change({ quotedHtml })}
              className="compose__editor compose__quote"
              label="Quoted text"
            />
          ) : (
            <button
              type="button"
              className="quote-toggle quote-toggle--compose"
              aria-label="Show trimmed content"
              data-tooltip="Show trimmed content"
              onClick={() => setShowQuote(true)}
            >
              <span />
              <span />
              <span />
            </button>
          )
        ) : null}
        {draft.attachments.filter((a) => !a.cid).length ? (
          <div className="compose__atts">
            {draft.attachments
              .filter((a) => !a.cid)
              .map((a) => (
                <div key={a.key} className={`compose-att${a.error ? ' compose-att--error' : ''}`}>
                  <Icon name={attachmentIcon(a.type, a.name)} size={18} />
                  <span className="compose-att__name">{a.name}</span>
                  <span className="compose-att__size">({a.error ?? formatSize(a.size)})</span>
                  <IconButton
                    icon="close"
                    label="Remove attachment"
                    size={24}
                    iconSize={16}
                    onClick={() => c.change({ attachments: draft.attachments.filter((x) => x.key !== a.key) })}
                  />
                  {!a.blobId && !a.error ? (
                    <div className="compose-att__progress">
                      <div style={{ width: `${Math.round((a.progress ?? 0) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        ) : null}
      </div>
      {showFmt ? <FormattingToolbar editor={editor} /> : null}
      <div className="compose__bar">
        <div className="send-split">
          <button type="button" className="send-split__main" onClick={() => void c.send()} data-tooltip="Send (⌘Enter)">
            Send
          </button>
          <button
            type="button"
            className="send-split__drop"
            aria-label="More send options"
            data-tooltip="More send options"
            onClick={(e) => setMenu({ kind: 'send', anchor: e.currentTarget })}
          >
            <Icon name="arrow_drop_down" size={20} />
          </button>
        </div>
        <div className="compose__tools">
          <IconButton icon="format_color_text" label="Formatting options" size={32} active={showFmt} onClick={() => setShowFmt(!showFmt)} />
          <IconButton icon="attach_file" label="Attach files" size={32} onClick={() => fileInput.current?.click()} />
          <IconButton
            icon="link"
            label="Insert link (⌘K)"
            size={32}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editor.current?.saveSelection();
              setLinkDlg({ text: editor.current?.selectedText() ?? '', url: '' });
            }}
          />
          <IconButton
            icon="mood"
            label="Insert emoji"
            size={32}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              editor.current?.saveSelection();
              setMenu({ kind: 'emoji', anchor: e.currentTarget });
            }}
          />
          <IconButton icon="image" label="Insert photo" size={32} onClick={() => imageInput.current?.click()} />
          <IconButton
            icon="signature"
            label="Insert signature"
            size={32}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              editor.current?.saveSelection();
              setMenu({ kind: 'signature', anchor: e.currentTarget });
            }}
          />
          <IconButton icon="more_vert" label="More options" size={32} onClick={(e) => setMenu({ kind: 'more', anchor: e.currentTarget })} />
        </div>
        <span className="compose__status" aria-live="polite">
          {c.status === 'saving' ? 'Saving…' : c.status === 'saved' ? 'Draft saved' : c.status === 'error' ? 'Couldn’t save draft' : ''}
        </span>
        <IconButton icon="delete" label="Discard draft (⌘⇧D)" size={32} className="compose__discard" onClick={() => void c.discard()} />
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) c.attach([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          const added = c.attach(files, true);
          for (const a of added) if (a.previewUrl) editor.current?.insertHtml(`<img src="${a.previewUrl}" alt="${escapeHtml(a.name)}" style="max-width:100%">`);
        }}
      />
      {dragOver ? <div className="compose__drop">Drop files here</div> : null}
    </div>
  );

  const menus = (
    <>
      {menu?.kind === 'send' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          <MenuItem icon="schedule_send" label="Schedule send" onSelect={() => (setMenu(null), setScheduleDlg(true))} />
        </Menu>
      ) : null}
      {menu?.kind === 'emoji' ? (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start" className="emoji-picker" role="menu" label="Insert emoji">
          {EMOJI.map((em) => (
            <button
              key={em}
              type="button"
              role="menuitem"
              className="emoji-picker__btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (setMenu(null), editor.current?.insertHtml(em))}
            >
              {em}
            </button>
          ))}
        </Popover>
      ) : null}
      {menu?.kind === 'signature' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          {identity?.htmlSignature || identity?.textSignature ? (
            <MenuItem
              label="My signature"
              onSelect={() => {
                setMenu(null);
                const sig = identity.htmlSignature ? sanitizeForCompose(identity.htmlSignature) : escapeHtml(identity.textSignature).replace(/\n/g, '<br>');
                editor.current?.insertHtml(`<div class="ff_signature">-- <br>${sig}</div>`);
              }}
            />
          ) : (
            <MenuItem label="No signature" disabled />
          )}
          <MenuItem label="Manage signatures" onSelect={() => (setMenu(null), window.location.assign('/mail/settings/general#signature'))} />
        </Menu>
      ) : null}
      {menu?.kind === 'more' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          <MenuItem icon="open_in_full" label="Full screen" onSelect={() => (setMenu(null), updateComposer(composer.id, { window: 'maximized' }))} />
          <MenuItem icon="save" label="Save draft" hint="⌘S" onSelect={() => (setMenu(null), void c.save())} />
          <MenuItem
            icon="format_clear"
            label="Plain text mode"
            onSelect={() => {
              setMenu(null);
              const text = editor.current?.getHtml() ?? '';
              const div = document.createElement('div');
              div.innerHTML = text;
              const plain = escapeHtml(div.innerText).replace(/\n/g, '<br>');
              c.change({ html: plain });
              if (editor.current) {
                editor.current.focus();
                document.execCommand('selectAll');
                editor.current.insertHtml(plain);
              }
            }}
          />
          <MenuItem icon="print" label="Print" onSelect={() => (setMenu(null), window.print())} />
        </Menu>
      ) : null}
      {menu?.kind === 'from' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          {identities.map((i) => (
            <MenuItem
              key={i.id}
              checked={i.id === identity?.id}
              label={`${i.name} <${i.email}>`}
              onSelect={() => (setMenu(null), c.change({ identityId: i.id }))}
            />
          ))}
        </Menu>
      ) : null}
      {menu?.kind === 'replyType' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          <MenuItem
            icon="reply"
            label="Reply"
            onSelect={() => (setMenu(null), draft.sourceEmailId && draft.threadId && void reply(draft.threadId, 'reply', { inline: true }))}
          />
          <MenuItem
            icon="reply_all"
            label="Reply all"
            onSelect={() => (setMenu(null), draft.sourceEmailId && draft.threadId && void reply(draft.threadId, 'replyAll', { inline: true }))}
          />
          <MenuItem
            icon="forward"
            label="Forward"
            onSelect={() => (setMenu(null), draft.sourceEmailId && draft.threadId && void reply(draft.threadId, 'forward', { inline: true }))}
          />
          <MenuItem icon="edit" label="Edit subject" onSelect={() => (setMenu(null), setEditSubject(true))} />
          <MenuItem
            icon="open_in_new"
            label="Pop out reply"
            onSelect={() => (setMenu(null), updateComposer(composer.id, { inline: false, window: 'normal' }))}
          />
        </Menu>
      ) : null}
      {linkDlg ? (
        <LinkDialog
          initial={linkDlg}
          onClose={() => setLinkDlg(null)}
          onInsert={(text, url) => {
            setLinkDlg(null);
            const href = /^[^@\s]+@[^@\s]+$/.test(url) ? `mailto:${url}` : /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
            if (!/^(https?:|mailto:)/i.test(href)) return;
            editor.current?.insertHtml(`<a href="${escapeHtml(href)}">${escapeHtml(text || url)}</a>`);
          }}
        />
      ) : null}
      {scheduleDlg ? (
        <Dialog title="Schedule send" onClose={() => setScheduleDlg(false)} className="schedule-dialog">
          <div className="schedule-list">
            {lastScheduledAt && new Date(lastScheduledAt) > new Date() ? (
              <button type="button" className="schedule-opt" onClick={() => (setScheduleDlg(false), void c.send(new Date(lastScheduledAt)))}>
                <span>Last scheduled time</span>
                <span className="schedule-opt__when">{formatShortDateTime(new Date(lastScheduledAt))}</span>
              </button>
            ) : null}
            {scheduleOptions.map((o) => (
              <button key={o.label} type="button" className="schedule-opt" onClick={() => (setScheduleDlg(false), void c.send(o.when))}>
                <span>{o.label}</span>
                <span className="schedule-opt__when">{formatShortDateTime(o.when)}</span>
              </button>
            ))}
            <button
              type="button"
              className="schedule-opt schedule-opt--pick"
              onClick={() => {
                setScheduleDlg(false);
                const d = new Date();
                d.setDate(d.getDate() + 1);
                d.setHours(8, 0, 0, 0);
                openDialog({
                  kind: 'datetime',
                  title: 'Pick date & time',
                  initial: d,
                  max: new Date(Date.now() + 30 * 86400_000 - 60_000),
                  onPick: (when) => void c.send(when),
                });
              }}
            >
              <Icon name="date_range" size={20} />
              <span>Pick date &amp; time</span>
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );

  if (composer.inline) {
    return (
      <div
        ref={rootRef}
        className={`compose compose--inline${focused ? ' compose--focused' : ''}`}
        onKeyDown={onKeyDown}
        onFocus={() => !focused && focusComposer(composer.id)}
        data-composer={composer.id}
      >
        <Avatar name={identity?.name} email={identity?.email ?? ''} size={40} className="compose__inline-avatar" />
        <div className="compose__inline-card">{body}</div>
        {menus}
      </div>
    );
  }

  return (
    <div
      className={`compose compose--docked compose--${composer.window}${focused ? ' compose--focused' : ''}`}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      onMouseDown={() => !focused && useUi.setState({ focusedComposer: composer.id })}
      data-composer={composer.id}
    >
      {header}
      {!isMin ? body : null}
      {menus}
    </div>
  );
}

function LinkDialog({
  initial,
  onClose,
  onInsert,
}: {
  initial: { text: string; url: string };
  onClose: () => void;
  onInsert: (text: string, url: string) => void;
}) {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  return (
    <Dialog
      title="Edit link"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="text" disabled={!url.trim()} onClick={() => onInsert(text, url.trim())}>
            OK
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">Text to display</span>
        <input className="field__input" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">Link to: web address or email address</span>
        <input
          className="field__input"
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && onInsert(text, url.trim())}
        />
      </label>
    </Dialog>
  );
}
