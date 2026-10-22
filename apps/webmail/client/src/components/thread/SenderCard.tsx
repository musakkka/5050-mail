import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Popover } from '../ui/Menu';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/Button';
import { useComposeOpeners } from '../compose/openers';
import { useUi } from '../../state/ui';

/** Hover card for a sender (02-components §8.7): shows after ~500 ms over the avatar/name. */
export function SenderHover({ name, email, children }: { name: string | null; email: string; children: ReactNode }) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const leave = useRef<ReturnType<typeof setTimeout>>();
  const { compose } = useComposeOpeners();
  const showSnack = useUi((s) => s.showSnack);
  const nav = useNavigate();
  return (
    <span
      className="sender-hover"
      onMouseEnter={(e) => {
        clearTimeout(leave.current);
        const el = e.currentTarget;
        timer.current = setTimeout(() => setAnchor(el), 500);
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        leave.current = setTimeout(() => setAnchor(null), 300);
      }}
    >
      {children}
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="sender-card" autoFocus={false} label={`${name ?? email} contact card`}>
          <div onMouseEnter={() => clearTimeout(leave.current)} onMouseLeave={() => setAnchor(null)}>
            <div className="sender-card__top">
              <Avatar name={name} email={email} size={64} />
              <div className="sender-card__who">
                <div className="sender-card__name">{name || email}</div>
                <div className="sender-card__email">{email}</div>
              </div>
            </div>
            <div className="sender-card__actions">
              <IconButton icon="mail" label="Send email" onClick={() => (setAnchor(null), compose({ to: [{ name: name ?? '', email }] }))} />
              <IconButton icon="search" label="Search emails" onClick={() => (setAnchor(null), nav(`/mail/search/${encodeURIComponent(`from:${email}`)}`))} />
              <IconButton
                icon="content_copy"
                label="Copy email address"
                onClick={() => {
                  void navigator.clipboard?.writeText(email);
                  setAnchor(null);
                  showSnack({ text: 'Email address copied.' });
                }}
              />
            </div>
          </div>
        </Popover>
      ) : null}
    </span>
  );
}
