import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { BrandMark } from '../components/ui/Logo';
import { Button } from '../components/ui/Button';
import { Avatar } from '../components/ui/Avatar';
import { Icon, type IconKey } from '../components/icons/Icon';
import { Snackbar } from '../components/ui/Snackbar';
import { LinearProgress } from '../components/ui/Progress';
import { AdminProvider } from '../admin/state';
import { OverviewPage } from './admin/OverviewPage';
import { DomainsPage } from './admin/DomainsPage';
import { DomainDetailPage } from './admin/DomainDetailPage';
import { UsersPage } from './admin/UsersPage';
import { UserDetailPage } from './admin/UserDetailPage';
import { GroupsPage } from './admin/GroupsPage';
import { GroupDetailPage, ListDetailPage } from './admin/GroupDetailPage';
import type { Me } from '../api/auth';

/** Shown to signed-in users without admin rights. */
function NotAuthorized({ me }: { me: Me }) {
  const nav = useNavigate();
  return (
    <div className="admin admin--denied">
      <div className="adm-denied">
        <BrandMark height={40} />
        <h1>You don't have access to the admin console</h1>
        <p>
          You're signed in as <strong>{me.email}</strong>, which isn't an administrator account. If you need to manage domains or users, ask an administrator to
          give your account the admin role.
        </p>
        <Button variant="filled" icon="mail" onClick={() => nav('/mail/inbox')}>
          Back to mail
        </Button>
      </div>
    </div>
  );
}

const NAV: { to: string; label: string; icon: IconKey; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', icon: 'dashboard', end: true },
  { to: '/admin/domains', label: 'Domains', icon: 'domain' },
  { to: '/admin/users', label: 'Users', icon: 'person' },
  { to: '/admin/groups', label: 'Groups & lists', icon: 'groups' },
];

function AdminShell({ me }: { me: Me }) {
  const nav = useNavigate();
  return (
    <div className="admin">
      <header className="admin__bar">
        <button type="button" className="admin__brand" onClick={() => nav('/admin')} aria-label="Admin console home">
          <BrandMark height={28} title="5050 Mail" />
          <span className="admin__title">
            <span className="admin__title-strong">Admin</span>
          </span>
        </button>
        <span className="admin__spacer" />
        <Button variant="text" icon="mail" onClick={() => nav('/mail/inbox')}>
          Back to mail
        </Button>
        <span className="admin__me" title={me.email}>
          <Avatar name={me.name} email={me.email} size={32} />
        </span>
      </header>
      <div className="admin__body">
        <nav className="adm-nav" aria-label="Admin sections">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `adm-nav__item${isActive ? ' adm-nav__item--on' : ''}`}>
              {({ isActive }) => (
                <>
                  <Icon name={n.icon} size={20} fill={isActive} />
                  <span>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <main className="admin__main">
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="domains" element={<DomainsPage />} />
            <Route path="domains/:id" element={<DomainDetailPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="groups/:id" element={<GroupDetailPage />} />
            <Route path="lists/:id" element={<ListDetailPage />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
      </div>
      <Snackbar />
    </div>
  );
}

/**
 * Admin console. The client-side gate is only cosmetic: every call goes
 * through the user's own session and Stalwart refuses non-admins.
 */
export function AdminPage({ me }: { me: Me }) {
  if (!me.isAdmin) return <NotAuthorized me={me} />;
  return (
    <AdminProvider
      me={me}
      fallback={
        <div className="admin">
          <LinearProgress active />
        </div>
      }
    >
      <AdminShell me={me} />
    </AdminProvider>
  );
}
