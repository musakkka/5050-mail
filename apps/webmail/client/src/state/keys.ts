/** Registry the active list / conversation view publishes for keyboard shortcuts. */
import { create } from 'zustand';
import type { ActionKind } from '../mail/actions';

export interface ListKeyApi {
  moveCursor: (delta: number) => void;
  openCursor: () => void;
  toggleSelectCursor: () => void;
  selectBy: (pred: 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred') => void;
  act: (kind: ActionKind) => void;
  nextPage: () => void;
  prevPage: () => void;
  openMenu: (kind: 'move' | 'label' | 'snooze' | 'more') => void;
  reply: (mode: 'reply' | 'replyAll' | 'forward') => void;
  focusToolbar: () => void;
  cycleTab: (delta: number) => void;
  refresh: () => void;
}

export interface ThreadKeyApi {
  act: (kind: ActionKind) => void;
  reply: (mode: 'reply' | 'replyAll' | 'forward') => void;
  back: () => void;
  /** Go to older (+1) / newer (-1) conversation. */
  sibling: (delta: number, archiveFirst?: boolean) => void;
  expandAll: () => void;
  collapseAll: () => void;
  moveMessageCursor: (delta: number) => void;
  toggleCursorMessage: () => void;
  openMenu: (kind: 'move' | 'label' | 'snooze' | 'more') => void;
  markUnreadFromCursor: () => void;
}

interface KeysState {
  list: ListKeyApi | null;
  thread: ThreadKeyApi | null;
  setList: (a: ListKeyApi | null) => void;
  setThread: (a: ThreadKeyApi | null) => void;
}

export const useKeys = create<KeysState>((set) => ({
  list: null,
  thread: null,
  setList: (list) => set({ list }),
  setThread: (thread) => set({ thread }),
}));
