import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModal } from './useModal';

/** Modal dialog with scrim (02-components §13): focus trap, Esc, scroll lock, focus restore. */
export function Dialog({
  title,
  children,
  actions,
  onClose,
  className,
  wide,
  labelledBy,
}: {
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  className?: string;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  return createPortal(
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog${wide ? ' dialog--wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? 'dialog-title'}
      >
        {title ? (
          <h2 className="dialog__title" id="dialog-title">
            {title}
          </h2>
        ) : null}
        <div className="dialog__body">{children}</div>
        {actions ? <div className="dialog__actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
