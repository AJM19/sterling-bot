import { log } from './log.js';

const NY = 'America/New_York';

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function getNyDateParts(d: Date): { y: string; m: string; day: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  return {
    y: parts.find(p => p.type === 'year')!.value,
    m: parts.find(p => p.type === 'month')!.value,
    day: parts.find(p => p.type === 'day')!.value,
  };
}

function nyWallClockToUtcMs(year: string, month: string, day: string, hh: number, mm: number, ss: number): number {
  const wallIso = `${year}-${month}-${day}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
  const pretendUtc = new Date(wallIso).getTime();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(pretendUtc));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  const nyIso = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`;
  const nyAsUtc = new Date(nyIso).getTime();
  const offset = pretendUtc - nyAsUtc;
  return pretendUtc + offset;
}

export function easternTodayAt(hour: number, minute: number, second: number): number {
  const { y, m, day } = getNyDateParts(new Date());
  return nyWallClockToUtcMs(y, m, day, hour, minute, second);
}

export function easternHmsFromNow(msAhead: number): { hour: number; minute: number; second: number } {
  const target = new Date(Date.now() + msAhead);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(target);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
  const rawHour = get('hour');
  return { hour: rawHour === 24 ? 0 : rawHour, minute: get('minute'), second: get('second') };
}

export async function waitUntilEastern(hour: number, minute: number, second: number, bufferMs: number): Promise<void> {
  const targetMs = easternTodayAt(hour, minute, second) + bufferMs;
  const delta = targetMs - Date.now();

  if (delta <= 0) {
    log.warn('wait.target_in_past', { delta_ms: delta, target_iso: new Date(targetMs).toISOString() });
    return;
  }

  log.info('wait.start', {
    target_iso: new Date(targetMs).toISOString(),
    delta_ms: delta,
    buffer_ms: bufferMs,
  });

  if (delta > 250) {
    await new Promise(resolve => setTimeout(resolve, delta - 250));
  }

  while (Date.now() < targetMs) {
    // tight spin for the final ~250ms; gives us millisecond precision
  }

  log.info('wait.fired', {
    fired_at_iso: new Date().toISOString(),
    drift_ms: Date.now() - targetMs,
  });
}
