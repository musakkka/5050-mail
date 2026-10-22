import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type IconTone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'gray' | 'sand' | 'mauve';

/** Tone → CSS colour. Kept to the same Radix steps the reference uses for its status tiles. */
export const TONE_COLOR: Record<IconTone, string> = {
  green: 'var(--green-a10)',
  red: 'var(--red-a10)',
  amber: 'var(--amber-a10)',
  blue: 'var(--blue-a10)',
  violet: 'var(--violet-a10)',
  gray: 'var(--gray-10)',
  sand: 'var(--sand-a10)',
  mauve: 'var(--mauve-a10)',
};

/**
 * Glassy rounded tile with a glowing ring and a glyph: our own drawing in the
 * reference's visual language (used for email/domain/key/webhook rows and headers).
 */
export function AppIcon({
  size = 32,
  tone = 'green',
  children,
  className,
  glyphSize,
}: {
  size?: number;
  tone?: IconTone;
  children: ReactNode;
  className?: string;
  glyphSize?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const color = TONE_COLOR[tone];
  const r = size * 0.3125;
  const g = glyphSize ?? Math.round(size * 0.5);
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size, color }} aria-hidden="true">
      <svg className="absolute left-0 top-0 saturate-150" width={size} height={size} viewBox="0 0 80 80" fill="none">
        <defs>
          <clipPath id={`${uid}c`}>
            <rect width="80" height="80" rx="25" />
          </clipPath>
          <linearGradient id={`${uid}t`} x1="40" x2="40" y1="0" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--gray-12)" stopOpacity="1" />
            <stop offset="1" stopColor="var(--gray-12)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}s`} x1="40" x2="40" y1="0" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--gray-12)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--gray-12)" stopOpacity="0.25" />
          </linearGradient>
          <radialGradient id={`${uid}r`} cx="40" cy="40" r="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={`${uid}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="80" style={{ maskType: 'alpha' }}>
            <rect width="80" height="80" fill={`url(#${uid}r)`} />
          </mask>
          <filter id={`${uid}b1`} x="-20" y="-20" width="120" height="120" filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation="18" />
          </filter>
          <filter id={`${uid}b2`} x="0" y="0" width="80" height="80" filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <pattern id={`${uid}p`} width="10" height="10" patternUnits="userSpaceOnUse">
            <circle cx="5" cy="5" r="1.1" fill="var(--gray-12)" fillOpacity="0.16" />
          </pattern>
        </defs>
        <g clipPath={`url(#${uid}c)`}>
          <rect width="80" height="80" rx="25" fill="var(--background)" />
          <rect width="80" height="80" rx="25" fill={`url(#${uid}t)`} fillOpacity="0.22" />
          <g mask={`url(#${uid}m)`}>
            <rect width="80" height="80" fill={`url(#${uid}p)`} />
          </g>
          <circle cx="40" cy="40" r="15" stroke="currentColor" strokeWidth="5" filter={`url(#${uid}b1)`} />
          <circle cx="40" cy="40" r="15" stroke="currentColor" strokeWidth="5" filter={`url(#${uid}b2)`} />
          <rect x="3" y="3" width="74" height="74" rx="22" fill="currentColor" fillOpacity="0.05" />
          <rect x="3" y="3" width="74" height="74" rx="22" stroke="var(--background)" strokeWidth="6" />
        </g>
        <rect x="1" y="1" width="78" height="78" rx="24" stroke={`url(#${uid}s)`} strokeWidth="2" />
      </svg>
      <span
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center [&_svg]:h-full [&_svg]:w-full"
        style={{ width: g, height: g, color, borderRadius: r }}
      >
        {children}
      </span>
    </div>
  );
}
