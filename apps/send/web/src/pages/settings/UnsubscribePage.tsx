import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs as T } from '@base-ui/react/tabs';
import { Check, ListChecks, Pencil } from 'lucide-react';
import { teams, topics as topicsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { UnsubscribePageSettings } from '@/api/types';
import { BrandMark } from '@/components/brand/BrandMark';
import { Button, buttonClass } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { TAB_CLASS } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/toast';
import { useSession } from '@/state/session';
import { SettingsLayout } from './SettingsLayout';

const DEFAULTS: Required<Omit<UnsubscribePageSettings, 'logo_url'>> & { logo_url: string | null } = {
  title: 'Do you want to unsubscribe?',
  description: 'Confirm your email preferences:',
  logo_url: null,
  accent_color: '#363A3F',
  background_color: '#05050A',
  show_topics: true,
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const on = (hex: string) => (HEX.test(hex) && luminance(hex) > 0.45 ? '#111113' : '#EDEEF0');

function Preview({ s, view, topicNames }: { s: typeof DEFAULTS; view: 'preferences' | 'success'; topicNames: string[] }) {
  const bg = HEX.test(s.background_color) ? s.background_color : DEFAULTS.background_color;
  const accent = HEX.test(s.accent_color) ? s.accent_color : DEFAULTS.accent_color;
  const fg = on(bg);
  return (
    <div
      className="relative overflow-hidden rounded-2xl border-x border-t border-gray-3 dark:border-gray-a1 select-none"
      style={{ background: bg, color: fg, colorScheme: luminance(bg) > 0.45 ? 'light' : 'dark' }}
      role="img"
      aria-label={`Unsubscribe page preview (${view})`}
    >
      <div className="flex min-h-[368px] flex-col items-center justify-between">
        <div className="flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-10 py-8 text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-white">
            {s.logo_url ? <img src={s.logo_url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : <Check size={24} className="text-black/15" />}
          </div>
          {view === 'preferences' ? (
            <>
              <h3 className="my-2 text-3xl font-semibold break-words [text-wrap:balance]">{s.title || DEFAULTS.title}</h3>
              <p className="text-sm opacity-50 break-words">{s.description || DEFAULTS.description}</p>
              <div className="mx-auto mt-7 w-full max-w-sm">
                {s.show_topics && topicNames.length ? (
                  <ul className="mb-2 flex flex-col gap-2 text-left text-sm">
                    {topicNames.slice(0, 4).map((t) => (
                      <li key={t} className="flex items-center gap-2 truncate">
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: accent, color: on(accent) }}>
                          <Check size={11} strokeWidth={3} />
                        </span>
                        <span className="truncate">{t}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="my-2 inline-flex w-full items-center justify-center rounded-xl py-2 text-sm font-semibold" style={{ background: accent, color: on(accent) }}>
                  {s.show_topics && topicNames.length ? 'Save preferences' : 'Unsubscribe'}
                </div>
              </div>
            </>
          ) : (
            <>
              <h3 className="my-2 text-3xl font-semibold">You have been unsubscribed</h3>
              <p className="text-sm opacity-50">You will no longer receive these emails.</p>
            </>
          )}
        </div>
        <div className="mb-6 flex items-center gap-2 text-xs font-medium text-nowrap">
          <span className="opacity-50">Powered by</span>
          <BrandMark height={12} />
          <span className="opacity-50">5050 Send</span>
        </div>
      </div>
    </div>
  );
}

export function UnsubscribePage() {
  const { team: sessionTeam, canManage } = useSession();
  const qc = useQueryClient();
  // /me may omit settings; GET /teams/:id always includes them.
  const detail = useTeamQuery(['team-detail'], (t) => teams.get(t));
  const team = detail.data ?? sessionTeam;
  const saved = { ...DEFAULTS, ...(team.settings?.unsubscribe_page ?? {}) } as typeof DEFAULTS;
  const [draft, setDraft] = useState(saved);
  const [view, setView] = useState<'preferences' | 'success'>('preferences');
  const [editing, setEditing] = useState(false);
  const topics = useTeamQuery(['topics'], (t) => topicsApi.list(t));
  const topicNames = (topics.data?.data ?? []).filter((t) => t.visibility !== 'private').map((t) => t.name);
  // Re-sync when the team (or its saved settings) changes.
  const savedKey = JSON.stringify(saved);
  useEffect(() => setDraft(JSON.parse(savedKey)), [savedKey]);

  const save = useTeamMutation((t, s: UnsubscribePageSettings) => teams.update(t, { settings: { unsubscribe_page: s } }), [['team-detail']], {
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Unsubscribe page saved');
      setEditing(false);
    },
  });
  const invalid = !HEX.test(draft.accent_color) || !HEX.test(draft.background_color) || (!!draft.logo_url && !/^https:\/\/\S+$/.test(draft.logo_url));
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (invalid) return;
    save.mutate({ ...draft, logo_url: draft.logo_url || null, title: draft.title.trim(), description: draft.description.trim() });
  };
  const set = <K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const ghost = buttonClass('ghost', '2', 'pl-2.5');

  return (
    <SettingsLayout title="Unsubscribe Page">
      <section className="flex flex-col gap-2 rounded-3xl border border-gray-3 p-4">
        <T.Root value={view} onValueChange={(v) => setView(v as typeof view)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <T.List className="flex flex-nowrap items-center gap-2">
              <T.Tab value="preferences" className={TAB_CLASS}>
                Preferences
              </T.Tab>
              <T.Tab value="success" className={TAB_CLASS}>
                Success
              </T.Tab>
            </T.List>
            <div className="flex items-center gap-1">
              <button type="button" className={ghost} onClick={() => setEditing(true)} disabled={!canManage} data-disabled={!canManage ? '' : undefined} title={canManage ? undefined : 'Only team admins can edit'}>
                <span>
                  <Pencil size={16} />
                </span>
                <span className="inline-flex items-center justify-center gap-1 truncate min-w-0">Edit</span>
              </button>
              <Link to="/audience/topics" className={ghost}>
                <span>
                  <ListChecks size={16} />
                </span>
                <span className="inline-flex items-center justify-center gap-1 truncate min-w-0">Topics</span>
              </Link>
            </div>
          </div>
          <div className="mt-2">
            <Preview s={draft} view={view} topicNames={topicNames} />
          </div>
        </T.Root>
      </section>
      <Dialog
        open={editing}
        onOpenChange={(o) => {
          setEditing(o);
          if (!o) setDraft(saved);
        }}
        title="Customize unsubscribe page"
        description="Changes preview live behind this dialog. Recipients see this page when they click an unsubscribe link."
        onSubmit={submit}
        size="md"
      >
        <form onSubmit={submit}>
          <Field label="Title" htmlFor="u-title">
            <Input id="u-title" maxLength={120} value={draft.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="u-desc">
            <Textarea id="u-desc" rows={2} maxLength={300} value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="Logo URL" htmlFor="u-logo" hint="An https:// image, shown in a circle." error={draft.logo_url && !/^https:\/\/\S+$/.test(draft.logo_url) ? 'Use an https:// URL' : undefined}>
            <Input id="u-logo" type="url" placeholder="https://example.com/logo.png" value={draft.logo_url ?? ''} onChange={(e) => set('logo_url', e.target.value || null)} />
          </Field>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {(['background_color', 'accent_color'] as const).map((k) => (
              <Field key={k} label={k === 'background_color' ? 'Background' : 'Accent'} htmlFor={`u-${k}`} error={HEX.test(draft[k]) ? undefined : 'Use a hex colour like #111111'}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${k === 'background_color' ? 'Background' : 'Accent'} colour picker`}
                    value={HEX.test(draft[k]) && draft[k].length === 7 ? draft[k] : '#000000'}
                    onChange={(e) => set(k, e.target.value)}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-interactive bg-interactive p-0.5"
                  />
                  <Input id={`u-${k}`} value={draft[k]} invalid={!HEX.test(draft[k])} maxLength={7} onChange={(e) => set(k, e.target.value)} className="font-mono" />
                </div>
              </Field>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between gap-4">
            <label htmlFor="u-topics" className="text-sm text-default">
              Show topics so recipients can choose what they receive
            </label>
            <Switch id="u-topics" checked={draft.show_topics} onChange={(v) => set('show_topics', v)} label="Show topics" />
          </div>
          <DialogActions>
            <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={invalid} loading={save.isPending}>
              Save
            </Button>
            <Button kbd={['Esc']} onClick={() => setDraft(DEFAULTS)}>
              Reset to default
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </SettingsLayout>
  );
}
