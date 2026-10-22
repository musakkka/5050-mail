import { ICON_PATHS, type IconName } from './paths';

const ALIASES = {
  expand_more: 'keyboard_arrow_down',
  expand_less: 'keyboard_arrow_up',
  help_outline: 'help',
} as const satisfies Record<string, IconName>;

export type IconKey = IconName | keyof typeof ALIASES;

export function Icon({
  name,
  size = 20,
  fill = false,
  className,
  title,
}: {
  name: IconKey;
  size?: number;
  fill?: boolean;
  className?: string;
  title?: string;
}) {
  const base = ((ALIASES as Record<string, IconName>)[name] ?? name) as IconName;
  const filled = `${base}:fill` as IconName;
  const d = (fill && filled in ICON_PATHS ? ICON_PATHS[filled] : ICON_PATHS[base]) ?? '';
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
