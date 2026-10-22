import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../icons/Icon';
import { useContacts } from '../../state/mail';
import { isValidEmail, parseRecipients, type Recipient } from '../../mail/compose';

/** Chip input for To / Cc / Bcc with autocomplete from previous correspondents. */
export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  trailing,
  onLabelClick,
  inputRef: externalRef,
}: {
  label: string;
  value: Recipient[];
  onChange: (r: Recipient[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
  onLabelClick?: () => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(0);
  const [chipFocus, setChipFocus] = useState<number | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? localRef;
  const { data: contacts } = useContacts(focused);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set(value.map((v) => v.email.toLowerCase()));
    return (contacts ?? [])
      .filter(
        (c) =>
          !taken.has(c.email.toLowerCase()) &&
          (c.email.toLowerCase().includes(q) ||
            c.name
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.startsWith(q)) ||
            c.name.toLowerCase().startsWith(q)),
      )
      .slice(0, 6);
  }, [text, contacts, value]);

  const commit = (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t) return false;
    const parsed = parseRecipients(t);
    if (!parsed.length) return false;
    onChange([...value, ...parsed.filter((p) => !value.some((v) => v.email.toLowerCase() === p.email.toLowerCase()))]);
    setText('');
    setHi(0);
    return true;
  };

  const pick = (i: number) => {
    const s = suggestions[i];
    if (!s) return commit();
    onChange([...value, { name: s.name, email: s.email }]);
    setText('');
    setHi(0);
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setHi((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setHi((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (text.trim()) {
        const did = suggestions.length ? pick(hi) : commit();
        if (did && e.key === 'Enter') e.preventDefault();
        if (did && e.key === 'Tab') e.preventDefault();
      }
    } else if (e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      if (chipFocus === value.length - 1) {
        onChange(value.slice(0, -1));
        setChipFocus(null);
      } else setChipFocus(value.length - 1);
    } else if (e.key === 'Escape' && suggestions.length) {
      e.stopPropagation();
      setText(text + ' ');
    } else setChipFocus(null);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text');
    if (/[,;\n]/.test(t) || parseRecipients(t).length > 1) {
      e.preventDefault();
      commit(text + t);
    }
  };

  return (
    <div className="rcpt" onClick={() => inputRef.current?.focus()}>
      <button type="button" className="rcpt__label" tabIndex={-1} onClick={onLabelClick}>
        {label}
      </button>
      <div className="rcpt__chips">
        {value.map((r, i) => {
          const valid = isValidEmail(r.email);
          return (
            <span
              key={`${r.email}-${i}`}
              className={`chip${valid ? '' : ' chip--invalid'}${chipFocus === i ? ' chip--focus' : ''}`}
              data-tooltip={r.name ? `${r.name} <${r.email}>` : r.email}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
                setText(r.name ? `${r.name} <${r.email}>` : r.email);
                inputRef.current?.focus();
              }}
            >
              <Avatar name={r.name} email={r.email} size={24} />
              <span className="chip__text">{r.name || r.email}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${r.email}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((_, j) => j !== i));
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="rcpt__input"
          value={text}
          autoFocus={autoFocus}
          aria-label={`${label} recipients`}
          onChange={(e) => {
            setText(e.target.value);
            setHi(0);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setChipFocus(null);
            if (text.trim() && !suggestions.length) commit();
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {trailing}
      {focused && suggestions.length ? (
        <div className="rcpt__suggest" role="listbox">
          {suggestions.map((s, i) => (
            <div
              key={s.email}
              role="option"
              aria-selected={i === hi}
              className={`rcpt__opt${i === hi ? ' rcpt__opt--hi' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <Avatar name={s.name} email={s.email} size={32} />
              <span className="rcpt__opt-text">
                <span className="rcpt__opt-name">{s.name || s.email}</span>
                {s.name ? <span className="rcpt__opt-email">{s.email}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
