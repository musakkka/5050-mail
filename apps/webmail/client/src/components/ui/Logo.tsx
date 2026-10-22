import { AQUA_PLATE, LIME_PLATE, MARK_VB } from '../brand/paths';

/**
 * 5050 brand mark: the lime "50" and aqua "50" plates from the 5050 brand kit,
 * printed flat and multiplied where they overlap (screened in dark mode). Inline
 * so the inks follow the theme (--brand-* tokens). No outlines, gradients or shine.
 */
function Plates() {
  return (
    <>
      <g className="brand-plate brand-plate--lime">
        {LIME_PLATE.map((d) => (
          <path key={d.slice(0, 16)} d={d} fillRule="evenodd" />
        ))}
      </g>
      <g className="brand-plate brand-plate--aqua">
        {AQUA_PLATE.map((d) => (
          <path key={d.slice(0, 16)} d={d} fillRule="evenodd" />
        ))}
      </g>
    </>
  );
}

/** The 5050 mark on its own. `height` is the rendered height in px. */
export function BrandMark({ height = 32, title }: { height?: number; title?: string }) {
  return (
    <svg
      className="brand-mark"
      width={Math.round((height * MARK_VB.w) / MARK_VB.h)}
      height={height}
      viewBox={`${MARK_VB.x} ${MARK_VB.y} ${MARK_VB.w} ${MARK_VB.h}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <Plates />
    </svg>
  );
}

/** Top-bar logo, in Gmail's logo position. */
export function BrandLogo({ onClick }: { onClick?: () => void }) {
  return (
    <a
      href="/mail/inbox"
      className="brand-logo"
      aria-label="5050 Mail"
      onClick={(e) => {
        if (onClick) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <BrandMark height={28} />
    </a>
  );
}
