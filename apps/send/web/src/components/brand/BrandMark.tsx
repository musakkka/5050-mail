import { AQUA_PLATE, LIME_PLATE, MARK_VB, PLATE_INKS } from './paths';
import { cn } from '@/lib/cn';

/**
 * The 5050 mark (lime "50" + aqua "50" plates, multiplied in light mode and
 * screened in dark mode). Used wherever the reference shows its logo.
 */
export function BrandMark({ height = 24, title, className }: { height?: number; title?: string; className?: string }) {
  return (
    <svg
      className={cn('brand-mark shrink-0', className)}
      width={Math.round((height * MARK_VB.w) / MARK_VB.h)}
      height={height}
      viewBox={`${MARK_VB.x} ${MARK_VB.y} ${MARK_VB.w} ${MARK_VB.h}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ isolation: 'isolate' }}
    >
      <g className="fill-[var(--brand-lime)]" style={{ ['--brand-lime' as string]: PLATE_INKS.light.lime }}>
        {LIME_PLATE.map((d) => (
          <path key={d.slice(0, 16)} d={d} fillRule="evenodd" className="dark:fill-[#C4F53A]" />
        ))}
      </g>
      <g className="mix-blend-multiply dark:mix-blend-screen">
        {AQUA_PLATE.map((d) => (
          <path key={d.slice(0, 16)} d={d} fillRule="evenodd" fill={PLATE_INKS.light.aqua} className="dark:fill-[#3FD6FA]" />
        ))}
      </g>
    </svg>
  );
}

/** Square team avatar: the 5050 mark on a dark tile (where the reference shows a team avatar). */
export function TeamAvatar({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('relative shrink-0 inline-flex items-center justify-center overflow-hidden rounded-lg bg-[#0d0f12] ring-1 ring-inset ring-white/10', className)}
      style={{ width: size, height: size, minWidth: size }}
      aria-hidden="true"
    >
      <BrandMark height={Math.round(size * 0.36)} />
    </span>
  );
}
