import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ellipsis, Inbox as InboxIcon, Plus } from 'lucide-react';
import { domains as domainsApi, inboxes as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import type { Inbox } from '@/api/types';
import { PageBody, PageHeader } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Switch';
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

const LOCAL_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._%-]{1,64}(?<!\.)$/;

function CreateInboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const doms = useTeamQuery(['domains'], (t) => domainsApi.list(t), { enabled: open });
  const usable = useMemo(() => (doms.data?.data ?? []).filter((d) => d.capabilities?.receiving === 'enabled' || d.capabilities?.sending === 'enabled'), [doms.data]);
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [fromName, setFromName] = useState('');
  const [forwarding, setForwarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setLocal('');
      setName('');
      setFromName('');
      setForwarding(false);
      setError(null);
    }
  }, [open]);
  useEffect(() => {
    if (!domain && usable.length) setDomain((usable.find((d) => d.capabilities?.receiving === 'enabled') ?? usable[0]!).name);
  }, [usable, domain]);
  const dom = usable.find((d) => d.name === domain);
  const receiving = dom?.capabilities?.receiving === 'enabled';
  const nav = useNavigate();
  const create = useTeamMutation((t, b: { email_address: string; name?: string; from_name?: string; forwarding?: boolean }) => api.create(t, b), [['inboxes']], {
    silent: true,
    onSuccess: () => {
      toast.success('Inbox created');
      onOpenChange(false);
    },
  });
  const submit = () => {
    const l = local.trim().toLowerCase();
    if (!LOCAL_RE.test(l)) return setError('Use letters, numbers, dots, dashes, underscores or %; no leading, trailing or double dots.');
    if (!dom) return setError('Choose a domain.');
    if (!receiving && !forwarding) return setError(`Receiving is not enabled on ${dom.name}. Enable it on the domain, or use forwarding.`);
    if (/[:<>\r\n]/.test(fromName)) return setError('The sender name cannot contain : < > or line breaks.');
    setError(null);
    create.mutate(
      { email_address: `${l}@${dom.name}`, name: name.trim() || undefined, from_name: fromName.trim() || undefined, forwarding: forwarding || undefined },
      { onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the inbox.') },
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create inbox" onSubmit={submit} initialFocus={localRef}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!doms.isPending && usable.length === 0 ? (
          <div className="mt-6 flex flex-col items-start gap-3 rounded-2xl border border-default p-4 text-sm text-default">
            Inboxes live on one of your domains. Add a domain with receiving enabled first.
            <Button
              size="1"
              onClick={() => {
                onOpenChange(false);
                nav('/domains/add');
              }}
            >
              Add domain
            </Button>
          </div>
        ) : (
          <>
            <Field label="Address" htmlFor="inbox-local">
              <div className="flex min-w-0 items-center gap-2">
                <Input ref={localRef} id="inbox-local" placeholder="support" autoComplete="off" value={local} onChange={(e) => setLocal(e.target.value)} wrapperClassName="min-w-0 flex-1" />
                <span className="text-sm text-default">@</span>
                <Select
                  ariaLabel="Domain"
                  className="min-w-0 max-w-[55%]"
                  value={domain}
                  placeholder={doms.isPending ? 'Loading…' : 'Domain'}
                  onChange={setDomain}
                  options={usable.map((d) => ({ value: d.name, label: d.capabilities?.receiving === 'enabled' ? d.name : `${d.name} (sending only)`, text: d.name }))}
                />
              </div>
            </Field>
            <Field label="Name" htmlFor="inbox-name" hint="Shown in the dashboard (optional).">
              <Input id="inbox-name" placeholder="Support" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Sender name" htmlFor="inbox-from" hint="Replies are sent as “Sender name <address>” (optional).">
              <Input id="inbox-from" placeholder="Acme Support" maxLength={78} value={fromName} onChange={(e) => setFromName(e.target.value)} />
            </Field>
            <label className="mt-6 flex items-start gap-3 text-sm text-default">
              <Checkbox checked={forwarding} onChange={setForwarding} label="Use a forwarding address" className="mt-0.5" />
              <span>
                <span className="text-emphasis">Use a forwarding address</span>
                <span className="block text-xs text-muted">Keep your current MX and forward mail to a 5050 receiving address instead. Only sending needs to be verified.</span>
              </span>
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-error">
            {error}
          </p>
        ) : null}
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} loading={create.isPending} disabled={!usable.length}>
            Create
          </Button>
          <Button kbd={['Esc']} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function EditInboxDialog({ inbox, onClose }: { inbox: Inbox | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [fromName, setFromName] = useState('');
  useEffect(() => {
    setName(inbox?.name ?? '');
    setFromName(inbox?.from_name ?? '');
  }, [inbox]);
  const save = useTeamMutation((t, b: { name: string; from_name: string }) => api.update(t, inbox!.id, b), [['inboxes']], {
    onSuccess: () => {
      toast.success('Inbox updated');
      onClose();
    },
  });
  const submit = () => save.mutate({ name: name.trim(), from_name: fromName.trim() });
  return (
    <Dialog open={!!inbox} onOpenChange={(o) => !o && onClose()} title="Edit inbox" description={<span className="break-all">{inbox?.email_address}</span>} onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" htmlFor="edit-inbox-name">
          <Input id="edit-inbox-name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Sender name" htmlFor="edit-inbox-from">
          <Input id="edit-inbox-from" maxLength={78} value={fromName} onChange={(e) => setFromName(e.target.value)} />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} loading={save.isPending}>
            Save
          </Button>
          <Button kbd={['Esc']} onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function InboxesPage() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Inbox | null>(null);
  const [toDelete, setToDelete] = useState<Inbox | null>(null);
  const list = useTeamQuery(['inboxes'], (t) => api.list(t));
  const remove = useTeamMutation((t, id: string) => api.remove(t, id), [['inboxes']], {
    onSuccess: () => {
      toast.success('Inbox deleted');
      setToDelete(null);
    },
  });
  const all = list.data?.data ?? [];
  const rows = useMemo(() => {
    const s = q.toLowerCase();
    return all.filter((i) => !s || i.email_address.includes(s) || (i.name ?? '').toLowerCase().includes(s));
  }, [all, q]);
  const create = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
      Create inbox
    </Button>
  );
  const received = (i: Inbox) => nav(`/emails/receiving?q=${encodeURIComponent(i.email_address)}`);

  return (
    <>
      <PageHeader
        title="Inboxes"
        actions={
          <>
            {create}
            <ApiDrawerButton examples={API.inboxes!} />
          </>
        }
      />
      <PageBody>
        <div className="mb-3 flex flex-col items-center gap-2 md:mb-4 md:flex-row">
          <SearchInput value={q} onChange={setQ} className="w-full" />
        </div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.isPending && all.length === 0 ? (
          <EmptyState
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <InboxIcon strokeWidth={1.75} />
              </AppIcon>
            }
            title="No inboxes yet"
            description="Create an inbox to send, receive, organize, and manage all your emails."
            actions={create}
          />
        ) : !list.isPending && rows.length === 0 ? (
          <EmptyState compact title="No inboxes found" description="No inboxes match your search." />
        ) : (
          <Table>
            <THead>
              <Th>Address</Th>
              <Th className="w-[200px]">Name</Th>
              <Th className="w-[110px]">Unread</Th>
              <Th className="w-[160px]">Last received</Th>
              <Th className="text-right w-[140px]">Created</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>
              {list.isPending ? (
                <SkeletonRows cols={6} />
              ) : (
                rows.map((i) => (
                  <tr key={i.id}>
                    <Td className="py-3 max-w-[360px]">
                      <div className="group flex items-center gap-3 min-w-0">
                        <AppIcon size={32} tone={i.unread ? 'blue' : 'gray'} glyphSize={16}>
                          <InboxIcon />
                        </AppIcon>
                        <button
                          type="button"
                          onClick={() => received(i)}
                          title={i.email_address}
                          className="min-w-0 truncate border-b border-dashed border-link text-left text-sm text-emphasis transition duration-300 hover:border-link-hover"
                        >
                          {i.email_address}
                        </button>
                      </div>
                    </Td>
                    <Td className="max-w-[200px]">
                      <div className="truncate" title={i.name ?? undefined}>
                        {i.name ?? <span className="text-muted">—</span>}
                      </div>
                    </Td>
                    <Td>{i.unread ? <Badge tone="info" capitalize={false}>{i.unread} unread</Badge> : <span className="text-muted">0</span>}</Td>
                    <Td>
                      {i.last_received ? (
                        <Tooltip content={fullDateTime(i.last_received)}>
                          <time dateTime={i.last_received}>{timeAgoShort(i.last_received)}</time>
                        </Tooltip>
                      ) : (
                        <span className="text-muted">Never</span>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Tooltip content={fullDateTime(i.created_at)}>
                        <time dateTime={i.created_at}>{timeAgoShort(i.created_at)}</time>
                      </Tooltip>
                    </Td>
                    <Td className="text-center">
                      <Menu
                        align="end"
                        className="w-48"
                        trigger={
                          <button type="button" aria-label={`More actions for ${i.email_address}`} className={iconButtonClass('ghost', '2', 'align-middle')}>
                            <span className="inline-flex items-center justify-center opacity-100">
                              <Ellipsis size={12} strokeWidth={3} />
                            </span>
                          </button>
                        }
                      >
                        <MenuItem onClick={() => received(i)}>View received emails</MenuItem>
                        <MenuItem onClick={() => setEditing(i)}>Edit</MenuItem>
                        <MenuItem onClick={() => void navigator.clipboard?.writeText(i.email_address).then(() => toast('Address copied'))}>Copy address</MenuItem>
                        <MenuSeparator />
                        <MenuItem danger onClick={() => setToDelete(i)}>
                          Delete
                        </MenuItem>
                      </Menu>
                    </Td>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
        )}
      </PageBody>
      <CreateInboxDialog open={creating} onOpenChange={setCreating} />
      <EditInboxDialog inbox={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete inbox"
        description={
          <>
            <span className="text-emphasis break-all">{toDelete?.email_address}</span> and its threads and drafts will be deleted. Received emails stay under Emails → Receiving.
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
