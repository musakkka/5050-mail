import * as chrono from 'chrono-node';

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * `scheduled_at`: ISO 8601 or natural language ("in 1 min", "tomorrow at 9am",
 * "Friday at 3pm ET"). Natural language is resolved in UTC unless it names a zone.
 */
export function parseWhen(input: string, now = new Date()): Date | null {
  const s = input.trim();
  if (!s) return null;
  if (ISO_RE.test(s)) {
    const d = new Date(s.includes('T') || s.includes(' ') ? s.replace(' ', 'T') : `${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const r = chrono.parse(s, { instant: now, timezone: 'UTC' }, { forwardDate: true });
  if (!r.length) return null;
  const d = r[0]!.date();
  return Number.isNaN(d.getTime()) ? null : d;
}

const UNITS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

/** "10m", "2 hours", "1 day", "48h" → seconds. */
export function parseDuration(input: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input);
  if (!m) return null;
  const unit = UNITS[m[2]!.toLowerCase()];
  return unit ? Math.round(Number(m[1]) * unit) : null;
}

export const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const startOfUtcMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const nextUtcDay = (d = new Date()) => new Date(startOfUtcDay(d).getTime() + 86400_000);
export const nextUtcMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
