import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ellipsis, Plus, UserRound, X } from 'lucide-react';
import { contacts as contactsApi, segments as segmentsApi, properties as propertiesApi } from '@/api/client';
import { del, get, patch, post } from '@/api/http';
import { useTeamQuery } from '@/api/hooks';
import type { Contact, List } from '@/api/types';
import { DetailHeader, Meta, PageBody } from '@/components/layout/Page';
import { AppIcon } from '@/components/ui/AppIcon';
import { Badge } from '@/components/ui/Badge';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { IdPill } from '@/components/ui/CopyButton';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { Field, Input } from '@/components/ui/Input';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast, toastError } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { useTeamId } from '@/state/session';
import { ConfirmDialog, contactName, useInvalidateAudience } from './shared';

interface ContactTopic {
  id: string;
  name: string;
  description: string | null;
  subscription: 'opt_in' | 'opt_out';
}

const rs = (t: string, p: string) => `/teams/${t}/resend${p}`;

function Section({ title, description, children, right }: { title: string; description?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-emphasis">{title}</h2>
          {description ? <p className="mt-1 text-sm text-default">{description}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function ContactDetailPage() {
  const { id = '' } = useParams();
  const teamId = useTeamId();
  const nav = useNavigate();
  const invalidate = useInvalidateAudience();
  const contact = useTeamQuery(['contacts', 'one', id], (t) => contactsApi.get(t, id));
  const segs = useTeamQuery(['contacts', 'one', id, 'segments'], (t) => contactsApi.segments(t, id));
  const allSegs = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  const topics = useTeamQuery(['contacts', 'one', id, 'topics'], (t) => get<List<ContactTopic>>(rs(t, `/contacts/${encodeURIComponent(id)}/topics`)));
  const props = useTeamQuery(['properties'], (t) => propertiesApi.list(t));
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addSeg, setAddSeg] = useState('');
  const [propDraft, setPropDraft] = useState<Record<string, string>>({});

  const c = contact.data;
  useEffect(() => {
    if (!c) return;
    const d: Record<string, string> = {};
    for (const p of props.data?.data ?? []) d[p.key] = c.properties?.[p.key] === undefined || c.properties?.[p.key] === null ? '' : String(c.properties[p.key]);
    setPropDraft(d);
  }, [c, props.data]);

  const refresh = async () => {
    await invalidate();
  };

  const update = async (b: Partial<Contact>, msg: string) => {
    try {
      await contactsApi.update(teamId, id, b);
      await refresh();
      toast.success(msg);
    } catch (e) {
      toastError(e);
    }
  };

  if (contact.error) {
    return (
      <PageBody className="pt-8">
        <ErrorState error={contact.error} onRetry={() => void contact.refetch()} />
      </PageBody>
    );
  }

  const memberIds = new Set((segs.data?.data ?? []).map((s) => s.id));
  const available = (allSegs.data?.data ?? []).filter((s) => !memberIds.has(s.id));
  const propsChanged = c && Object.entries(propDraft).some(([k, v]) => v !== (c.properties?.[k] === undefined || c.properties?.[k] === null ? '' : String(c.properties[k])));

  return (
    <PageBody className="pt-2 pb-8 md:pt-8">
      <DetailHeader
        icon={
          <AppIcon size={80} tone={c?.unsubscribed ? 'gray' : 'blue'} glyphSize={36}>
            <UserRound strokeWidth={1.75} />
          </AppIcon>
        }
        eyebrow="Contact"
        title={c ? c.email : <Skeleton className="h-8 w-72" />}
        back={{ to: '/audience', label: 'Contacts' }}
        actions={
          <Menu
            align="end"
            className="w-48"
            trigger={
              <button type="button" aria-label="More actions" className={iconButtonClass('secondary', '2')} disabled={!c}>
                <span className="inline-flex items-center justify-center opacity-100">
                  <Ellipsis size={12} strokeWidth={3} />
                </span>
              </button>
            }
          >
            <MenuItem onClick={() => setEdit(true)}>Edit contact</MenuItem>
            <MenuItem onClick={() => c && void update({ unsubscribed: !c.unsubscribed }, c.unsubscribed ? 'Contact resubscribed' : 'Contact unsubscribed')}>
              {c?.unsubscribed ? 'Resubscribe' : 'Unsubscribe'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={() => setConfirm(true)}>
              Delete contact
            </MenuItem>
          </Menu>
        }
      />
      <div className="md:grid md:grid-cols-4 gap-4">
        <Meta label="First name">
          <span className="truncate">{c ? c.first_name || <span className="text-muted">—</span> : <Skeleton className="h-4 w-24" />}</span>
        </Meta>
        <Meta label="Last name">
          <span className="truncate">{c ? c.last_name || <span className="text-muted">—</span> : <Skeleton className="h-4 w-24" />}</span>
        </Meta>
        <Meta label="Status">{c ? <Badge tone={c.unsubscribed ? 'neutral' : 'success'}>{c.unsubscribed ? 'unsubscribed' : 'subscribed'}</Badge> : <Skeleton className="h-6 w-24" />}</Meta>
        <Meta label="Added">
          {c ? (
            <Tooltip content={fullDateTime(c.created_at)}>
              <time dateTime={c.created_at}>{timeAgoShort(c.created_at)}</time>
            </Tooltip>
          ) : (
            <Skeleton className="h-4 w-16" />
          )}
        </Meta>
        <Meta label="ID" className="md:col-span-2">
          {c ? <IdPill value={c.id} /> : <Skeleton className="h-6 w-64" />}
        </Meta>
      </div>

      <Section title="Subscription" description="Unsubscribed contacts don't receive broadcasts. Transactional emails are not affected.">
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-default px-4 py-3">
          <span className="text-sm text-emphasis">{c?.unsubscribed ? 'Unsubscribed from all broadcasts' : 'Subscribed to broadcasts'}</span>
          <Switch
            checked={!!c && !c.unsubscribed}
            disabled={!c}
            label="Subscribed"
            onChange={(v) => void update({ unsubscribed: !v }, v ? 'Contact resubscribed' : 'Contact unsubscribed')}
          />
        </div>
      </Section>

      <Section
        title="Segments"
        right={
          available.length ? (
            <div className="flex items-center gap-2">
              <Select
                value={addSeg}
                onChange={setAddSeg}
                placeholder="Add to segment…"
                ariaLabel="Add to segment"
                options={available.map((s) => ({ value: s.id, label: s.name }))}
                className="w-48"
              />
              <Button
                icon={<Plus size={16} />}
                disabled={!addSeg}
                onClick={async () => {
                  try {
                    await post(rs(teamId, `/contacts/${encodeURIComponent(id)}/segments/${addSeg}`));
                    setAddSeg('');
                    await refresh();
                    toast.success('Added to segment');
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                Add
              </Button>
            </div>
          ) : null
        }
      >
        {segs.isPending ? (
          <Skeleton className="h-8 w-48" />
        ) : (segs.data?.data ?? []).length ? (
          <div className="flex flex-wrap gap-2">
            {segs.data!.data.map((s) => (
              <span key={s.id} className="inline-flex h-8 max-w-full items-center gap-1 rounded-xl border border-interactive bg-interactive pl-3 pr-1 text-sm text-emphasis">
                <span className="truncate">{s.name}</span>
                <button
                  type="button"
                  aria-label={`Remove from ${s.name}`}
                  className={iconButtonClass('ghost', '1')}
                  onClick={async () => {
                    try {
                      await del(rs(teamId, `/contacts/${encodeURIComponent(id)}/segments/${s.id}`));
                      await refresh();
                      toast.success(`Removed from ${s.name}`);
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Not in any segment.</p>
        )}
      </Section>

      <Section title="Topics" description="What this contact wants to hear about.">
        {topics.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : topics.error ? (
          <ErrorState error={topics.error} onRetry={() => void topics.refetch()} className="min-h-0 py-6" />
        ) : (topics.data?.data ?? []).length ? (
          <ul className="divide-y divide-gray-2 rounded-2xl border border-default">
            {topics.data!.data.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-emphasis">{t.name}</p>
                  {t.description ? <p className="truncate text-xs text-muted">{t.description}</p> : null}
                </div>
                <Switch
                  checked={t.subscription === 'opt_in'}
                  label={`Subscribed to ${t.name}`}
                  onChange={async (v) => {
                    try {
                      await patch(rs(teamId, `/contacts/${encodeURIComponent(id)}/topics`), { topics: [{ id: t.id, subscription: v ? 'opt_in' : 'opt_out' }] });
                      await refresh();
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact title="No topics" description="Create topics in Audience → Topics to let contacts choose what they receive." className="min-h-0 py-8" />
        )}
      </Section>

      <Section
        title="Properties"
        right={
          propsChanged ? (
            <Button
              variant="primary"
              onClick={() => {
                const out: Record<string, string> = {};
                for (const [k, v] of Object.entries(propDraft)) out[k] = v;
                void update({ properties: out } as Partial<Contact>, 'Properties saved');
              }}
            >
              Save
            </Button>
          ) : null
        }
      >
        {(props.data?.data ?? []).length ? (
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {props.data!.data.map((p) => (
              <div key={p.id} className="mb-4 flex min-w-0 flex-col gap-2">
                <label htmlFor={`prop-${p.key}`} className="truncate font-mono text-xs text-default">
                  {p.key} <span className="text-muted">({p.type})</span>
                </label>
                <Input
                  id={`prop-${p.key}`}
                  inputMode={p.type === 'number' ? 'decimal' : undefined}
                  value={propDraft[p.key] ?? ''}
                  placeholder={p.fallback_value === null ? '' : `Fallback: ${p.fallback_value}`}
                  invalid={p.type === 'number' && !!propDraft[p.key] && Number.isNaN(Number(propDraft[p.key]))}
                  onChange={(e) => setPropDraft((d) => ({ ...d, [p.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No custom properties. Add them in Audience → Properties.</p>
        )}
      </Section>

      {c ? <EditContactDialog open={edit} onOpenChange={setEdit} contact={c} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete contact"
        description={<>Delete <span className="text-emphasis break-all">{c?.email}</span>? This can't be undone.</>}
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await contactsApi.remove(teamId, id);
            await refresh();
            toast.success('Contact deleted');
            nav('/audience');
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
    </PageBody>
  );
}

function EditContactDialog({ open, onOpenChange, contact, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; contact: Contact; onSaved: () => Promise<unknown> }) {
  const teamId = useTeamId();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFirst(contact.first_name ?? '');
      setLast(contact.last_name ?? '');
    }
  }, [open, contact]);
  const submit = async () => {
    setBusy(true);
    try {
      await contactsApi.update(teamId, contact.id, { first_name: first.trim() || null, last_name: last.trim() || null });
      await onSaved();
      toast.success('Contact updated');
      onOpenChange(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Edit contact" description={<span className="break-all">{contactName(contact) || contact.email}</span>} onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="First name" htmlFor="edit-first">
          <Input id="edit-first" autoFocus value={first} onChange={(e) => setFirst(e.target.value)} />
        </Field>
        <Field label="Last name" htmlFor="edit-last">
          <Input id="edit-last" value={last} onChange={(e) => setLast(e.target.value)} />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" loading={busy} kbd={['⌘', '↩︎']}>
            Save
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
