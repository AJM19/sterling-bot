import { chromium, Page, Locator } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { log } from './log.js';
import { waitUntilEastern } from './timing.js';
import { getNextSaturdayInEastern, CalendarDate } from './nextSaturday.js';

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

  const target = getNextSaturdayInEastern();
  log.info('booker.target_date', { ...target });

  try {
    await login(page, opts.email, opts.password);
    await screenshot(page, screenshotDir, '01-after-login');

    await clickAgree(page);
    await screenshot(page, screenshotDir, '02-after-agree');

    await setGolfers(page, opts.golfers);
    await screenshot(page, screenshotDir, '03-form-staged');

    if (!opts.overrideFireNow) {
      await waitUntilEastern(5, 0, 0, opts.raceFireBufferMs);
    } else {
      log.warn('booker.wait.bypassed', { reason: 'OVERRIDE_FIRE_NOW' });
    }

    // Primary attempt: user's preferred holes setting (default 18). Filter to window.
    await setHoles(page, opts.holes);
    await clickTargetDay(page, target);
    await screenshot(page, screenshotDir, '04-time-slots-primary');

    let chosen = await findEarliestInWindow(page, opts, opts.holes);
    let holesUsed = opts.holes;
    let outsideWindow = false;

    // Fallback: if no in-window slot for primary holes count and we weren't already trying 9,
    // switch to 9 holes and grab the EARLIEST AVAILABLE slot regardless of window.
    if (!chosen && opts.holes !== 9) {
      log.info('booker.fallback.trying_9_holes', { primary_holes: opts.holes });
      await setHoles(page, 9);
      await clickTargetDay(page, target);
      await screenshot(page, screenshotDir, '04b-time-slots-9-holes');
      chosen = await findEarliest(page, 9);
      if (chosen) {
        holesUsed = 9;
        outsideWindow =
          chosen.time24 < opts.targetTimeMin || chosen.time24 > opts.targetTimeMax;
      }
    }

    if (!chosen) {
      log.warn('booker.no_slots_any_holes', { window: [opts.targetTimeMin, opts.targetTimeMax] });
      return;
    }

    log.info('booker.slot.chosen', {
      time: chosen.time12,
      hole: chosen.hole,
      holes_played: holesUsed,
      outside_window: outsideWindow,
      label: chosen.rawLabel,
    });

    if (opts.dryRun) {
      log.info('booker.dry_run.stop', {
        would_book: chosen.time12,
        hole: chosen.hole,
        holes_played: holesUsed,
        outside_window: outsideWindow,
      });
      await screenshot(page, screenshotDir, '05-dry-run-stop');
      return;
    }

    // Wait for the postback response so the screenshot captures Sterling's actual reply
    // (confirmation page or red error), not the in-flight page.
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
    log.info('booker.slot.clicked', { time: chosen.time12, holes_played: holesUsed });

    const response = await postbackPromise;
    if (response) {
      log.info('booker.slot.postback_complete', { status: response.status() });
    } else {
      log.warn('booker.slot.postback_timeout');
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await screenshot(page, screenshotDir, '06-after-booking-click');

    // Look for red error text Sterling shows when a booking fails (e.g. slot taken,
    // outside window, etc.). If present, log as a failure rather than success.
    const bodyText = (await page.locator('body').textContent().catch(() => null)) ?? '';
    const errorIndicators = /not available|already booked|invalid|error|denied/i;
    if (errorIndicators.test(bodyText)) {
      const errSnippet = bodyText
        .replace(/\s+/g, ' ')
        .match(/[^.]*?(not available|already booked|invalid|error|denied)[^.]*\./i)?.[0]
        ?.slice(0, 200) ?? '';
      log.error('booker.booking_failed', {
        attempted: chosen.time12,
        holes_played: holesUsed,
        date: target.iso,
        message: errSnippet,
      });
      return;
    }

    log.info('booker.success', {
      booked: chosen.time12,
      hole: chosen.hole,
      holes_played: holesUsed,
      outside_window: outsideWindow,
      date: target.iso,
    });
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
  opts: BookerOptions,
  holesContext: number,
): Promise<Slot | null> {
  const slots = await readAvailableSlots(page);
  log.info('booker.slots.found', {
    holes: holesContext,
    count: slots.length,
    slots: slots.map(s => ({ time: s.time12, hole: s.hole })),
  });

  const inWindow = slots
    .filter(s => s.time24 >= opts.targetTimeMin && s.time24 <= opts.targetTimeMax)
    .sort((a, b) => a.time24.localeCompare(b.time24));

  if (inWindow.length === 0) {
    log.warn('booker.no_slots_in_window', {
      holes: holesContext,
      window: [opts.targetTimeMin, opts.targetTimeMax],
      available: slots.map(s => s.time12),
    });
    return null;
  }
  return inWindow[0];
}

async function findEarliest(page: Page, holesContext: number): Promise<Slot | null> {
  const slots = await readAvailableSlots(page);
  log.info('booker.slots.found', {
    holes: holesContext,
    count: slots.length,
    slots: slots.map(s => ({ time: s.time12, hole: s.hole })),
  });
  if (slots.length === 0) return null;
  return slots.slice().sort((a, b) => a.time24.localeCompare(b.time24))[0];
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
