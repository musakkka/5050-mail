import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/Button';
import { useMail, useMailboxes } from '../../state/mail';
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../../state/settings';
import { useUi } from '../../state/ui';
import type { Category } from '../../mail/mapping';
import type { VacationResponse } from '../../jmap/types';
import { sanitizeForCompose } from '../../mail/sanitize';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'labels', label: 'Labels' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'advanced', label: 'Advanced' },
];

function Row({ label, children, help }: { label: ReactNode; children: ReactNode; help?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__label">
        {label}
        {help ? <div className="set-row__help">{help}</div> : null}
      </div>
      <div className="set-row__ctl">{children}</div>
    </div>
  );
}

export function SettingsPage({ tab }: { tab: string }) {
  const nav = useNavigate();
  const settings = useSettings();
  const showSnack = useUi((s) => s.showSnack);
  const { client, identities, refreshIdentities } = useMail();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Settings>(settings);
  const identity = identities[0];
  const [signature, setSignature] = useState(identity?.htmlSignature ?? '');
  const { data: vacation } = useQuery({ queryKey: ['vacation'], queryFn: async () => (await client.vacationGet()).list[0] ?? null });
  const [vac, setVac] = useState<VacationResponse | null>(null);
  useEffect(() => setVac(vacation ?? null), [vacation]);
  const set = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));
  const keys = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  const dirty =
    keys.some((k) => JSON.stringify(draft[k]) !== JSON.stringify(settings[k])) ||
    signature !== (identity?.htmlSignature ?? '') ||
    JSON.stringify(vac) !== JSON.stringify(vacation ?? null);

  const save = async () => {
    settings.set(pick(draft, keys));
    try {
      if (identity && signature !== (identity.htmlSignature ?? '')) {
        const html = sanitizeForCompose(signature);
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        await client.call('Identity/set', { update: { [identity.id]: { htmlSignature: html, textSignature: tmp.innerText } } });
        await refreshIdentities();
      }
      if (vac && JSON.stringify(vac) !== JSON.stringify(vacation)) {
        const { id: _id, ...patch } = vac;
        await client.vacationSet(patch);
        qc.invalidateQueries({ queryKey: ['vacation'] });
      }
      showSnack({ text: 'Your preferences have been saved.' });
    } catch (e) {
      showSnack({ text: `Couldn't save: ${(e as Error).message}` });
    }
  };

  return (
    <div className="settings">
      <h1 className="settings__title">Settings</h1>
      <div className="settings__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`settings__tab${tab === t.key ? ' settings__tab--on' : ''}`}
            onClick={() => nav(`/mail/settings/${t.key}`)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings__body">
        {tab === 'general' ? (
          <>
            <Row label="Maximum page size:">
              Show{' '}
              <select value={draft.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) as Settings['pageSize'] })}>
                {[10, 15, 20, 25, 50, 100].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>{' '}
              conversations per page
            </Row>
            <Row label="Undo Send:">
              Send cancellation period:{' '}
              <select value={draft.undoSendSeconds} onChange={(e) => set({ undoSendSeconds: Number(e.target.value) as Settings['undoSendSeconds'] })}>
                {[5, 10, 20, 30].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>{' '}
              seconds
            </Row>
            <Row label="Default reply behaviour:">
              <label className="radio-line">
                <input type="radio" checked={draft.defaultReply === 'reply'} onChange={() => set({ defaultReply: 'reply' })} /> Reply
              </label>
              <label className="radio-line">
                <input type="radio" checked={draft.defaultReply === 'replyAll'} onChange={() => set({ defaultReply: 'replyAll' })} /> Reply all
              </label>
            </Row>
            <Row label="Hover actions:">
              <label className="radio-line">
                <input type="radio" checked={draft.hoverActions} onChange={() => set({ hoverActions: true })} /> Enable hover actions
              </label>
              <label className="radio-line">
                <input type="radio" checked={!draft.hoverActions} onChange={() => set({ hoverActions: false })} /> Disable hover actions
              </label>
            </Row>
            <Row label="Images:">
              <label className="radio-line">
                <input type="radio" checked={draft.externalImages === 'always'} onChange={() => set({ externalImages: 'always' })} /> Always display external
                images
              </label>
              <label className="radio-line">
                <input type="radio" checked={draft.externalImages === 'ask'} onChange={() => set({ externalImages: 'ask' })} /> Ask before displaying external
                images
              </label>
            </Row>
            <Row label="Conversation View:">
              <label className="radio-line">
                <input type="radio" checked={draft.conversationView} onChange={() => set({ conversationView: true })} /> Conversation view on
              </label>
              <label className="radio-line">
                <input type="radio" checked={!draft.conversationView} onChange={() => set({ conversationView: false })} /> Conversation view off
              </label>
            </Row>
            <Row label="Desktop notifications:" help="Allows 5050 Mail to display popup notifications on your desktop when new email messages arrive.">
              <label className="radio-line">
                <input
                  type="radio"
                  checked={draft.desktopNotifications}
                  onChange={async () => {
                    if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
                    set({ desktopNotifications: true });
                  }}
                />{' '}
                New mail notifications on
              </label>
              <label className="radio-line">
                <input type="radio" checked={!draft.desktopNotifications} onChange={() => set({ desktopNotifications: false })} /> Mail notifications off
              </label>
            </Row>
            <Row label="Keyboard shortcuts:">
              <label className="radio-line">
                <input type="radio" checked={!draft.keyboardShortcuts} onChange={() => set({ keyboardShortcuts: false })} /> Keyboard shortcuts off
              </label>
              <label className="radio-line">
                <input type="radio" checked={draft.keyboardShortcuts} onChange={() => set({ keyboardShortcuts: true })} /> Keyboard shortcuts on
              </label>
            </Row>
            <Row label="Snippets:">
              <label className="radio-line">
                <input type="radio" checked={draft.snippets} onChange={() => set({ snippets: true })} /> Show snippets
              </label>
              <label className="radio-line">
                <input type="radio" checked={!draft.snippets} onChange={() => set({ snippets: false })} /> No snippets
              </label>
            </Row>
            <div id="signature">
              <Row label="Signature:" help="(appended at the end of all outgoing messages)">
                {identity ? (
                  <>
                    <div className="set-sig__who">
                      {identity.name} &lt;{identity.email}&gt;
                    </div>
                    <textarea
                      className="set-sig"
                      value={signature}
                      rows={5}
                      placeholder="Your signature (HTML allowed)"
                      onChange={(e) => setSignature(e.target.value)}
                    />
                  </>
                ) : (
                  'No identity'
                )}
              </Row>
            </div>
            <Row label="Vacation responder:" help="(sends an automated reply to incoming messages)">
              {vac ? (
                <div className="set-vac">
                  <label className="radio-line">
                    <input type="radio" checked={!vac.isEnabled} onChange={() => setVac({ ...vac, isEnabled: false })} /> Vacation responder off
                  </label>
                  <label className="radio-line">
                    <input type="radio" checked={vac.isEnabled} onChange={() => setVac({ ...vac, isEnabled: true })} /> Vacation responder on
                  </label>
                  <div className="set-vac__grid">
                    <span>First day:</span>
                    <input
                      type="date"
                      value={vac.fromDate?.slice(0, 10) ?? ''}
                      onChange={(e) => setVac({ ...vac, fromDate: e.target.value ? `${e.target.value}T00:00:00Z` : null })}
                    />
                    <span>Last day:</span>
                    <input
                      type="date"
                      value={vac.toDate?.slice(0, 10) ?? ''}
                      onChange={(e) => setVac({ ...vac, toDate: e.target.value ? `${e.target.value}T23:59:59Z` : null })}
                    />
                    <span>Subject:</span>
                    <input value={vac.subject ?? ''} onChange={(e) => setVac({ ...vac, subject: e.target.value })} />
                    <span>Message:</span>
                    <textarea rows={5} value={vac.textBody ?? ''} onChange={(e) => setVac({ ...vac, textBody: e.target.value, htmlBody: null })} />
                  </div>
                </div>
              ) : (
                'Loading…'
              )}
            </Row>
          </>
        ) : null}
        {tab === 'inbox' ? (
          <>
            <Row label="Inbox type:">
              <select value={draft.inboxType} onChange={(e) => set({ inboxType: e.target.value as Settings['inboxType'] })}>
                <option value="default">Default</option>
                <option value="important">Important first</option>
                <option value="unread">Unread first</option>
                <option value="starred">Starred first</option>
              </select>
            </Row>
            <Row label="Categories:" help="Choose which message categories to show as inbox tabs. Other messages will appear in the Primary tab.">
              {(['primary', 'social', 'promotions', 'updates', 'forums'] as Category[]).map((c) => (
                <label key={c} className="radio-line">
                  <input
                    type="checkbox"
                    disabled={c === 'primary'}
                    checked={draft.categories.includes(c)}
                    onChange={(e) => set({ categories: e.target.checked ? [...draft.categories, c] : draft.categories.filter((x) => x !== c) })}
                  />{' '}
                  {c[0]!.toUpperCase() + c.slice(1)}
                </label>
              ))}
            </Row>
            <Row label="Reading pane:">
              {(['none', 'right', 'below'] as const).map((p) => (
                <label key={p} className="radio-line">
                  <input type="radio" checked={draft.readingPane === p} onChange={() => set({ readingPane: p })} />{' '}
                  {p === 'none' ? 'No split' : p === 'right' ? 'Right of inbox' : 'Below inbox'}
                </label>
              ))}
              <div className="set-inline">
                Mark item as read:{' '}
                <select value={draft.markReadDelay} onChange={(e) => set({ markReadDelay: Number(e.target.value) })}>
                  <option value={0}>Immediately</option>
                  <option value={1}>After 1 second</option>
                  <option value={3}>After 3 seconds</option>
                  <option value={20}>After 20 seconds</option>
                  <option value={-1}>Never</option>
                </select>
              </div>
            </Row>
            <Row label="Importance markers:">
              <label className="radio-line">
                <input type="radio" checked={draft.importanceMarkers} onChange={() => set({ importanceMarkers: true })} /> Show markers
              </label>
              <label className="radio-line">
                <input type="radio" checked={!draft.importanceMarkers} onChange={() => set({ importanceMarkers: false })} /> No markers
              </label>
            </Row>
          </>
        ) : null}
        {tab === 'labels' ? <LabelsTab /> : null}
        {tab === 'advanced' ? (
          <Row label="Server-side features:">
            <p className="set-note">
              Snooze wake-ups, moving delivered scheduled mail to Sent, and muting new replies run in this browser while 5050 Mail is open. A server-side worker
              will take these over in a future release.
            </p>
          </Row>
        ) : null}
      </div>
      {tab !== 'labels' ? (
        <div className="settings__footer">
          <Button variant="filled" disabled={!dirty} onClick={() => void save()}>
            Save Changes
          </Button>
          <Button
            variant="outlined"
            onClick={() => {
              setDraft(useSettings.getState());
              setSignature(identity?.htmlSignature ?? '');
              setVac(vacation ?? null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function pick<T extends object>(o: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

function LabelsTab() {
  const { data: model } = useMailboxes();
  const visibility = useSettings((s) => s.labelVisibility);
  const setSettings = useSettings((s) => s.set);
  const openDialog = useUi((s) => s.openDialog);
  const nav = useNavigate();
  return (
    <div className="set-labels">
      <table className="set-labels__table">
        <thead>
          <tr>
            <th>System labels</th>
            <th>Messages</th>
            <th>Unread</th>
          </tr>
        </thead>
        <tbody>
          {['inbox', 'sent', 'drafts', 'scheduled', 'snoozed', 'archive', 'junk', 'trash'].map((r) => {
            const m = model?.byRole.get(r);
            if (!m) return null;
            return (
              <tr key={r}>
                <td>
                  {
                    {
                      inbox: 'Inbox',
                      sent: 'Sent',
                      drafts: 'Drafts',
                      scheduled: 'Scheduled',
                      snoozed: 'Snoozed',
                      archive: 'Archive',
                      junk: 'Spam',
                      trash: 'Trash',
                    }[r]
                  }
                </td>
                <td>{m.totalEmails}</td>
                <td>{m.unreadEmails}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="set-labels__head">
        <h2>Labels</h2>
        <Button variant="outlined" icon="add" onClick={() => openDialog({ kind: 'createLabel' })}>
          Create new label
        </Button>
      </div>
      <table className="set-labels__table">
        <tbody>
          {model?.labels.map((l) => (
            <tr key={l.mailbox.id}>
              <td style={{ paddingLeft: 8 + l.depth * 20 }}>
                <button type="button" className="link-btn" onClick={() => nav(`/mail/label/${encodeURIComponent(l.path)}`)}>
                  {l.mailbox.name}
                </button>
              </td>
              <td>{l.mailbox.totalThreads} conversations</td>
              <td className="set-labels__vis">
                {(['show', 'unread', 'hide'] as const).map((v) => {
                  const cur = visibility[l.mailbox.id] ?? 'show';
                  const text = v === 'show' ? 'show' : v === 'unread' ? 'show if unread' : 'hide';
                  return cur === v ? (
                    <b key={v}>{text}</b>
                  ) : (
                    <button key={v} type="button" className="link-btn" onClick={() => setSettings({ labelVisibility: { ...visibility, [l.mailbox.id]: v } })}>
                      {text}
                    </button>
                  );
                })}
              </td>
              <td>
                <button type="button" className="link-btn" onClick={() => openDialog({ kind: 'editLabel', mailboxId: l.mailbox.id })}>
                  edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
