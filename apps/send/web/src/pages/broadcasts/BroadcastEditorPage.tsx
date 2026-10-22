import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Braces, CalendarClock, ChevronLeft, Ellipsis, Eye, Send, SquarePen } from 'lucide-react';
import { broadcasts as broadcastsApi, domains as domainsApi, properties as propertiesApi, segments as segmentsApi, topics as topicsApi } from '@/api/client';
import { ApiError, post } from '@/api/http';
import { useTeamQuery } from '@/api/hooks';
import type { Broadcast } from '@/api/types';
import { useTitle } from '@/components/layout/Page';
import { Badge } from '@/components/ui/Badge';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/EmptyState';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast, toastError } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatNumber, fullDateTime, timeAgoShort } from '@/lib/format';
import { useTeamId } from '@/state/session';
import { ConfirmDialog, useSegmentContacts } from '../audience/shared';
import { broadcastStatus } from './status';
import { SendBroadcastDialog } from './SendBroadcastDialog';

type Draft = Pick<Broadcast, 'name' | 'from' | 'subject' | 'reply_to' | 'preview_text' | 'segment_id' | 'topic_id'> & { html: string };

const EMPTY: Draft = { name: '', from: '', subject: '', reply_to: null, preview_text: '', segment_id: null, topic_id: null, html: '' };

const STARTER = `<p>Hi {{{contact.first_name|there}}},</p>
<p>Write your message here.</p>
<p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>`;

const SAMPLE: Record<string, string> = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/** Fill personalization tags with a sample contact for the preview. */
export function personalize(html: string, props: Record<string, string> = {}): string {
  return html.replace(/\{\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}\}\}/g, (_m, key: string, fb?: string) => {
    const k = key.replace(/^contact\./, '');
    if (k === 'RESEND_UNSUBSCRIBE_URL') return '#unsubscribe';
    const legacy: Record<string, string> = { FIRST_NAME: 'first_name', LAST_NAME: 'last_name', EMAIL: 'email' };
    const v = SAMPLE[legacy[k] ?? k] ?? props[k];
    return (v ?? fb ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  });
}

function fromBroadcast(b: Broadcast): Draft {
  return {
    name: b.name ?? '',
    from: b.from ?? '',
    subject: b.subject ?? '',
    reply_to: b.reply_to,
    preview_text: b.preview_text ?? '',
    segment_id: b.segment_id,
    topic_id: b.topic_id ?? null,
    html: b.html ?? '',
  };
}

function FieldRow({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-gray-3 px-4 py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <label htmlFor={htmlFor} className="w-24 shrink-0 text-sm text-default">
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
      {hint ? <div className="shrink-0 text-xs">{hint}</div> : null}
    </div>
  );
}

const BARE_INPUT =
  'h-8 w-full min-w-0 bg-transparent text-sm text-emphasis placeholder:text-placeholder outline-hidden rounded-lg px-2 -mx-2 focus-visible:bg-interactive disabled:cursor-not-allowed disabled:text-default';

export function BroadcastEditorPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const teamId = useTeamId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const bc = useTeamQuery(['broadcasts', 'one', id], (t) => broadcastsApi.get(t, id), { enabled: !isNew });
  const segs = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  const tops = useTeamQuery(['topics'], (t) => topicsApi.list(t));
  const doms = useTeamQuery(['domains'], (t) => domainsApi.list(t));
  const props = useTeamQuery(['properties'], (t) => propertiesApi.list(t));
  const [draft, setDraft] = useState<Draft>(isNew ? { ...EMPTY, html: STARTER } : EMPTY);
  const [loaded, setLoaded] = useState(isNew);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [sendOpen, setSendOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const creating = useRef(false);

  useTitle(draft.name || (isNew ? 'New broadcast' : 'Broadcast'));

  useEffect(() => {
    if (bc.data && !dirty) {
      setDraft(fromBroadcast(bc.data));
      setLoaded(true);
    }
  }, [bc.data, dirty]);

  const status = isNew ? 'draft' : (bc.data?.status ?? 'draft');
  const editable = status === 'draft' || (isNew && true);
  const st = broadcastStatus(status);

  const missing = [!draft.from?.trim() && 'sender', !draft.subject?.trim() && 'subject', !draft.segment_id && 'audience'].filter(Boolean) as string[];

  const payload = useCallback(
    (d: Draft) => ({
      name: d.name?.trim() || null,
      from: d.from?.trim() || null,
      subject: d.subject?.trim() || null,
      reply_to: d.reply_to?.length ? d.reply_to : null,
      preview_text: d.preview_text?.trim() || null,
      segment_id: d.segment_id,
      topic_id: d.topic_id,
      html: d.html,
    }),
    [],
  );

  const save = useCallback(
    async (d: Draft): Promise<string | null> => {
      setSaving('saving');
      setSaveError(null);
      try {
        if (isNew) {
          if (creating.current) return null;
          creating.current = true;
          const r = await broadcastsApi.create(teamId, payload(d) as Partial<Broadcast>);
          await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
          setDirty(false);
          setSaving('saved');
          nav(`/broadcasts/${r.id}`, { replace: true });
          return r.id;
        }
        await broadcastsApi.update(teamId, id, payload(d) as Partial<Broadcast>);
        await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
        setDirty(false);
        setSaving('saved');
        return id;
      } catch (e) {
        creating.current = false;
        setSaving('error');
        setSaveError(e instanceof Error ? e.message : 'Could not save');
        return null;
      }
    },
    [isNew, id, teamId, payload, qc, nav],
  );

  // Autosave drafts (a new broadcast is created once it has a sender, subject and audience).
  useEffect(() => {
    if (!dirty || !editable || !loaded) return;
    if (isNew && missing.length) return;
    const t = window.setTimeout(() => void save(draft), 900);
    return () => window.clearTimeout(t);
  }, [draft, dirty, editable, loaded, isNew, missing.length, save]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const change = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
    setSaving('idle');
  };

  const insert = (tag: string) => {
    const el = htmlRef.current;
    const text = draft.html;
    const s = el?.selectionStart ?? text.length;
    const e = el?.selectionEnd ?? text.length;
    change('html', text.slice(0, s) + tag + text.slice(e));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + tag.length, s + tag.length);
    });
  };

  const fromDomain = (draft.from ?? '').match(/@([^>\s]+)>?\s*$/)?.[1]?.toLowerCase();
  const domain = (doms.data?.data ?? []).find((d) => d.name === fromDomain);
  const fromWarning = fromDomain && doms.data ? (!domain ? 'Domain not added' : domain.status !== 'verified' ? 'Domain not verified' : null) : null;

  const members = useSegmentContacts(draft.segment_id);
  const segment = (segs.data?.data ?? []).find((s) => s.id === draft.segment_id);
  const recipients = members.data ? members.data.filter((c) => !c.unsubscribed).length : segment?.contacts_count;

  const propMap = useMemo(() => Object.fromEntries((props.data?.data ?? []).map((p) => [p.key, p.fallback_value === null ? '' : String(p.fallback_value)])), [props.data]);
  const previewDoc = useMemo(() => {
    const body = personalize(draft.html || '<p style="color:#888;font-family:sans-serif">Nothing to preview yet.</p>', propMap);
    const pre = draft.preview_text ? `<div style="display:none;max-height:0;overflow:hidden">${personalize(draft.preview_text, propMap)}</div>` : '';
    return /<html[\s>]/i.test(body) ? body : `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff}</style></head><body>${pre}${body}</body></html>`;
  }, [draft.html, draft.preview_text, propMap]);

  const openSend = async () => {
    if (missing.length) {
      toast.error(`Add a ${missing.join(', ')} before sending.`);
      return;
    }
    if (dirty || isNew) {
      const ok = await save(draft);
      if (!ok) return;
    }
    setSendOpen(true);
  };

  const cancelSchedule = async () => {
    setBusy(true);
    try {
      await post(`/teams/${teamId}/resend/broadcasts/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
      toast.success('Schedule canceled. The broadcast is a draft again.');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // ⌘S saves.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (editable && dirty && !(isNew && missing.length)) void save(draft);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [editable, dirty, isNew, missing.length, save, draft]);

  if (!isNew && bc.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <ErrorState error={bc.error instanceof ApiError && bc.error.status === 404 ? 'This broadcast does not exist or was deleted.' : bc.error} onRetry={() => void bc.refetch()} />
      </div>
    );
  }

  const saveLabel =
    saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : dirty ? (isNew && missing.length ? `Add ${missing.join(', ')} to save` : 'Unsaved changes') : isNew ? 'Not saved yet' : 'Saved';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-6 pt-2 pb-8 md:pt-6">
      {/* Top bar */}
      <div className="flex min-h-10 flex-wrap items-center gap-3">
        <Tooltip content="Back to broadcasts">
          <Link to="/broadcasts" aria-label="Back to broadcasts" className={iconButtonClass('secondary', '2')}>
            <ChevronLeft size={18} />
          </Link>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="sr-only">{draft.name || 'Untitled broadcast'}</h1>
          {loaded ? (
            <input
              aria-label="Broadcast name"
              value={draft.name ?? ''}
              onChange={(e) => change('name', e.target.value.slice(0, 70))}
              placeholder="Untitled broadcast"
              className="font-display effect-font-styling min-w-[10ch] max-w-full [field-sizing:content] truncate rounded-lg bg-transparent px-1 -mx-1 text-[22px] leading-[30px] tracking-[-0.03rem] text-emphasis font-medium placeholder:text-placeholder outline-hidden focus-visible:bg-interactive"
            />
          ) : (
            <Skeleton className="h-7 w-64" />
          )}
          <Badge tone={st.badge} className="shrink-0">
            {st.label.toLowerCase()}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {editable ? (
            <span className={cn('hidden text-xs sm:inline', saving === 'error' ? 'text-error' : 'text-muted')} role="status" aria-live="polite" title={saveError ?? undefined}>
              {saveLabel}
            </span>
          ) : null}
          {!isNew ? (
            <Menu
              align="end"
              className="w-48"
              trigger={
                <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                  <span className="inline-flex items-center justify-center opacity-100">
                    <Ellipsis size={12} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <MenuItem
                onClick={async () => {
                  try {
                    const r = await post<{ id: string }>(`/teams/${teamId}/resend/broadcasts/${id}/duplicate`);
                    await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
                    nav(`/broadcasts/${r.id}`);
                    toast.success('Broadcast duplicated');
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Duplicate
              </MenuItem>
              {status === 'draft' || status === 'scheduled' ? (
                <>
                  <MenuSeparator />
                  <MenuItem danger onClick={() => setConfirmDelete(true)}>
                    Delete
                  </MenuItem>
                </>
              ) : null}
            </Menu>
          ) : null}
          {status === 'scheduled' ? (
            <Button onClick={() => void cancelSchedule()} loading={busy}>
              Cancel schedule
            </Button>
          ) : null}
          {editable ? (
            <Button variant="primary" icon={<Send size={16} />} onClick={() => void openSend()} disabled={saving === 'saving'}>
              Send
            </Button>
          ) : null}
        </div>
      </div>

      {status === 'scheduled' && bc.data?.scheduled_at ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-info-subtle bg-info px-4 py-3 text-sm text-info">
          <CalendarClock size={16} className="shrink-0" />
          <span className="min-w-0">
            Scheduled for <span className="font-medium">{fullDateTime(bc.data.scheduled_at)}</span>. Cancel the schedule to edit it.
          </span>
        </div>
      ) : status === 'sent' && bc.data?.sent_at ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-success-subtle bg-success px-4 py-3 text-sm text-success">
          <Send size={16} className="shrink-0" />
          <span>
            Sent {timeAgoShort(bc.data.sent_at)} ({fullDateTime(bc.data.sent_at)}).
          </span>
        </div>
      ) : !editable ? (
        <div className="mt-4 rounded-2xl border border-default px-4 py-3 text-sm text-default">This broadcast is {st.label.toLowerCase()} and can no longer be edited.</div>
      ) : saving === 'error' && saveError ? (
        <div role="alert" className="mt-4 rounded-2xl border border-error-subtle bg-error px-4 py-3 text-sm text-error">
          {saveError}
        </div>
      ) : null}

      {/* Envelope */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-default">
        <FieldRow label="From" htmlFor="bc-from" hint={fromWarning ? <Link to="/domains" className="text-warning hover:underline">{fromWarning}</Link> : null}>
          <input id="bc-from" className={BARE_INPUT} disabled={!editable} placeholder="Acme <news@yourdomain.com>" value={draft.from ?? ''} onChange={(e) => change('from', e.target.value)} autoComplete="off" />
        </FieldRow>
        <FieldRow
          label="To"
          htmlFor="bc-segment"
          hint={draft.segment_id && recipients !== undefined ? <span className="text-muted">{formatNumber(recipients)} subscribed contact{recipients === 1 ? '' : 's'}</span> : null}
        >
          <Select
            id="bc-segment"
            value={draft.segment_id ?? ''}
            onChange={(v) => change('segment_id', v || null)}
            disabled={!editable}
            placeholder="Select a segment"
            options={(segs.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            className="-mx-2 border-transparent bg-transparent pl-2 hover:bg-interactive max-w-md"
          />
        </FieldRow>
        <FieldRow label="Topic" htmlFor="bc-topic">
          <Select
            id="bc-topic"
            value={draft.topic_id ?? 'none'}
            onChange={(v) => change('topic_id', v === 'none' ? null : v)}
            disabled={!editable}
            options={[{ value: 'none', label: 'No topic (all subscribed contacts)' }, ...(tops.data?.data ?? []).map((t) => ({ value: t.id, label: t.name }))]}
            className="-mx-2 border-transparent bg-transparent pl-2 hover:bg-interactive max-w-md"
          />
        </FieldRow>
        <FieldRow label="Reply-To" htmlFor="bc-reply">
          <input
            id="bc-reply"
            className={BARE_INPUT}
            disabled={!editable}
            placeholder="support@yourdomain.com"
            value={(draft.reply_to ?? []).join(', ')}
            onChange={(e) =>
              change(
                'reply_to',
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean).length
                  ? e.target.value.split(',').map((s) => s.trim())
                  : null,
              )
            }
          />
        </FieldRow>
        <FieldRow label="Subject" htmlFor="bc-subject">
          <input id="bc-subject" className={BARE_INPUT} disabled={!editable} placeholder="What's new this month" value={draft.subject ?? ''} onChange={(e) => change('subject', e.target.value)} />
        </FieldRow>
        <FieldRow label="Preview text" htmlFor="bc-preview">
          <input
            id="bc-preview"
            className={BARE_INPUT}
            disabled={!editable}
            placeholder="Shown next to the subject in the inbox"
            value={draft.preview_text ?? ''}
            onChange={(e) => change('preview_text', e.target.value)}
          />
        </FieldRow>
      </div>

      {/* Body */}
      <div className="mt-6 flex items-center justify-between gap-2">
        <div className="lg:hidden">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'edit', label: 'HTML' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
        </div>
        <span className="hidden text-sm font-semibold text-emphasis lg:inline">Content</span>
        <Menu
          align="end"
          className="w-72"
          trigger={
            <Button size="1" icon={<Braces size={14} />} disabled={!editable}>
              Insert variable
            </Button>
          }
        >
          <MenuLabel>Contact</MenuLabel>
          {[
            ['First name', '{{{contact.first_name|there}}}'],
            ['Last name', '{{{contact.last_name}}}'],
            ['Email', '{{{contact.email}}}'],
          ].map(([l, tag]) => (
            <MenuItem key={tag} onClick={() => insert(tag!)} right={<code className="truncate font-mono text-[11px] text-muted">{tag}</code>}>
              {l}
            </MenuItem>
          ))}
          {(props.data?.data ?? []).length ? <MenuLabel>Properties</MenuLabel> : null}
          {(props.data?.data ?? []).map((p) => (
            <MenuItem key={p.id} onClick={() => insert(`{{{contact.${p.key}}}}`)} right={<code className="truncate font-mono text-[11px] text-muted">{`{{{contact.${p.key}}}}`}</code>}>
              <span className="font-mono text-xs">{p.key}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => insert('<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>')}>Unsubscribe link</MenuItem>
        </Menu>
      </div>
      <div className="mt-3 grid min-h-[520px] grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-2xl border border-default', view === 'preview' && 'max-lg:hidden')}>
          <div className="flex h-9 items-center gap-2 border-b border-gray-3 px-3 text-xs text-default">
            <SquarePen size={14} /> HTML
          </div>
          {loaded ? (
            <textarea
              ref={htmlRef}
              aria-label="Email HTML"
              spellCheck={false}
              disabled={!editable}
              value={draft.html}
              onChange={(e) => change('html', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  insert('  ');
                }
              }}
              placeholder="<p>Hello {{{contact.first_name|there}}}</p>"
              className="min-h-[480px] w-full flex-1 resize-none bg-gray-a1/20 p-4 font-mono text-[13px] leading-5 text-emphasis outline-hidden placeholder:text-placeholder disabled:text-default"
            />
          ) : (
            <Skeleton className="m-4 h-64" />
          )}
        </div>
        <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-2xl border border-default', view === 'edit' && 'max-lg:hidden')}>
          <div className="flex h-9 items-center gap-2 border-b border-gray-3 px-3 text-xs text-default">
            <Eye size={14} /> Preview <span className="text-muted">· sample contact Ada Lovelace</span>
          </div>
          <div className="border-b border-gray-3 px-4 py-2 text-xs">
            <p className="truncate text-emphasis">{personalize(draft.subject || '(no subject)', propMap)}</p>
            <p className="truncate text-muted">{draft.from || 'No sender'}</p>
          </div>
          <iframe title="Broadcast preview" sandbox="" referrerPolicy="no-referrer" srcDoc={previewDoc} className="min-h-[440px] w-full flex-1 bg-white" />
        </div>
      </div>

      {!isNew ? (
        <SendBroadcastDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          broadcastId={id}
          segmentName={segment?.name}
          recipients={recipients}
          subject={draft.subject ?? ''}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete broadcast"
        description={status === 'scheduled' ? 'The scheduled send is canceled and the broadcast is deleted.' : 'This draft will be deleted.'}
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await broadcastsApi.remove(teamId, id);
            await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
            toast.success('Broadcast deleted');
            nav('/broadcasts');
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
