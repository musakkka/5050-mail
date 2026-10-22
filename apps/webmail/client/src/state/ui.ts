import { create } from 'zustand';
import type { ComposeDraft } from '../mail/compose';

// ------------------------------------------------------------------ snackbar
export interface SnackAction {
  label: string;
  run: () => void | Promise<void>;
}
export interface Snack {
  id: number;
  text: string;
  actions?: SnackAction[];
  /** ms; default 10s. 0 = until dismissed. */
  duration?: number;
}

// ------------------------------------------------------------------ composers
export type ComposerWindow = 'normal' | 'minimized' | 'maximized';
export interface Composer {
  id: string;
  draft: ComposeDraft;
  window: ComposerWindow;
  /** Inline reply inside a conversation (not docked). */
  inline: boolean;
  /** Bumps to request focus of the body. */
  focusNonce: number;
}

// ------------------------------------------------------------------ dialogs
export type DialogState =
  | { kind: 'none' }
  | { kind: 'shortcuts' }
  | { kind: 'createLabel'; parentId?: string; applyToSelection?: boolean }
  | { kind: 'editLabel'; mailboxId: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; onConfirm: () => void }
  | { kind: 'alert'; title?: string; body: string }
  | { kind: 'datetime'; title: string; initial?: Date; max?: Date; onPick: (d: Date) => void };

interface UiState {
  snack: Snack | null;
  showSnack: (s: Omit<Snack, 'id'>) => number;
  hideSnack: (id?: number) => void;

  /** Last undoable action (for `z`). */
  undo: (() => Promise<void>) | null;
  setUndo: (fn: (() => Promise<void>) | null) => void;

  composers: Composer[];
  openComposer: (draft: ComposeDraft, opts?: { inline?: boolean; window?: ComposerWindow }) => string;
  updateComposer: (id: string, patch: Partial<Composer> | ((c: Composer) => Partial<Composer>)) => void;
  updateDraft: (id: string, patch: Partial<ComposeDraft>) => void;
  closeComposer: (id: string) => void;
  focusComposer: (id: string) => void;
  focusedComposer: string | null;

  selection: Set<string>;
  selectionAnchor: string | null;
  /** "Select all N conversations in view" mode. */
  selectAllMatching: boolean;
  setSelection: (ids: Set<string>, anchor?: string | null) => void;
  clearSelection: () => void;
  setSelectAllMatching: (v: boolean) => void;

  /** Keyboard cursor (j/k) row index on the current page. */
  cursor: number;
  setCursor: (i: number) => void;
  /** The cursor bar is only drawn once the keyboard has been used for navigation. */
  kbdNav: boolean;
  setKbdNav: (v: boolean) => void;

  quickSettingsOpen: boolean;
  setQuickSettings: (open: boolean) => void;
  sidePanel: string | null;
  setSidePanel: (p: string | null) => void;
  navHoverOpen: boolean;
  setNavHoverOpen: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;

  dialog: DialogState;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;

  /** Global "loading" bar (list fetches etc). */
  busy: number;
  addBusy: (d: number) => void;

  /** Ask the list/thread to open a menu (keyboard `v`, `l`, `b`, `.`). */
  menuRequest: { kind: 'move' | 'label' | 'snooze' | 'more'; nonce: number } | null;
  requestMenu: (kind: 'move' | 'label' | 'snooze' | 'more') => void;
}

let snackSeq = 0;
let composerSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  snack: null,
  showSnack: (s) => {
    const id = ++snackSeq;
    set({ snack: { ...s, id } });
    return id;
  },
  hideSnack: (id) => {
    const cur = get().snack;
    if (!cur || (id !== undefined && cur.id !== id)) return;
    set({ snack: null });
  },

  undo: null,
  setUndo: (fn) => set({ undo: fn }),

  composers: [],
  focusedComposer: null,
  openComposer: (draft, opts = {}) => {
    const id = `cmp${++composerSeq}`;
    set((s) => {
      let composers = s.composers;
      if (opts.inline) composers = composers.filter((c) => !(c.inline && c.draft.threadId === draft.threadId));
      // Gmail: when too many docked windows, older ones minimise.
      const docked = composers.filter((c) => !c.inline);
      const maxOpen = Math.max(1, Math.floor((window.innerWidth - 300) / 556));
      if (!opts.inline && docked.filter((c) => c.window === 'normal').length >= maxOpen) {
        const oldest = docked.find((c) => c.window === 'normal');
        if (oldest) composers = composers.map((c) => (c === oldest ? { ...c, window: 'minimized' } : c));
      }
      return {
        composers: [...composers, { id, draft, window: opts.window ?? 'normal', inline: !!opts.inline, focusNonce: 1 }],
        focusedComposer: id,
      };
    });
    return id;
  },
  updateComposer: (id, patch) =>
    set((s) => ({ composers: s.composers.map((c) => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)) })),
  updateDraft: (id, patch) => set((s) => ({ composers: s.composers.map((c) => (c.id === id ? { ...c, draft: { ...c.draft, ...patch } } : c)) })),
  closeComposer: (id) =>
    set((s) => ({ composers: s.composers.filter((c) => c.id !== id), focusedComposer: s.focusedComposer === id ? null : s.focusedComposer })),
  focusComposer: (id) =>
    set((s) => ({
      focusedComposer: id,
      composers: s.composers.map((c) => (c.id === id ? { ...c, focusNonce: c.focusNonce + 1, window: c.window === 'minimized' ? 'normal' : c.window } : c)),
    })),

  selection: new Set(),
  selectionAnchor: null,
  selectAllMatching: false,
  setSelection: (ids, anchor) => set((s) => ({ selection: ids, selectionAnchor: anchor === undefined ? s.selectionAnchor : anchor, selectAllMatching: false })),
  clearSelection: () => set({ selection: new Set(), selectionAnchor: null, selectAllMatching: false }),
  setSelectAllMatching: (v) => set({ selectAllMatching: v }),

  cursor: 0,
  setCursor: (i) => set({ cursor: i }),
  kbdNav: false,
  setKbdNav: (v) => set((s) => (s.kbdNav === v ? s : { kbdNav: v })),

  quickSettingsOpen: false,
  setQuickSettings: (open) => set({ quickSettingsOpen: open }),
  sidePanel: null,
  setSidePanel: (p) => set({ sidePanel: p }),
  navHoverOpen: false,
  setNavHoverOpen: (v) => set({ navHoverOpen: v }),
  mobileNavOpen: false,
  setMobileNavOpen: (v) => set({ mobileNavOpen: v }),

  dialog: { kind: 'none' },
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: { kind: 'none' } }),

  busy: 0,
  addBusy: (d) => set((s) => ({ busy: Math.max(0, s.busy + d) })),

  menuRequest: null,
  requestMenu: (kind) => set((s) => ({ menuRequest: { kind, nonce: (s.menuRequest?.nonce ?? 0) + 1 } })),
}));

export function emptyDraft(identityId?: string): ComposeDraft {
  return { mode: 'new', identityId, to: [], cc: [], bcc: [], subject: '', html: '', quotedHtml: '', attachments: [], inReplyTo: null, references: null };
}
