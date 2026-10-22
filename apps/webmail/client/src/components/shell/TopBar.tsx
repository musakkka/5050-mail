import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton, Button } from '../ui/Button';
import { BrandLogo } from '../ui/Logo';
import { Avatar } from '../ui/Avatar';
import { Menu, MenuDivider, MenuItem, Popover } from '../ui/Menu';
import { SearchBar } from './SearchBar';
import { useMail } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import { logout } from '../../api/auth';
import { queryClient } from '../../state/mail';

export function TopBar({ searchQuery }: { searchQuery: string | null }) {
  const nav = useNavigate();
  const { me } = useMail();
  const navCollapsed = useSettings((s) => s.navCollapsed);
  const setSettings = useSettings((s) => s.set);
  const quickOpen = useUi((s) => s.quickSettingsOpen);
  const setQuick = useUi((s) => s.setQuickSettings);
  const setMobileNav = useUi((s) => s.setMobileNavOpen);
  const openDialog = useUi((s) => s.openDialog);
  const [support, setSupport] = useState<Element | null>(null);
  const [account, setAccount] = useState<Element | null>(null);

  return (
    <header className="topbar">
      <div className="topbar__start">
        <IconButton
          icon="menu"
          label="Main menu"
          size={48}
          iconSize={24}
          aria-expanded={!navCollapsed}
          className="topbar__menu"
          onClick={() => {
            if (window.innerWidth < 600) setMobileNav(true);
            else setSettings({ navCollapsed: !navCollapsed });
          }}
        />
        <BrandLogo onClick={() => nav('/mail/inbox')} />
      </div>
      <div className="topbar__search">
        <SearchBar currentQuery={searchQuery} />
      </div>
      <div className="topbar__end">
        <IconButton icon="help" label="Support" size={48} iconSize={24} className="topbar__support" onClick={(e) => setSupport(e.currentTarget)} />
        <IconButton icon="settings" label="Settings" size={48} iconSize={24} active={quickOpen} onClick={() => setQuick(!quickOpen)} />
        <button
          type="button"
          className="topbar__avatar"
          aria-label={`Account: ${me.name} (${me.email})`}
          data-tooltip={`5050 Mail account\n${me.name}\n${me.email}`}
          onClick={(e) => setAccount(e.currentTarget)}
        >
          <Avatar name={me.name} email={me.email} size={32} />
        </button>
      </div>
      {support ? (
        <Menu anchor={support} onClose={() => setSupport(null)} placement="bottom-end">
          <MenuItem
            icon="help"
            label="Help"
            onSelect={() => (
              setSupport(null),
              openDialog({
                kind: 'alert',
                title: '5050 Mail help',
                body: '5050 Mail works like the webmail you already know. Press ? to see keyboard shortcuts, use the search bar with operators like from:, has:attachment or older_than:7d, and open Settings from the gear icon.',
              })
            )}
          />
          <MenuItem icon="keyboard" label="Keyboard shortcuts" hint="?" onSelect={() => (setSupport(null), openDialog({ kind: 'shortcuts' }))} />
          <MenuDivider />
          <MenuItem icon="settings" label="All settings" onSelect={() => (setSupport(null), nav('/mail/settings/general'))} />
        </Menu>
      ) : null}
      {account ? <AccountMenu anchor={account} onClose={() => setAccount(null)} /> : null}
    </header>
  );
}

function AccountMenu({ anchor, onClose }: { anchor: Element; onClose: () => void }) {
  const { me } = useMail();
  const nav = useNavigate();
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" className="account-menu" label="Account">
      <div className="account-menu__email">{me.email}</div>
      <div className="account-menu__avatar">
        <Avatar name={me.name} email={me.email} size={80} />
      </div>
      <div className="account-menu__hi">Hi, {me.name.split(' ')[0]}!</div>
      <div className="account-menu__actions">
        <Button variant="outlined" onClick={() => (onClose(), nav('/mail/settings/general'))}>
          Manage your 5050 Mail account
        </Button>
        {me.isAdmin ? (
          <Button variant="outlined" icon="admin_panel_settings" onClick={() => (onClose(), nav('/admin'))}>
            Admin console
          </Button>
        ) : null}
      </div>
      <div className="account-menu__signout">
        <Button
          variant="tonal"
          icon="logout"
          onClick={async () => {
            await logout();
            queryClient.clear();
            location.assign('/login');
          }}
        >
          Sign out
        </Button>
      </div>
      <div className="account-menu__footer">5050 Mail · on your own domains</div>
    </Popover>
  );
}
