import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Ellipsis, Monitor, Plus, Smartphone, Trash, TriangleAlert } from 'lucide-react';
import { templates as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { Template, TemplateVariable, TemplateVariableType } from '@/api/types';
import { useTitle } from '@/components/layout/Page';
import { Button, IconButton, iconButtonClass, Kbd } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { isValidKey, renderPreview, undeclared } from './vars';

interface Draft {
  name: string;
  alias: string;
  from: string;
  subject: string;
  reply_to: string;
  html: string;
  text: string;
  variables: TemplateVariable[];
}

function toDraft(t: Template): Draft {
  return {
    name: t.name,
    alias: t.alias ?? '',
    from: t.from ?? '',
    subject: t.subject ?? '',
    reply_to: Array.isArray(t.reply_to) ? t.reply_to.join(', ') : (t.reply_to ?? ''),
    html: t.html ?? '',
    text: t.text ?? '',
    variables: (t.variables ?? []).map((v) => ({ key: v.key, type: v.type, fallback_value: v.fallback_value ?? null })),
  };
}

function fallbackInput(v: TemplateVariable): string {
  if (v.fallback_value === null || v.fallback_value === undefined) return '';
  return typeof v.fallback_value === 'string' ? v.fallback_value : JSON.stringify(v.fallback_value);
}

function parseFallback(type: TemplateVariableType, raw: string): { value: unknown; error?: string } {
  if (raw === '') return { value: null };
  if (type === 'string') return { value: raw };
  if (type === 'number') return Number.isFinite(Number(raw)) ? { value: Number(raw) } : { value: raw, error: 'Must be a number' };
  if (type === 'boolean') return raw === 'true' || raw === 'false' ? { value: raw === 'true' } : { value: raw, error: 'true or false' };
  try {
    const v = JSON.parse(raw);
    if (type === 'list' && !Array.isArray(v)) return { value: raw, error: 'Must be a JSON array' };
    if (type === 'object' && (typeof v !== 'object' || Array.isArray(v) || v === null)) return { value: raw, error: 'Must be a JSON object' };
    return { value: v };
  } catch {
    return { value: raw, error: 'Invalid JSON' };
  }
}

const TYPES: { value: TemplateVariableType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'object', label: 'Object' },
  { value: 'list', label: 'List' },
];

function VariablesPanel({ draft, setDraft, missing }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void; missing: string[] }) {
  const [raw, setRaw] = useState<Record<number, string>>({});
  const update = (i: number, patch: Partial<TemplateVariable>) => setDraft((d) => ({ ...d, variables: d.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  const keys = draft.variables.map((v) => v.key);
  return (
    <div className="flex flex-col gap-3">
      {missing.length ? (
        <div role="status" className="flex flex-col gap-2 rounded-2xl border border-warning-subtle bg-warning px-3 py-2.5 text-sm text-warning">
          <span className="flex items-center gap-2">
            <TriangleAlert size={16} className="shrink-0" />
            Used but not declared: <span className="min-w-0 break-all font-mono text-xs">{missing.join(', ')}</span>
          </span>
          <Button
            size="1"
            className="w-fit"
            onClick={() => setDraft((d) => ({ ...d, variables: [...d.variables, ...missing.map((k) => ({ key: k, type: 'string' as const, fallback_value: null }))] }))}
          >
            Declare {missing.length === 1 ? 'it' : `all ${missing.length}`}
          </Button>
        </div>
      ) : null}
      {draft.variables.length === 0 ? (
        <p className="text-sm text-default">
          No variables. Use <code className="rounded bg-interactive px-1 font-mono text-xs text-emphasis">{'{{{NAME}}}'}</code> in the subject or HTML and declare it here with a fallback.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {draft.variables.map((v, i) => {
            const dup = keys.indexOf(v.key) !== i;
            const keyErr = !v.key ? 'Required' : dup ? 'Duplicate key' : !isValidKey(v.key) ? 'Letters, numbers, _ (not reserved)' : undefined;
            const fb = raw[i] ?? fallbackInput(v);
            const fbErr = parseFallback(v.type, fb).error;
            return (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)_32px] items-start gap-2">
                <div>
                  <Input aria-label="Variable key" placeholder="KEY" value={v.key} invalid={!!keyErr && v.key !== ''} className="font-mono" onChange={(e) => update(i, { key: e.target.value.trim() })} />
                  {keyErr && v.key !== '' ? <p className="mt-1 text-xs text-error">{keyErr}</p> : null}
                </div>
                <Select
                  value={v.type}
                  ariaLabel="Variable type"
                  options={TYPES}
                  onChange={(type) => {
                    const p = parseFallback(type, fb);
                    update(i, { type, fallback_value: p.error ? null : p.value });
                    setRaw((r) => ({ ...r, [i]: p.error ? '' : fb }));
                  }}
                />
                <div>
                  <Input
                    aria-label="Fallback value"
                    placeholder="Fallback (optional)"
                    value={fb}
                    invalid={!!fbErr}
                    onChange={(e) => {
                      setRaw((r) => ({ ...r, [i]: e.target.value }));
                      const p = parseFallback(v.type, e.target.value);
                      if (!p.error) update(i, { fallback_value: p.value });
                    }}
                  />
                  {fbErr ? <p className="mt-1 text-xs text-error">{fbErr}</p> : null}
                </div>
                <IconButton label={`Remove ${v.key || 'variable'}`} variant="ghost" onClick={() => setDraft((d) => ({ ...d, variables: d.variables.filter((_, j) => j !== i) }))}>
                  <Trash size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        className="w-fit"
        icon={<Plus size={16} />}
        disabled={draft.variables.length >= 50}
        onClick={() => setDraft((d) => ({ ...d, variables: [...d.variables, { key: '', type: 'string', fallback_value: null }] }))}
      >
        Add variable
      </Button>
    </div>
  );
}

function FieldRow({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[96px_minmax(0,1fr)]">
      <label htmlFor={htmlFor} className="text-sm text-default">
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
    </div>
  );
}

export function TemplateEditorPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useTeamQuery(['templates', id], (t) => api.get(t, id));
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [tab, setTab] = useState<'html' | 'text' | 'variables'>('html');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  useTitle(draft?.name ? `${draft.name} · Templates` : 'Templates');

  useEffect(() => {
    if (q.data && (loadedFor.current !== q.data.id || !draft)) {
      setDraftState(toDraft(q.data));
      loadedFor.current = q.data.id;
    }
  }, [q.data, draft]);
  const setDraft = (f: (d: Draft) => Draft) => setDraftState((d) => (d ? f(d) : d));

  const base = useMemo(() => (q.data ? JSON.stringify(toDraft(q.data)) : ''), [q.data]);
  const dirty = !!draft && JSON.stringify(draft) !== base;
  const missing = draft ? undeclared(draft.variables, draft.html, draft.subject) : [];
  const invalidVars = !!draft && draft.variables.some((v, i) => !isValidKey(v.key) || draft.variables.findIndex((x) => x.key === v.key) !== i);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const payload = (d: Draft): Partial<Template> => ({
    name: d.name.trim() || 'Untitled template',
    alias: d.alias.trim() || null,
    from: d.from.trim() || null,
    subject: d.subject || null,
    reply_to: d.reply_to.trim() ? d.reply_to.split(',').map((s) => s.trim()).filter(Boolean) : null,
    html: d.html,
    text: d.text === '' ? null : d.text,
    variables: d.variables,
  });

  const save = useTeamMutation((t, d: Draft) => api.update(t, id, payload(d)), [['templates']], { silent: true });
  const publish = useTeamMutation((t) => api.publish(t, id), [['templates']], { silent: true });
  const duplicate = useTeamMutation((t) => api.duplicate(t, id), [['templates']], { onSuccess: (r) => nav(`/templates/${r.id}`) });
  const remove = useTeamMutation((t) => api.remove(t, id), [['templates']], {
    onSuccess: () => {
      toast.success('Template deleted');
      nav('/templates');
    },
  });

  const doSave = async (thenPublish = false) => {
    if (!draft) return;
    if (invalidVars) {
      setTab('variables');
      setError('Fix the variable keys before saving.');
      return;
    }
    setError(null);
    try {
      if (dirty) await save.mutateAsync(draft);
      if (thenPublish) {
        await publish.mutateAsync(undefined as never);
        toast.success('Template published');
      } else if (dirty) toast.success('Template saved');
      await q.refetch();
      setDraftState(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the template.');
    }
  };

  const saveRef = useRef(doSave);
  saveRef.current = doSave;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const busy = save.isPending || publish.isPending;
  const t = q.data;
  const previewHtml = draft ? renderPreview(draft.html, draft.variables, true) : '';
  const previewSubject = draft ? renderPreview(draft.subject, draft.variables, false) : '';

  if (q.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-default bg-background px-6 py-3">
        <div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-2">
          <Tooltip content="Back to templates">
            <Link to="/templates" aria-label="Back to templates" className={iconButtonClass('ghost', '2')}>
              <ChevronLeft size={18} />
            </Link>
          </Tooltip>
          <h1 className="sr-only">{draft?.name || 'Template'}</h1>
          {draft ? (
            <input
              aria-label="Template name"
              value={draft.name}
              maxLength={100}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className="min-w-[6ch] max-w-[420px] shrink [field-sizing:content] truncate rounded-lg bg-transparent px-1.5 py-1 text-base font-semibold text-emphasis outline-hidden hover:bg-interactive focus-visible:bg-interactive focus-visible:ring-2 focus-visible:ring-focus"
            />
          ) : (
            <Skeleton className="h-6 w-48" />
          )}
          {t ? (
            t.status === 'published' ? (
              <Badge tone="success" className="shrink-0">published</Badge>
            ) : (
              <Badge tone="neutral" className="shrink-0">draft</Badge>
            )
          ) : null}
          {t?.has_unpublished_versions || (t?.status === 'published' && dirty) ? (
            <Tooltip content="Sending keeps using the published version until you publish again.">
              <span className="hidden items-center gap-1.5 text-xs text-warning sm:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--amber-a11)]" />
                Unpublished changes
              </span>
            </Tooltip>
          ) : null}
          {dirty ? <span className="hidden text-xs text-muted md:inline">Unsaved</span> : t ? <span className="hidden text-xs text-muted md:inline">Saved {timeAgoShort(t.updated_at)}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Menu
            align="end"
            className="w-44"
            trigger={
              <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')}>
                <Ellipsis size={12} strokeWidth={3} />
              </button>
            }
          >
            <MenuItem onClick={() => duplicate.mutate(undefined as never)}>Duplicate</MenuItem>
            <MenuItem
              onClick={() => {
                void navigator.clipboard?.writeText(t?.alias ?? id).then(() => toast('Copied'));
              }}
            >
              Copy {t?.alias ? 'alias' : 'ID'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={() => setConfirmDelete(true)}>
              Delete
            </MenuItem>
          </Menu>
          <Button kbd={['⌘', 'S']} onClick={() => void doSave(false)} disabled={!dirty || busy} loading={save.isPending && !publish.isPending}>
            Save
          </Button>
          <Button variant="primary" onClick={() => void doSave(true)} disabled={busy || !draft || (!dirty && t?.status === 'published' && !t.has_unpublished_versions)} loading={publish.isPending}>
            Publish
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mx-6 mt-4 rounded-xl border border-error-subtle bg-error px-3 py-2 text-sm text-error">
          {error}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-2">
        <section aria-label="Template content" className="flex min-w-0 flex-col gap-4">
          {!draft ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
              <Skeleton className="h-80" />
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-3xl border border-gray-3 p-4">
                <FieldRow label="From" htmlFor="tpl-from">
                  <Input id="tpl-from" placeholder="Acme <hello@yourdomain.com>" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
                </FieldRow>
                <FieldRow label="Subject" htmlFor="tpl-subject">
                  <Input id="tpl-subject" placeholder="Subject" value={draft.subject} onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))} />
                </FieldRow>
                <FieldRow label="Reply-To" htmlFor="tpl-reply">
                  <Input id="tpl-reply" placeholder="support@yourdomain.com" value={draft.reply_to} onChange={(e) => setDraft((d) => ({ ...d, reply_to: e.target.value }))} />
                </FieldRow>
                <FieldRow label="Alias" htmlFor="tpl-alias" hint="Send with template: { id: 'alias' } instead of the ID.">
                  <Input id="tpl-alias" placeholder="welcome-email" className="font-mono" value={draft.alias} onChange={(e) => setDraft((d) => ({ ...d, alias: e.target.value.replace(/\s+/g, '-') }))} />
                </FieldRow>
              </div>
              <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-3xl border border-gray-3">
                <div className="px-4 pb-3 pt-4">
                  <Tabs
                    value={tab}
                    onChange={setTab}
                    tabs={[
                      { value: 'html', label: 'HTML' },
                      { value: 'text', label: 'Plain text' },
                      { value: 'variables', label: <span className="inline-flex items-center gap-1.5">Variables{missing.length ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--amber-a11)]" aria-label="needs attention" /> : <span className="text-muted">{draft.variables.length}</span>}</span> },
                    ]}
                  />
                </div>
                {tab === 'html' ? (
                  <textarea
                    aria-label="HTML"
                    spellCheck={false}
                    value={draft.html}
                    onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Tab' && !e.shiftKey) {
                        e.preventDefault();
                        const el = e.currentTarget;
                        const { selectionStart: s, selectionEnd: en } = el;
                        const v = el.value.slice(0, s) + '  ' + el.value.slice(en);
                        setDraft((d) => ({ ...d, html: v }));
                        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                      }
                    }}
                    className="min-h-[360px] w-full flex-1 resize-none bg-gray-a1/20 p-4 font-mono text-[13px] leading-5 text-emphasis outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                  />
                ) : tab === 'text' ? (
                  <div className="flex flex-1 flex-col gap-2 p-4 pt-0">
                    <p className="text-xs text-muted">Leave empty to generate the plain-text part from the HTML when sending.</p>
                    <Textarea aria-label="Plain text" value={draft.text} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} className="min-h-[320px] flex-1 font-mono text-[13px]" />
                  </div>
                ) : (
                  <div className="p-4 pt-0">
                    <VariablesPanel draft={draft} setDraft={setDraft} missing={missing} />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
        <section aria-label="Preview" className="flex min-w-0 flex-col overflow-hidden rounded-3xl border border-gray-3">
          <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
            <div className="min-w-0">
              <p className="text-xs uppercase text-default">Preview</p>
              <p className="truncate text-sm text-emphasis" title={previewSubject}>
                {previewSubject || <span className="text-muted">No subject</span>}
              </p>
            </div>
            <div aria-label="Preview size" role="radiogroup" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-xl bg-interactive p-0.5 dark:bg-elevated">
              {(
                [
                  ['desktop', 'Desktop', Monitor],
                  ['mobile', 'Mobile', Smartphone],
                ] as const
              ).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-label={label}
                  aria-checked={device === v}
                  onClick={() => setDevice(v)}
                  className="flex h-7 aspect-square items-center justify-center rounded-[0.62rem] text-default hover:bg-interactive-hover aria-checked:bg-interactive-hover aria-checked:text-emphasis focus-visible:ring-2 focus-visible:ring-focus outline-hidden"
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-h-[520px] flex-1 justify-center bg-gray-a1/20 p-4">
            {draft ? (
              <iframe
                title="Template preview"
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={previewHtml}
                className={cn('h-full min-h-[500px] rounded-xl border border-default bg-white transition-[width] duration-300', device === 'desktop' ? 'w-full' : 'w-[375px] max-w-full')}
              />
            ) : (
              <Skeleton className="h-full w-full" />
            )}
          </div>
          {t ? (
            <p className="border-t border-gray-3 px-4 py-2.5 text-xs text-muted">
              Created {fullDateTime(t.created_at)}
              {t.published_at ? ` · Published ${timeAgoShort(t.published_at)}` : ' · Not published yet'}
              <span className="ml-2 hidden md:inline">
                <Kbd>⌘</Kbd> <Kbd>S</Kbd> to save
              </span>
            </p>
          ) : null}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete template"
        description={<>This deletes the template and its published version. Emails and automations that use it will fail to send.</>}
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined as never)}
      />
    </div>
  );
}
