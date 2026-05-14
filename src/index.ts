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

  const opts: BookerOptions = {
    email,
    password,
    dryRun: parseBool(process.env.DRY_RUN, true),
    targetTimeMin: process.env.TARGET_TIME_MIN ?? '10:00',
    targetTimeMax: process.env.TARGET_TIME_MAX ?? '15:00',
    golfers: parseInt10(process.env.GOLFERS, 2),
    holes: parseInt10(process.env.HOLES, 18),
    raceFireBufferMs: parseInt10(process.env.RACE_FIRE_BUFFER_MS, 50),
    overrideFireNow: parseBool(process.env.OVERRIDE_FIRE_NOW, false),
    simulateWaitMs: process.env.SIMULATE_WAIT_MS ? parseInt10(process.env.SIMULATE_WAIT_MS, 0) : null,
    headless: parseBool(process.env.HEADLESS, true),
  };

  log.info('boot.config', {
    dry_run: opts.dryRun,
    target_window: [opts.targetTimeMin, opts.targetTimeMax],
    golfers: opts.golfers,
    holes: opts.holes,
    race_fire_buffer_ms: opts.raceFireBufferMs,
    override_fire_now: opts.overrideFireNow,
    headless: opts.headless,
  });

  await book(opts);
  log.info('boot.complete');
}

main().catch(err => {
  const e = err as Error;
  log.error('boot.fatal', { message: e.message, stack: e.stack });
  process.exit(1);
});
