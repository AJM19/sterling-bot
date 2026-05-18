import { chromium, Page, Locator } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from './log.js';
import { waitUntilEastern, easternHmsFromNow } from './timing.js';
import { getTargetDateInEastern, CalendarDate } from './targetDate.js';

export interface BookerOptions {
  email: string;
  password: string;
  dryRun: boolean;
  targetTimeMin: string;  // "HH:MM" 24h
  targetTimeMax: string;  // "HH:MM" 24h
  golfers: number;
  holes: number;
  raceFireBufferMs: number;
  overrideFireNow: boolean;
  simulateWaitMs: number | null;
  headless: boolean;
}

interface Slot {
  time24: string;       // "13:50"
  time12: string;       // "1:50 pm"
  hole: string;         // "Hole-01"
  locator: Locator;
  rawLabel: string;
}

export async function book(opts: BookerOptions): Promise<void> {
  const screenshotDir = path.resolve('screenshots', log.runId);
  await fs.mkdir(screenshotDir, { recursive: true });

  const browser = await chromium.launch({
    headless: opts.headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const target = getTargetDateInEastern();
  log.info('booker.target_date', { ...target });

  try {
    await login(page, opts.email, opts.password);
    await screenshot(page, screenshotDir, '01-after-login');

    await clickAgree(page);
    await screenshot(page, screenshotDir, '02-after-agree');

    // Pre-stage the form so the post-5am re-stage is fast.
    await setGolfers(page, opts.golfers);
    await setHoles(page, opts.holes);
    await screenshot(page, screenshotDir, '03-form-staged-prestage');

    if (opts.simulateWaitMs != null) {
      const t = easternHmsFromNow(opts.simulateWaitMs);
      log.info('booker.wait.simulating_target', {
        in_ms: opts.simulateWaitMs,
        eastern_target: `${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`,
      });
      await waitUntilEastern(t.hour, t.minute, t.second, opts.raceFireBufferMs);
    } else if (opts.overrideFireNow) {
      log.warn('booker.wait.bypassed', { reason: 'OVERRIDE_FIRE_NOW' });
    } else {
      await waitUntilEastern(5, 0, 0, opts.raceFireBufferMs);
    }

    // Sterling only renders #DayNN for next Saturday once the 7-day window opens at 5:00 AM ET.
    // Click btnDisplay until that link appears (handles minor server clock skew at the boundary).
    await refreshAfterFireMoment(page, target);
    await screenshot(page, screenshotDir, '03b-after-5am-refresh');

    // Two-tier attempt chain:
    //   1) GOLFERS, HOLES, primary window
    //   2) GOLFERS - 1, HOLES, primary window (skipped if GOLFERS <= 1)
    // If neither matches, the bot exits without booking. No more 9-hole failsafe.
    interface Attempt {
      golfers: number;
      holes: number;
      windowMin: string;
      windowMax: string;
      screenshotName: string;
      tier: 'primary' | 'fewer_golfers';
    }
    const attempts: Attempt[] = [
      {
        golfers: opts.golfers,
        holes: opts.holes,
        windowMin: opts.targetTimeMin,
        windowMax: opts.targetTimeMax,
        screenshotName: '04a-attempt-primary',
        tier: 'primary',
      },
    ];
    if (opts.golfers > 1) {
      attempts.push({
        golfers: opts.golfers - 1,
        holes: opts.holes,
        windowMin: opts.targetTimeMin,
        windowMax: opts.targetTimeMax,
        screenshotName: '04b-attempt-fewer-golfers',
        tier: 'fewer_golfers',
      });
    }

    let chosen: Slot | null = null;
    let attemptUsed: Attempt | null = null;

    for (const att of attempts) {
      log.info('booker.attempt.starting', {
        tier: att.tier,
        golfers: att.golfers,
        holes: att.holes,
        window: [att.windowMin, att.windowMax],
      });
      await setGolfers(page, att.golfers);
      await setHoles(page, att.holes);
      await clickTargetDay(page, target);
      await screenshot(page, screenshotDir, att.screenshotName);

      chosen = await findEarliestInWindow(page, att.windowMin, att.windowMax, att.holes);

      if (chosen) {
        attemptUsed = att;
        log.info('booker.attempt.matched', {
          tier: att.tier,
          golfers: att.golfers,
          holes: att.holes,
          time: chosen.time12,
        });
        break;
      }
      log.warn('booker.attempt.no_match', { tier: att.tier });
    }

    if (!chosen || !attemptUsed) {
      log.warn('booker.no_slots_any_attempt', { window: [opts.targetTimeMin, opts.targetTimeMax] });
      return;
    }

    const outsideWindow =
      chosen.time24 < opts.targetTimeMin || chosen.time24 > opts.targetTimeMax;

    log.info('booker.slot.chosen', {
      tier: attemptUsed.tier,
      time: chosen.time12,
      hole: chosen.hole,
      golfers_played: attemptUsed.golfers,
      holes_played: attemptUsed.holes,
      outside_window: outsideWindow,
      label: chosen.rawLabel,
    });

    if (opts.dryRun) {
      log.info('booker.dry_run.stop', {
        tier: attemptUsed.tier,
        would_book: chosen.time12,
        hole: chosen.hole,
        golfers_played: attemptUsed.golfers,
        holes_played: attemptUsed.holes,
        outside_window: outsideWindow,
      });
      await screenshot(page, screenshotDir, '05-dry-run-stop');
      return;
    }

    // Click-and-verify with retry. We use POSITIVE success detection — Sterling's success
    // page shows "Your tee time has been recorded ... Your confirmation number is: <N>".
    // Anything else (race conflict, generic error, session bounce) is treated as a failure
    // so the bot doesn't optimistically declare success on an unexpected page.
    const MAX_CLICK_RETRIES = 4;
    const tried = new Set<string>([chosen.time24]);
    let bookingSucceeded = false;
    let lastBodySnippet = '';

    for (let retry = 0; retry <= MAX_CLICK_RETRIES; retry++) {
      const postbackPromise = page
        .waitForResponse(
          resp =>
            resp.url().includes('bookingadmin.aspx') &&
            resp.request().method() === 'POST' &&
            resp.status() < 400,
          { timeout: 15000 },
        )
        .catch(() => null);

      await chosen.locator.click();
      log.info('booker.slot.clicked', {
        tier: attemptUsed.tier,
        time: chosen.time12,
        retry,
        golfers_played: attemptUsed.golfers,
        holes_played: attemptUsed.holes,
      });

      const response = await postbackPromise;
      if (response) {
        log.info('booker.slot.postback_complete', { status: response.status(), retry });
      } else {
        log.warn('booker.slot.postback_timeout', { retry });
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const screenshotName = retry === 0 ? '06-after-booking-click' : `06-after-booking-click-retry-${retry}`;
      await screenshot(page, screenshotDir, screenshotName);

      const bodyText = (await page.locator('body').textContent().catch(() => null)) ?? '';
      const successPattern = /your tee time has been recorded|your confirmation number is/i;
      const confirmMatch = bodyText.match(/confirmation number is:?\s*(\S+)/i);

      if (successPattern.test(bodyText)) {
        bookingSucceeded = true;
        log.info('booker.success', {
          tier: attemptUsed.tier,
          booked: chosen.time12,
          hole: chosen.hole,
          golfers_played: attemptUsed.golfers,
          holes_played: attemptUsed.holes,
          outside_window: outsideWindow,
          date: target.iso,
          confirmation_number: confirmMatch?.[1] ?? null,
          retries_used: retry,
        });
        break;
      }

      lastBodySnippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
      log.warn('booker.slot.click_rejected', {
        tier: attemptUsed.tier,
        attempted: chosen.time12,
        retry,
        body_snippet: lastBodySnippet,
      });

      if (retry === MAX_CLICK_RETRIES) break;

      // Re-fetch the slot list (the rejected slot is presumably no longer available).
      // Pick the next earliest IN THE SAME TIER WINDOW that we haven't tried yet.
      await clickTargetDay(page, target);
      const fresh = await readAvailableSlots(page);
      const remaining = fresh
        .filter(s => !tried.has(s.time24))
        .filter(s => s.time24 >= attemptUsed!.windowMin && s.time24 <= attemptUsed!.windowMax)
        .sort((a, b) => a.time24.localeCompare(b.time24));

      if (remaining.length === 0) {
        log.warn('booker.slot.no_more_candidates', {
          tier: attemptUsed.tier,
          tried: Array.from(tried),
        });
        break;
      }

      chosen = remaining[0];
      tried.add(chosen.time24);
      log.info('booker.slot.retry_picked', {
        tier: attemptUsed.tier,
        time: chosen.time12,
        retry: retry + 1,
      });
    }

    if (!bookingSucceeded) {
      log.error('booker.booking_failed', {
        tier: attemptUsed.tier,
        tried_times: Array.from(tried),
        last_body_snippet: lastBodySnippet,
        date: target.iso,
      });
    }
  } catch (err) {
    const e = err as Error;
    log.error('booker.exception', { message: e.message, stack: e.stack });
    await screenshot(page, screenshotDir, 'error').catch(() => {});
    throw err;
  } finally {
    log.info('booker.cleanup', { screenshot_dir: screenshotDir });
    await browser.close();
  }
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('https://sterling.chelseareservations.com/golf/bookingadmin.aspx');
  log.info('booker.login.page_loaded', { url: page.url() });

  // First Login button opens the credential form
  await page.getByRole('button', { name: 'Login' }).first().click();

  await page.locator('#txtLogin').fill(email);
  await page.locator('#txtPassword').fill(password);

  // Second Login button submits
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.getByRole('button', { name: 'Login' }).first().click(),
  ]);
  log.info('booker.login.complete', { url: page.url() });
}

async function clickAgree(page: Page): Promise<void> {
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.getByRole('button', { name: 'I Agree' }).click(),
  ]);
  log.info('booker.agree.complete', { url: page.url() });
}

async function refreshAfterFireMoment(page: Page, target: CalendarDate): Promise<void> {
  // Don't navigate (page.goto resets Sterling's session view). Click #btnDisplay — this is a
  // postback that asks the server to regenerate the calendar section based on the current
  // ddlMonth/ddlYear. Sterling decides which days are bookable at server-eval time, so a
  // postback at 5:00:00 AM picks up the new day link automatically.
  //
  // Retry up to MAX_ATTEMPTS times: if Sterling's server clock is behind ours by even a few
  // milliseconds, the first click could return a response generated at 4:59:59.x with the
  // target day still hidden. Each subsequent retry waits RETRY_DELAY_MS so the server moves
  // past 5:00:00 AM on its own clock.
  const dayId = `#Day${target.dayOfMonth}`;
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 400;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log.info('booker.refresh.attempt', { attempt, day_selector: dayId, url: page.url() });

    const postbackPromise = page
      .waitForResponse(
        resp =>
          resp.url().includes('bookingadmin.aspx') &&
          resp.request().method() === 'POST' &&
          resp.status() < 400,
        { timeout: 15000 },
      )
      .catch(() => null);

    await page.locator('#btnDisplay').click();
    const response = await postbackPromise;
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

    const dayCount = await page.locator(dayId).count();
    log.info('booker.refresh.day_check', {
      attempt,
      postback_status: response?.status() ?? 'timeout',
      day_link_present: dayCount > 0,
    });

    if (dayCount > 0) {
      log.info('booker.refresh.complete', { attempts: attempt });
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  log.error('booker.refresh.exhausted_retries', { day_selector: dayId, attempts: MAX_ATTEMPTS });
}

async function setGolfers(page: Page, golfers: number): Promise<void> {
  await page.locator('#ddlQuantity').selectOption(String(golfers));
  log.info('booker.form.staged', { golfers });
}

async function setHoles(page: Page, holes: number): Promise<void> {
  // Best-effort: the dropdown may not exist on all pages of the flow; silently skip if missing.
  const dd = page.locator('#ddlHoleSelection');
  if (await dd.count() === 0) {
    log.info('booker.holes.dropdown_absent', { holes_requested: holes });
    return;
  }
  await dd.selectOption(String(holes));
  log.info('booker.holes.set', { holes });
}

async function findEarliestInWindow(
  page: Page,
  windowMin: string,
  windowMax: string,
  holesContext: number,
): Promise<Slot | null> {
  const slots = await readAvailableSlots(page);
  log.info('booker.slots.found', {
    holes: holesContext,
    count: slots.length,
    slots: slots.map(s => ({ time: s.time12, hole: s.hole })),
  });

  const inWindow = slots
    .filter(s => s.time24 >= windowMin && s.time24 <= windowMax)
    .sort((a, b) => a.time24.localeCompare(b.time24));

  if (inWindow.length === 0) {
    log.warn('booker.no_slots_in_window', {
      holes: holesContext,
      window: [windowMin, windowMax],
      available: slots.map(s => s.time12),
    });
    return null;
  }
  return inWindow[0];
}

async function clickTargetDay(page: Page, target: CalendarDate): Promise<void> {
  const dayId = `#Day${target.dayOfMonth}`;
  log.info('booker.day.click_target', { day_selector: dayId, iso: target.iso });

  // Wait for the ASP.NET postback to complete (rather than checking the DOM, which can return
  // stale "Compare..." slot links from a previous click before the new HTML lands).
  const postbackPromise = page
    .waitForResponse(
      resp =>
        resp.url().includes('bookingadmin.aspx') &&
        resp.request().method() === 'POST' &&
        resp.status() < 400,
      { timeout: 15000 },
    )
    .catch(() => null);

  await page.locator(dayId).click();
  log.info('booker.day.clicked', { day: target.dayOfMonth });

  const response = await postbackPromise;
  if (response) {
    log.info('booker.day.postback_complete', { status: response.status() });
  } else {
    log.warn('booker.day.postback_timeout');
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
}

async function readAvailableSlots(page: Page): Promise<Slot[]> {
  // Time slot links look like "<HH>:<MM> <am|pm>  Hole-<NN>" (e.g. "06:00 pm  Hole-01").
  // Booked slots have a "Booked - X-X" indicator in a sibling <font> inside the same <td>.
  const allLinks = await page.locator('a').all();
  const slots: Slot[] = [];
  let booked = 0;

  for (const loc of allLinks) {
    const raw = (await loc.textContent().catch(() => null))?.trim();
    if (!raw) continue;
    const match = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s+(Hole-\d+)$/i);
    if (!match) continue;

    const parentText = await loc
      .evaluate(el => (el.closest('td')?.textContent || '').toLowerCase())
      .catch(() => '');
    if (/\bbooked\b/.test(parentText)) {
      booked++;
      continue;
    }

    const hour12 = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const meridiem = match[3].toLowerCase();
    let hour24 = hour12 % 12;
    if (meridiem === 'pm') hour24 += 12;

    slots.push({
      time24: `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      time12: `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`,
      hole: match[4],
      locator: loc,
      rawLabel: raw,
    });
  }

  log.info('booker.slots.scanned', { available: slots.length, booked });
  return slots;
}

async function screenshot(page: Page, dir: string, name: string): Promise<void> {
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log.info('booker.screenshot', { file });
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
