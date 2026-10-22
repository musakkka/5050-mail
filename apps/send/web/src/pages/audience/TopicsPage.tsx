import { useEffect, useMemo, useState } from 'react';
import { Ellipsis, Plus, Tag } from 'lucide-react';
import { topics as topicsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Topic } from '@/api/types';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { AppIcon } from '@/components/ui/AppIcon';
import { Badge } from '@/components/ui/Badge';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { AudienceFrame, ConfirmDialog } from './shared';
import { UnsubscribePreview } from './UnsubscribePreview';

function TopicIcon({ size = 32 }: { size?: number }) {
  return (
    <AppIcon size={size} tone="violet" glyphSize={Math.round(size * 0.5)}>
      <Tag strokeWidth={2} />
    </AppIcon>
  );
}

function TopicDialog({ open, onOpenChange, topic }: { open: boolean; onOpenChange: (o: boolean) => void; topic?: Topic | null }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [def, setDef] = useState<'opt_in' | 'opt_out'>('opt_in');
  const [vis, setVis] = useState<'public' | 'private'>('public');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(topic?.name ?? '');
      setDescription(topic?.description ?? '');
      setDef(topic?.default_subscription ?? 'opt_in');
      setVis(topic?.visibility ?? 'public');
      setError(null);
    }
  }, [open, topic]);
  const save = useTeamMutation(
    (t, b: { name: string; description?: string; default_subscription: 'opt_in' | 'opt_out'; visibility: 'public' | 'private' }) =>
      topic ? topicsApi.update(t, topic.id, b) : topicsApi.create(t, b),
    [['topics']],
    {
      silent: true,
      onSuccess: () => {
        toast.success(topic ? 'Topic updated' : 'Topic created');
        onOpenChange(false);
      },
    },
  );
  const submit = () => {
    const n = name.trim();
    if (!n) return setError('Enter a name.');
    if (n.length > 50) return setError('Use at most 50 characters.');
    save.mutate({ name: n, description: description.trim() || undefined, default_subscription: def, visibility: vis }, { onError: (e) => setError(e instanceof Error ? e.message : 'Failed') });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={topic ? 'Edit topic' : 'Create topic'} onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" htmlFor="topic-name" error={error}>
          <Input id="topic-name" autoFocus autoComplete="off" placeholder="e.g., Product updates" value={name} invalid={!!error} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={
            <>
              Description <span className="text-xs text-muted">(optional)</span>
            </>
          }
          htmlFor="topic-description"
        >
          <Textarea id="topic-description" rows={2} maxLength={200} placeholder="Shown on the unsubscribe page" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Default subscription" htmlFor="topic-default" hint={def === 'opt_in' ? 'Contacts receive this topic unless they opt out.' : 'Contacts only receive this topic after opting in.'}>
          <Select
            id="topic-default"
            value={def}
            onChange={setDef}
            disabled={!!topic}
            options={[
              { value: 'opt_in', label: 'Opt-in' },
              { value: 'opt_out', label: 'Opt-out' },
            ]}
          />
        </Field>
        <Field label="Visibility" htmlFor="topic-visibility" hint={vis === 'public' ? 'Listed on the unsubscribe page.' : 'Hidden from the unsubscribe page.'}>
          <Select
            id="topic-visibility"
            value={vis}
            onChange={setVis}
            options={[
              { value: 'public', label: 'Public' },
              { value: 'private', label: 'Private' },
            ]}
          />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()} kbd={['⌘', '↩︎']}>
            {topic ? 'Save' : 'Create'}
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function TopicsPage() {
  const list = useTeamQuery(['topics'], (t) => topicsApi.list(t));
  const [q, setQ] = useState('');
  const [def, setDef] = useState<'any' | 'opt_in' | 'opt_out'>('any');
  const [dialog, setDialog] = useState<{ topic: Topic | null } | null>(null);
  const [toDelete, setToDelete] = useState<Topic | null>(null);
  const remove = useTeamMutation((t, id: string) => topicsApi.remove(t, id), [['topics']], {
    onSuccess: () => {
      toast.success('Topic deleted');
      setToDelete(null);
    },
  });
  const all = list.data?.data ?? [];
  const rows = useMemo(
    () => all.filter((t) => (def === 'any' || t.default_subscription === def) && (!q || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q.toLowerCase()))),
    [all, q, def],
  );
  const create = () => setDialog({ topic: null });
  const actions = (
    <>
      <Button variant="primary" icon={<Plus size={16} />} onClick={create}>
        Create topic
      </Button>
      <ApiDrawerButton examples={API.topics!} />
    </>
  );
  return (
    <AudienceFrame title="Topics" actions={actions}>
      <div className="xl:flex xl:gap-8">
        <div className="min-w-0 xl:w-3/5">
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <SearchInput value={q} onChange={setQ} className="sm:col-span-2" />
            <Select
              value={def}
              onChange={setDef}
              ariaLabel="Default subscription"
              options={[
                { value: 'any', label: 'Any default' },
                { value: 'opt_in', label: 'Opt-in' },
                { value: 'opt_out', label: 'Opt-out' },
              ]}
            />
          </div>
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : !list.isPending && rows.length === 0 ? (
            all.length ? (
              <EmptyState compact title="No topics found" description="No topics match these filters." />
            ) : (
              <EmptyState
                className="min-h-90"
                icon={<TopicIcon size={105} />}
                title="No topics yet"
                description="Use Topics with Unsubscribe Page to let users choose the content they want to receive."
                actions={
                  <Button variant="primary" icon={<Plus size={16} />} onClick={create}>
                    Create topic
                  </Button>
                }
              />
            )
          ) : (
            <Table>
              <THead>
                <Th>Name</Th>
                <Th className="w-[110px]">Default</Th>
                <Th className="w-[100px]">Visibility</Th>
                <Th className="w-[110px] text-right">Created</Th>
                <Th className="w-[56px]">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <TBody>
                {list.isPending ? (
                  <SkeletonRows cols={5} rows={3} />
                ) : (
                  rows.map((t) => (
                    <tr key={t.id}>
                      <Td className="py-3 max-w-[260px]">
                        <div className="flex min-w-0 items-center gap-3">
                          <TopicIcon />
                          <div className="min-w-0">
                            <button type="button" onClick={() => setDialog({ topic: t })} className="block max-w-full truncate border-b border-dashed border-link text-left text-sm text-emphasis hover:border-link-hover" title={t.name}>
                              {t.name}
                            </button>
                            {t.description ? (
                              <p className="truncate text-xs text-muted" title={t.description}>
                                {t.description}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={t.default_subscription === 'opt_in' ? 'success' : 'neutral'} capitalize={false}>
                          {t.default_subscription === 'opt_in' ? 'Opt-in' : 'Opt-out'}
                        </Badge>
                      </Td>
                      <Td className="capitalize">{t.visibility ?? 'public'}</Td>
                      <Td className="text-right">
                        <Tooltip content={fullDateTime(t.created_at)}>
                          <time dateTime={t.created_at}>{timeAgoShort(t.created_at)}</time>
                        </Tooltip>
                      </Td>
                      <Td className="text-center">
                        <Menu
                          align="end"
                          className="w-44"
                          trigger={
                            <button type="button" aria-label="More actions" className={iconButtonClass('ghost', '2', 'align-middle')}>
                              <span className="inline-flex items-center justify-center opacity-100">
                                <Ellipsis size={12} strokeWidth={3} />
                              </span>
                            </button>
                          }
                        >
                          <MenuItem onClick={() => setDialog({ topic: t })}>Edit topic</MenuItem>
                          <MenuSeparator />
                          <MenuItem danger onClick={() => setToDelete(t)}>
                            Delete topic
                          </MenuItem>
                        </Menu>
                      </Td>
                    </tr>
                  ))
                )}
              </TBody>
            </Table>
          )}
        </div>
        <div className="hidden xl:block xl:w-2/5">
          <UnsubscribePreview topics={all} />
        </div>
      </div>
      <TopicDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} topic={dialog?.topic} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete topic"
        description={
          <>
            Delete <span className="text-emphasis break-all">{toDelete?.name}</span>? Contact subscriptions to this topic are removed and it disappears from the unsubscribe page.
          </>
        }
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </AudienceFrame>
  );
}
