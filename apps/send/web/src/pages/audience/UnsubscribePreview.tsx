import { Link } from 'react-router-dom';
import { Check, Pencil } from 'lucide-react';
import type { Topic, UnsubscribePageSettings } from '@/api/types';
import { BrandMark } from '@/components/brand/BrandMark';
import { useSession } from '@/state/session';

/** Live, non-interactive preview of the hosted unsubscribe page (Topics tab). */
export function UnsubscribePreview({ topics, settings }: { topics: Topic[]; settings?: UnsubscribePageSettings }) {
  const team = useSession().team;
  const s = settings ?? team.settings?.unsubscribe_page ?? {};
  const bg = '#05050A';
  const fg = '#EDEEF0';
  const accent = '#363A3F';
  const visible = topics.filter((t) => t.visibility !== 'private');
  return (
    <div className="relative">
      <Link
        to="/settings/unsubscribe-page"
        className="inline-flex items-center justify-center select-none cursor-pointer transition ease-in-out duration-200 font-medium text-xs h-6 px-2 pl-2.5 rounded-lg gap-1 absolute z-10 right-2 top-2 border bg-white/10 border-white/10 text-[#EDEEF0] hover:!bg-white/15 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-hidden"
      >
        <Pencil size={12} />
        <span className="inline-flex items-center justify-center gap-1 truncate min-w-0">Customize page</span>
      </Link>
      <div
        className="relative overflow-hidden rounded-2xl border-x border-t border-gray-3 dark:border-gray-a1 ring ring-gray-a3 dark:ring-gray-a4 select-none"
        style={{ background: bg, color: fg, colorScheme: 'dark' }}
        aria-label="Unsubscribe page preview"
        role="img"
      >
        <div className="flex min-h-[404px] flex-col items-center justify-between">
          <div className="flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-10 py-8 text-center">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-white">
              {s.logo_url ? <img src={s.logo_url} alt="" className="h-12 w-12 rounded-full object-contain" /> : <Check size={24} className="text-black/20" />}
            </div>
            <h3 className="text-[28px] font-semibold leading-[36px] tracking-tight [text-wrap:balance]">{s.title || 'Do you want to unsubscribe?'}</h3>
            <p className="mt-1 text-sm opacity-50">{s.description || 'Confirm your email preferences:'}</p>
            <div className="mx-auto mt-7 w-full max-w-sm">
              {visible.length ? (
                <ul className="flex flex-col gap-2 text-left text-sm">
                  {visible.slice(0, 4).map((t) => (
                    <li key={t.id} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: '#ffffff0d' }}>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-white/30" style={{ background: t.default_subscription === 'opt_in' ? fg : 'transparent' }}>
                        {t.default_subscription === 'opt_in' ? <Check size={11} className="text-black" strokeWidth={3} /> : null}
                      </span>
                      <span className="min-w-0 truncate">{t.name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mx-auto mt-4 w-full max-w-96">
                <div className="pointer-events-none my-2 inline-flex w-full items-center justify-center rounded-xl py-2 text-sm font-semibold" style={{ background: accent }}>
                  {visible.length ? 'Update preferences' : 'Unsubscribe'}
                </div>
              </div>
            </div>
          </div>
          <div className="mb-6 flex items-center gap-2 text-nowrap text-xs font-medium">
            <span className="opacity-50">Powered by</span>
            <BrandMark height={12} />
            <span className="opacity-50">5050 Send</span>
          </div>
        </div>
      </div>
    </div>
  );
}
