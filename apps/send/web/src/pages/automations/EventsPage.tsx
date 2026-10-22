import { useEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, Plus, Trash, Zap } from 'lucide-react';
import { events as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { EventDefinition, EventPropertyType } from '@/api/types';
import { PageBody, PageHeader } from '@/components/layout/Page';
import { Button, IconButton, iconButtonClass } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { AutomationTabsRow } from './shared';

const TYPES: { value: EventPropertyType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
];

type Prop = { key: string; type: EventPropertyType };

/** "Add event" / "Edit event" dialog: name plus optional typed payload properties. */
export function EventDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (o: boolean) => void; editing?: EventDefinition | null }) {
  const [name, setName] = useState('');
  const [props, setProps] = useState<Prop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const reset = () => {
    setName(editing?.name ?? '');
    setProps(editing?.schema ? Object.entries(editing.schema).map(([key, type]) => ({ key, type })) : []);
    setError(null);
  };
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = useTeamMutation(
    (t, b: { name: string; schema: Record<string, EventPropertyType> | null }) => (editing ? api.update(t, editing.id, { schema: b.schema }) : api.create(t, b)),
    [['events']],
    {
      silent: true,
      onSuccess: () => {
        toast.success(editing ? 'Event updated' : 'Event created');
        onOpenChange(false);
      },
    },
  );
  const submit = () => {
    const n = name.trim();
    if (!editing && !/^[A-Za-z0-9_.:-]{1,100}$/.test(n)) return setError('Use letters, numbers, dots, dashes and underscores.');
    if (n.startsWith('resend:')) return setError('Event names cannot start with "resend:".');
    const keys = props.map((p) => p.key.trim());
    if (keys.some((k) => !/^[A-Za-z0-9_]{1,50}$/.test(k))) return setError('Property keys use letters, numbers and underscores.');
    if (new Set(keys).size !== keys.length) return setError('Property keys must be unique.');
    setError(null);
    save.mutate(
      { name: n, schema: props.length ? Object.fromEntries(props.map((p) => [p.key.trim(), p.type])) : null },
      { onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the event.') },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit event' : 'Add event'}
      onSubmit={submit}
      initialFocus={nameRef}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mt-4 flex flex-col gap-2">
          <Input
            ref={nameRef}
            id="event-name"
            aria-label="Event name"
            required
            autoComplete="off"
            placeholder="e.g., domain-created"
            value={name}
            readOnly={!!editing}
            invalid={!!error && !props.length}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <hr className="h-px w-full border-0 bg-gray-3" />
        {props.length ? (
          <ul className="flex flex-col gap-2" aria-label="Event properties">
            {props.map((p, i) => (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_120px_32px] gap-2">
                <Input
                  aria-label="Property key"
                  placeholder="property_name"
                  className="font-mono"
                  value={p.key}
                  autoFocus={i === props.length - 1 && p.key === ''}
                  onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                />
                <Select value={p.type} ariaLabel="Property type" options={TYPES} onChange={(type) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, type } : x)))} />
                <IconButton label={`Remove ${p.key || 'property'}`} variant="ghost" onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))}>
                  <Trash size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button icon={<Plus size={16} />} onClick={() => setProps((ps) => [...ps, { key: '', type: 'string' }])} disabled={props.length >= 50}>
            Add event property
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        <DialogActions className="mt-2">
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} loading={save.isPending}>
            Save
          </Button>
          <Button kbd={['Esc']} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function EventsPage() {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EventDefinition | null>(null);
  const [toDelete, setToDelete] = useState<EventDefinition | null>(null);
  const list = useTeamQuery(['events'], (t) => api.list(t));
  const remove = useTeamMutation((t, id: string) => api.remove(t, id), [['events']], {
    onSuccess: () => {
      toast.success('Event deleted');
      setToDelete(null);
    },
  });
  const all = list.data?.data ?? [];
  const rows = useMemo(() => all.filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase())), [all, q]);
  const add = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
      Add event
    </Button>
  );
  return (
    <>
      <PageHeader title="Automations" />
      <PageBody>
        <AutomationTabsRow action={add} />
        <div className="mb-4 flex flex-row gap-2 w-full">
          <SearchInput value={q} onChange={setQ} className="w-full" placeholder="Search..." />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          <EmptyState
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <Zap strokeWidth={1.75} />
              </AppIcon>
            }
            title="No events yet"
            description="Create events to trigger automations."
            actions={add}
          />
        ) : !list.isPending && rows.length === 0 ? (
          <EmptyState compact title="No events found" description="No events match your search." />
        ) : (
          <Table>
            <THead>
              <Th>Name</Th>
              <Th>Properties</Th>
              <Th className="text-right w-[160px]">Created</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>
              {list.isPending ? (
                <SkeletonRows cols={4} />
              ) : (
                rows.map((e) => {
                  const props = Object.entries(e.schema ?? {});
                  return (
                    <tr key={e.id}>
                      <Td className="py-3 max-w-[360px]">
                        <div className="flex items-center gap-3 min-w-0">
                          <AppIcon size={32} tone="violet" glyphSize={16}>
                            <Zap />
                          </AppIcon>
                          <span className="truncate font-mono text-[13px] text-emphasis" title={e.name}>
                            {e.name}
                          </span>
                        </div>
                      </Td>
                      <Td className="max-w-[420px]">
                        {props.length ? (
                          <div className="flex min-w-0 gap-1 overflow-hidden">
                            {props.slice(0, 4).map(([k, t]) => (
                              <Badge key={k} tone="neutral" capitalize={false} className="font-mono shrink-0">
                                {k}: {t}
                              </Badge>
                            ))}
                            {props.length > 4 ? <span className="text-xs text-muted self-center">+{props.length - 4}</span> : null}
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <Tooltip content={fullDateTime(e.created_at)}>
                          <time dateTime={e.created_at}>{timeAgoShort(e.created_at)}</time>
                        </Tooltip>
                      </Td>
                      <Td className="text-center">
                        <Menu
                          align="end"
                          className="w-44"
                          trigger={
                            <button type="button" aria-label={`More actions for ${e.name}`} className={iconButtonClass('ghost', '2', 'align-middle')}>
                              <span className="inline-flex items-center justify-center opacity-100">
                                <Ellipsis size={12} strokeWidth={3} />
                              </span>
                            </button>
                          }
                        >
                          <MenuItem onClick={() => setEditing(e)}>Edit properties</MenuItem>
                          <MenuItem onClick={() => void navigator.clipboard?.writeText(e.name).then(() => toast('Event name copied'))}>Copy name</MenuItem>
                          <MenuSeparator />
                          <MenuItem danger onClick={() => setToDelete(e)}>
                            Delete
                          </MenuItem>
                        </Menu>
                      </Td>
                    </tr>
                  );
                })
              )}
            </TBody>
          </Table>
        )}
      </PageBody>
      <EventDialog open={adding} onOpenChange={setAdding} />
      <EventDialog key={editing?.id ?? 'none'} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} editing={editing} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete event"
        description={
          <>
            Automations triggered by <span className="font-mono text-emphasis break-all">{toDelete?.name}</span> will stop starting new runs.
          </>
        }
        loading={remove.isPending}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
        }}
      />
    </>
  );
}
