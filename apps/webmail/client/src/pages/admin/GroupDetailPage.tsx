import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, IconButton } from '../../components/ui/Button';
import { Avatar } from '../../components/ui/Avatar';
import { LinearProgress } from '../../components/ui/Progress';
import { Icon } from '../../components/icons/Icon';
import { adminErrorMessage } from '../../admin/api';
import { useAccount, useAccounts, useAdmin, useAdminAction, useGroupMembers, useMailingList } from '../../admin/state';
import { AliasesCard } from './UserDetailPage';
import { splitAddresses } from './GroupsPage';
import { Banner, Card, ConfirmDeleteDialog, EmptyState, PageHeader, TextField } from './ui';

function DescriptionCard({ value, onSave, busy }: { value: string; onSave: (v: string) => void; busy: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <form
      className="adm-inline-add"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <TextField label="Description" value={v} onChange={(e) => setV(e.target.value)} />
      <Button variant="tonal" type="submit" disabled={busy || v === value}>
        Save
      </Button>
    </form>
  );
}

/** Search-as-you-type picker over users. */
function UserPicker({ exclude, onPick, disabled }: { exclude: Set<string>; onPick: (id: string) => void; disabled?: boolean }) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 200);
    return () => clearTimeout(t);
  }, [term]);
  const { data, isFetching } = useAccounts({ kind: 'User', search: debounced, position: 0, limit: 8 });
  const results = debounced ? (data?.items ?? []).filter((u) => !exclude.has(u.id)) : [];
  return (
    <div className="adm-picker">
      <label className="adm-search adm-search--field">
        <Icon name="person_add" size={20} />
        <input
          type="search"
          placeholder="Add members: search users by name or address"
          aria-label="Search users to add"
          value={term}
          disabled={disabled}
          onChange={(e) => setTerm(e.target.value)}
        />
      </label>
      {debounced ? (
        <ul className="adm-picker__results" role="listbox" aria-label="Matching users">
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="adm-picker__item"
                onClick={() => {
                  onPick(u.id);
                  setTerm('');
                }}
              >
                <Avatar name={u.description || u.name} email={u.emailAddress} size={28} />
                <span className="adm-strong">{u.description || u.name}</span>
                <span className="adm-sub">{u.emailAddress}</span>
                <Icon name="add" size={20} />
              </button>
            </li>
          ))}
          {!results.length && !isFetching ? <li className="adm-picker__none">No users match “{debounced}”</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function GroupDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { api } = useAdmin();
  const { data: group, isLoading, error } = useAccount(id);
  const { data: members = [] } = useGroupMembers(id);
  const { run, busy } = useAdminAction();
  const [deleting, setDeleting] = useState(false);

  if (isLoading) return <LinearProgress active />;
  if (error || !group || group['@type'] !== 'Group')
    return (
      <div className="adm-page">
        <PageHeader title="Group" back={() => nav('/admin/groups')} />
        {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : <EmptyState icon="groups" title="This group no longer exists" />}
      </div>
    );

  return (
    <div className="adm-page">
      <PageHeader
        back={() => nav('/admin/groups')}
        title={group.emailAddress}
        subtitle="Group · shared mailbox"
        actions={
          <Button variant="outlined" icon="delete" className="btn--danger-outline" onClick={() => setDeleting(true)}>
            Delete group
          </Button>
        }
      />
      <div className="adm-grid2">
        <Card title={`Members (${members.length})`} icon="groups" className="adm-span2">
          <p className="adm-muted">Members see this group's mailbox in their own account and can read and reply to its mail.</p>
          <UserPicker
            exclude={new Set(members.map((m) => m.id))}
            disabled={busy}
            onPick={(uid) => run(() => api.setMembership(uid, group.id, true), 'Member added')}
          />
          {members.length ? (
            <ul className="adm-list adm-list--people">
              {members.map((m) => (
                <li key={m.id} className="adm-list__item">
                  <button type="button" className="adm-person adm-person--link" onClick={() => nav(`/admin/users/${m.id}`)}>
                    <Avatar name={m.description || m.name} email={m.emailAddress} size={32} />
                    <span>
                      <span className="adm-strong">{m.description || m.name}</span>
                      <span className="adm-sub">{m.emailAddress}</span>
                    </span>
                  </button>
                  <IconButton
                    icon="person_remove"
                    label={`Remove ${m.emailAddress}`}
                    size={36}
                    disabled={busy}
                    onClick={() => run(() => api.setMembership(m.id, group.id, false), `${m.emailAddress} removed`)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="adm-sub adm-none">No members yet.</p>
          )}
        </Card>
        <Card title="Details" icon="info">
          <DescriptionCard
            value={group.description ?? ''}
            busy={busy}
            onSave={(v) => run(() => api.updateAccount(group.id, { description: v.trim() || null }), 'Description saved')}
          />
        </Card>
        <AliasesCard account={group} intro="Extra addresses that deliver to this group's mailbox." />
      </div>
      {deleting ? (
        <ConfirmDeleteDialog
          title={`Delete ${group.emailAddress}?`}
          confirmText={group.emailAddress}
          actionLabel="Delete group"
          body="The group's shared mailbox and all of its mail are permanently deleted. Members keep their own accounts."
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const ok = await run(() => api.deleteGroup(group.id), `${group.emailAddress} deleted`);
            if (ok) nav('/admin/groups');
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}

export function ListDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { api } = useAdmin();
  const { data: list, isLoading, error } = useMailingList(id);
  const { run, busy } = useAdminAction();
  const [adding, setAdding] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (isLoading) return <LinearProgress active />;
  if (error || !list)
    return (
      <div className="adm-page">
        <PageHeader title="Mailing list" back={() => nav('/admin/groups?tab=lists')} />
        {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : <EmptyState icon="forward_to_inbox" title="This list no longer exists" />}
      </div>
    );

  const recipients = Object.keys(list.recipients ?? {})
    .filter((r) => list.recipients[r])
    .sort();
  const add = async () => {
    const { valid, invalid } = splitAddresses(adding);
    if (invalid.length) return setAddErr(`Not an email address: ${invalid.slice(0, 3).join(', ')}`);
    if (!valid.length) return;
    setAddErr(null);
    const next = [...new Set([...recipients, ...valid])];
    if (await run(() => api.setRecipients(list.id, next), `${valid.length === 1 ? valid[0] : `${valid.length} recipients`} added`)) setAdding('');
  };

  return (
    <div className="adm-page">
      <PageHeader
        back={() => nav('/admin/groups?tab=lists')}
        title={list.emailAddress}
        subtitle="Mailing list · forwards to every recipient"
        actions={
          <Button variant="outlined" icon="delete" className="btn--danger-outline" onClick={() => setDeleting(true)}>
            Delete list
          </Button>
        }
      />
      <div className="adm-grid2">
        <Card title={`Recipients (${recipients.length})`} icon="forward_to_inbox" className="adm-span2">
          <form
            className="adm-inline-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <TextField
              label="Add recipients"
              value={adding}
              placeholder="name@example.com, other@example.org"
              error={addErr}
              autoComplete="off"
              onChange={(e) => setAdding(e.target.value)}
            />
            <Button variant="tonal" icon="add" type="submit" disabled={busy || !adding.trim()}>
              Add
            </Button>
          </form>
          {recipients.length ? (
            <ul className="adm-chips">
              {recipients.map((r) => (
                <li key={r} className="adm-rchip">
                  <span>{r}</span>
                  <IconButton
                    icon="close"
                    label={`Remove ${r}`}
                    size={24}
                    iconSize={16}
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          api.setRecipients(
                            list.id,
                            recipients.filter((x) => x !== r),
                          ),
                        `${r} removed`,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="adm-sub adm-none">No recipients yet. Mail sent to this list goes nowhere until you add some.</p>
          )}
        </Card>
        <Card title="Details" icon="info">
          <DescriptionCard
            value={list.description ?? ''}
            busy={busy}
            onSave={(v) => run(() => api.updateMailingList(list.id, { description: v.trim() || null }), 'Description saved')}
          />
        </Card>
        <AliasesCard account={list} object="MailingList" intro="Extra addresses that deliver to this list." />
      </div>
      {deleting ? (
        <ConfirmDeleteDialog
          title={`Delete ${list.emailAddress}?`}
          confirmText={list.emailAddress}
          actionLabel="Delete list"
          body="Mail sent to this address will bounce. Recipients aren't affected."
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const ok = await run(() => api.deleteMailingList(list.id), `${list.emailAddress} deleted`);
            if (ok) nav('/admin/groups?tab=lists');
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}
