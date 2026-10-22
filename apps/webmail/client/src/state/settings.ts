/**
 * User preferences (Gmail "Settings"). Persisted per account in localStorage —
 * none of this is sensitive. TODO(v2): sync to a FileNode `5050-settings.json`
 * (05-jmap-mapping §11) so prefs roam across devices.
 */
import { create } from 'zustand';
import type { Category } from '../mail/mapping';

export type Theme = 'light' | 'dark' | 'system';
export type Density = 'default' | 'comfortable' | 'compact';
export type ReadingPane = 'none' | 'right' | 'below';
export type InboxType = 'default' | 'important' | 'unread' | 'starred';
export type LabelVisibility = 'show' | 'unread' | 'hide';

export interface Settings {
  theme: Theme;
  density: Density;
  readingPane: ReadingPane;
  /** Fraction of the card given to the list in split modes. */
  splitRatio: number;
  inboxType: InboxType;
  /** Enabled inbox category tabs (Primary is always on). */
  categories: Category[];
  conversationView: boolean;
  keyboardShortcuts: boolean;
  undoSendSeconds: 5 | 10 | 20 | 30;
  pageSize: 10 | 15 | 20 | 25 | 50 | 100;
  navCollapsed: boolean;
  sidePanelHidden: boolean;
  /** "Images: Always display external images / Ask before displaying". */
  externalImages: 'ask' | 'always';
  trustedImageSenders: string[];
  labelColors: Record<string, { bg: string; fg: string }>;
  /** "In label list": show / show if unread / hide (keyed by mailbox id). */
  labelVisibility: Record<string, LabelVisibility>;
  hoverActions: boolean;
  defaultReply: 'reply' | 'replyAll';
  importanceMarkers: boolean;
  snippets: boolean;
  desktopNotifications: boolean;
  /** Mark as read in split pane after N seconds (0 = immediately, -1 = never). */
  markReadDelay: number;
  recentSearches: string[];
  lastScheduledAt?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  density: 'default',
  readingPane: 'none',
  splitRatio: 0.5,
  inboxType: 'default',
  categories: ['primary', 'promotions', 'social', 'updates'],
  conversationView: true,
  keyboardShortcuts: true,
  undoSendSeconds: 5,
  pageSize: 50,
  navCollapsed: false,
  sidePanelHidden: false,
  externalImages: 'ask',
  trustedImageSenders: [],
  labelColors: {},
  labelVisibility: {},
  hoverActions: true,
  defaultReply: 'reply',
  importanceMarkers: true,
  snippets: true,
  desktopNotifications: false,
  markReadDelay: 0,
  recentSearches: [],
};

interface SettingsState extends Settings {
  account: string | null;
  set: (patch: Partial<Settings>) => void;
  load: (account: string) => void;
}

const key = (account: string) => `ff:settings:${account}`;

function read(account: string): Partial<Settings> {
  try {
    const raw = localStorage.getItem(key(account));
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  account: null,
  set: (patch) => {
    set(patch);
    const { account } = get();
    if (!account) return;
    try {
      const { set: _s, load: _l, account: _a, ...rest } = get();
      localStorage.setItem(key(account), JSON.stringify(rest));
    } catch {
      /* storage full / disabled */
    }
  },
  load: (account) => set({ ...DEFAULT_SETTINGS, ...read(account), account }),
}));

export function settingsSnapshot(): Settings {
  return useSettings.getState();
}
