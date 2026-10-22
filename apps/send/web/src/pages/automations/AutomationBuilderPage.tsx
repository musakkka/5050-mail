import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronLeft, Clock, Ellipsis, GitBranch, Hourglass, Mail, Plus, Trash, UserMinus, UserPen, Users, Zap } from 'lucide-react';
import { automations as api, events as eventsApi, segments as segmentsApi, templates as templatesApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { Automation, AutomationConnection, AutomationStep, AutomationStepType } from '@/api/types';
import { useTitle } from '@/components/layout/Page';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { Menu, MenuItem, MenuSeparator, MenuLabel } from '@/components/ui/Menu';
import { AppIcon, type IconTone } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

type Step = AutomationStep;

const KINDS: Record<AutomationStepType, { label: string; icon: typeof Zap; tone: IconTone; hint: string }> = {
  trigger: { label: 'Trigger', icon: Zap, tone: 'violet', hint: 'Starts a run when this event is sent' },
  send_email: { label: 'Send email', icon: Mail, tone: 'green', hint: 'Send a published template to the contact' },
  delay: { label: 'Delay', icon: Clock, tone: 'gray', hint: 'Wait a fixed time (up to 30 days)' },
  wait_for_event: { label: 'Wait for event', icon: Hourglass, tone: 'amber', hint: 'Pause until the contact sends an event' },
  condition: { label: 'Condition', icon: GitBranch, tone: 'blue', hint: 'Continue only when a rule matches' },
  add_to_segment: { label: 'Add to segment', icon: Users, tone: 'blue', hint: 'Add the contact to a segment' },
  contact_update: { label: 'Update contact', icon: UserPen, tone: 'gray', hint: 'Change contact fields' },
  contact_delete: { label: 'Delete contact', icon: UserMinus, tone: 'red', hint: 'Remove the contact' },
};
const ADDABLE: AutomationStepType[] = ['send_email', 'delay', 'wait_for_event', 'condition', 'add_to_segment', 'contact_update', 'contact_delete'];

const OPERATORS = [
  ['eq', 'equals'],
  ['neq', 'does not equal'],
  ['contains', 'contains'],
  ['starts_with', 'starts with'],
  ['ends_with', 'ends with'],
  ['gt', 'greater than'],
  ['lt', 'less than'],
  ['exists', 'exists'],
  ['is_empty', 'is empty'],
] as const;

function defaults(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case 'trigger':
      return { event_name: '' };
    case 'delay':
      return { duration: '1 day' };
    case 'wait_for_event':
      return { event_name: '', timeout: '7 days' };
    case 'condition':
      return { type: 'rule', field: 'event.plan', operator: 'eq', value: 'pro' };
    case 'send_email':
      return { template: { id: '' } };
    case 'add_to_segment':
      return { segment_id: '' };
    case 'contact_update':
      return { unsubscribed: false };
    case 'contact_delete':
      return {};
  }
}

/** Walk the graph from the trigger along one path (the builder edits linear flows). */
function linearize(a: Automation): Step[] {
  const steps = a.steps ?? [];
  const conns = a.connections ?? [];
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const out: Step[] = [];
  let cur = steps.find((s) => s.type === 'trigger');
  const seen = new Set<string>();
  while (cur && !seen.has(cur.key)) {
    out.push(cur);
    seen.add(cur.key);
    const c = conns.find((x) => x.from === cur!.key && (!x.type || x.type === 'default' || x.type === 'condition_met' || x.type === 'event_received'));
    cur = c ? byKey.get(c.to) : undefined;
  }
  // Steps not on the main path are kept at the end so nothing is silently dropped.
  for (const s of steps) if (!seen.has(s.key)) out.push(s);
  return out;
}

function toGraph(steps: Step[]): { steps: Step[]; connections: AutomationConnection[] } {
  const keyed = steps.map((s, i) => ({ ...s, key: s.key || `step_${i + 1}` }));
  const connections: AutomationConnection[] = [];
  for (let i = 0; i < keyed.length - 1; i++) {
    const from = keyed[i]!;
    connections.push({ from: from.key, to: keyed[i + 1]!.key, type: from.type === 'condition' ? 'condition_met' : from.type === 'wait_for_event' ? 'event_received' : 'default' });
  }
  return { steps: keyed, connections };
}

function splitDuration(d: unknown): { n: string; unit: string } {
  const m = String(d ?? '').match(/^\s*(\d+)\s*(minute|hour|day|week)s?\s*$/i);
  return m ? { n: m[1]!, unit: m[2]!.toLowerCase() } : { n: '1', unit: 'day' };
}

function Duration({ value, onChange, label }: { value: unknown; onChange: (v: string) => void; label: string }) {
  const { n, unit } = splitDuration(value);
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <Input aria-label={`${label} amount`} type="number" min={1} className="no-spinner" value={n} onChange={(e) => onChange(`${Math.max(1, Number(e.target.value) || 1)} ${unit}${Number(e.target.value) === 1 ? '' : 's'}`)} />
      <Select
        ariaLabel={`${label} unit`}
        value={unit}
        onChange={(u) => onChange(`${n} ${u}${n === '1' ? '' : 's'}`)}
        options={[
          { value: 'minute', label: n === '1' ? 'Minute' : 'Minutes' },
          { value: 'hour', label: n === '1' ? 'Hour' : 'Hours' },
          { value: 'day', label: n === '1' ? 'Day' : 'Days' },
          { value: 'week', label: n === '1' ? 'Week' : 'Weeks' },
        ]}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-default">{label}</span>
      {children}
    </label>
  );
}

function EventPicker({ value, onChange, names, label }: { value: string; onChange: (v: string) => void; names: string[]; label: string }) {
  const opts = [...new Set([...names, ...(value ? [value] : [])])];
  if (!opts.length)
    return (
      <div className="flex flex-col gap-1">
        <Input aria-label={label} placeholder="user.signed_up" className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="text-xs text-muted">
          No events defined yet. <Link to="/automations/events" className="underline hover:text-emphasis">Add one</Link> or type a name.
        </span>
      </div>
    );
  return <Select ariaLabel={label} value={value} placeholder="Select an event" onChange={onChange} options={opts.map((n) => ({ value: n, label: <span className="font-mono">{n}</span>, text: n }))} />;
}

function StepFields({ step, set, data }: { step: Step; set: (cfg: Record<string, unknown>) => void; data: { events: string[]; templates: { id: string; name: string; published: boolean }[]; segments: { id: string; name: string }[] } }) {
  const c = step.config;
  const patch = (p: Record<string, unknown>) => set({ ...c, ...p });
  switch (step.type) {
    case 'trigger':
      return (
        <Row label="When this event is sent">
          <EventPicker label="Trigger event" value={String(c.event_name ?? '')} names={data.events} onChange={(v) => patch({ event_name: v })} />
        </Row>
      );
    case 'delay':
      return (
        <Row label="Wait for">
          <Duration label="Delay" value={c.duration} onChange={(v) => patch({ duration: v })} />
        </Row>
      );
    case 'wait_for_event':
      return (
        <div className="flex flex-col gap-3">
          <Row label="Event">
            <EventPicker label="Event to wait for" value={String(c.event_name ?? '')} names={data.events} onChange={(v) => patch({ event_name: v })} />
          </Row>
          <Row label="Give up after">
            <Duration label="Timeout" value={c.timeout ?? '7 days'} onChange={(v) => patch({ timeout: v })} />
          </Row>
        </div>
      );
    case 'condition':
      return (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-default">Continue when</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input aria-label="Field" className="font-mono" placeholder="event.plan" value={String(c.field ?? '')} onChange={(e) => patch({ type: 'rule', field: e.target.value })} />
            <Select ariaLabel="Operator" value={String(c.operator ?? 'eq')} onChange={(v) => patch({ type: 'rule', operator: v })} options={OPERATORS.map(([v, l]) => ({ value: v, label: l }))} />
            {c.operator === 'exists' || c.operator === 'is_empty' ? null : <Input aria-label="Value" placeholder="pro" value={String(c.value ?? '')} onChange={(e) => patch({ type: 'rule', value: e.target.value })} />}
          </div>
          <span className="text-xs text-muted">Fields: event.*, contact.*. When the rule does not match, the run ends.</span>
        </div>
      );
    case 'send_email': {
      const tpl = (c.template ?? {}) as { id?: string };
      const chosen = data.templates.find((t) => t.id === tpl.id);
      return (
        <div className="flex flex-col gap-3">
          <Row label="Template">
            {data.templates.length ? (
              <Select
                ariaLabel="Template"
                value={tpl.id ?? ''}
                placeholder="Select a template"
                onChange={(id) => patch({ template: { ...tpl, id } })}
                options={data.templates.map((t) => ({ value: t.id, label: t.published ? t.name : `${t.name} (draft)`, text: t.name }))}
              />
            ) : (
              <span className="text-sm text-default">
                No templates yet. <Link className="underline hover:text-emphasis" to="/templates">Create one</Link> first.
              </span>
            )}
          </Row>
          {chosen && !chosen.published ? <p className="text-xs text-warning">Publish this template before enabling the automation.</p> : null}
          <Row label="Subject (optional override)">
            <Input aria-label="Subject override" placeholder="Uses the template subject" value={String(c.subject ?? '')} onChange={(e) => patch({ subject: e.target.value || undefined })} />
          </Row>
        </div>
      );
    }
    case 'add_to_segment':
      return (
        <Row label="Segment">
          <Select ariaLabel="Segment" value={String(c.segment_id ?? '')} placeholder="Select a segment" onChange={(v) => patch({ segment_id: v })} options={data.segments.map((s) => ({ value: s.id, label: s.name }))} />
        </Row>
      );
    case 'contact_update':
      return (
        <label className="flex items-center justify-between gap-3 text-sm text-default">
          Mark as unsubscribed
          <Switch checked={!!c.unsubscribed} onChange={(v) => patch({ unsubscribed: v })} label="Mark as unsubscribed" />
        </label>
      );
    case 'contact_delete':
      return <p className="text-sm text-default">The contact is deleted when the run reaches this step.</p>;
  }
}

function AddStep({ onAdd, disabled }: { onAdd: (t: AutomationStepType) => void; disabled?: boolean }) {
  return (
    <div className="relative flex h-12 items-center justify-center">
      <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gray-4" />
      <Menu
        align="center"
        className="w-64"
        trigger={
          <button type="button" aria-label="Add step" disabled={disabled} className={iconButtonClass('secondary', '1', 'relative z-10 rounded-full bg-background disabled:opacity-50')}>
            <Plus size={14} />
          </button>
        }
      >
        <MenuLabel>Add step</MenuLabel>
        {ADDABLE.map((t) => {
          const K = KINDS[t];
          return (
            <MenuItem key={t} icon={<K.icon />} onClick={() => onAdd(t)}>
              {K.label}
            </MenuItem>
          );
        })}
      </Menu>
    </div>
  );
}

export function AutomationBuilderPage() {
  const { id = '' } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const q = useTeamQuery(['automations', id], (t) => api.get(t, id), { enabled: !isNew });
  const ev = useTeamQuery(['events'], (t) => eventsApi.list(t));
  const tp = useTeamQuery(['templates'], (t) => templatesApi.list(t));
  const sg = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  const [name, setName] = useState(isNew ? 'Untitled automation' : '');
  const [steps, setSteps] = useState<Step[] | null>(isNew ? [{ key: 'trigger', type: 'trigger', config: defaults('trigger') }] : null);
  const [baseline, setBaseline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loaded = useRef<string | null>(null);
  useTitle(name ? `${name} · Automations` : 'Automations');

  useEffect(() => {
    if (q.data && loaded.current !== q.data.updated_at + q.data.id) {
      loaded.current = q.data.updated_at + q.data.id;
      const s = linearize(q.data);
      setName(q.data.name);
      setSteps(s);
      setBaseline(JSON.stringify([q.data.name, s]));
    }
  }, [q.data]);

  const data = useMemo(
    () => ({
      events: (ev.data?.data ?? []).map((e) => e.name),
      templates: (tp.data?.data ?? []).map((t) => ({ id: t.id, name: t.name, published: t.status === 'published' || !!t.published_at })),
      segments: (sg.data?.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    }),
    [ev.data, tp.data, sg.data],
  );

  const enabled = q.data?.status === 'enabled';
  const dirty = isNew || (!!steps && JSON.stringify([name, steps]) !== baseline);
  const graphDirty = !!steps && !!q.data && JSON.stringify(steps) !== JSON.stringify(linearize(q.data));

  const validate = (): string | null => {
    if (!name.trim()) return 'Give the automation a name.';
    if (!steps?.length || steps[0]!.type !== 'trigger' || !String(steps[0]!.config.event_name ?? '').trim()) return 'Choose the event that triggers this automation.';
    for (const s of steps) {
      if (s.type === 'send_email' && !(s.config.template as { id?: string } | undefined)?.id) return 'Every “Send email” step needs a template.';
      if (s.type === 'add_to_segment' && !s.config.segment_id) return 'Choose a segment for “Add to segment”.';
      if (s.type === 'wait_for_event' && !String(s.config.event_name ?? '').trim()) return 'Choose the event to wait for.';
      if (s.type === 'condition' && !String(s.config.field ?? '').trim()) return 'Conditions need a field.';
    }
    return null;
  };

  const save = useTeamMutation(
    async (t, opts: { enable?: boolean }) => {
      const graph = toGraph(steps!);
      if (isNew) return api.create(t, { name: name.trim(), status: opts.enable ? 'enabled' : 'disabled', ...graph });
      if (graphDirty && enabled) await api.stop(t, id);
      await api.update(t, id, { name: name.trim(), ...(graphDirty ? graph : {}) });
      if (opts.enable !== undefined || (graphDirty && enabled)) {
        const want = opts.enable ?? enabled;
        if (want) await api.update(t, id, { status: 'enabled' });
      }
      return { id };
    },
    [['automations']],
    { silent: true },
  );
  const stop = useTeamMutation((t) => api.stop(t, id), [['automations']], { onSuccess: () => toast.success('Automation disabled') });
  const remove = useTeamMutation((t) => api.remove(t, id), [['automations']], {
    onSuccess: () => {
      toast.success('Automation deleted');
      nav('/automations');
    },
  });
  const duplicate = useTeamMutation((t) => api.duplicate(t, id), [['automations']], { onSuccess: (r) => nav(`/automations/${r.id}`) });

  const run = async (enable?: boolean) => {
    const v = validate();
    if (v) return setError(v);
    setError(null);
    try {
      const r = await save.mutateAsync({ enable });
      toast.success(enable ? 'Automation enabled' : 'Automation saved');
      if (isNew) nav(`/automations/${r.id}`, { replace: true });
      else await q.refetch();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the automation.');
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void runRef.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const insert = (at: number, type: AutomationStepType) =>
    setSteps((s) => {
      const used = new Set((s ?? []).map((x) => x.key));
      let n = (s?.length ?? 0) + 1;
      while (used.has(`step_${n}`)) n++;
      const next = [...(s ?? [])];
      next.splice(at, 0, { key: `step_${n}`, type, config: defaults(type) });
      return next;
    });
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const next = [...(s ?? [])];
      const j = i + d;
      if (j < 1 || j >= next.length) return next;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  if (q.error) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 pt-8">
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const busy = save.isPending || stop.isPending;
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-default bg-background px-6 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Tooltip content="Back to automations">
            <Link to="/automations" aria-label="Back to automations" className={iconButtonClass('ghost', '2')}>
              <ChevronLeft size={18} />
            </Link>
          </Tooltip>
          <h1 className="sr-only">{name || 'Automation'}</h1>
          {steps ? (
            <input
              aria-label="Automation name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              className="min-w-[6ch] max-w-[420px] shrink [field-sizing:content] truncate rounded-lg bg-transparent px-1.5 py-1 text-base font-semibold text-emphasis outline-hidden hover:bg-interactive focus-visible:bg-interactive focus-visible:ring-2 focus-visible:ring-focus"
            />
          ) : (
            <Skeleton className="h-6 w-48" />
          )}
          <Badge tone={enabled ? 'success' : 'neutral'} className="shrink-0">{isNew ? 'new' : (q.data?.status ?? '…')}</Badge>
          {dirty && !isNew ? <span className="hidden text-xs text-muted md:inline">Unsaved changes</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isNew ? (
            <>
              <label className="mr-1 flex items-center gap-2 text-sm text-default">
                <span className="hidden sm:inline">Enabled</span>
                <Switch
                  checked={enabled}
                  disabled={busy || !q.data}
                  label="Enabled"
                  onChange={(v) => {
                    if (v) void run(true);
                    else stop.mutate(undefined as never);
                  }}
                />
              </label>
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
                <MenuSeparator />
                <MenuItem danger onClick={() => setConfirmDelete(true)}>
                  Delete
                </MenuItem>
              </Menu>
            </>
          ) : null}
          <Button variant="primary" kbd={['⌘', 'S']} onClick={() => void run()} disabled={!dirty || busy || !steps} loading={save.isPending}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mx-6 mt-4 rounded-xl border border-error-subtle bg-error px-3 py-2 text-sm text-error">
          {error}
        </div>
      ) : null}
      {enabled && graphDirty ? (
        <p className="mx-6 mt-4 rounded-xl border border-warning-subtle bg-warning px-3 py-2 text-sm text-warning">
          This automation is enabled. Saving pauses it briefly to apply the new steps, then enables it again.
        </p>
      ) : null}
      <div className="flex-1 bg-[radial-gradient(var(--gray-4)_1px,transparent_1px)] [background-size:16px_16px] px-4 py-10">
        <ol className="mx-auto flex w-full max-w-md flex-col" aria-label="Steps">
          {!steps
            ? Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="mb-12">
                  <Skeleton className="h-32 rounded-3xl" />
                </li>
              ))
            : steps.map((s, i) => {
                const K = KINDS[s.type] ?? KINDS.delay;
                return (
                  <li key={s.key + i} className="flex flex-col">
                    <section aria-label={`${i + 1}. ${K.label}`} className="rounded-3xl border border-default bg-background p-4 shadow-lg">
                      <header className="mb-3 flex items-center gap-3">
                        <AppIcon size={32} tone={K.tone} glyphSize={16}>
                          <K.icon />
                        </AppIcon>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-emphasis">{K.label}</p>
                          <p className="truncate text-xs text-muted">{K.hint}</p>
                        </div>
                        {s.type !== 'trigger' ? (
                          <Menu
                            align="end"
                            className="w-40"
                            trigger={
                              <button type="button" aria-label={`Actions for step ${i + 1}`} className={iconButtonClass('ghost', '2')}>
                                <Ellipsis size={12} strokeWidth={3} />
                              </button>
                            }
                          >
                            <MenuItem icon={<ArrowUp />} disabled={i <= 1} onClick={() => move(i, -1)}>
                              Move up
                            </MenuItem>
                            <MenuItem icon={<ArrowDown />} disabled={i >= steps.length - 1} onClick={() => move(i, 1)}>
                              Move down
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem danger icon={<Trash />} onClick={() => setSteps((x) => (x ?? []).filter((_, j) => j !== i))}>
                              Remove step
                            </MenuItem>
                          </Menu>
                        ) : null}
                      </header>
                      <StepFields step={s} data={data} set={(config) => setSteps((x) => (x ?? []).map((y, j) => (j === i ? { ...y, config } : y)))} />
                    </section>
                    <AddStep onAdd={(t) => insert(i + 1, t)} disabled={steps.length >= 150} />
                  </li>
                );
              })}
          {steps ? (
            <li className={cn('mx-auto flex items-center gap-2 rounded-full border border-default bg-background px-3 py-1 text-xs text-default')}>
              <span className="h-1.5 w-1.5 rounded-full bg-gray-8" /> End of run
            </li>
          ) : null}
        </ol>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete automation"
        description="The automation is deleted and running runs are cancelled."
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined as never)}
      />
    </div>
  );
}
