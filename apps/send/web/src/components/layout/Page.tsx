import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PRODUCT } from '@/lib/config';

/** Sets document.title like the reference ("Emails · Resend" → "Emails · 5050 Send"). */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${PRODUCT}` : PRODUCT;
  }, [title]);
}

export const H1_CLASS = 'font-display effect-font-styling text-[28px] leading-[34px] tracking-[-0.045rem] text-emphasis font-medium';

/** Title row of list pages. */
export function PageHeader({ title, actions, className }: { title: ReactNode; actions?: ReactNode; className?: string }) {
  useTitle(typeof title === 'string' ? title : null);
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-6 pt-2 md:pt-8 flex gap-3 items-center justify-between pb-6 md:pb-8', className)}>
      <h1 className={cn(H1_CLASS, 'min-w-0 truncate')}>{title}</h1>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/** Content column (max-w-6xl, 24px gutters). */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-full px-6 md:max-w-6xl', className)}>{children}</div>;
}

/** Header of detail pages: big status tile, eyebrow label, title and actions. */
export function DetailHeader({
  icon,
  eyebrow,
  title,
  actions,
  back,
}: {
  icon: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}) {
  useTitle(typeof title === 'string' ? title : typeof eyebrow === 'string' ? eyebrow : null);
  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-6 md:flex-row">
      {icon}
      <div className="w-full min-w-0 overflow-hidden text-center md:text-left">
        {back ? (
          <Link to={back.to} className="sr-only focus:not-sr-only focus:inline-flex items-center gap-1 text-sm text-default hover:text-emphasis">
            <ChevronLeft size={14} /> {back.label}
          </Link>
        ) : null}
        <span className="text-sm text-default font-semibold">{eyebrow}</span>
        <h1 className={cn(H1_CLASS, 'w-full truncate md:max-w-[800px]')} translate="no" title={typeof title === 'string' ? title : undefined}>
          {title}
        </h1>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/** Uppercase label + value block used in detail page metadata grids. */
export function Meta({ label, children, className, info }: { label: ReactNode; children: ReactNode; className?: string; info?: ReactNode }) {
  return (
    <div className={cn('mt-8 flex w-full min-w-0 flex-col gap-2', className)}>
      <span className="text-xs text-default w-fit uppercase flex items-center gap-1">
        {label}
        {info}
      </span>
      <div className="flex min-h-5 min-w-0 items-center gap-2 text-sm text-emphasis">{children}</div>
    </div>
  );
}

/** Dashed-underline link used for emails, keys, logs in tables and detail pages. */
export function DashedLink({ to, children, className, title }: { to: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <Link
      to={to}
      title={title}
      className={cn('cursor-pointer border-b border-dashed border-link transition duration-300 ease-in-out group-hover:border-link-hover hover:border-link-hover truncate min-w-0', className)}
    >
      <span className="text-sm text-emphasis font-normal cursor-pointer">{children}</span>
    </Link>
  );
}

/** Section heading inside cards/settings pages. */
export function SectionTitle({ children, className, as: As = 'h2' }: { children: ReactNode; className?: string; as?: 'h2' | 'h3' }) {
  return <As className={cn('text-base text-emphasis font-semibold', className)}>{children}</As>;
}
