import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Avatar } from '../../components/ui/Avatar';
import { LinearProgress } from '../../components/ui/Progress';
import { Icon } from '../../components/icons/Icon';
import { formatSize } from '../../lib/format';
import { adminErrorMessage } from '../../admin/api';
import { generatePassword, isAdminRole, isSuspended, quotaBytes, validateLocalPart, validatePassword } from '../../admin/model';
import { useAccounts, useAdmin, useDomains, useRefreshAdmin } from '../../admin/state';
import type { Account, UserRole } from '../../admin/types';
import { AddressField, Banner, Card, Chip, CopyButton, EmptyState, PageHeader, Pager, PasswordField, SelectField, TextField, copyText } from './ui';
import { loginDetailsText } from '../../admin/mailSettings';
import { useUi } from '../../state/ui';

const PAGE = 25;

export function StatusChip({ account }: { account: Account }) {
  return isSuspended(account.permissions) ? (
    <Chip tone="warning" icon="pause_circle">
      Suspended
    </Chip>
  ) : (
    <Chip tone="ok" icon="check_circle">
      Active
    </Chip>
  );
}

export function StorageCell({ account }: { account: Account }) {
  const quota = account.quotas?.maxDiskQuota;
  const used = account.usedDiskQuota ?? 0;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  return (
    <div className="adm-storage">
      <span>
        {formatSize(used)}
        {quota ? ` of ${formatSize(quota)}` : ''}
      </span>
      {quota ? (
        <span className={`adm-meter${pct > 90 ? ' adm-meter--hot' : ''}`}>
          <span style={{ width: `${pct}%` }} />
        </span>
      ) : (
        <span className="adm-sub">No limit</span>
      )}
    </div>
  );
}

function CreatedDialog({ email, password, onClose, onOpen }: { email: string; password: string; onClose: () => void; onOpen: () => void }) {
  const showSnack = useUi((s) => s.showSnack);
  return (
    <Dialog
      title="User added"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Done
          </Button>
          <Button variant="filled" onClick={onOpen}>
            Open user
          </Button>
        </>
      }
    >
      <p className="dialog__text">Share these sign-in details with the user. The password isn't shown again.</p>
      <div className="adm-creds">
        <div className="adm-creds__row">
          <span className="adm-creds__k">Email</span>
          <span className="adm-mono">{email}</span>
          <CopyButton text={email} what="Email" />
        </div>
        <div className="adm-creds__row">
          <span className="adm-creds__k">Password</span>
          <span className="adm-mono">{password}</span>
          <CopyButton text={password} what="Password" />
        </div>
      </div>
      <div className="adm-sending__actions">
        <Button
          variant="outlined"
          icon="content_copy"
          onClick={async () => {
            await copyText(loginDetailsText({ webmailUrl: window.location.origin, email, password }));
            showSnack({ text: 'Login details copied to clipboard', duration: 4000 });
          }}
        >
          Copy login details
        </Button>
      </div>
    </Dialog>
  );
}

function AddUserDialog({ onClose, defaultDomainId }: { onClose: () => void; defaultDomainId?: string }) {
  const { api } = useAdmin();
  const nav = useNavigate();
  const { data: domains = [] } = useDomains();
  const refresh = useRefreshAdmin();
  const [displayName, setDisplayName] = useState('');
  const [local, setLocal] = useState('');
  const [localTouched, setLocalTouched] = useState(false);
  const [domainId, setDomainId] = useState(defaultDomainId ?? domains[0]?.id ?? '');
  const [password, setPassword] = useState(() => generatePassword());
  const [role, setRole] = useState<UserRole>('User');
  const [quota, setQuota] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; email: string } | null>(null);
  useEffect(() => {
    if (!domainId && domains[0]) setDomainId(domains[0].id);
  }, [domains, domainId]);

  const errors = {
    local: validateLocalPart(local),
    password: validatePassword(password),
    quota: quota.trim() && !quotaBytes(quota) ? 'Enter a number of GB, or leave empty for no limit' : null,
    domain: domainId ? null : 'Add a domain first',
  };
  const invalid = Object.values(errors).some(Boolean);
  const domainName = domains.find((d) => d.id === domainId)?.name ?? '';

  const submit = async () => {
    setShowErrors(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.createUser({ name: local, domainId, description: displayName, password, role, quotaBytes: quotaBytes(quota) });
      await refresh();
      setCreated({ id, email: `${local.trim().toLowerCase()}@${domainName}` });
    } catch (e) {
      setError(adminErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (created)
    return <CreatedDialog email={created.email} password={password} onClose={onClose} onOpen={() => (onClose(), nav(`/admin/users/${created.id}`))} />;

  return (
    <Dialog
      title="Add a user"
      onClose={onClose}
      className="adm-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" disabled={busy} onClick={submit}>
            Add user
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
        <TextField
          label="Name"
          value={displayName}
          autoFocus
          autoComplete="off"
          onChange={(e) => {
            setDisplayName(e.target.value);
            if (!localTouched)
              setLocal(
                e.target.value
                  .trim()
                  .toLowerCase()
                  .normalize('NFKD')
                  .replace(/[̀-ͯ]/g, '')
                  .replace(/\s+/g, '.')
                  .replace(/[^a-z0-9._-]/g, ''),
              );
          }}
        />
        <AddressField
          label="Email address"
          local={local}
          domainId={domainId}
          domains={domains}
          onLocal={(v) => {
            setLocalTouched(true);
            setLocal(v);
          }}
          onDomain={setDomainId}
          error={showErrors ? (errors.local ?? errors.domain) : null}
        />
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          onGenerate={() => setPassword(generatePassword())}
          error={showErrors ? errors.password : null}
          help="A strong password is generated for you. You'll see it once more after the user is added."
        />
        <div className="adm-row2">
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="User">User</option>
            <option value="Admin">Administrator</option>
          </SelectField>
          <TextField
            label="Storage limit"
            value={quota}
            inputMode="decimal"
            placeholder="No limit"
            suffix={<span className="adm-unit">GB</span>}
            error={showErrors ? errors.quota : null}
            onChange={(e) => setQuota(e.target.value)}
          />
        </div>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { data: domains = [] } = useDomains();
  const search = params.get('q') ?? '';
  const domainId = params.get('domain') ?? '';
  const position = Number(params.get('pos') ?? 0) || 0;
  const [input, setInput] = useState(search);
  const [adding, setAdding] = useState(false);
  const { data, isFetching, error } = useAccounts({ kind: 'User', search, domainId: domainId || undefined, position, limit: PAGE });
  const domainName = (id: string) => domains.find((d) => d.id === id)?.name;

  const update = (p: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(p)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  // Debounced search-as-you-type.
  useEffect(() => {
    if (input === search) return;
    const t = setTimeout(() => update({ q: input.trim(), pos: '' }), 250);
    return () => clearTimeout(t);
  }, [input]);

  return (
    <div className="adm-page">
      <PageHeader
        title="Users"
        subtitle="Mailboxes and the people who sign in to them"
        actions={
          <Button variant="filled" icon="person_add" onClick={() => setAdding(true)} disabled={!domains.length}>
            Add a user
          </Button>
        }
      />
      <Card className="adm-card--table">
        <div className="adm-toolbar">
          <label className="adm-search">
            <Icon name="search" size={20} />
            <input
              type="search"
              placeholder="Search by name, address or alias"
              aria-label="Search users"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <div className="adm-filter">
            <select aria-label="Filter by domain" value={domainId} onChange={(e) => update({ domain: e.target.value, pos: '' })}>
              <option value="">All domains</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <Icon name="arrow_drop_down" size={24} className="adm-field__caret" />
          </div>
          <span className="admin__spacer" />
          {data ? <Pager position={position} limit={PAGE} total={data.total} onChange={(p) => update({ pos: p ? String(p) : '' })} /> : null}
        </div>
        <LinearProgress active={isFetching} />
        {error ? (
          <div className="adm-card__pad">
            <Banner tone="error">{adminErrorMessage(error)}</Banner>
          </div>
        ) : null}
        {data?.items.length ? (
          <table className="adm-table adm-table--click">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Storage used</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} onClick={() => nav(`/admin/users/${a.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/users/${a.id}`)}>
                  <td>
                    <div className="adm-person">
                      <Avatar name={a.description || a.name} email={a.emailAddress} size={32} />
                      <div>
                        <div className="adm-strong">{a.description || a.name}</div>
                        <div className="adm-sub">{a.emailAddress}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {isAdminRole(a) ? (
                      <Chip tone="primary" icon="admin_panel_settings">
                        Admin
                      </Chip>
                    ) : (
                      'User'
                    )}
                  </td>
                  <td>
                    <StatusChip account={a} />
                  </td>
                  <td>
                    <StorageCell account={a} />
                  </td>
                  <td className="adm-sub">{new Date(a.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : data ? (
          <EmptyState icon="person" title={search || domainId ? 'No matching users' : 'No users yet'}>
            {search ? `Nothing matches “${search}”${domainId ? ` on ${domainName(domainId)}` : ''}.` : null}
          </EmptyState>
        ) : null}
      </Card>
      {adding ? <AddUserDialog defaultDomainId={domainId || undefined} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
