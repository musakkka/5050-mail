/** Small building blocks shared by the admin pages (Google Admin–style cards, fields, chips). */
import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Button, IconButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Icon, type IconKey } from '../../components/icons/Icon';
import { useUi } from '../../state/ui';
import type { Health } from '../../admin/model';

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: () => void }) {
  return (
    <header className="adm-head">
      {back ? <IconButton icon="arrow_back" label="Back" onClick={back} /> : null}
      <div className="adm-head__text">
        <h1 className="adm-head__title">{title}</h1>
        {subtitle ? <div className="adm-head__sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="adm-head__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  icon?: IconKey;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`adm-card${className ? ` ${className}` : ''}`}>
      {title ? (
        <div className="adm-card__head">
          {icon ? <Icon name={icon} size={20} className="adm-card__icon" /> : null}
          <h2 className="adm-card__title">{title}</h2>
          {actions ? <div className="adm-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="adm-card__body">{children}</div>
    </section>
  );
}

const HEALTH_ICON: Record<Health['state'], IconKey> = {
  ok: 'check_circle',
  pending: 'hourglass_top',
  warning: 'warning',
  error: 'error',
  off: 'remove',
};

export function HealthChip({ health, compact }: { health: Health; compact?: boolean }) {
  return (
    <span className={`adm-chip adm-chip--${health.state}`} title={compact ? health.detail : undefined}>
      <Icon name={HEALTH_ICON[health.state]} size={16} fill={health.state !== 'off' && health.state !== 'pending'} />
      {health.label}
    </span>
  );
}

export function Chip({ tone = 'neutral', icon, children }: { tone?: 'neutral' | 'ok' | 'warning' | 'error' | 'primary'; icon?: IconKey; children: ReactNode }) {
  return (
    <span className={`adm-chip adm-chip--${tone}`}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </span>
  );
}

/** Outlined text field (GM3), label above-inline like Google Admin forms. */
export function TextField({
  label,
  help,
  error,
  suffix,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: ReactNode; error?: string | null; suffix?: ReactNode }) {
  const id = useId();
  return (
    <div className={`adm-field${error ? ' adm-field--error' : ''}${className ? ` ${className}` : ''}`}>
      <label className="adm-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="adm-field__box">
        <input id={id} className="adm-field__input" aria-invalid={!!error} {...rest} />
        {suffix ? <span className="adm-field__suffix">{suffix}</span> : null}
      </div>
      {error ? <div className="adm-field__error">{error}</div> : help ? <div className="adm-field__help">{help}</div> : null}
    </div>
  );
}

export function SelectField({
  label,
  help,
  error,
  children,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <div className={`adm-field${error ? ' adm-field--error' : ''}${className ? ` ${className}` : ''}`}>
      <label className="adm-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="adm-field__box">
        <select id={id} className="adm-field__input adm-field__select" {...rest}>
          {children}
        </select>
        <Icon name="arrow_drop_down" size={24} className="adm-field__caret" />
      </div>
      {error ? <div className="adm-field__error">{error}</div> : help ? <div className="adm-field__help">{help}</div> : null}
    </div>
  );
}

/** `local` @ `domain` input pair used for addresses, aliases, groups and lists. */
export function AddressField({
  label,
  local,
  domainId,
  domains,
  onLocal,
  onDomain,
  error,
  help,
  autoFocus,
}: {
  label: string;
  local: string;
  domainId: string;
  domains: { id: string; name: string }[];
  onLocal: (v: string) => void;
  onDomain: (v: string) => void;
  error?: string | null;
  help?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className={`adm-field${error ? ' adm-field--error' : ''}`}>
      <label className="adm-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="adm-address">
        <div className="adm-field__box adm-address__local">
          <input
            id={id}
            className="adm-field__input"
            value={local}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(e) => onLocal(e.target.value)}
          />
        </div>
        <span className="adm-address__at">@</span>
        <div className="adm-field__box adm-address__domain">
          <select className="adm-field__input adm-field__select" aria-label={`${label} domain`} value={domainId} onChange={(e) => onDomain(e.target.value)}>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <Icon name="arrow_drop_down" size={24} className="adm-field__caret" />
        </div>
      </div>
      {error ? <div className="adm-field__error">{error}</div> : help ? <div className="adm-field__help">{help}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`adm-switch${checked ? ' adm-switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="adm-switch__thumb">{checked ? <Icon name="check" size={16} /> : null}</span>
    </button>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  const showSnack = useUi((s) => s.showSnack);
  return (
    <IconButton
      icon="content_copy"
      label={label}
      size={32}
      iconSize={18}
      onClick={async () => {
        await copyText(text);
        showSnack({ text: `${what ?? 'Value'} copied to clipboard`, duration: 4000 });
      }}
    />
  );
}

export function EmptyState({ icon, title, children, action }: { icon: IconKey; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="adm-empty">
      <Icon name={icon} size={48} />
      <div className="adm-empty__title">{title}</div>
      {children ? <div className="adm-empty__text">{children}</div> : null}
      {action}
    </div>
  );
}

export function Pager({ position, limit, total, onChange }: { position: number; limit: number; total: number; onChange: (pos: number) => void }) {
  const first = total ? position + 1 : 0;
  const last = Math.min(position + limit, total);
  return (
    <div className="adm-pager">
      <span className="adm-pager__range">
        {first}–{last} of {total}
      </span>
      <IconButton icon="chevron_left" label="Previous page" disabled={position === 0} onClick={() => onChange(Math.max(0, position - limit))} />
      <IconButton icon="chevron_right" label="Next page" disabled={last >= total} onClick={() => onChange(position + limit)} />
    </div>
  );
}

export function Banner({ tone = 'info', icon, children }: { tone?: 'info' | 'warning' | 'error'; icon?: IconKey; children: ReactNode }) {
  return (
    <div className={`adm-banner adm-banner--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'info' ? 'info' : tone)} size={20} fill />
      <div className="adm-banner__text">{children}</div>
    </div>
  );
}

/** Destructive confirmation that requires typing the object's name (Google Admin pattern). */
export function ConfirmDeleteDialog({
  title,
  body,
  confirmText,
  actionLabel = 'Delete',
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmText: string;
  actionLabel?: string;
  onConfirm: () => Promise<boolean | void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().toLowerCase() === confirmText.toLowerCase();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            className="btn--danger"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              const res = await onConfirm();
              setBusy(false);
              if (res !== false) onClose();
            }}
          >
            {actionLabel}
          </Button>
        </>
      }
    >
      <div className="dialog__text">{body}</div>
      <TextField
        label={`Type ${confirmText} to confirm`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="adm-confirm-field"
      />
    </Dialog>
  );
}

/** Password input with show/hide, generate and copy. */
export function PasswordField({
  label,
  value,
  onChange,
  onGenerate,
  error,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onGenerate: () => void;
  error?: string | null;
  help?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="adm-password">
      <TextField
        label={label}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        spellCheck={false}
        error={error}
        help={help}
        suffix={
          <>
            <IconButton
              icon={show ? 'visibility_off' : 'visibility'}
              label={show ? 'Hide password' : 'Show password'}
              size={32}
              iconSize={18}
              onClick={() => setShow(!show)}
            />
            {value ? <CopyButton text={value} label="Copy password" what="Password" /> : null}
          </>
        }
      />
      <Button
        variant="text"
        icon="password"
        onClick={() => {
          onGenerate();
          setShow(true);
        }}
      >
        Generate
      </Button>
    </div>
  );
}
