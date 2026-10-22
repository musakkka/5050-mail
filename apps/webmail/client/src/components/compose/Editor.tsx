import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconKey } from '../icons/Icon';
import { Menu, MenuItem } from '../ui/Menu';
import { sanitizeForCompose } from '../../mail/sanitize';
import { escapeHtml } from '../../lib/format';

export interface EditorHandle {
  focus: (atStart?: boolean) => void;
  exec: (cmd: string, value?: string) => void;
  insertHtml: (html: string) => void;
  getHtml: () => string;
  /** Replace the content without reporting it as an edit. */
  setHtml: (html: string) => void;
  saveSelection: () => void;
  restoreSelection: () => void;
  selectedText: () => string;
}

/** contentEditable rich-text body (Gmail uses Arial "small"). */
export const Editor = forwardRef<
  EditorHandle,
  { initialHtml: string; onChange: (html: string) => void; onKeyDown?: (e: KeyboardEvent) => void; placeholder?: string; className?: string; label?: string }
>(function Editor({ initialHtml, onChange, onKeyDown, placeholder, className, label }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [empty, setEmpty] = useState(!initialHtml);

  const initialized = useRef(false);
  useEffect(() => {
    // Initial content only — subsequent edits are owned by the DOM. Once per instance: a re-run
    // (React StrictMode) must not wipe content inserted since (e.g. the signature).
    if (el.current && !initialized.current) el.current.innerHTML = initialHtml;
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    const html = el.current?.innerHTML ?? '';
    setEmpty(!el.current?.textContent?.trim() && !el.current?.querySelector('img'));
    onChange(html);
  };

  useImperativeHandle(ref, () => ({
    focus: (atStart = true) => {
      const node = el.current;
      if (!node) return;
      node.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(atStart);
      sel.removeAllRanges();
      sel.addRange(r);
    },
    exec: (cmd, value) => {
      el.current?.focus();
      if (saved.current) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(saved.current);
        saved.current = null;
      }
      document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor' || cmd === 'fontName' ? 'true' : 'false');
      document.execCommand(cmd, false, value);
      emit();
    },
    insertHtml: (html) => {
      el.current?.focus();
      if (saved.current) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(saved.current);
        saved.current = null;
      }
      document.execCommand('insertHTML', false, html);
      emit();
    },
    getHtml: () => el.current?.innerHTML ?? '',
    setHtml: (html) => {
      if (!el.current) return;
      el.current.innerHTML = html;
      setEmpty(!el.current.textContent?.trim() && !el.current.querySelector('img'));
    },
    saveSelection: () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && el.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    },
    restoreSelection: () => {
      if (!saved.current) return;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved.current);
    },
    selectedText: () => window.getSelection()?.toString() ?? '',
  }));

  return (
    <div className={`editor-wrap${className ? ` ${className}` : ''}`}>
      {empty && placeholder ? <div className="editor__placeholder">{placeholder}</div> : null}
      <div
        ref={el}
        className="editor"
        dir="auto"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label={label ?? 'Message Body'}
        suppressContentEditableWarning
        spellCheck
        onInput={emit}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          if (e.clipboardData.files.length) return; // images handled by parent
          e.preventDefault();
          const safe = html ? sanitizeForCompose(html) : escapeHtml(text).replace(/\n/g, '<br>');
          document.execCommand('insertHTML', false, safe);
          emit();
        }}
      />
    </div>
  );
});

const FONTS = [
  { label: 'Sans Serif', value: 'arial, sans-serif' },
  { label: 'Serif', value: "'times new roman', serif" },
  { label: 'Fixed width', value: 'monospace' },
  { label: 'Wide', value: "'arial black', sans-serif" },
  { label: 'Narrow', value: "'arial narrow', sans-serif" },
  { label: 'Comic Sans MS', value: "'comic sans ms', sans-serif" },
  { label: 'Garamond', value: 'garamond, serif' },
  { label: 'Georgia', value: 'georgia, serif' },
  { label: 'Tahoma', value: 'tahoma, sans-serif' },
  { label: 'Trebuchet MS', value: "'trebuchet ms', sans-serif" },
  { label: 'Verdana', value: 'verdana, sans-serif' },
];
const SIZES = [
  { label: 'Small', value: '1' },
  { label: 'Normal', value: '2' },
  { label: 'Large', value: '4' },
  { label: 'Huge', value: '6' },
];
const COLORS = [
  '#000000',
  '#444444',
  '#666666',
  '#999999',
  '#cccccc',
  '#eeeeee',
  '#f3f3f3',
  '#ffffff',
  '#ff0000',
  '#ff9900',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#0000ff',
  '#9900ff',
  '#ff00ff',
  '#f4cccc',
  '#fce5cd',
  '#fff2cc',
  '#d9ead3',
  '#d0e0e3',
  '#cfe2f3',
  '#d9d2e9',
  '#ead1dc',
  '#e06666',
  '#f6b26b',
  '#ffd966',
  '#93c47d',
  '#76a5af',
  '#6fa8dc',
  '#8e7cc3',
  '#c27ba0',
  '#cc0000',
  '#e69138',
  '#f1c232',
  '#6aa84f',
  '#45818e',
  '#3d85c6',
  '#674ea7',
  '#a64d79',
  '#990000',
  '#b45f06',
  '#bf9000',
  '#38761d',
  '#134f5c',
  '#0b5394',
  '#351c75',
  '#741b47',
];

/** Formatting toolbar (02-components §9.1). */
export function FormattingToolbar({ editor }: { editor: React.RefObject<EditorHandle> }) {
  const [menu, setMenu] = useState<null | { kind: 'font' | 'size' | 'color' | 'align'; anchor: Element }>(null);
  const [font, setFont] = useState('Sans Serif');
  const btn = (icon: IconKey, label: string, cmd: string, value?: string) => (
    <button
      type="button"
      className="fmt__btn"
      aria-label={label}
      data-tooltip={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor.current?.exec(cmd, value)}
    >
      <Icon name={icon} size={20} />
    </button>
  );
  const open = (kind: 'font' | 'size' | 'color' | 'align') => (e: React.MouseEvent) => {
    editor.current?.saveSelection();
    setMenu({ kind, anchor: e.currentTarget });
  };
  return (
    <div className="fmt" role="toolbar" aria-label="Formatting options">
      {btn('undo', 'Undo (⌘Z)', 'undo')}
      {btn('redo', 'Redo (⌘Y)', 'redo')}
      <span className="fmt__div" />
      <button type="button" className="fmt__select" data-tooltip="Font" onMouseDown={(e) => e.preventDefault()} onClick={open('font')}>
        {font}
        <Icon name="arrow_drop_down" size={20} />
      </button>
      <span className="fmt__div" />
      <button
        type="button"
        className="fmt__btn fmt__btn--drop"
        aria-label="Size"
        data-tooltip="Size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={open('size')}
      >
        <Icon name="format_size" size={20} />
        <Icon name="arrow_drop_down" size={16} />
      </button>
      <span className="fmt__div" />
      {btn('format_bold', 'Bold (⌘B)', 'bold')}
      {btn('format_italic', 'Italic (⌘I)', 'italic')}
      {btn('format_underlined', 'Underline (⌘U)', 'underline')}
      <button
        type="button"
        className="fmt__btn fmt__btn--drop"
        aria-label="Text colour"
        data-tooltip="Text colour"
        onMouseDown={(e) => e.preventDefault()}
        onClick={open('color')}
      >
        <Icon name="format_color_text" size={20} />
        <Icon name="arrow_drop_down" size={16} />
      </button>
      <span className="fmt__div" />
      <button
        type="button"
        className="fmt__btn fmt__btn--drop"
        aria-label="Align"
        data-tooltip="Align"
        onMouseDown={(e) => e.preventDefault()}
        onClick={open('align')}
      >
        <Icon name="format_align_left" size={20} />
        <Icon name="arrow_drop_down" size={16} />
      </button>
      {btn('format_list_numbered', 'Numbered list (⌘⇧7)', 'insertOrderedList')}
      {btn('format_list_bulleted', 'Bulleted list (⌘⇧8)', 'insertUnorderedList')}
      {btn('format_indent_decrease', 'Indent less (⌘[)', 'outdent')}
      {btn('format_indent_increase', 'Indent more (⌘])', 'indent')}
      <span className="fmt__div" />
      {btn('format_quote', 'Quote (⌘⇧9)', 'formatBlock', 'blockquote')}
      {btn('strikethrough_s', 'Strikethrough (⌘⇧X)', 'strikeThrough')}
      {btn('format_clear', 'Remove formatting (⌘\\)', 'removeFormat')}
      {menu?.kind === 'font' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          {FONTS.map((f) => (
            <MenuItem
              key={f.label}
              checked={font === f.label}
              label={<span style={{ fontFamily: f.value }}>{f.label}</span>}
              onSelect={() => (setMenu(null), setFont(f.label), editor.current?.exec('fontName', f.value))}
            />
          ))}
        </Menu>
      ) : null}
      {menu?.kind === 'size' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          {SIZES.map((s) => (
            <MenuItem key={s.label} label={s.label} onSelect={() => (setMenu(null), editor.current?.exec('fontSize', s.value))} />
          ))}
        </Menu>
      ) : null}
      {menu?.kind === 'align' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start">
          <MenuItem icon="format_align_left" label="Left" onSelect={() => (setMenu(null), editor.current?.exec('justifyLeft'))} />
          <MenuItem icon="format_align_center" label="Center" onSelect={() => (setMenu(null), editor.current?.exec('justifyCenter'))} />
          <MenuItem icon="format_align_right" label="Right" onSelect={() => (setMenu(null), editor.current?.exec('justifyRight'))} />
        </Menu>
      ) : null}
      {menu?.kind === 'color' ? (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} placement="top-start" className="color-menu">
          <div className="color-cols">
            {(['hiliteColor', 'foreColor'] as const).map((cmd) => (
              <div key={cmd}>
                <div className="color-cols__title">{cmd === 'foreColor' ? 'Text colour' : 'Background colour'}</div>
                <div className="color-grid color-grid--small">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="menuitem"
                      className="color-swatch color-swatch--small"
                      style={{ background: c }}
                      aria-label={c}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => (setMenu(null), editor.current?.exec(cmd, c))}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Menu>
      ) : null}
    </div>
  );
}

/** Ctrl/⌘ formatting shortcuts (04-keyboard "Formatting text"). Returns true if handled. */
export function handleFormattingKeys(e: KeyboardEvent, editor: EditorHandle | null): boolean {
  if (!editor) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return false;
  const k = e.key.toLowerCase();
  const map: Record<string, [string, string?]> = e.shiftKey
    ? {
        '7': ['insertOrderedList'],
        '&': ['insertOrderedList'],
        '8': ['insertUnorderedList'],
        '*': ['insertUnorderedList'],
        '9': ['formatBlock', 'blockquote'],
        '(': ['formatBlock', 'blockquote'],
        l: ['justifyLeft'],
        e: ['justifyCenter'],
        r: ['justifyRight'],
        x: ['strikeThrough'],
      }
    : { '[': ['outdent'], ']': ['indent'], '\\': ['removeFormat'] };
  const hit = map[k];
  if (!hit) return false;
  e.preventDefault();
  editor.exec(hit[0], hit[1]);
  return true;
}
