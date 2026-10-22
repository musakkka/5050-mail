import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { LinearProgress } from '../../components/ui/Progress';
import { adminErrorMessage } from '../../admin/api';
import { validateLocalPart } from '../../admin/model';
import { useAccounts, useAdmin, useDomains, useMailingLists, useRefreshAdmin } from '../../admin/state';
import { useUi } from '../../state/ui';
import { AddressField, Banner, Card, EmptyState, PageHeader, TextField } from './ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Split pasted text into addresses: commas, semicolons, whitespace or newlines. */
export function splitAddresses(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);
  const valid = [...new Set(parts.filter((p) => EMAIL_RE.test(p)).map((p) => p.toLowerCase()))];
  return { valid, invalid: parts.filter((p) => !EMAIL_RE.test(p)) };
}

function CreateDialog({ kind, onClose }: { kind: 'group' | 'list'; onClose: () => void }) {
  const { api } = useAdmin();
  const nav = useNavigate();
  const refresh = useRefreshAdmin();
  const showSnack = useUi((s) => s.showSnack);
  const { data: domains = [] } = useDomains();
  const [local, setLocal] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [recipients, setRecipients] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!domainId && domains[0]) setDomainId(domains[0].id);
  }, [domains, domainId]);
  const parsed = splitAddresses(recipients);
  const localErr = validateLocalPart(local);
  const recErr = parsed.invalid.length ? `Not an email address: ${parsed.invalid.slice(0, 3).join(', ')}` : null;
  const address = `${local.trim().toLowerCase()}@${domains.find((d) => d.id === domainId)?.name ?? ''}`;

  const submit = async () => {
    setShowErrors(true);
    if (localErr || recErr) return;
    setBusy(true);
    setError(null);
    try {
      const id =
        kind === 'group'
          ? await api.createGroup({ name: local, domainId, description })
          : await api.createMailingList({ name: local, domainId, description, recipients: parsed.valid });
      await refresh();
      showSnack({ text: `${address} created` });
      onClose();
      nav(kind === 'group' ? `/admin/groups/${id}` : `/admin/lists/${id}`);
    } catch (e) {
      setError(adminErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={kind === 'group' ? 'Create a group' : 'Create a mailing list'}
      onClose={onClose}
      className="adm-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" disabled={busy || !domains.length} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dialog__text adm-dialog-intro">
          {kind === 'group'
            ? 'A group is a shared mailbox: mail to its address lands in one mailbox that every member can open from their own account.'
            : 'A mailing list forwards each message sent to its address to every recipient, inside or outside your domains.'}
        </p>
        <AddressField
          label={kind === 'group' ? 'Group address' : 'List address'}
          local={local}
          domainId={domainId}
          domains={domains}
          onLocal={setLocal}
          onDomain={setDomainId}
          error={showErrors ? localErr : null}
          autoFocus
        />
        <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        {kind === 'list' ? (
          <div className={`adm-field${showErrors && recErr ? ' adm-field--error' : ''}`}>
            <label className="adm-field__label" htmlFor="adm-recipients">
              Recipients
            </label>
            <textarea
              id="adm-recipients"
              className="adm-textarea"
              rows={4}
              value={recipients}
              placeholder="alice@example.com, bob@example.org"
              onChange={(e) => setRecipients(e.target.value)}
            />
            {showErrors && recErr ? (
              <div className="adm-field__error">{recErr}</div>
            ) : (
              <div className="adm-field__help">Separate addresses with commas or new lines. You can add more later.</div>
            )}
          </div>
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function GroupsTable() {
  const nav = useNavigate();
  const { data, isFetching, error } = useAccounts({ kind: 'Group', position: 0, limit: 500 });
  return (
    <>
      <LinearProgress active={isFetching} />
      {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : null}
      {data?.items.length ? (
        <table className="adm-table adm-table--click">
          <thead>
            <tr>
              <th>Group</th>
              <th>Description</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((g) => (
              <tr key={g.id} onClick={() => nav(`/admin/groups/${g.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/groups/${g.id}`)}>
                <td className="adm-strong">{g.emailAddress}</td>
                <td className="adm-sub">{g.description}</td>
                <td className="adm-sub">{new Date(g.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : data ? (
        <EmptyState icon="groups" title="No groups yet">
          Groups are shared mailboxes, like support@ or sales@, that several people can read.
        </EmptyState>
      ) : null}
    </>
  );
}

function ListsTable() {
  const nav = useNavigate();
  const { data, isFetching, error } = useMailingLists();
  return (
    <>
      <LinearProgress active={isFetching} />
      {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : null}
      {data?.length ? (
        <table className="adm-table adm-table--click">
          <thead>
            <tr>
              <th>Mailing list</th>
              <th>Description</th>
              <th>Recipients</th>
            </tr>
          </thead>
          <tbody>
            {data.map((l) => (
              <tr key={l.id} onClick={() => nav(`/admin/lists/${l.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/lists/${l.id}`)}>
                <td className="adm-strong">{l.emailAddress}</td>
                <td className="adm-sub">{l.description}</td>
                <td>{Object.keys(l.recipients ?? {}).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : data ? (
        <EmptyState icon="forward_to_inbox" title="No mailing lists yet">
          Mailing lists forward mail to a set of addresses, like everyone@ or board@.
        </EmptyState>
      ) : null}
    </>
  );
}

export function GroupsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'lists' ? 'lists' : 'groups';
  const [creating, setCreating] = useState<'group' | 'list' | null>(null);
  return (
    <div className="adm-page">
      <PageHeader
        title="Groups & mailing lists"
        subtitle="Shared mailboxes and distribution lists"
        actions={
          <Button variant="filled" icon={tab === 'groups' ? 'group_add' : 'add'} onClick={() => setCreating(tab === 'groups' ? 'group' : 'list')}>
            {tab === 'groups' ? 'Create group' : 'Create mailing list'}
          </Button>
        }
      />
      <Card className="adm-card--table">
        <div className="adm-tabs" role="tablist">
          {(
            [
              ['groups', 'Groups'],
              ['lists', 'Mailing lists'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={`adm-tab${tab === k ? ' adm-tab--on' : ''}`}
              onClick={() => setParams(k === 'lists' ? { tab: 'lists' } : {}, { replace: true })}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'groups' ? <GroupsTable /> : <ListsTable />}
      </Card>
      {creating ? <CreateDialog kind={creating} onClose={() => setCreating(null)} /> : null}
    </div>
  );
}
