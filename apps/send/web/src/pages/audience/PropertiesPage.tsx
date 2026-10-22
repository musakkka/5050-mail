import { useEffect, useMemo, useState } from 'react';
import { Braces, Ellipsis, Plus } from 'lucide-react';
import { properties as propertiesApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { ContactProperty } from '@/api/types';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { AppIcon } from '@/components/ui/AppIcon';
import { Badge } from '@/components/ui/Badge';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { AudienceFrame, ConfirmDialog } from './shared';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;

function PropertyDialog({ open, onOpenChange, property }: { open: boolean; onOpenChange: (o: boolean) => void; property?: ContactProperty | null }) {
  const [key, setKey] = useState('');
  const [type, setType] = useState<'string' | 'number'>('string');
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState<{ field: 'key' | 'fallback'; msg: string } | null>(null);
  useEffect(() => {
    if (open) {
      setKey(property?.key ?? '');
      setType(property?.type ?? 'string');
      setFallback(property?.fallback_value === null || property?.fallback_value === undefined ? '' : String(property.fallback_value));
      setError(null);
    }
  }, [open, property]);
  const save = useTeamMutation(
    (t, b: { key: string; type: 'string' | 'number'; fallback_value: string | number | null }) =>
      property ? propertiesApi.update(t, property.id, { fallback_value: b.fallback_value }) : propertiesApi.create(t, b),
    [['properties']],
    {
      silent: true,
      onSuccess: () => {
        toast.success(property ? 'Property updated' : 'Property added');
        onOpenChange(false);
      },
    },
  );
  const submit = () => {
    const k = key.trim();
    if (!KEY_RE.test(k)) return setError({ field: 'key', msg: 'Use letters, numbers and underscores (max 50), not starting with a number.' });
    let fb: string | number | null = fallback.trim() === '' ? null : fallback;
    if (type === 'number' && fb !== null) {
      if (Number.isNaN(Number(fb))) return setError({ field: 'fallback', msg: 'Enter a number.' });
      fb = Number(fb);
    }
    save.mutate({ key: k, type, fallback_value: fb }, { onError: (e) => setError({ field: 'key', msg: e instanceof Error ? e.message : 'Failed' }) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={property ? 'Edit property' : 'Add property'} onSubmit={submit}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field className="mt-4" label="Name" htmlFor="property-key" error={error?.field === 'key' ? error.msg : null}>
          <Input
            id="property-key"
            autoFocus={!property}
            autoComplete="off"
            placeholder="e.g., company_name"
            value={key}
            readOnly={!!property}
            invalid={error?.field === 'key'}
            onChange={(e) => setKey(e.target.value.replace(/\s/g, '_'))}
          />
        </Field>
        <Field className="mt-0" label="Type" htmlFor="property-type">
          <Select
            id="property-type"
            value={type}
            onChange={setType}
            disabled={!!property}
            options={[
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
            ]}
          />
        </Field>
        <Field
          className="mt-0"
          label={
            <>
              Fallback Value <span className="text-xs font-normal text-gray-8">(optional)</span>
            </>
          }
          htmlFor="property-fallback"
          error={error?.field === 'fallback' ? error.msg : null}
        >
          <Input
            id="property-fallback"
            autoFocus={!!property}
            autoComplete="off"
            inputMode={type === 'number' ? 'decimal' : undefined}
            placeholder="Value to use when property is empty"
            value={fallback}
            invalid={error?.field === 'fallback'}
            onChange={(e) => setFallback(e.target.value)}
          />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" loading={save.isPending} kbd={['⌘', '↩︎']}>
            {property ? 'Save' : 'Add'}
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function PropertiesPage() {
  const list = useTeamQuery(['properties'], (t) => propertiesApi.list(t));
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | 'string' | 'number'>('all');
  const [dialog, setDialog] = useState<{ property: ContactProperty | null } | null>(null);
  const [toDelete, setToDelete] = useState<ContactProperty | null>(null);
  const remove = useTeamMutation((t, id: string) => propertiesApi.remove(t, id), [['properties'], ['contacts']], {
    onSuccess: () => {
      toast.success('Property deleted');
      setToDelete(null);
    },
  });
  const all = list.data?.data ?? [];
  const rows = useMemo(() => all.filter((p) => (type === 'all' || p.type === type) && (!q || p.key.toLowerCase().includes(q.toLowerCase()))), [all, q, type]);
  const add = () => setDialog({ property: null });
  const actions = (
    <>
      <Button variant="primary" icon={<Plus size={16} />} onClick={add}>
        Add property
      </Button>
      <ApiDrawerButton examples={API.properties!} />
    </>
  );
  return (
    <AudienceFrame title="Properties" actions={actions}>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={q} onChange={setQ} className="flex-auto sm:flex-[3]" />
        <div className="sm:w-[270px]">
          <Select
            value={type}
            onChange={setType}
            ariaLabel="Type"
            options={[
              { value: 'all', label: 'All types' },
              { value: 'string', label: 'String' },
              { value: 'number', label: 'Number' },
            ]}
          />
        </div>
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.isPending && rows.length === 0 ? (
        all.length ? (
          <EmptyState compact title="No properties found" description="No properties match these filters." />
        ) : (
          <EmptyState
            className="min-h-90"
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <Braces strokeWidth={1.75} />
              </AppIcon>
            }
            title="No properties yet"
            description="Properties allow you to store custom data for your contacts and use them in your Broadcasts for personalization."
            actions={
              <Button variant="primary" icon={<Plus size={16} />} onClick={add}>
                Add property
              </Button>
            }
          />
        )
      ) : (
        <Table>
          <THead>
            <Th className="w-[320px]">Name</Th>
            <Th className="w-[120px]">Type</Th>
            <Th>Fallback value</Th>
            <Th className="text-right w-[160px]">Created</Th>
            <Th className="w-[70px]">
              <span className="sr-only">Actions</span>
            </Th>
          </THead>
          <TBody>
            {list.isPending ? (
              <SkeletonRows cols={5} rows={3} />
            ) : (
              rows.map((p) => (
                <tr key={p.id}>
                  <Td className="py-3 max-w-[320px]">
                    <div className="group flex min-w-0 items-center gap-2">
                      <button type="button" onClick={() => setDialog({ property: p })} className="truncate border-b border-dashed border-link font-mono text-[13px] text-emphasis hover:border-link-hover" title={p.key}>
                        {p.key}
                      </button>
                      <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <CopyButton value={`{{{contact.${p.key}}}}`} label={`Copy {{{contact.${p.key}}}}`} />
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <Badge tone="neutral">{p.type}</Badge>
                  </Td>
                  <Td className="max-w-[280px]">
                    <div className="truncate" title={p.fallback_value === null ? undefined : String(p.fallback_value)}>
                      {p.fallback_value === null || p.fallback_value === '' ? <span className="text-muted">—</span> : String(p.fallback_value)}
                    </div>
                  </Td>
                  <Td className="text-right">
                    <Tooltip content={fullDateTime(p.created_at)}>
                      <time dateTime={p.created_at}>{timeAgoShort(p.created_at)}</time>
                    </Tooltip>
                  </Td>
                  <Td className="text-center">
                    <Menu
                      align="end"
                      className="w-48"
                      trigger={
                        <button type="button" aria-label="More actions" className={iconButtonClass('ghost', '2', 'align-middle')}>
                          <span className="inline-flex items-center justify-center opacity-100">
                            <Ellipsis size={12} strokeWidth={3} />
                          </span>
                        </button>
                      }
                    >
                      <MenuItem onClick={() => setDialog({ property: p })}>Edit fallback value</MenuItem>
                      <MenuSeparator />
                      <MenuItem danger onClick={() => setToDelete(p)}>
                        Delete property
                      </MenuItem>
                    </Menu>
                  </Td>
                </tr>
              ))
            )}
          </TBody>
        </Table>
      )}
      <PropertyDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} property={dialog?.property} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete property"
        description={
          <>
            Delete <span className="font-mono text-emphasis break-all">{toDelete?.key}</span>? Its value is removed from every contact.
          </>
        }
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </AudienceFrame>
  );
}
