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

export function getNextSaturdayInEastern(now: Date = new Date()): CalendarDate {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  for (let i = 1; i <= 14; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = fmt.formatToParts(candidate);
    const weekday = parts.find(p => p.type === 'weekday')!.value;
    if (weekday === 'Sat') {
      const year = parseInt(parts.find(p => p.type === 'year')!.value, 10);
      const month = parseInt(parts.find(p => p.type === 'month')!.value, 10);
      const dayOfMonth = parseInt(parts.find(p => p.type === 'day')!.value, 10);
      return {
        year,
        month,
        monthName: MONTH_NAMES[month - 1],
        dayOfMonth,
        iso: `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`,
      };
    }
  }
  throw new Error('Could not find next Saturday within 14 days of now');
}
