import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/shell/TopBar';
import { Nav } from '../components/shell/Nav';
import { SidePanel } from '../components/shell/SidePanel';
import { QuickSettings } from '../components/shell/QuickSettings';
import { ThreadList } from '../components/list/ThreadList';
import { ThreadView } from '../components/thread/ThreadView';
import { ComposeDock } from '../components/compose/ComposeDock';
import { Dialogs } from '../components/dialogs/Dialogs';
import { SettingsPage } from '../components/settings/SettingsPage';
import { GoToLabel } from '../components/shell/GoToLabel';
import { Snackbar } from '../components/ui/Snackbar';
import { Icon } from '../components/icons/Icon';
import { useShortcuts } from '../components/keyboard/useShortcuts';
import { FULL_PROPS } from '../mail/threads';
import { draftFromEmail } from '../mail/compose';
import { parseMailPath, viewTitle } from '../mail/views';
import { useMail, useMailboxes, useThreadPage, useCategoryCounts } from '../state/mail';
import { useSettings } from '../state/settings';
import { useUi, emptyDraft } from '../state/ui';

export function MailApp() {
  const loc = useLocation();
  const nav = useNavigate();
  const route = parseMailPath(loc.pathname, loc.search);
  const { view, threadId, page, settings: settingsTab } = route;
  const { me, identities, client } = useMail();
  const navCollapsedSetting = useSettings((s) => s.navCollapsed);
  const readingPane = useSettings((s) => s.readingPane);
  const splitRatio = useSettings((s) => s.splitRatio);
  const setSettings = useSettings((s) => s.set);
  const categories = useSettings((s) => s.categories);
  const inboxType = useSettings((s) => s.inboxType);
  const quickOpen = useUi((s) => s.quickSettingsOpen);
  const openComposer = useUi((s) => s.openComposer);
  const { data: model } = useMailboxes();
  const { data: counts } = useCategoryCounts();
  const { data: pageData } = useThreadPage(view, page);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [mobile, setMobile] = useState(() => window.innerWidth < 600);

  useShortcuts(!!threadId && !settingsTab);

  useEffect(() => {
    const f = () => {
      setNarrow(window.innerWidth < 1024);
      setMobile(window.innerWidth < 600);
    };
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);

  // ?compose=new opens a composer (used by `d` / Shift+C and external links);
  // ?compose=<draftId> reopens a saved draft (pop-out window).
  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    const c = p.get('compose');
    if (c === 'new' || p.get('to')) {
      openComposer({ ...emptyDraft(identities[0]?.id), to: p.get('to') ? [{ name: '', email: p.get('to')! }] : [] }, { window: 'normal' });
    } else if (c) {
      void client
        .emailGet({
          ids: [c],
          properties: FULL_PROPS,
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
          bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'disposition', 'cid'],
        })
        .then((r) => r.list[0] && openComposer(draftFromEmail(r.list[0], identities), { window: 'maximized' }))
        .catch(() => undefined);
    }
    if (c || p.get('to')) {
      p.delete('compose');
      p.delete('to');
      nav({ pathname: loc.pathname, search: p.toString() }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search]);

  // Tab title: "Inbox (12) - you@domain - 5050 Mail" (Gmail's pattern).
  useEffect(() => {
    const inbox = model?.byRole.get('inbox');
    const categoriesOn = inboxType === 'default' && categories.length > 1;
    const unread = categoriesOn && counts?.primary ? counts.primary.unread : (inbox?.unreadThreads ?? 0);
    const title = settingsTab ? 'Settings' : viewTitle(view);
    document.title = `${view.kind === 'folder' && view.key === 'inbox' && unread ? `Inbox (${unread})` : title} - ${me.email} - 5050 Mail`;
  }, [model, counts, view, me.email, settingsTab, categories, inboxType]);

  const collapsed = navCollapsedSetting || narrow;
  const split = readingPane !== 'none' && !mobile && !settingsTab;

  let content;
  if (settingsTab) content = <SettingsPage tab={settingsTab} />;
  else if (!split) {
    content = threadId ? (
      <ThreadView key={threadId} view={view} page={page} threadId={threadId} siblings={pageData?.items ?? []} total={pageData?.total} />
    ) : (
      <ThreadList view={view} page={page} compactRows={mobile} />
    );
  } else {
    content = (
      <SplitPane
        dir={readingPane === 'right' ? 'row' : 'column'}
        ratio={splitRatio}
        onRatio={(r) => setSettings({ splitRatio: r })}
        first={<ThreadList view={view} page={page} openThreadId={threadId} compactRows={readingPane === 'right'} />}
        second={
          threadId ? (
            <ThreadView key={threadId} view={view} page={page} threadId={threadId} siblings={pageData?.items ?? []} total={pageData?.total} split />
          ) : (
            <div className="pane-empty">
              <Icon name="mail" size={48} />
              <div>No conversations selected</div>
            </div>
          )
        }
      />
    );
  }

  return (
    <div className={`app${collapsed ? ' app--nav-collapsed' : ''}${quickOpen ? ' app--qs' : ''}`}>
      <TopBar searchQuery={view.kind === 'search' ? view.key : null} />
      <div className="app__body">
        <Nav view={view} collapsed={collapsed} />
        <main className="main-card" tabIndex={-1} aria-label={settingsTab ? 'Settings' : viewTitle(view)}>
          {content}
        </main>
        {quickOpen ? <QuickSettings /> : <SidePanel />}
      </div>
      <ComposeDock />
      {mobile && !threadId ? (
        <button type="button" className="fab" aria-label="Compose" onClick={() => openComposer(emptyDraft(identities[0]?.id))}>
          <Icon name="edit" size={24} />
          <span>Compose</span>
        </button>
      ) : null}
      <Snackbar />
      <Dialogs />
      <GoToLabel />
    </div>
  );
}

function SplitPane({
  dir,
  ratio,
  onRatio,
  first,
  second,
}: {
  dir: 'row' | 'column';
  ratio: number;
  onRatio: (r: number) => void;
  first: React.ReactNode;
  second: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [r, setR] = useState(ratio);
  useEffect(() => setR(ratio), [ratio]);
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let last = r;
    const move = (ev: PointerEvent) => {
      const v = dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      const min = dir === 'row' ? 380 / rect.width : 120 / rect.height;
      last = Math.min(1 - min, Math.max(min, v));
      setR(last);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      onRatio(last);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`split split--${dir}`}>
      <div className="split__a" style={{ flexBasis: `${r * 100}%` }}>
        {first}
      </div>
      <div className="split__divider" role="separator" aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'} onPointerDown={drag} />
      <div className="split__b">{second}</div>
    </div>
  );
}
