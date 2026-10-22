import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons/Icon';
import { IconButton, Button } from '../ui/Button';
import { Avatar } from '../ui/Avatar';
import { useContacts, useMailboxes } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { buildQuery, EMPTY_ADVANCED, parseAdvanced, type AdvancedSearch } from '../../mail/searchParser';
import { useUi } from '../../state/ui';

interface Suggestion {
  kind: 'recent' | 'contact' | 'query';
  text: string;
  sub?: string;
  query: string;
  email?: string;
}

export function SearchBar({ currentQuery }: { currentQuery: string | null }) {
  const nav = useNavigate();
  const [value, setValue] = useState(currentQuery ?? '');
  const [focused, setFocused] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const recent = useSettings((s) => s.recentSearches);
  const setSettings = useSettings((s) => s.set);
  const { data: contacts } = useContacts(focused);

  useEffect(() => setValue(currentQuery ?? ''), [currentQuery]);

  // `/` focuses search (registered globally in shortcuts; also expose via event).
  useEffect(() => {
    const f = () => inputRef.current?.focus();
    const adv = () => setAdvanced(true);
    window.addEventListener('ff:focus-search', f);
    window.addEventListener('ff:advanced-search', adv);
    return () => {
      window.removeEventListener('ff:focus-search', f);
      window.removeEventListener('ff:advanced-search', adv);
    };
  }, []);

  const suggestions = useMemo<Suggestion[]>(() => {
    const v = value.trim().toLowerCase();
    const out: Suggestion[] = [];
    const recents = recent.filter((r) => !v || r.toLowerCase().includes(v)).slice(0, v ? 3 : 6);
    for (const r of recents) out.push({ kind: 'recent', text: r, query: r });
    if (v.length >= 1 && !/[:"]/.test(v)) {
      for (const c of contacts ?? []) {
        if (out.length >= 8) break;
        if (c.email.toLowerCase().includes(v) || c.name.toLowerCase().includes(v))
          out.push({ kind: 'contact', text: c.name || c.email, sub: c.email, query: `from:${c.email}`, email: c.email });
      }
    }
    return out;
  }, [value, recent, contacts]);

  const submit = (q: string) => {
    const query = q.trim();
    if (!query) return;
    setSettings({ recentSearches: [query, ...recent.filter((r) => r !== query)].slice(0, 10) });
    setFocused(false);
    setAdvanced(false);
    inputRef.current?.blur();
    nav(`/mail/search/${encodeURIComponent(query)}`);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (hi >= 0 && suggestions[hi]) submit(suggestions[hi]!.query);
    else submit(value);
  };

  const open = focused && !advanced && suggestions.length > 0;

  return (
    <div ref={wrapRef} className={`search${focused || advanced ? ' search--focused' : ''}${open ? ' search--open' : ''}`}>
      <form className="search__form" role="search" onSubmit={onSubmit}>
        <IconButton icon="search" label="Search" type="submit" iconSize={24} className="search__btn" onClick={(e) => (e.preventDefault(), submit(value))} />
        <input
          ref={inputRef}
          className="search__input"
          placeholder="Search mail"
          aria-label="Search mail"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setHi(-1);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(suggestions.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(-1, h - 1));
            } else if (e.key === 'Escape') {
              setFocused(false);
              inputRef.current?.blur();
            }
          }}
        />
        {value ? (
          <IconButton
            icon="close"
            label="Clear search"
            iconSize={24}
            onClick={() => {
              setValue('');
              if (currentQuery) nav('/mail/inbox');
              inputRef.current?.focus();
            }}
          />
        ) : null}
        <IconButton icon="tune" label="Show search options" iconSize={24} className="search__tune" active={advanced} onClick={() => setAdvanced((a) => !a)} />
      </form>
      {open ? (
        <div className="search__suggest" role="listbox">
          {suggestions.map((s, i) => (
            <div
              key={`${s.kind}:${s.query}`}
              role="option"
              aria-selected={i === hi}
              className={`search__opt${i === hi ? ' search__opt--hi' : ''}${s.kind === 'contact' ? ' search__opt--contact' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                submit(s.query);
              }}
              onMouseEnter={() => setHi(i)}
            >
              {s.kind === 'contact' ? (
                <Avatar name={s.text} email={s.email!} size={32} />
              ) : (
                <Icon name={s.kind === 'recent' ? 'schedule' : 'search'} size={20} />
              )}
              <span className="search__opt-text">
                <span>{s.text}</span>
                {s.sub ? <span className="search__opt-sub">{s.sub}</span> : null}
              </span>
            </div>
          ))}
          <div className="search__hint">Press Enter to search</div>
        </div>
      ) : null}
      {advanced ? (
        <AdvancedSearchPanel
          initial={value ? parseAdvanced(value) : EMPTY_ADVANCED}
          onClose={() => setAdvanced(false)}
          onSearch={(q) => {
            setValue(q);
            submit(q);
          }}
        />
      ) : null}
    </div>
  );
}

function AdvancedSearchPanel({ initial, onSearch, onClose }: { initial: AdvancedSearch; onSearch: (q: string) => void; onClose: () => void }) {
  const [a, setA] = useState<AdvancedSearch>(initial);
  const { data: model } = useMailboxes();
  const openDialog = useUi((s) => s.openDialog);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest('.search__tune')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const field = (k: keyof AdvancedSearch, label: string) => (
    <label className="adv__row">
      <span className="adv__label">{label}</span>
      <input className="adv__input" value={a[k] as string} onChange={(e) => setA({ ...a, [k]: e.target.value })} />
    </label>
  );
  const q = buildQuery(a);
  return (
    <div ref={ref} className="adv" role="dialog" aria-label="Search options">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q) onSearch(q);
        }}
      >
        {field('from', 'From')}
        {field('to', 'To')}
        {field('subject', 'Subject')}
        {field('hasWords', 'Has the words')}
        {field('doesntHave', "Doesn't have")}
        <div className="adv__row">
          <span className="adv__label">Size</span>
          <select
            className="adv__select"
            value={a.sizeOp}
            onChange={(e) => setA({ ...a, sizeOp: e.target.value as AdvancedSearch['sizeOp'] })}
            aria-label="Size comparison"
          >
            <option value="larger">greater than</option>
            <option value="smaller">less than</option>
          </select>
          <input
            className="adv__input adv__input--num"
            inputMode="numeric"
            value={a.size}
            onChange={(e) => setA({ ...a, size: e.target.value.replace(/[^\d]/g, '') })}
            aria-label="Size"
          />
          <select
            className="adv__select"
            value={a.sizeUnit}
            onChange={(e) => setA({ ...a, sizeUnit: e.target.value as AdvancedSearch['sizeUnit'] })}
            aria-label="Size unit"
          >
            <option>MB</option>
            <option>KB</option>
            <option>Bytes</option>
          </select>
        </div>
        <div className="adv__row">
          <span className="adv__label">Date within</span>
          <select
            className="adv__select"
            value={a.dateWithin}
            onChange={(e) => setA({ ...a, dateWithin: e.target.value as AdvancedSearch['dateWithin'] })}
            aria-label="Date within"
          >
            <option value="">—</option>
            <option value="1d">1 day</option>
            <option value="3d">3 days</option>
            <option value="1w">1 week</option>
            <option value="2w">2 weeks</option>
            <option value="1m">1 month</option>
            <option value="2m">2 months</option>
            <option value="6m">6 months</option>
            <option value="1y">1 year</option>
          </select>
          <input
            className="adv__input"
            type="date"
            value={a.date}
            onChange={(e) => setA({ ...a, date: e.target.value, dateWithin: a.dateWithin || '1d' })}
            aria-label="Date"
          />
        </div>
        <div className="adv__row">
          <span className="adv__label">Search</span>
          <select
            className="adv__select adv__select--wide"
            value={a.searchIn}
            onChange={(e) => setA({ ...a, searchIn: e.target.value })}
            aria-label="Search in"
          >
            <option value="">All Mail</option>
            <option value="in:inbox">Inbox</option>
            <option value="is:starred">Starred</option>
            <option value="in:sent">Sent Mail</option>
            <option value="in:drafts">Drafts</option>
            <option value="in:spam">Spam</option>
            <option value="in:trash">Trash</option>
            <option value="in:anywhere">Mail &amp; Spam &amp; Trash</option>
            <option value="is:read">Read Mail</option>
            <option value="is:unread">Unread Mail</option>
            {model?.labels.map((l) => (
              <option key={l.mailbox.id} value={`label:${l.path.includes(' ') ? `"${l.path}"` : l.path}`}>
                {l.path}
              </option>
            ))}
          </select>
        </div>
        <label className="adv__check">
          <input type="checkbox" checked={a.hasAttachment} onChange={(e) => setA({ ...a, hasAttachment: e.target.checked })} />
          <span>Has attachment</span>
        </label>
        <div className="adv__footer">
          <Button
            variant="text"
            onClick={() =>
              openDialog({
                kind: 'alert',
                title: 'Create filter',
                body: 'Filters are stored as Sieve rules on the mail server. The filter editor is coming soon — for now, use the search to find matching mail.',
              })
            }
          >
            Create filter
          </Button>
          <Button variant="filled" type="submit" disabled={!q}>
            Search
          </Button>
        </div>
      </form>
    </div>
  );
}
