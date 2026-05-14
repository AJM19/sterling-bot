const NY = 'America/New_York';

export interface CalendarDate {
  year: number;
  month: number;       // 1-12
  monthName: string;   // "January" ... "December"
  dayOfMonth: number;  // 1-31
  iso: string;         // YYYY-MM-DD (NY local)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function getTargetDateInEastern(daysAhead: number = 7, now: Date = new Date()): CalendarDate {
  // Read today's calendar date in NY.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'month')!.value, 10);
  const d = parseInt(parts.find(p => p.type === 'day')!.value, 10);

  // Date.UTC handles month/year rollover automatically (e.g. Dec 28 + 7 → Jan 4).
  // Using UTC math avoids DST traps that come from "add 7 * 86400000 ms".
  const target = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  const td = target.getUTCDate();

  return {
    year: ty,
    month: tm,
    monthName: MONTH_NAMES[tm - 1],
    dayOfMonth: td,
    iso: `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`,
  };
}
