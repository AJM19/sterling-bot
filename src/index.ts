import { log } from './log.js';
import { book, BookerOptions } from './booker.js';

function parseBool(s: string | undefined, def: boolean): boolean {
  if (s === undefined || s === '') return def;
  return s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'yes';
}

function parseInt10(s: string | undefined, def: number): number {
  if (s === undefined || s === '') return def;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? def : n;
}

function normalizeTime(s: string | undefined, def: string): string {
  if (!s) return def;
  const match = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return def;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

async function main(): Promise<void> {
  const email = process.env.STERLING_EMAIL;
  const password = process.env.STERLING_PASSWORD;
  if (!email || !password) {
    log.error('boot.missing_env', { missing: ['STERLING_EMAIL', 'STERLING_PASSWORD'].filter(k => !process.env[k]) });
    process.exit(1);
  }

  if (parseBool(process.env.SKIP_NEXT, false)) {
    log.info('boot.skipped', { reason: 'SKIP_NEXT' });
    return;
  }

  // Tuesday runs override env config: 3 golfers, 5:20–5:30 PM ET window.
  // All other days use the env-configured values.
  const nyWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(new Date());
  const tuesdayOverride = nyWeekday === 'Tue';

  const opts: BookerOptions = {
    email,
    password,
    dryRun: parseBool(process.env.DRY_RUN, true),
    targetTimeMin: tuesdayOverride ? '17:20' : normalizeTime(process.env.TARGET_TIME_MIN, '10:00'),
    targetTimeMax: tuesdayOverride ? '17:30' : normalizeTime(process.env.TARGET_TIME_MAX, '15:00'),
    golfers: tuesdayOverride ? 3 : parseInt10(process.env.GOLFERS, 2),
    holes: parseInt10(process.env.HOLES, 18),
    raceFireBufferMs: parseInt10(process.env.RACE_FIRE_BUFFER_MS, 50),
    overrideFireNow: parseBool(process.env.OVERRIDE_FIRE_NOW, false),
    simulateWaitMs: process.env.SIMULATE_WAIT_MS ? parseInt10(process.env.SIMULATE_WAIT_MS, 0) : null,
    headless: parseBool(process.env.HEADLESS, true),
  };

  log.info('boot.config', {
    dry_run: opts.dryRun,
    ny_weekday: nyWeekday,
    tuesday_override: tuesdayOverride,
    target_window: [opts.targetTimeMin, opts.targetTimeMax],
    golfers: opts.golfers,
    holes: opts.holes,
    race_fire_buffer_ms: opts.raceFireBufferMs,
    override_fire_now: opts.overrideFireNow,
    headless: opts.headless,
  });

  // Sanity: an inverted or empty window is almost always a 12h/24h mixup
  // (e.g. "02:30" meaning 2:30 PM instead of 14:30). Refuse to run rather than
  // letting the booker walk into a guaranteed-no-match state.
  if (opts.targetTimeMax <= opts.targetTimeMin) {
    log.error('boot.invalid_window', {
      target_time_min: opts.targetTimeMin,
      target_time_max: opts.targetTimeMax,
      hint: 'TARGET_TIME_MAX must be > TARGET_TIME_MIN, in 24-hour HH:MM. 2:30 PM is 14:30, not 02:30.',
    });
    process.exit(1);
  }

  await book(opts);
  log.info('boot.complete');
}

main().catch(err => {
  const e = err as Error;
  log.error('boot.fatal', { message: e.message, stack: e.stack });
  process.exit(1);
});
