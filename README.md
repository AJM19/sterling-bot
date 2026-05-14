# sterling-bot

Weekly cron that books a Saturday tee time at Sterling Farms Golf Course (Stamford, CT) the moment the 7-day booking window opens at 5:00 AM ET.

## What it does

Every Saturday at 5:00:00 AM Eastern, logs into `sterling.chelseareservations.com` with your account, clicks I Agree, sets 2 golfers, then clicks the following Saturday on the calendar and clicks the earliest available time slot between 10:00 AM and 3:00 PM. Clicking the time slot IS the booking — Sterling emails the confirmation.

## Setup

```bash
npm install
cp .env.example .env
# edit .env, at minimum set STERLING_PERMIT
```

Required env: `STERLING_EMAIL`, `STERLING_PASSWORD`. See `.env.example` for the rest.

## Local dry-run

Verifies the flow without booking. Skips the wait for 5 AM ET.

```bash
npm run dry-run
```

Screenshots dump to `/tmp/screenshots/<run-id>/`. Inspect `05-dry-run-stop.png` for the slot the bot would have booked.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: New Project → Deploy from GitHub → pick the repo.
3. Variables tab: add `STERLING_EMAIL` and `STERLING_PASSWORD`. Leave `DRY_RUN=true` for the first weekly run.
4. Settings → confirm the cron schedule shows `58 8 * * 6` (UTC).
5. Trigger one manual deploy to verify the build succeeds.

Cron fires at `58 8 * * 6` UTC = 3:58 AM EST (winter) / 4:58 AM EDT (summer). The script then idles until exactly 5:00:00 AM in `America/New_York` before firing the booking click — DST is handled by the script, not the cron schedule.

## Going live

After a Saturday dry-run produces sensible screenshots and logs, set `DRY_RUN=false` in Railway and let it run the next Saturday.

## Pausing a week

Set `SKIP_NEXT=1` in Railway env vars. The next scheduled run exits cleanly. Unset it after.

## Files

- `src/index.ts` — entry, env parsing
- `src/booker.ts` — Playwright flow
- `src/timing.ts` — DST-aware wait until exactly 5:00:00 AM ET
- `src/nextSaturday.ts` — calendar math for the target Saturday
- `src/log.ts` — JSON-line logger with permit redaction
- `Dockerfile` — pinned Playwright base image
- `railway.json` — cron schedule

## Notes

- Sterling Farms is operated by Chelsea Reservation Systems (ASP.NET WebForms). The site relies on `__VIEWSTATE` postbacks, which is why we use Playwright (real browser) rather than raw HTTP.
- The bot is designed to run idempotently — if the calendar isn't open yet for next Saturday, the click will fail and we exit clean.
