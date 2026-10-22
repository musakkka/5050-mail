import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format, parseISO } from 'date-fns';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

const TICK = { fill: '#A09FA6', fontSize: 11 };
const AXIS = 'var(--metrics-axis)';

/** Smallest 1/2/2.5/5 × 10^k step ≥ raw (integer steps when `int`). */
export function niceStep(raw: number, int = false): number {
  if (raw <= 0) return int ? 1 : 0.05;
  const k = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const v = m * k;
    if (v >= raw && (!int || Number.isInteger(v))) return v;
  }
  return 10 * k;
}

export const dayLabel = (p: string) => {
  try {
    return format(parseISO(p), 'MMM, dd');
  } catch {
    return p;
  }
};

function ChartTooltip({ active, payload, label, series, percent }: { active?: boolean; payload?: { dataKey?: string | number; value?: number }[]; label?: string; series: SeriesDef[]; percent?: boolean }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => (p.value ?? 0) > 0 || payload.length <= 3);
  return (
    <div className="min-w-40 rounded-xl border border-interactive bg-background px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 text-default">{label ? dayLabel(label) : ''}</p>
      {(rows.length ? rows : payload.slice(0, 1)).map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        return (
          <p key={String(p.dataKey)} className="flex items-center justify-between gap-4 text-emphasis">
            <span className="flex items-center gap-1.5">
              <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: s?.color }} />
              {s?.label ?? p.dataKey}
            </span>
            <span className="tabular-nums">{percent ? `${Number(p.value ?? 0).toFixed(2).replace(/\.?0+$/, '')}%` : (p.value ?? 0).toLocaleString()}</span>
          </p>
        );
      })}
    </div>
  );
}

/** Main events chart: one area per series, right-hand Y axis, dashed grid. */
export function EventsChart({ data, series, zoom = 1 }: { data: Record<string, number | string>[]; series: SeriesDef[]; zoom?: number }) {
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))));
  const top = Math.max(1, max / zoom);
  const step = niceStep(top / 4, true);
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const nice = ticks[4]!;
  return (
    <ResponsiveContainer width="100%" height={300} className="relative **:outline-hidden">
      <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 25 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`m-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="10%" stopColor={s.color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--gray-a2)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="period" tickFormatter={dayLabel} tick={TICK} tickLine={false} axisLine={{ stroke: AXIS }} height={30} interval="preserveStartEnd" minTickGap={8} />
        <YAxis orientation="right" domain={[0, nice]} ticks={ticks} allowDataOverflow allowDecimals={false} tick={TICK} tickLine={{ stroke: AXIS }} axisLine={{ stroke: AXIS }} width={60} />
        <Tooltip cursor={{ stroke: 'var(--gray-a4)' }} content={<ChartTooltip series={series} />} />
        {series.map((s) => (
          <Area key={s.key} type="linear" dataKey={s.key} stroke={s.color} strokeWidth={2} fill={`url(#m-${s.key})`} fillOpacity={0.6} isAnimationActive={false} activeDot={{ r: 3, strokeWidth: 0, fill: s.color }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Rate chart (bounce / complaint): daily bars with a dashed "RISK" threshold. */
export function RateChart({ data, dataKey, color, max, threshold, ticks }: { data: Record<string, number | string>[]; dataKey: string; color: string; max: number; threshold: number; ticks: number[] }) {
  const fmt = (v: number) => `${Number(v.toFixed(3))}%`;
  return (
    <ResponsiveContainer width="100%" height={300} className="relative z-40 **:outline-hidden">
      <BarChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 20 }}>
        <CartesianGrid stroke="var(--gray-a2)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="period" tickFormatter={dayLabel} tick={TICK} tickLine={false} axisLine={{ stroke: AXIS }} height={30} interval="preserveStartEnd" minTickGap={24} />
        <YAxis orientation="right" domain={[0, max]} ticks={ticks} allowDataOverflow tickFormatter={fmt} tick={TICK} tickLine={{ stroke: AXIS }} axisLine={{ stroke: AXIS }} width={42} />
        <Tooltip cursor={{ fill: 'var(--gray-a2)' }} content={<ChartTooltip series={[{ key: dataKey, label: 'Rate', color }]} percent />} />
        <ReferenceLine y={threshold} stroke="var(--orange-a9)" strokeDasharray="2 2" ifOverflow="extendDomain" label={{ value: 'RISK', position: 'insideTopLeft', fill: 'var(--orange-a11)', fontSize: 10 }} />
        <Bar dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
