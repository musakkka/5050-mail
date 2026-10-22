import type { MouseEvent } from 'react';

/** Gmail-style checkbox: 18px box, dark fill when checked. */
export function Checkbox({
  checked,
  indeterminate,
  onToggle,
  label,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (e: MouseEvent) => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      data-tooltip="Select"
      className={`checkbox${checked ? ' checkbox--on' : ''}${indeterminate ? ' checkbox--mixed' : ''}${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
    >
      <span className="checkbox__box">
        {indeterminate ? (
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <rect x="4" y="8" width="10" height="2" fill="currentColor" />
          </svg>
        ) : checked ? (
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <path d="M7.2 12.3 3.9 9l-1.1 1.1 4.4 4.4 9.4-9.4-1.1-1.1z" fill="currentColor" />
          </svg>
        ) : null}
      </span>
    </button>
  );
}
