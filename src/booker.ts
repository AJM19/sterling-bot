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

    // Primary attempt: user's preferred holes setting (default 18).
    await setHoles(page, opts.holes);
    await clickTargetDay(page, target);
    await screenshot(page, screenshotDir, '04-time-slots-primary');

    let chosen = await findEarliestInWindow(page, opts, opts.holes);
    let holesUsed = opts.holes;

    // Fallback: if the user wanted 18 holes and nothing's in window, try 9 holes.
    if (!chosen && opts.holes !== 9) {
      log.info('booker.fallback.trying_9_holes', { primary_holes: opts.holes });
      await setHoles(page, 9);
      await clickTargetDay(page, target);
      await screenshot(page, screenshotDir, '04b-time-slots-9-holes');
      chosen = await findEarliestInWindow(page, opts, 9);
      if (chosen) holesUsed = 9;
    }

    if (!chosen) {
      log.warn('booker.no_slots_any_holes', { window: [opts.targetTimeMin, opts.targetTimeMax] });
      return;
    }

    log.info('booker.slot.chosen', {
      time: chosen.time12,
      hole: chosen.hole,
      holes_played: holesUsed,
      label: chosen.rawLabel,
    });

    if (opts.dryRun) {
      log.info('booker.dry_run.stop', {
        would_book: chosen.time12,
        hole: chosen.hole,
        holes_played: holesUsed,
      });
      await screenshot(page, screenshotDir, '05-dry-run-stop');
      return;
    }

    await chosen.locator.click();
    log.info('booker.slot.clicked', { time: chosen.time12, holes_played: holesUsed });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await screenshot(page, screenshotDir, '06-after-booking-click');
    log.info('booker.success', {
      booked: chosen.time12,
      hole: chosen.hole,
      holes_played: holesUsed,
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

async function clickTargetDay(page: Page, target: CalendarDate): Promise<void> {
  const dayId = `#Day${target.dayOfMonth}`;
  log.info('booker.day.click_target', { day_selector: dayId, iso: target.iso });

  // The day cell is <a id="DayNN" href="javascript:__doPostBack('DayNN','')">. The href
  // is a synthetic javascript: URL, so we must dispatch a real click (which lets Playwright
  // run the JS handler and submit the postback form).
  await page.locator(dayId).click();
  log.info('booker.day.clicked', { day: target.dayOfMonth });

  // The postback returns a full page replacement. Wait for any slot link matching the pattern
  // to appear, since the postback may not trigger a top-level navigation event.
  const slotPattern = /\d{1,2}:\d{2}\s*(am|pm)\s+Hole-\d+/i;
  try {
    await page.waitForFunction(
      (re: string) => {
        const rx = new RegExp(re, 'i');
        return Array.from(document.querySelectorAll('a')).some(a => rx.test((a.textContent || '').trim()));
      },
      slotPattern.source,
      { timeout: 15000 }
    );
    log.info('booker.day.slot_list_rendered');
  } catch {
    log.warn('booker.day.slot_list_timeout');
  }

  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
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
