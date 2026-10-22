import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, IconButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Avatar } from '../../components/ui/Avatar';
import { LinearProgress } from '../../components/ui/Progress';
import { formatSize } from '../../lib/format';
import { adminErrorMessage } from '../../admin/api';
import {
  aliasAddress,
  aliasList,
  generatePassword,
  isAdminRole,
  isSuspended,
  quotaBytes,
  quotaGb,
  validateLocalPart,
  validatePassword,
} from '../../admin/model';
import { useAccount, useAccounts, useAdmin, useAdminAction, useDomainMap, useDomains } from '../../admin/state';
import type { Account, EmailAlias } from '../../admin/types';
import { AddressField, Banner, Card, Chip, ConfirmDeleteDialog, CopyButton, EmptyState, PageHeader, PasswordField, SelectField, TextField } from './ui';
import { StatusChip } from './UsersPage';

function ResetPasswordDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { api } = useAdmin();
  const { run, busy } = useAdminAction();
  const [password, setPassword] = useState(() => generatePassword());
  const [done, setDone] = useState(false);
  const err = validatePassword(password);
  if (done)
    return (
      <Dialog
        title="Password changed"
        onClose={onClose}
        actions={
          <Button variant="filled" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="dialog__text">Share the new password with {account.description || account.emailAddress}. It isn't shown again.</p>
        <div className="adm-creds">
          <div className="adm-creds__row">
            <span className="adm-creds__k">Password</span>
            <span className="adm-mono">{password}</span>
            <CopyButton text={password} what="Password" />
          </div>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      title={`Reset password for ${account.emailAddress}`}
      onClose={onClose}
      className="adm-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            disabled={busy || !!err}
            onClick={async () => {
              if (await run(() => api.setPassword(account, password))) setDone(true);
            }}
          >
            Reset password
          </Button>
        </>
      }
    >
      <PasswordField
        label="New password"
        value={password}
        onChange={setPassword}
        onGenerate={() => setPassword(generatePassword())}
        error={err}
        help="The user's current password stops working immediately. App passwords are kept."
      />
    </Dialog>
  );
}

/** Alias editor for anything with an aliases objectList: users, groups and mailing lists. */
export function AliasesCard({
  account,
  object = 'Account',
  intro = 'Extra addresses that deliver to this mailbox. Aliases can be on any domain hosted here, and the user can sign in and send with them.',
}: {
  account: Pick<Account, 'id' | 'aliases' | 'domainId' | 'emailAddress'>;
  object?: 'Account' | 'MailingList';
  intro?: string;
}) {
  const { api } = useAdmin();
  const { data: domains = [] } = useDomains();
  const byId = useDomainMap();
  const { run, busy } = useAdminAction();
  const aliases = aliasList(account);
  const [local, setLocal] = useState('');
  const [domainId, setDomainId] = useState(account.domainId);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    const e = validateLocalPart(local);
    if (e) return setErr(e);
    const alias: EmailAlias = { name: local.trim().toLowerCase(), domainId };
    const address = aliasAddress(alias, byId);
    if (address === account.emailAddress || aliases.some((a) => aliasAddress(a, byId) === address)) return setErr('That address is already on this account');
    setErr(null);
    if (await run(() => api.setAliases(account.id, [...aliases, alias], object), `${address} added`)) setLocal('');
  };
  return (
    <Card title="Email aliases" icon="alternate_email">
      <p className="adm-muted">{intro}</p>
      {aliases.length ? (
        <ul className="adm-list">
          {aliases.map((a, i) => {
            const address = aliasAddress(a, byId);
            return (
              <li key={`${address}-${i}`} className="adm-list__item">
                <span className="adm-mono">{address}</span>
                <IconButton
                  icon="close"
                  label={`Remove ${address}`}
                  size={32}
                  iconSize={18}
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api.setAliases(
                          account.id,
                          aliases.filter((_, j) => j !== i),
                          object,
                        ),
                      `${address} removed`,
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="adm-sub adm-none">No aliases.</p>
      )}
      <form
        className="adm-inline-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <AddressField label="Add an alias" local={local} domainId={domainId} domains={domains} onLocal={setLocal} onDomain={setDomainId} error={err} />
        <Button variant="tonal" icon="add" disabled={busy || !local.trim()} onClick={add}>
          Add alias
        </Button>
      </form>
    </Card>
  );
}

function GroupsCard({ account }: { account: Account }) {
  const { api } = useAdmin();
  const nav = useNavigate();
  const { run, busy } = useAdminAction();
  const { data: groups } = useAccounts({ kind: 'Group', position: 0, limit: 500 });
  const [pick, setPick] = useState('');
  const memberOf = new Set(Object.keys(account.memberGroupIds ?? {}).filter((id) => account.memberGroupIds![id]));
  const all = groups?.items ?? [];
  const mine = all.filter((g) => memberOf.has(g.id));
  const others = all.filter((g) => !memberOf.has(g.id));
  return (
    <Card title="Groups" icon="groups">
      {mine.length ? (
        <ul className="adm-list">
          {mine.map((g) => (
            <li key={g.id} className="adm-list__item">
              <button type="button" className="link-btn adm-mono" onClick={() => nav(`/admin/groups/${g.id}`)}>
                {g.emailAddress}
              </button>
              <IconButton
                icon="close"
                label={`Remove from ${g.emailAddress}`}
                size={32}
                iconSize={18}
                disabled={busy}
                onClick={() => run(() => api.setMembership(account.id, g.id, false), `Removed from ${g.emailAddress}`)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-sub adm-none">Not a member of any group.</p>
      )}
      {others.length ? (
        <div className="adm-inline-add">
          <SelectField label="Add to group" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a group…</option>
            {others.map((g) => (
              <option key={g.id} value={g.id}>
                {g.emailAddress}
              </option>
            ))}
          </SelectField>
          <Button
            variant="tonal"
            icon="group_add"
            disabled={!pick || busy}
            onClick={async () => {
              const g = others.find((x) => x.id === pick);
              if (await run(() => api.setMembership(account.id, pick, true), `Added to ${g?.emailAddress ?? 'group'}`)) setPick('');
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { api, me } = useAdmin();
  const { data: account, isLoading, error } = useAccount(id);
  const { run, busy } = useAdminAction();
  const [name, setName] = useState('');
  const [quota, setQuota] = useState('');
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!account) return;
    setName(account.description ?? '');
    setQuota(quotaGb(account.quotas?.maxDiskQuota));
  }, [account]);

  if (isLoading) return <LinearProgress active />;
  if (error || !account || account['@type'] !== 'User')
    return (
      <div className="adm-page">
        <PageHeader title="User" back={() => nav('/admin/users')} />
        {error ? <Banner tone="error">{adminErrorMessage(error)}</Banner> : <EmptyState icon="person" title="This user no longer exists" />}
      </div>
    );

  const self = account.emailAddress.toLowerCase() === me.email.toLowerCase();
  const suspended = isSuspended(account.permissions);
  const admin = isAdminRole(account);
  const quotaLimit = account.quotas?.maxDiskQuota;
  const quotaErr = quota.trim() && !quotaBytes(quota) ? 'Enter a number of GB, or leave empty for no limit' : null;
  const pct = quotaLimit ? Math.min(100, (account.usedDiskQuota / quotaLimit) * 100) : 0;

  return (
    <div className="adm-page">
      <PageHeader
        back={() => nav('/admin/users')}
        title={
          <span className="adm-person adm-person--lg">
            <Avatar name={account.description || account.name} email={account.emailAddress} size={48} />
            <span>
              {account.description || account.name}
              <span className="adm-head__email">{account.emailAddress}</span>
            </span>
          </span>
        }
        subtitle={
          <>
            <StatusChip account={account} />{' '}
            {admin ? (
              <Chip tone="primary" icon="admin_panel_settings">
                Administrator
              </Chip>
            ) : null}{' '}
            {self ? <Chip>You</Chip> : null}
          </>
        }
        actions={
          <>
            <Button variant="outlined" icon="password" onClick={() => setResetting(true)}>
              Reset password
            </Button>
            <Button
              variant="outlined"
              icon={suspended ? 'play_circle' : 'pause_circle'}
              disabled={busy || self}
              title={self ? "You can't suspend your own account" : undefined}
              onClick={() =>
                run(() => api.setSuspended(account, !suspended), suspended ? `${account.emailAddress} reactivated` : `${account.emailAddress} suspended`)
              }
            >
              {suspended ? 'Reactivate' : 'Suspend'}
            </Button>
            <Button
              variant="outlined"
              icon="delete"
              className="btn--danger-outline"
              disabled={self}
              title={self ? "You can't delete your own account" : undefined}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </>
        }
      />
      {suspended ? (
        <Banner tone="warning" icon="pause_circle">
          This user is suspended: they can't sign in (webmail, IMAP, SMTP), but mail sent to them is still delivered.
        </Banner>
      ) : null}

      <div className="adm-grid2">
        <Card title="User information" icon="person">
          <form
            className="adm-inline-add"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.setDisplayName(account.id, name), 'Name saved');
            }}
          >
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button variant="tonal" disabled={busy || name === (account.description ?? '')} type="submit">
              Save
            </Button>
          </form>
          <ul className="adm-kv">
            <li>
              <span>Primary address</span>
              <span className="adm-mono">{account.emailAddress}</span>
            </li>
            <li>
              <span>Created</span>
              <span className="adm-sub">{new Date(account.createdAt).toLocaleString()}</span>
            </li>
          </ul>
        </Card>

        <Card title="Role & storage" icon="admin_panel_settings">
          <SelectField
            label="Role"
            value={admin ? 'Admin' : account.roles['@type'] === 'Custom' ? 'Custom' : 'User'}
            disabled={busy || self || account.roles['@type'] === 'Custom'}
            help={
              self
                ? "You can't change your own role."
                : account.roles['@type'] === 'Custom'
                  ? 'This account uses custom roles, managed in the server settings.'
                  : 'Administrators can manage domains, users and groups.'
            }
            onChange={(e) => run(() => api.setRole(account.id, e.target.value as 'User' | 'Admin'), 'Role updated')}
          >
            <option value="User">User</option>
            <option value="Admin">Administrator</option>
            {account.roles['@type'] === 'Custom' ? <option value="Custom">Custom</option> : null}
          </SelectField>
          <div className="adm-storage adm-storage--wide">
            <span>
              {formatSize(account.usedDiskQuota ?? 0)} used{quotaLimit ? ` of ${formatSize(quotaLimit)}` : ''}
            </span>
            {quotaLimit ? (
              <span className={`adm-meter${pct > 90 ? ' adm-meter--hot' : ''}`}>
                <span style={{ width: `${pct}%` }} />
              </span>
            ) : null}
          </div>
          <form
            className="adm-inline-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!quotaErr) void run(() => api.setQuota(account, quotaBytes(quota)), 'Storage limit saved');
            }}
          >
            <TextField
              label="Storage limit"
              value={quota}
              inputMode="decimal"
              placeholder="No limit"
              suffix={<span className="adm-unit">GB</span>}
              error={quotaErr}
              onChange={(e) => setQuota(e.target.value)}
            />
            <Button variant="tonal" type="submit" disabled={busy || !!quotaErr || quota === quotaGb(quotaLimit)}>
              Save
            </Button>
          </form>
        </Card>

        <AliasesCard account={account} />
        <GroupsCard account={account} />
      </div>

      {resetting ? <ResetPasswordDialog account={account} onClose={() => setResetting(false)} /> : null}
      {deleting ? (
        <ConfirmDeleteDialog
          title={`Delete ${account.emailAddress}?`}
          confirmText={account.emailAddress}
          actionLabel="Delete user"
          body={<>The mailbox, all of its mail, contacts and calendars, and its aliases are permanently deleted. This can't be undone.</>}
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const ok = await run(() => api.deleteAccount(account.id), `${account.emailAddress} deleted`);
            if (ok) nav('/admin/users');
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}
