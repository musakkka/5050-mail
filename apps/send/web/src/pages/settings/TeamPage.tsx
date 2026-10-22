import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Plug } from 'lucide-react';
import { Tabs as T } from '@base-ui/react/tabs';
import { teams } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Member, OAuthGrant } from '@/api/types';
import { TeamAvatar } from '@/components/brand/BrandMark';
import { Badge } from '@/components/ui/Badge';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { ErrorState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/ListControls';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { TAB_CLASS } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast, toastError } from '@/components/ui/toast';
import { format } from 'date-fns';
import { timeAgoLong } from '@/lib/format';
import { useSession } from '@/state/session';
import { SettingsCard, SettingsLayout } from './SettingsLayout';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES = [
  { value: 'admin' as const, label: 'Admin', description: 'Invite and remove members, manage API keys and team settings.' },
  { value: 'member' as const, label: 'Member', description: 'Manage emails, domains, and webhooks.' },
];

function RoleRadio({ value, onChange }: { value: 'admin' | 'member'; onChange: (v: 'admin' | 'member') => void }) {
  return (
    <div role="radiogroup" aria-label="Role">
      {ROLES.map((r) => (
        <label key={r.value} className="flex cursor-pointer gap-2 pb-6 last:pb-5">
          <input type="radio" name="role" value={r.value} checked={value === r.value} onChange={() => onChange(r.value)} className="peer sr-only" />
          <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 rounded-full border border-gray-4 peer-focus-visible:ring-2 peer-focus-visible:ring-focus">
            {value === r.value ? <span className="m-auto block h-2 w-2 rounded-full bg-gray-12" /> : null}
          </span>
          <span className="block text-sm text-default">
            <span className="block text-sm font-semibold text-emphasis">{r.label}</span>
            <span className="text-sm font-normal text-default">{r.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState<string | null>(null);
  const add = useTeamMutation((t, v: { email: string; role: 'admin' | 'member' }) => teams.addMember(t, v.email, v.role), [['members']], {
    silent: true,
    onSuccess: (_r, v) => {
      toast.success(`${v.email} was added to the team`);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setError(null);
    }
  }, [open]);
  const valid = EMAIL_RE.test(email.trim());
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || add.isPending) return;
    setError(null);
    add.mutate({ email: email.trim().toLowerCase(), role }, { onError: (err) => setError(err.message) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Invite a team member" onSubmit={submit}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="invite-email" className="text-sm text-default">
            Email address
          </label>
          <Input id="invite-email" type="email" autoComplete="off" placeholder="ada.lovelace@example.com" value={email} invalid={!!error} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <p className="text-xs text-muted">They sign in with this 5050 Mail address.</p>
        </div>
        <div className="mt-4 flex flex-col gap-4">
          <span className="text-sm text-default">Select role</span>
          <RoleRadio value={role} onChange={setRole} />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        <div className="flex items-center">
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!valid} loading={add.isPending}>
            Invite
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CreateTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { setTeam } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const t = await teams.create({ name: n });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setTeam(t.id);
      toast.success(`Team ${t.name} created`);
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Create team" onSubmit={() => void submit()}>
      <form onSubmit={submit}>
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="team-new-name" className="text-sm text-default">
            Team name
          </label>
          <Input id="team-new-name" maxLength={100} placeholder="acme-production" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <p className="text-xs text-muted">New teams start with the default quotas. You become its admin.</p>
        </div>
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!name.trim()} loading={busy}>
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

function Overview() {
  const { team, canManage } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState(team.name);
  useEffect(() => setName(team.name), [team.name, team.id]);
  const save = useTeamMutation((t, n: string) => teams.update(t, { name: n }), [], {
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Team name updated');
    },
  });
  const dirty = name.trim() !== team.name && name.trim().length > 0;
  return (
    <SettingsCard
      title="Overview"
      bodyClassName="p-0"
      footer={
        <Button type="submit" form="team-overview" disabled={!dirty || !canManage} loading={save.isPending}>
          Save
        </Button>
      }
    >
      <div className="mb-2 flex max-w-md flex-col gap-2 p-4">
        <span className="text-sm text-default">Avatar</span>
        <div className="flex items-center gap-4">
          <TeamAvatar size={80} className="rounded-3xl" />
          <p className="text-xs text-default font-normal max-w-60">Every team uses the 5050 mark. Team names tell them apart.</p>
        </div>
      </div>
      <form
        id="team-overview"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && canManage) save.mutate(name.trim());
        }}
      >
        <div className="mb-2 flex max-w-md flex-col gap-2 p-4">
          <label htmlFor="team-name" className="text-sm text-default">
            Team name
          </label>
          <Input id="team-name" maxLength={100} placeholder="Your team name" value={name} readOnly={!canManage} onChange={(e) => setName(e.target.value)} />
          {!canManage ? <p className="text-xs text-muted">Only team admins can rename the team.</p> : null}
        </div>
      </form>
    </SettingsCard>
  );
}

function MemberRow({ m, adminCount }: { m: Member; adminCount: number }) {
  const { me, canManage, team } = useSession();
  const [confirm, setConfirm] = useState(false);
  const self = m.email === me.email;
  const setRole = useTeamMutation((t, role: 'admin' | 'member') => teams.setRole(t, m.email, role), [['members']], {
    onSuccess: (_r, role) => toast.success(`${m.email} is now ${role === 'admin' ? 'an admin' : 'a member'}`),
  });
  const remove = useTeamMutation((t) => teams.removeMember(t, m.email), [['members']], {
    onSuccess: () => {
      setConfirm(false);
      toast.success(self ? `You left ${team.name}` : `${m.email} was removed`);
      if (self) window.location.assign('/emails');
    },
  });
  const lastAdmin = m.role === 'admin' && adminCount <= 1;
  return (
    <div className="relative flex w-full items-center justify-between gap-2 p-4">
      <div className="w-72 min-w-0 md:w-[unset] md:flex-1">
        <div className="mb-1 min-w-0">
          <p className="truncate text-sm text-emphasis font-semibold" translate="no" title={m.email}>
            {m.email}
            {self ? <span className="ml-1.5 font-normal text-muted">(you)</span> : null}
          </p>
        </div>
        <p className="text-xs text-default font-normal">Joined on {format(new Date(m.created_at), 'MMM dd, yyyy')}</p>
      </div>
      <div className="w-20 shrink-0 md:w-[unset] md:flex-1">
        <Badge>{m.role}</Badge>
      </div>
      <div className="hidden w-40 min-w-0 md:flex md:flex-1">
        <span className="truncate text-sm text-default" title={m.added_by ?? undefined}>
          {m.added_by ?? '—'}
        </span>
      </div>
      <div className="flex w-10 shrink-0 items-center justify-end md:absolute md:right-4 md:h-6 md:w-6">
        {canManage || self ? (
          <Menu
            align="end"
            className="w-52"
            trigger={
              <button type="button" aria-label={`More actions for ${m.email}`} className={iconButtonClass('ghost', '2')}>
                <span className="inline-flex items-center justify-center opacity-100">
                  <Ellipsis size={12} strokeWidth={3} />
                </span>
              </button>
            }
          >
            {canManage ? (
              <>
                <MenuItem disabled={m.role === 'admin'} onClick={() => setRole.mutate('admin')}>
                  Make admin
                </MenuItem>
                <MenuItem disabled={m.role === 'member' || lastAdmin} onClick={() => setRole.mutate('member')}>
                  Make member
                </MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem danger disabled={lastAdmin} onClick={() => setConfirm(true)}>
              {self ? 'Leave team' : 'Remove from team'}
            </MenuItem>
          </Menu>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={self ? 'Leave team' : 'Remove member'}
        description={
          self ? (
            <>You will lose access to {team.name}.</>
          ) : (
            <>
              <span className="break-all text-emphasis">{m.email}</span> will lose access to {team.name}.
            </>
          )
        }
        confirmLabel={self ? 'Leave' : 'Remove'}
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}

function Members({ q }: { q: string }) {
  const members = useTeamQuery(['members'], (t) => teams.members(t));
  const rows = useMemo(() => (members.data?.data ?? []).filter((m) => !q || m.email.toLowerCase().includes(q.toLowerCase())), [members.data, q]);
  const admins = (members.data?.data ?? []).filter((m) => m.role === 'admin').length;
  if (members.error) return <ErrorState className="m-4" error={members.error} onRetry={() => void members.refetch()} />;
  return (
    <div className="min-w-[560px] md:min-w-0">
      <div className="flex w-full items-center justify-between gap-2 px-4 pt-8 pb-1">
        <div className="w-72 md:w-[unset] md:flex-1">
          <p className="text-xs text-default font-normal">Email</p>
        </div>
        <div className="w-20 md:w-[unset] md:flex-1">
          <p className="text-xs text-default font-normal">Role</p>
        </div>
        <div className="hidden w-40 md:block md:flex-1">
          <p className="text-xs text-default font-normal">Added by</p>
        </div>
        <div className="w-10 md:hidden" />
      </div>
      <div className="grid divide-y divide-gray-2">
        {members.isPending ? (
          [0, 1].map((i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="h-9 w-64" />
              <Skeleton className="h-6 w-16" />
            </div>
          ))
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-default">{q ? `No members match “${q}”.` : 'No members yet.'}</p>
        ) : (
          rows.map((m) => <MemberRow key={m.email} m={m} adminCount={admins} />)
        )}
      </div>
    </div>
  );
}

function GrantRow({ g }: { g: OAuthGrant }) {
  const { canManage } = useSession();
  const [confirm, setConfirm] = useState(false);
  const revoke = useTeamMutation((t) => teams.revokeGrant(t, g.id), [['grants']], {
    onSuccess: () => {
      setConfirm(false);
      toast.success(`${g.client_name} was disconnected`);
    },
  });
  return (
    <div className="flex items-center justify-between gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-interactive bg-interactive text-default">
          <Plug size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-emphasis" title={g.client_name}>
            {g.client_name}
          </p>
          <p className="truncate text-xs text-default">
            {g.scopes.join(', ') || 'No scopes'} · Authorized {timeAgoLong(g.created_at)}
            {g.last_used_at ? ` · Last used ${timeAgoLong(g.last_used_at)}` : ''}
          </p>
        </div>
      </div>
      <Tooltip content={canManage ? undefined : 'Only team admins can revoke apps'}>
        <span>
          <Button size="1" variant="danger" disabled={!canManage} onClick={() => setConfirm(true)}>
            Revoke
          </Button>
        </span>
      </Tooltip>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Revoke access"
        description={<>{g.client_name} will no longer be able to act on this team.</>}
        confirmLabel="Revoke"
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate(undefined)}
      />
    </div>
  );
}

function AuthorizedApps({ q }: { q: string }) {
  const grants = useTeamQuery(['grants'], (t) => teams.grants(t));
  const rows = (grants.data?.data ?? []).filter((g) => !q || g.client_name.toLowerCase().includes(q.toLowerCase()));
  if (grants.error) return <ErrorState className="m-4" error={grants.error} onRetry={() => void grants.refetch()} />;
  if (grants.isPending)
    return (
      <div className="p-4">
        <Skeleton className="h-10 w-full" />
      </div>
    );
  if (!rows.length)
    return (
      <div className="flex flex-col items-center justify-center gap-8 overflow-hidden rounded-2xl px-6 py-12">
        <div className="flex max-w-md flex-col gap-2 text-center">
          <h3 className="text-xl tracking-[-0.16px] text-emphasis font-bold">{q ? 'No matching apps' : 'No authorized apps'}</h3>
          <span className="text-sm text-default font-normal text-balance break-words">
            When someone on this team authorizes a third-party app, their consent will appear here.
          </span>
        </div>
      </div>
    );
  return (
    <div className="mt-4 grid divide-y divide-gray-2">
      {rows.map((g) => (
        <GrantRow key={g.id} g={g} />
      ))}
    </div>
  );
}

export function TeamPage() {
  const { canManage, me } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'authorized-apps' ? 'apps' : 'members';
  const [q, setQ] = useState('');
  const [invite, setInvite] = useState(false);
  const createOpen = params.get('create') === '1' && me.isAdmin;
  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v === null) n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
  };
  return (
    <SettingsLayout title="Team">
      <Overview />
      <section className="relative overflow-x-auto overflow-y-hidden rounded-3xl border border-default pb-4">
        <T.Root value={tab} onValueChange={(v) => setParam('tab', v === 'apps' ? 'authorized-apps' : null)}>
          <div className="flex w-full flex-wrap items-center justify-between gap-3 p-4 pb-2">
            <T.List className="flex flex-nowrap items-center gap-2 p-1 -m-1 shrink-0">
              <T.Tab value="members" className={TAB_CLASS}>
                Members
              </T.Tab>
              <T.Tab value="apps" className={TAB_CLASS}>
                Authorized apps
              </T.Tab>
            </T.List>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <SearchInput value={q} onChange={setQ} className="min-w-0 flex-1 sm:w-56 sm:flex-none" />
              {tab === 'members' ? (
                <Tooltip content={canManage ? undefined : 'Only team admins can invite members'}>
                  <span className="inline-flex">
                    <Button onClick={() => setInvite(true)} disabled={!canManage}>
                      Invite
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
            </div>
          </div>
          <T.Panel value="members" className="outline-hidden">
            <Members q={q} />
          </T.Panel>
          <T.Panel value="apps" className="outline-hidden">
            <AuthorizedApps q={q} />
          </T.Panel>
        </T.Root>
      </section>
      <SettingsCard title="Exports" footer={<Button onClick={() => window.location.assign('/emails')}>Go to emails</Button>}>
        <p className="text-sm text-default font-normal">Export emails, contacts and logs as CSV from the download button on each list.</p>
      </SettingsCard>
      <InviteDialog open={invite} onOpenChange={setInvite} />
      <CreateTeamDialog open={createOpen} onOpenChange={(o) => !o && setParam('create', null)} />
    </SettingsLayout>
  );
}
